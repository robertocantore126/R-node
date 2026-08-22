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
import { sheetToPdf, PAGE_SIZES, PT_PER_UNIT, type PdfImageSource } from "../src/export/pdf";
import { HEURISTIC_MEASURER } from "../src/layout/measure";
import { applyLayout } from "../src/layout/mindmap";
import { DocumentModel } from "../src/core/doc";
import type { MindNode, Sheet, TextRun } from "../src/core/types";

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

/**
 * Rich text and pictures: what the export used to drop on the floor.
 *
 * Both were declared gaps rather than bugs, which is why they lasted — the
 * header said "run-level bold/italic is NOT approximated" and "JPEG only", and
 * a declared gap is invisible until someone opens the file. A real map is
 * mostly styled prose and pasted PNGs, so the two gaps together removed most
 * of what was on the page.
 */
describe("PDF rich text", () => {
  /** One topic whose title carries the given runs, laid out for real. */
  function richSheet(runs: TextRun[], style: Record<string, unknown> = {}): Sheet {
    const { sheet, add } = makeSheet();
    const n = add(sheet.rootNodeId, runs.map((r) => r.text).join(""), style);
    n.titleRuns = runs;
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    return sheet;
  }
  const streamsOf = async (sheet: Sheet): Promise<string> =>
    (await pageStreams((await sheetToPdf(sheet, { ...OPTS, page: "A1" })).blob)).join("\n");

  it("draws a bold run bold and an italic run italic", async () => {
    const text = await streamsOf(
      richSheet([
        { text: "plain " },
        { text: "heavy", bold: true },
        { text: " and " },
        { text: "slanted", italic: true },
        { text: " and " },
        { text: "both", bold: true, italic: true },
      ]),
    );
    // Every face is SELECTED, and each phrase is its own Tj: the version this
    // replaces concatenated the whole line into one string under /F1.
    expect(text).toMatch(/\/F2 [\d.]+ Tf/);
    expect(text).toMatch(/\/F3 [\d.]+ Tf/);
    expect(text).toMatch(/\/F4 [\d.]+ Tf/);
    expect(text).toContain("(heavy) Tj");
    expect(text).toContain("(slanted) Tj");
    expect(text).toContain("(both) Tj");
  });

  it("carries a run's own colour, not just the topic's", async () => {
    const text = await streamsOf(richSheet([{ text: "black " }, { text: "blue", color: "#3366cc" }]));
    // #3366cc is 0.2 0.4 0.8, and it must be set immediately before the phrase.
    expect(text).toMatch(/0\.200 0\.400 0\.800 rg\n1 0 0 1 [-\d.]+ [-\d.]+ Tm\n\(blue\) Tj/);
  });

  it("rules an underlined run for exactly its own width", async () => {
    const text = await streamsOf(
      richSheet([{ text: "off " }, { text: "under", underline: true }, { text: " off" }]),
    );
    // The topic's own box is a rounded rectangle (`c f`), so a `re f` here is
    // a rule and nothing else.
    const rules = [...text.matchAll(/^([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+) re f$/gm)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[3]),
    }));
    expect(rules.length).toBe(1);
    const word = /1 0 0 1 ([-\d.]+) [-\d.]+ Tm\n\(under\) Tj/.exec(text);
    expect(word).not.toBeNull();
    // Same left edge as the word it belongs to, and only as wide as that word.
    expect(rules[0].x).toBeCloseTo(Number(word![1]), 1);
    expect(rules[0].w).toBeGreaterThan(0);
    expect(rules[0].w).toBeLessThan(5 * 0.55 * 14);
  });

  it("draws the marker of a list item", async () => {
    const text = await streamsOf(richSheet([{ text: "first item", listIndent: 1 }]));
    // WinAnsi 0x95 is the bullet. It was never emitted at all before, so a
    // list arrived as paragraphs indented for no visible reason.
    expect(text).toContain("(" + String.fromCharCode(0x95) + ") Tj");
  });

  it("declares its own advance widths, so a style change lands where the layout put it", async () => {
    const out = await sheetToPdf(richSheet([{ text: "aaaa " }, { text: "bbbb", bold: true }]), {
      ...OPTS,
      page: "A1",
    });
    const file = new TextDecoder("latin1").decode(new Uint8Array(await out.blob.arrayBuffer()));
    // Four faces, each with a Widths array and a descriptor to hang it on.
    expect((file.match(/\/Widths \[/g) ?? []).length).toBe(4);
    expect((file.match(/\/FontDescriptor \d+ 0 R/g) ?? []).length).toBe(4);
    expect(file).toContain("/FirstChar 32");
    expect(file).toContain("/LastChar 255");

    // The second phrase starts exactly one first-phrase-width along. This is
    // the property that removes the gap before every bold word: without a
    // declared Widths the viewer advances by Helvetica's metrics while this x
    // came from the measurer's, and the two disagree by a few percent.
    const text = (await pageStreams(out.blob)).join("\n");
    const a = /1 0 0 1 ([-\d.]+) [-\d.]+ Tm\n\(aaaa \) Tj/.exec(text);
    const b = /1 0 0 1 ([-\d.]+) [-\d.]+ Tm\n\(bbbb\) Tj/.exec(text);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // HEURISTIC_MEASURER makes every glyph 0.55em, so five of them at 14px is
    // 38.5 world units, scaled onto the paper.
    expect(Number(b![1]) - Number(a![1])).toBeCloseTo(5 * 0.55 * 14 * out.scale, 1);
  });

  it("spells a character WinAnsi has, and counts the ones it does not", async () => {
    const out = await sheetToPdf(richSheet([{ text: "a—b śūnyatā 中" }]), {
      ...OPTS,
      page: "A1",
    });
    const text = (await pageStreams(out.blob)).join("\n");
    // The em dash is WinAnsi 0x97. It used to be "?", mid-word, which reads as
    // corruption rather than as a font limit.
    expect(text).toContain(String.fromCharCode(0x97));
    // Diacritics are stripped rather than the letter being lost.
    expect(text).toContain("sunyata");
    // What is genuinely unrepresentable is counted, not swallowed.
    expect(out.report.units.unmappableChars).toBe(1);
  });
});

describe("PDF images", () => {
  /** A topic showing one asset, plus the attachment card the measurer needs. */
  function imageSheet(): Sheet {
    const { sheet, add } = makeSheet();
    add(sheet.rootNodeId, "shown", { image: "asset1" });
    sheet.attachments = [
      { id: "asset1", w: 4, h: 2, mime: "image/png", name: "a", bytes: 0 },
    ] as unknown as Sheet["attachments"];
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    return sheet;
  }
  const fileOf = async (out: { blob: Blob }): Promise<string> =>
    new TextDecoder("latin1").decode(new Uint8Array(await out.blob.arrayBuffer()));

  it("embeds a JPEG untouched", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const src: PdfImageSource = { w: 4, h: 2, jpeg };
    const out = await sheetToPdf(imageSheet(), { ...OPTS, imageBytes: async () => src });
    const file = await fileOf(out);
    expect(file).toContain("/Filter /DCTDecode");
    expect(file).toContain("/Width 4 /Height 2");
  });

  it("deflates a decoded image instead of reporting it missing", async () => {
    // The whole of the old behaviour: anything but a JPEG was dropped, and a
    // pasted screenshot is a PNG.
    const out = await sheetToPdf(imageSheet(), {
      ...OPTS,
      imageBytes: async () => ({ w: 4, h: 2, rgb: new Uint8Array(4 * 2 * 3).fill(200) }),
    });
    expect(out.images).toBe(1);
    expect(out.report.units.imagesMissing).toBe(0);
    expect(out.report.units.imagesDeflated).toBe(1);
    expect(await fileOf(out)).toMatch(/\/Subtype \/Image[^>]*\/Filter \/FlateDecode/);
  });

  it("carries transparency as an SMask", async () => {
    const out = await sheetToPdf(imageSheet(), {
      ...OPTS,
      imageBytes: async () => ({
        w: 4,
        h: 2,
        rgb: new Uint8Array(4 * 2 * 3).fill(200),
        alpha: new Uint8Array(4 * 2).fill(128),
      }),
    });
    expect(out.report.units.imagesMasked).toBe(1);
    const file = await fileOf(out);
    expect(file).toMatch(/\/SMask \d+ 0 R/);
    expect(file).toContain("/ColorSpace /DeviceGray");
  });

  it("still reports an asset whose bytes it cannot get", async () => {
    const out = await sheetToPdf(imageSheet(), { ...OPTS, imageBytes: async () => null });
    expect(out.images).toBe(0);
    expect(out.report.units.imagesMissing).toBe(1);
  });
});
