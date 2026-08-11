import { describe, expect, it } from "vitest";
import { BULLET_WIDTH_EM, measureNode, MIN_TOPIC_W, wrapRunLines, HEURISTIC_MEASURER } from "../src/layout/measure";
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

  it("a fixed width re-wraps the text and the height follows (Xmind resize)", () => {
    const title = "word word word word word word word word word word";
    const narrow = measureNode(node({ title, style: { width: 120 } }));
    const wide = measureNode(node({ title, style: { width: 400 } }));
    expect(narrow.w).toBe(120);
    expect(wide.w).toBe(400);
    // fewer chars fit per line at 120px → more lines → taller box
    expect(narrow.h).toBeGreaterThan(wide.h);
    // clearing the width returns to auto-fit (capped at MAX_TOPIC_W)
    const auto = measureNode(node({ title }));
    expect(auto.w).toBeLessThanOrEqual(280);
  });

  it("explicit widths below the minimum are clamped up", () => {
    const e = measureNode(node({ title: "T", style: { width: 40 } }));
    expect(e.w).toBe(MIN_TOPIC_W);
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

  it("list items carry a bullet on the first line and indent the text column on every line", () => {
    const lines = wrapRunLines(
      [{ text: "A fairly long list item that will wrap onto multiple lines because the budget is small", listIndent: 1 }],
      80,
      HEURISTIC_MEASURER,
      { fontSize: 14 }
    );
    expect(lines.length).toBeGreaterThan(1);
    // The marker is metadata, not a text segment: it lives in its own column
    // of known width (BULLET_WIDTH_EM) so the overlay's CSS can reproduce it.
    const bulletW = BULLET_WIDTH_EM * 14;
    expect(lines[0].bullet?.char).toBe("•");
    expect(lines[0].bullet?.x).toBeCloseTo(0, 5);
    // the text column is indented on EVERY line — first line included, which
    // is what makes a wrapped item hang under its own text in both renderers
    for (const line of lines) {
      expect(line.indent).toBeCloseTo(bulletW, 5);
    }
    // and only the first line gets the marker
    for (const line of lines.slice(1)) expect(line.bullet).toBeUndefined();
  });

  it("nested list items sit one bullet column deeper", () => {
    const lines = wrapRunLines([{ text: "deep", listIndent: 2 }], 200, HEURISTIC_MEASURER, { fontSize: 14 });
    const bulletW = BULLET_WIDTH_EM * 14;
    expect(lines[0].indent).toBeCloseTo(bulletW * 2, 5);
    expect(lines[0].bullet?.x).toBeCloseTo(bulletW, 5);
    expect(lines[0].bullet?.char).toBe("◦");
  });

  it("a paraGap run starts a new block even without a newline", () => {
    // editorStateToRuns marks a root-child boundary with paraGap alone; the
    // canvas used to run the two paragraphs together on a single line.
    const lines = wrapRunLines(
      [{ text: "first" }, { text: "second", paraGap: true }],
      400,
      HEURISTIC_MEASURER,
      { fontSize: 14 }
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].gapPx).toBeCloseTo(14 * 1.25 * 0.6, 5);
  });

  it("the block gap comes from the strut, not from the following line's height", () => {
    // margin-top: calc(0.6 * 1.25em) resolves against the BLOCK's font size,
    // and a heading's size lives on an inner span — so a heading block's gap
    // is the same as any other block's.
    const lines = wrapRunLines(
      [{ text: "body" }, { text: "Heading", fontSize: 26, paraGap: true }],
      400,
      HEURISTIC_MEASURER,
      { fontSize: 14 }
    );
    expect(lines[1].gapPx).toBeCloseTo(14 * 1.25 * 0.6, 5);
  });

  it("a blank line between paragraphs survives, a trailing one does not", () => {
    const withBlank = wrapRunLines([{ text: "a" }, { text: "\n" }, { text: "\n" }, { text: "b" }], 400, HEURISTIC_MEASURER, { fontSize: 14 });
    expect(withBlank).toHaveLength(3);
    expect(withBlank[1].segments).toHaveLength(0);
    // the newline that merely closes the last block is not a blank line
    const trailing = wrapRunLines([{ text: "a" }, { text: "\n" }], 400, HEURISTIC_MEASURER, { fontSize: 14 });
    expect(trailing).toHaveLength(1);
  });

  it("a token wider than the column breaks mid-word instead of overflowing", () => {
    const lines = wrapRunLines(
      [{ text: "https://example.com/a/very/long/path/that/cannot/fit" }],
      80,
      HEURISTIC_MEASURER,
      { fontSize: 14 }
    );
    expect(lines.length).toBeGreaterThan(1);
    // nothing may stick out of the column: the canvas bitmap is exactly maxW
    // wide, so an unbroken token used to be silently clipped
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(80 + 0.001);
  });

  it("trailing whitespace does not count towards the line width", () => {
    // CSS hangs it past the line end; counting it pushed centered lines half a
    // space off and made the measured box wider than the text.
    const [line] = wrapRunLines([{ text: "word   " }], 400, HEURISTIC_MEASURER, { fontSize: 14 });
    expect(line.width).toBeCloseTo(HEURISTIC_MEASURER.measure("word", { fontSize: 14 }).width, 5);
  });
});
