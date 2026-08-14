import { describe, expect, it } from "vitest";
import { ARROW_HALF_ANGLE, ARROW_LEN, BULLET_WIDTH_EM, IMAGE_GAP, imageResolver, MAX_IMAGE_W, measureNode, MIN_TOPIC_W, textInsets, wrapRunLines, bezierEnterRect, bezierExitRect, bezierPoint, bezierSlice, HEURISTIC_MEASURER, type Bezier3 } from "../src/layout/measure";
import { DocumentModel } from "../src/core/doc";
import { DEFAULT_STRUCTURE, type MindNode, type Sheet, type TextRun } from "../src/core/types";

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

describe("topic extent with an image (T12-1)", () => {
  const resolve = () => ({ w: 200, h: 100 });

  it("image 200x100 + one text line: imgH + IMAGE_GAP + lineH + pad*2 + 4", () => {
    const e = measureNode(node({ title: "Hi", style: { image: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.w).toBe(Math.max(MIN_TOPIC_W, 200 + 10 * 2)); // image wider than text
    expect(e.h).toBeCloseTo(100 + IMAGE_GAP + 14 * 1.25 + 10 * 2 + 4, 5);
  });

  it("image-only node: no IMAGE_GAP, no empty text line", () => {
    const e = measureNode(node({ title: "", style: { image: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.h).toBeCloseTo(100 + 10 * 2 + 4, 5);
  });

  it("explicit imageWidth changes width and height proportionally", () => {
    const e = measureNode(
      node({ title: "", style: { image: "img1", imageWidth: 120 } }),
      HEURISTIC_MEASURER,
      resolve
    );
    expect(e.w).toBe(120 + 10 * 2);
    expect(e.h).toBeCloseTo(120 * (100 / 200) + 10 * 2 + 4, 5); // imgH = 60
  });

  it("an image larger than MAX_IMAGE_W is capped at it (proportions kept)", () => {
    const e = measureNode(
      node({ title: "", style: { image: "big" } }),
      HEURISTIC_MEASURER,
      () => ({ w: 2000, h: 1000 })
    );
    expect(e.w).toBe(MAX_IMAGE_W + 10 * 2);
    expect(e.h).toBeCloseTo((MAX_IMAGE_W * 1000) / 2000 + 10 * 2 + 4, 5);
  });

  it("without a resolver (or unresolvable id) the node measures as text-only", () => {
    const withImg = node({ title: "Hi", style: { image: "img1" } });
    const plain = node({ title: "Hi" });
    expect(measureNode(withImg)).toEqual(measureNode(plain));
    expect(measureNode(withImg, HEURISTIC_MEASURER, () => null)).toEqual(measureNode(plain));
  });

  it("imageResolver reads the sheet's attachment cards", () => {
    const sheet: Sheet = {
      sheetId: "s1",
      title: "T",
      structure: DEFAULT_STRUCTURE,
      rootNodeId: "r",
      nodes: {},
      relationships: [],
      boundaries: [],
      summaries: [],
      callouts: [],
      labels: [],
      zones: [],
      attachments: [{ id: "a1", mime: "image/png", w: 200, h: 100, bytes: 10 }],
      comments: [],
      presentation: {},
    };
    const resolveImg = imageResolver(sheet);
    expect(resolveImg("a1")).toEqual({ w: 200, h: 100 });
    expect(resolveImg("missing")).toBeNull();
  });
});

describe("relationship curve geometry (bezier truncation)", () => {
  // The real relationship shape: controls at 0.35 of the span, y monotonic.
  const CURVE: Bezier3 = { p0: { x: 0, y: 0 }, p1: { x: 35, y: 0 }, p2: { x: 65, y: 50 }, p3: { x: 100, y: 50 } };

  it("bezierPoint evaluates the curve at the endpoints and the middle", () => {
    expect(bezierPoint(CURVE, 0)).toEqual({ x: 0, y: 0 });
    expect(bezierPoint(CURVE, 1)).toEqual({ x: 100, y: 50 });
    const mid = bezierPoint(CURVE, 0.5);
    // x is linear (controls collinear in x): 50; y = 50 * 0.5^2 * 2 = 25.
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(25);
  });

  it("bezierSlice keeps the endpoints and the exact end tangent", () => {
    const s = bezierSlice(CURVE, 0.5, 0.8);
    expect(s.p0.x).toBeCloseTo(bezierPoint(CURVE, 0.5).x, 9);
    expect(s.p0.y).toBeCloseTo(bezierPoint(CURVE, 0.5).y, 9);
    expect(s.p3.x).toBeCloseTo(bezierPoint(CURVE, 0.8).x, 9);
    expect(s.p3.y).toBeCloseTo(bezierPoint(CURVE, 0.8).y, 9);
    // The slice's end segment direction is the curve's tangent at t=0.8: for
    // this shape it points up-right — never along the chord to the centre.
    const tangent = { x: s.p3.x - s.p2.x, y: s.p3.y - s.p2.y };
    expect(tangent.y).toBeGreaterThan(0);
    expect(tangent.x).toBeGreaterThan(0);
  });

  it("bezierEnterRect / bezierExitRect find the exact border crossings", () => {
    // The target box x 90..110, y 40..60. The crossing sits on its left
    // border, and the point flips from outside to inside exactly there.
    const t1 = bezierEnterRect(CURVE, 90, 40, 20, 20);
    const p1 = bezierPoint(CURVE, t1);
    expect(p1.x).toBeCloseTo(90, 6);
    expect(p1.y).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(p1.y).toBeLessThanOrEqual(60 + 1e-6);
    expect(bezierPoint(CURVE, t1 - 1e-5).x).toBeLessThan(90);
    expect(bezierPoint(CURVE, t1 + 1e-5).x).toBeGreaterThanOrEqual(90);
    // The source box x -10..10, y -10..10: leaves on its right border.
    const t0 = bezierExitRect(CURVE, -10, -10, 20, 20);
    const p0 = bezierPoint(CURVE, t0);
    expect(p0.x).toBeCloseTo(10, 6);
    expect(p0.y).toBeGreaterThanOrEqual(-10 - 1e-6);
    expect(p0.y).toBeLessThanOrEqual(10 + 1e-6);
  });

  it("a box that already contains the whole curve clamps instead of looping", () => {
    expect(bezierEnterRect(CURVE, -50, -50, 300, 300)).toBe(0);
    expect(bezierExitRect(CURVE, -50, -50, 300, 300)).toBe(1);
  });

  it("the shared arrowhead constants are positive and sane", () => {
    expect(ARROW_LEN).toBeGreaterThan(0);
    expect(ARROW_HALF_ANGLE).toBeGreaterThan(0);
    expect(ARROW_HALF_ANGLE).toBeLessThan(Math.PI / 2);
  });
});

describe("topic extent with side images (multi-slot)", () => {
  const resolve = () => ({ w: 200, h: 100 });
  const plain = () => measureNode(node({ title: "Hi" }), HEURISTIC_MEASURER, resolve);

  it("a left image widens the box by imgW + IMAGE_GAP, beside the text, and the box height fits max(text, image)", () => {
    const e = measureNode(node({ title: "Hi", style: { imageLeft: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.w - plain().w).toBe(200 + IMAGE_GAP);
    // Side column, not a stack: the height is max(textH, imgH), less than
    // the same image above the text would need.
    expect(e.h).toBeCloseTo(Math.max(14 * 1.25, 100) + 10 * 2 + 4, 5);
  });

  it("a right image mirrors the left one", () => {
    const e = measureNode(node({ title: "Hi", style: { imageRight: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.w - plain().w).toBe(200 + IMAGE_GAP);
  });

  it("left + right images reserve both side columns", () => {
    const e = measureNode(node({ title: "Hi", style: { imageLeft: "img1", imageRight: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.w - plain().w).toBe((200 + IMAGE_GAP) * 2);
  });

  it("a bottom image adds its height + IMAGE_GAP below the text", () => {
    const e = measureNode(node({ title: "Hi", style: { imageBottom: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.h - plain().h).toBeCloseTo(100 + IMAGE_GAP, 5);
  });

  it("top + bottom images stack in the middle column, each separated by IMAGE_GAP", () => {
    const e = measureNode(node({ title: "Hi", style: { image: "img1", imageBottom: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(e.h).toBeCloseTo(100 + IMAGE_GAP + 14 * 1.25 + IMAGE_GAP + 100 + 10 * 2 + 4, 5);
  });

  it("the extent cache distinguishes the slots: same id, different slot, different box", () => {
    const top = measureNode(node({ title: "Hi", style: { image: "img1" } }), HEURISTIC_MEASURER, resolve);
    const left = measureNode(node({ title: "Hi", style: { imageLeft: "img1" } }), HEURISTIC_MEASURER, resolve);
    expect(top.w).not.toBe(left.w);
  });
});

describe("textInsets — what an image slot reserves next to the text", () => {
  const none = { top: null, bottom: null, left: null, right: null };

  it("reserves nothing at all for an empty slot", () => {
    // The bug this pins: the editing overlay added IMAGE_GAP on all four sides
    // unconditionally. On a topic with only a top image that stole 2 x
    // IMAGE_GAP of text width the canvas never gave up, so the paragraph
    // re-wrapped the moment the node was double-clicked.
    expect(textInsets(none)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("reserves the image plus ONE gap on the side that holds it, and zero elsewhere", () => {
    expect(textInsets({ ...none, top: { w: 160, h: 90 } })).toEqual({ top: 90 + IMAGE_GAP, bottom: 0, left: 0, right: 0 });
    expect(textInsets({ ...none, left: { w: 64, h: 48 } })).toEqual({ top: 0, bottom: 0, left: 64 + IMAGE_GAP, right: 0 });
  });

  it("uses height for top/bottom and width for left/right", () => {
    const all = textInsets({
      top: { w: 100, h: 60 },
      bottom: { w: 100, h: 30 },
      left: { w: 40, h: 200 },
      right: { w: 20, h: 200 },
    });
    expect(all).toEqual({ top: 60 + IMAGE_GAP, bottom: 30 + IMAGE_GAP, left: 40 + IMAGE_GAP, right: 20 + IMAGE_GAP });
  });

  it("treats a zero-sized image as no image", () => {
    expect(textInsets({ ...none, left: { w: 0, h: 0 } }).left).toBe(0);
  });
});
