import { describe, expect, it } from "vitest";
import { sheetToSvg } from "../src/export/svg";
import { bezierEnterRect, bezierPoint, HEURISTIC_MEASURER, imageResolver, measureNode, positionedImageSlots, type Bezier3 } from "../src/layout/measure";
import { applyLayout } from "../src/layout/mindmap";
import { DocumentModel } from "../src/core/doc";
import type { MindNode, Sheet, TextRun } from "../src/core/types";

function makeSheet(): { sheet: Sheet; add: (parentId: string, title: string, runs?: TextRun[], style?: Record<string, unknown>) => MindNode } {
  const model = new DocumentModel(DocumentModel.blank("m"));
  const sheet = model.sheet;
  sheet.nodes[sheet.rootNodeId].title = "Root";
  let seq = 0;
  const add = (parentId: string, title: string, runs?: TextRun[], style: Record<string, unknown> = {}): MindNode => {
    const id = `n${++seq}`;
    const n = {
      id,
      type: "subtopic",
      parentId,
      childrenIds: [],
      title,
      titleRuns: runs,
      position: { x: 0, y: 0, manual: false },
      style: { fontSize: 14, padding: 9, shape: "rounded", ...style },
      collapsed: false,
      labels: [],
      markers: [],
      notes: "",
      task: null,
      metadata: { createdAt: "", updatedAt: "" },
    } as unknown as MindNode;
    sheet.nodes[id] = n;
    sheet.nodes[parentId].childrenIds.push(id);
    return n;
  };
  return { sheet, add };
}

const OPTS = {
  measurer: HEURISTIC_MEASURER,
  colorOf: () => ({ fill: "#ffffff", text: "#000000" }),
  linkColorOf: () => "#888888",
  background: "#ffffff" as string | null,
};

describe("SVG export", () => {
  it("covers every node in the viewBox", async () => {
    const { sheet, add } = makeSheet();
    for (let i = 0; i < 8; i++) add(sheet.rootNodeId, `Topic ${i}`);
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, OPTS);

    expect(out.nodes).toBe(9);
    const vb = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(out.svg);
    expect(vb).not.toBeNull();
    const [minX, minY, w, h] = vb!.slice(1).map(Number);
    for (const n of Object.values(sheet.nodes)) {
      expect(n.position.x).toBeGreaterThanOrEqual(minX);
      expect(n.position.y).toBeGreaterThanOrEqual(minY);
      expect(n.position.x).toBeLessThanOrEqual(minX + w);
      expect(n.position.y).toBeLessThanOrEqual(minY + h);
    }
  });

  it("emits ONE <text> per line, not one per word", async () => {
    // wrapRunLines returns a segment per token, spaces included. Emitting an
    // element per token means placing each word at an advance WE measured,
    // baking our font metrics into a file rendered by someone else's font
    // engine: the gaps between words then drift, cumulatively, along the line.
    // One <text> per line hands intra-line spacing back to the renderer.
    const { sheet, add } = makeSheet();
    add(sheet.rootNodeId, "quattro parole in fila", [{ text: "quattro parole in fila" }], { width: 400 });
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, OPTS);

    const texts = out.svg.match(/<text[^>]*>.*?<\/text>/g) ?? [];
    const withWords = texts.filter((t) => t.includes("quattro"));
    expect(withWords).toHaveLength(1);
    expect(withWords[0]).toContain("quattro parole in fila");
    // Spaces are their own segments: SVG collapses them without this.
    expect(withWords[0]).toContain('xml:space="preserve"');
  });

  it("splits a line into tspans only where the style changes", async () => {
    const { sheet, add } = makeSheet();
    add(sheet.rootNodeId, "aaa bbb ccc", [
      { text: "aaa " },
      { text: "bbb ", bold: true },
      { text: "ccc" },
    ], { width: 400 });
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, OPTS);

    const line = (out.svg.match(/<text[^>]*>.*?<\/text>/g) ?? []).find((t) => t.includes("aaa"))!;
    expect((line.match(/<tspan/g) ?? [])).toHaveLength(3);
    expect(line).toContain('font-weight="700"');
  });

  it("escapes markup in titles instead of emitting it", async () => {
    const { sheet, add } = makeSheet();
    add(sheet.rootNodeId, 'a<b>&"c"', [{ text: 'a<b>&"c"' }], { width: 400 });
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, OPTS);
    expect(out.svg).toContain("a&lt;b&gt;&amp;");
    expect(out.svg).not.toContain("<b>");
  });

  it("embeds image bytes, and marks the ones it cannot read", async () => {
    const { sheet, add } = makeSheet();
    sheet.attachments.push({ id: "ok", mime: "image/png", w: 400, h: 300, bytes: 10 });
    sheet.attachments.push({ id: "gone", mime: "image/png", w: 400, h: 300, bytes: 10 });
    add(sheet.rootNodeId, "con", [{ text: "con" }], { image: "ok", imageWidth: 120 });
    add(sheet.rootNodeId, "senza", [{ text: "senza" }], { image: "gone", imageWidth: 120 });
    applyLayout(sheet, false, HEURISTIC_MEASURER);

    const out = await sheetToSvg(sheet, {
      ...OPTS,
      imageDataUri: async (id) => (id === "ok" ? "data:image/png;base64,AAAA" : null),
    });

    expect(out.images).toBe(1);
    // Unreadable images are reported, never dropped in silence: the layout has
    // already reserved their space, so a missing one leaves a visible hole.
    expect(out.imagesMissing).toBe(1);
    expect(out.svg).toContain("data:image/png;base64,AAAA");
    expect(out.svg).toContain("stroke-dasharray");
  });

  it("fetches each asset once however many nodes share it", async () => {
    const { sheet, add } = makeSheet();
    sheet.attachments.push({ id: "shared", mime: "image/png", w: 100, h: 100, bytes: 10 });
    for (let i = 0; i < 5; i++) add(sheet.rootNodeId, `n${i}`, [{ text: `n${i}` }], { image: "shared" });
    applyLayout(sheet, false, HEURISTIC_MEASURER);

    let calls = 0;
    const out = await sheetToSvg(sheet, {
      ...OPTS,
      imageDataUri: async () => {
        calls++;
        return "data:image/png;base64,AAAA";
      },
    });
    expect(calls).toBe(1);
    expect(out.images).toBe(5);
  });

  it("emits every image slot, placed by the shared slot geometry (I9)", async () => {
    const { sheet, add } = makeSheet();
    sheet.attachments.push({ id: "side", mime: "image/png", w: 200, h: 100, bytes: 10 });
    const n = add(sheet.rootNodeId, "box", [{ text: "box" }], {
      imageBottom: "side",
      imageLeft: "side",
      imageRight: "side",
    });
    applyLayout(sheet, false, HEURISTIC_MEASURER);

    const out = await sheetToSvg(sheet, {
      ...OPTS,
      imageDataUri: async () => "data:image/png;base64,AAAA",
    });

    // One distinct attachment, three slots drawn.
    expect(out.images).toBe(3);
    expect(out.svg.match(/<image /g)).toHaveLength(3);
    // Coverage counts distinct assets as present and drawn slots as emitted.
    expect(out.report.coverage.images).toEqual({ present: 1, emitted: 3 });

    // Each <image> sits exactly where positionedImageSlots puts the slot —
    // the same call the canvas renderer uses, so the two exports can't
    // diverge.
    const m = measureNode(n, HEURISTIC_MEASURER, imageResolver(sheet));
    const pos = positionedImageSlots({ x: n.position.x, y: n.position.y, w: m.w, h: m.h }, n, imageResolver(sheet));
    for (const it of pos.items) {
      const num = (v: number): string => String(Math.round(v * 1000) / 1000);
      expect(out.svg).toContain(`<image x="${num(it.x)}" y="${num(it.y)}" width="${num(it.size.w)}" height="${num(it.size.h)}"`);
    }
  });

  it("emits relationships with an arrowhead that stops at the target's border, not its centre", async () => {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "From");
    const b = add(sheet.rootNodeId, "To");
    sheet.relationships.push({ id: "r1", fromId: a.id, toId: b.id });
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, { ...OPTS, relColorOf: () => "#ff0000" });

    expect(out.report.coverage.relationships).toEqual({ present: 1, emitted: 1 });
    // Connectors are paths only; the arrowhead is the one polygon.
    expect(out.svg.match(/<polygon/g)).toHaveLength(1);

    // The tip is the EXACT point where the curve crosses the target box.
    const am = measureNode(a, HEURISTIC_MEASURER);
    const bm = measureNode(b, HEURISTIC_MEASURER);
    const ax = a.position.x + am.w / 2;
    const ay = a.position.y + am.h / 2;
    const bx = b.position.x + bm.w / 2;
    const by = b.position.y + bm.h / 2;
    const curve: Bezier3 = {
      p0: { x: ax, y: ay },
      p1: { x: ax + (bx - ax) * 0.35, y: ay },
      p2: { x: bx - (bx - ax) * 0.35, y: by },
      p3: { x: bx, y: by },
    };
    const t1 = bezierEnterRect(curve, b.position.x, b.position.y, bm.w, bm.h);
    const tip = bezierPoint(curve, t1);
    const m = /<polygon points="([-\d.]+),([-\d.]+)/.exec(out.svg);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(tip.x, 2);
    expect(Number(m![2])).toBeCloseTo(tip.y, 2);

    // The line is truncated at the same point — the curve would otherwise
    // run on under the head toward the centre. The tip coordinates appear
    // again as the end of the relationship path's `d` attribute (the path
    // carries more attributes after it, so the `d` ends with a bare quote).
    const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);
    const tipPair = `${fmt(tip.x)},${fmt(tip.y)}`;
    expect(out.svg.includes(` ${tipPair}"`)).toBe(true);
  });

  it("a bidirectional relationship gets an arrowhead on both ends", async () => {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "From");
    const b = add(sheet.rootNodeId, "To");
    sheet.relationships.push({ id: "r1", fromId: a.id, toId: b.id, bidirectional: true });
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, { ...OPTS, relColorOf: () => "#ff0000" });
    expect(out.svg.match(/<polygon/g)).toHaveLength(2);
  });

  it("leaves collapsed subtrees out, as the map does", async () => {
    const { sheet, add } = makeSheet();
    const parent = add(sheet.rootNodeId, "parent");
    add(parent.id, "hidden child");
    parent.collapsed = true;
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, OPTS);
    expect(out.nodes).toBe(2); // root + parent
    expect(out.svg).not.toContain("hidden child");
  });
});
