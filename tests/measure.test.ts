import { describe, expect, it } from "vitest";
import { measureNode, MIN_TOPIC_W, wrapRunLines, HEURISTIC_MEASURER } from "../src/layout/measure";
import { DocumentModel } from "../src/core/doc";
import type { MindNode, TextRun } from "../src/core/types";

function lineHeights(runs: TextRun[], maxW = 200): number[] {
  return wrapRunLines(runs, maxW, HEURISTIC_MEASURER, { fontSize: 14 }).map((l) => l.height ?? 14 * 1.25);
}

function node(overrides: Partial<MindNode>): MindNode {
  const model = new DocumentModel(DocumentModel.blank("m"));
  const root = model.rootNode;
  return { ...root, ...overrides, style: { fontSize: 14, ...(overrides.style ?? {}) } };
}

describe("topic extent (observable model)", () => {
  it("short single-line title → minimum width, one line of height", () => {
    const e = measureNode(node({ title: "Hi" }));
    expect(e.w).toBe(MIN_TOPIC_W);
    expect(e.h).toBeCloseTo(14 * 1.25 + 10 * 2 + 4, 5); // line + padding + frame
  });

  it("a long title wraps and the topic grows taller", () => {
    const short = measureNode(node({ title: "Short" }));
    const long = measureNode(node({ title: "word word word word word word word word word word word word word" }));
    expect(long.h).toBeGreaterThan(short.h);
    // 13 words ≈ 64 chars ≈ 8 wrapped lines at heuristic 7.7px/char → clearly > 1 line
    expect(long.h).toBeGreaterThan(short.h + 14);
  });

  it("explicit newlines force line breaks", () => {
    const e = measureNode(node({ title: "Line one\nLine two" }));
    expect(e.h).toBeCloseTo(2 * 14 * 1.25 + 10 * 2 + 4, 5);
  });

  it("larger padding grows the vertical extent (and wraps text harder)", () => {
    const a = measureNode(node({ title: "Padding padding padding padding", style: { padding: 10 } }));
    const b = measureNode(node({ title: "Padding padding padding padding", style: { padding: 24 } }));
    // less text room → more lines → taller box (narrower is expected and fine)
    expect(b.h).toBeGreaterThan(a.h);
    expect(b.w * b.h).toBeGreaterThan(a.w * a.h);
  });

  it("circle is square; diamond and hexagon grow the box", () => {
    const c = measureNode(node({ title: "O", style: { shape: "circle", fontSize: 14 } }));
    expect(c.w).toBe(c.h);

    const base = measureNode(node({ title: "T", style: { shape: "rounded" } }));
    const d = measureNode(node({ title: "T", style: { shape: "diamond" } }));
    expect(d.w).toBe(base.w + 14);
    expect(d.h).toBe(base.h + 14);

    const hx = measureNode(node({ title: "T", style: { shape: "hexagon" } }));
    expect(hx.w).toBe(base.w + 14);
    expect(hx.h).toBe(base.h + 10);
  });

  it("explicit width/height override wins", () => {
    const e = measureNode(node({ title: "A very long title that would wrap", style: { width: 400, height: 90 } }));
    expect(e).toEqual({ w: 400, h: 90 });
  });

  it("font size scales the extent", () => {
    const s = measureNode(node({ title: "Scale", style: { fontSize: 12 } }));
    const l = measureNode(node({ title: "Scale", style: { fontSize: 28 } }));
    expect(l.w).toBeGreaterThan(s.w);
    expect(l.h).toBeGreaterThan(s.h);
  });

  it("measurer is pluggable (deterministic in tests)", () => {
    const title = "iiiiiiiiiiiiiiiiiiii"; // long enough to escape the min-width floor
    const wide = measureNode(node({ title }), { measure: (t, s) => ({ width: t.length * s.fontSize * 1.0 }) });
    const narrow = measureNode(node({ title }), { measure: (t, s) => ({ width: t.length * s.fontSize * 0.2 }) });
    expect(wide.w).toBeGreaterThan(narrow.w);
  });

  it("a paraGap run adds extra vertical height (paragraph spacing)", () => {
    // same two lines of text: with and without the paragraph gap
    const plain = measureNode(node({ title: "Line one\nLine two" }));
    const spaced = measureNode(node({ title: "Line one\nLine two", titleRuns: [{ text: "Line one" }, { text: "\n" }, { text: "Line two", paraGap: true }] }));
    expect(spaced.h).toBeGreaterThan(plain.h);
  });

  it("a heading-size run makes its line taller", () => {
    const sizes = lineHeights([{ text: "Body" }, { text: "Heading", fontSize: 26 }]);
    // both runs share one line; the tallest run sets the line height
    expect(sizes[0]).toBeCloseTo(26 * 1.25, 5);
  });

  it("list items get a bullet glyph on the first line and hanging indent after", () => {
    const lines = wrapRunLines(
      [{ text: "A fairly long list item that will wrap onto multiple lines because the budget is small", listIndent: 1 }],
      80,
      HEURISTIC_MEASURER,
      { fontSize: 14 }
    );
    expect(lines.length).toBeGreaterThan(1);
    const first = lines[0];
    // glyph is part of the first line's segments
    expect(first.segments[0].text).toContain("•");
    // continuation lines hang-indent under the bullet
    for (const line of lines.slice(1)) {
      expect((line.indent ?? 0)).toBeGreaterThan(0);
    }
  });
});
