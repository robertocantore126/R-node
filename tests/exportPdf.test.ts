/**
 * Gates on the paginated PDF.
 *
 * The rule the format exists to keep: the map is cut vertically and never
 * horizontally, at one scale, with every element on its canvas position. Each
 * clause of that is asserted here, because the first implementation broke two
 * of them in ways that looked fine in the numbers — it bucketed topics by which
 * cell held their centre, which moved them relative to each other across a cut,
 * and it clipped away the overhang instead of drawing it on the next sheet.
 */
import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { sheetToPdf, PAGE_SIZES, PT_PER_UNIT } from "../src/export/pdf";
import { HEURISTIC_MEASURER } from "../src/layout/measure";
import { applyLayout } from "../src/layout/mindmap";
import { DocumentModel } from "../src/core/doc";
import type { MindNode, Sheet } from "../src/core/types";

const MARGIN = 28.35;

function makeSheet(): { sheet: Sheet; add: (p: string, t: string, s?: Record<string, unknown>) => MindNode } {
  const model = new DocumentModel(DocumentModel.blank("m"));
  const sheet = model.sheet;
  sheet.nodes[sheet.rootNodeId].title = "Root";
  let seq = 0;
  const add = (parentId: string, title: string, style: Record<string, unknown> = {}): MindNode => {
    const id = `id${++seq}`;
    const n = {
      id, type: "subtopic", parentId, childrenIds: [], title,
      position: { x: 0, y: 0, manual: false },
      style: { fontSize: 14, padding: 9, shape: "rounded", ...style },
      collapsed: false, labels: [], markers: [], notes: "", task: null,
      metadata: { createdAt: "", updatedAt: "" },
    } as unknown as MindNode;
    sheet.nodes[id] = n;
    sheet.nodes[parentId].childrenIds.push(id);
    return n;
  };
  return { sheet, add };
}

/** A map with `n` children of the root, laid out for real. Tall and narrow. */
function mapOf(n: number): Sheet {
  const { sheet, add } = makeSheet();
  for (let i = 0; i < n; i++) add(sheet.rootNodeId, `t${i}`);
  applyLayout(sheet, false, HEURISTIC_MEASURER);
  return sheet;
}

/**
 * A map WIDE enough to force the fit-to-width scale below true size. Width
 * comes from depth, not from breadth: each level costs one level-spacing, so a
 * deep tree is what a narrow sheet has to shrink.
 */
function deepMap(depth: number): Sheet {
  const { sheet, add } = makeSheet();
  let seq = 0;
  const grow = (parentId: string, left: number): void => {
    if (left === 0) return;
    for (let i = 0; i < 2; i++) grow(add(parentId, `d${seq++}`).id, left - 1);
  };
  grow(sheet.rootNodeId, depth);
  applyLayout(sheet, false, HEURISTIC_MEASURER);
  return sheet;
}

const OPTS = {
  measurer: HEURISTIC_MEASURER,
  colorOf: () => ({ fill: "#ffffff", text: "#000000" }),
  linkColorOf: () => "#888888",
};

/** Every FlateDecode stream, decompressed. Image streams are DCT, not zlib. */
async function pageStreams(blob: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  const marker = "stream\n";
  let at = 0;
  for (;;) {
    const start = text.indexOf(marker, at);
    if (start < 0) break;
    const end = text.indexOf("\nendstream", start);
    if (end < 0) break;
    try {
      out.push(new TextDecoder("latin1").decode(unzlibSync(bytes.subarray(start + marker.length, end))));
    } catch {
      /* not zlib (an embedded JPEG): not a page */
    }
    // Past the whole token: "endstream" ENDS in "stream", so advancing by one
    // re-matches inside it and swallows the next object.
    at = end + "\nendstream".length;
  }
  return out;
}

/** Where a topic's title was placed on a sheet, in paper points. */
function placementsOf(stream: string, title: string): { x: number; y: number }[] {
  const lines = stream.split("\n");
  const out: { x: number; y: number }[] = [];
  let last: { x: number; y: number } | null = null;
  for (const line of lines) {
    const tm = /^1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm$/.exec(line);
    if (tm) last = { x: Number(tm[1]), y: Number(tm[2]) };
    else if (line === `(${title}) Tj` && last) out.push(last);
  }
  return out;
}

describe("paginated PDF", () => {
  it("never splits the map horizontally: the full width fits every sheet", async () => {
    for (const page of ["A4", "A1"] as const) {
      const out = await sheetToPdf(mapOf(150), { ...OPTS, page });
      const usableW = PAGE_SIZES[page].w - MARGIN * 2;
      const streams = await pageStreams(out.blob);
      // Every drawn x, across every sheet, inside the usable width.
      for (const stream of streams) {
        for (const m of stream.matchAll(/^1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm$/gm)) {
          expect(Number(m[1])).toBeGreaterThanOrEqual(MARGIN - 1);
          expect(Number(m[1])).toBeLessThanOrEqual(MARGIN + usableW + 1);
        }
      }
    }
  });

  it("puts a topic at the same paper x on every sheet it appears on", async () => {
    // The bug this replaces: pages had their own origin plus a bleed margin, so
    // the same topic landed at a different x depending on which sheet drew it.
    const out = await sheetToPdf(mapOf(150), { ...OPTS, page: "A4" });
    const streams = await pageStreams(out.blob);

    let checked = 0;
    for (let i = 0; i < 150; i++) {
      const hits = streams.flatMap((s) => placementsOf(s, `t${i}`));
      if (hits.length < 2) continue;
      const xs = new Set(hits.map((h) => h.x));
      expect(xs.size, `topic t${i} drawn at xs ${[...xs].join(", ")}`).toBe(1);
      checked++;
    }
    // The fixture has to actually contain straddling topics or this proves
    // nothing — a test that passes on an empty set is worse than no test.
    expect(checked, "no topic straddled a cut; fixture proves nothing").toBeGreaterThan(0);
  });

  it("cuts seamlessly: the two halves are exactly one page apart", async () => {
    // A topic across a boundary is drawn on both sheets. Sheet k+1 shows the
    // world one band lower, so the same topic's baseline must sit exactly one
    // usable-height further UP the page. Any other offset is a visible seam.
    const out = await sheetToPdf(mapOf(150), { ...OPTS, page: "A4" });
    const usableH = PAGE_SIZES.A4.h - MARGIN * 2;
    const streams = await pageStreams(out.blob);

    let checked = 0;
    for (let i = 0; i < 150; i++) {
      const perSheet = streams.map((s) => placementsOf(s, `t${i}`)).filter((hits) => hits.length > 0);
      if (perSheet.length < 2) continue;
      for (let k = 1; k < perSheet.length; k++) {
        expect(perSheet[k][0].y - perSheet[k - 1][0].y).toBeCloseTo(usableH, 1);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a bigger sheet buys a bigger scale, and bigger text", async () => {
    const sheet = deepMap(8);
    const a4 = await sheetToPdf(sheet, { ...OPTS, page: "A4" });
    const a1 = await sheetToPdf(sheet, { ...OPTS, page: "A1" });
    expect(a1.scale).toBeGreaterThan(a4.scale);
    expect(a1.report.units.minFontPt).toBeGreaterThan(a4.report.units.minFontPt as number);
    // Wider sheet, fewer sheets: the band covers more world.
    expect(a1.mapPages).toBeLessThanOrEqual(a4.mapPages);
  });

  it("never blows a narrow map up past true size", async () => {
    const out = await sheetToPdf(mapOf(3), { ...OPTS, page: "A0" });
    expect(out.scale).toBe(PT_PER_UNIT);
    expect(out.report.units.percentOfTrueSize).toBe(100);
  });

  it("every stream decompresses and draws something", async () => {
    const out = await sheetToPdf(mapOf(120), OPTS);
    expect(out.report.selfCheck?.ok, out.report.selfCheck?.detail).toBe(true);
    expect(out.report.selfCheck?.detail).toContain("sheets decompress");
  });

  it("draws every topic on at least one sheet", async () => {
    const out = await sheetToPdf(mapOf(120), { ...OPTS, page: "A4" });
    const all = (await pageStreams(out.blob)).join("\n");
    for (let i = 0; i < 120; i++) expect(all, `topic t${i} missing`).toContain(`(t${i}) Tj`);
  });

  it("declares one page object per sheet, at the requested size", async () => {
    const out = await sheetToPdf(mapOf(80), { ...OPTS, page: "A2" });
    const text = new TextDecoder("latin1").decode(new Uint8Array(await out.blob.arrayBuffer()));
    expect((text.match(/\/Type \/Page[^s]/g) ?? []).length).toBe(out.pages);
    expect(text).toContain(`/Count ${out.pages}`);
    expect(text).toContain(`/MediaBox [0 0 ${PAGE_SIZES.A2.w} ${PAGE_SIZES.A2.h}]`);
    expect(out.pages).toBe(out.mapPages); // no index sheet by default
  });

  it("adds an index sheet only when asked", async () => {
    const sheet = mapOf(80);
    const plain = await sheetToPdf(sheet, OPTS);
    const indexed = await sheetToPdf(sheet, { ...OPTS, index: true });
    expect(plain.pages).toBe(plain.mapPages);
    expect(indexed.pages).toBe(indexed.mapPages + 1);
    // The index is a silhouette: rectangles and page numbers, no titles.
    const first = (await pageStreams(indexed.blob))[0];
    expect(first).toContain("re f");
    expect(first).not.toContain("(t7) Tj");
  });

  it("survives an empty map instead of writing a broken file", async () => {
    const { sheet } = makeSheet();
    delete sheet.nodes[sheet.rootNodeId];
    const out = await sheetToPdf(sheet, OPTS);
    expect(out.pages).toBe(1);
    expect(out.nodes).toBe(0);
  });
});
