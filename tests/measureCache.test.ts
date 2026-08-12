import { describe, expect, it } from "vitest";
import {
  measureNode,
  HEURISTIC_MEASURER,
  type TextMeasurer,
  type TextMetricsInput,
} from "../src/layout/measure";
import { DocumentModel } from "../src/core/doc";
import type { MindNode } from "../src/core/types";

/**
 * Guards the extent cache in `measureTopic`.
 *
 * The cache is keyed by a signature built by hand from the body of the
 * measuring function. That is the whole risk: add a Style field that changes
 * how big a topic is, forget to add it to the key, and the layout keeps
 * handing out the OLD size forever. The symptom — topics overlapping or text
 * clipped — appears far from the edit that caused it, so it is exactly the
 * kind of bug that survives review.
 *
 * These tests mutate a node IN PLACE and re-measure, which is how the app
 * behaves (`applyDraftRuns` assigns straight onto the node), and assert that
 * the answer moved.
 */

/**
 * A measurer sensitive to every font field. The heuristic one ignores family,
 * weight and italic — under it those fields provably cannot change an extent,
 * so a missing-key regression on them would be invisible in Node. This stands
 * in for the canvas measurer used in the browser.
 */
const FONT_SENSITIVE: TextMeasurer = {
  measure: (t: string, s: TextMetricsInput) => ({
    width:
      t.length *
      s.fontSize *
      (0.55 + (s.fontWeight ?? 400) / 4000 + (s.italic ? 0.05 : 0) + (s.fontFamily === "Georgia" ? 0.1 : 0)),
  }),
  metrics: (s: TextMetricsInput) => ({ ascent: s.fontSize * 0.8, descent: s.fontSize * 0.2 }),
};

/** Three times wider per character than the heuristic — enough to force a
 *  different line count, which is what makes cross-measurer bleed visible. */
const WIDE: TextMeasurer = {
  measure: (t: string, s: TextMetricsInput) => ({ width: t.length * s.fontSize * 1.65 }),
  metrics: (s: TextMetricsInput) => ({ ascent: s.fontSize * 0.8, descent: s.fontSize * 0.2 }),
};

const TEXT = "a title long enough that wrapping and font choice both matter here";

function fresh(): MindNode {
  const model = new DocumentModel(DocumentModel.blank("m"));
  return { ...model.rootNode, title: TEXT, titleRuns: undefined, style: { fontSize: 14 } };
}

const AFFECTS: Array<[string, (n: MindNode) => void]> = [
  ["title", (n) => { n.title = "a completely different title, of a different length entirely"; }],
  ["titleRuns", (n) => { n.titleRuns = [{ text: "short" }]; n.title = "short"; }],
  ["style.width", (n) => { n.style.width = 320; }],
  ["style.height", (n) => { n.style.height = 400; }],
  ["style.fontSize", (n) => { n.style.fontSize = 28; }],
  ["style.padding", (n) => { n.style.padding = 30; }],
  ["style.fontFamily", (n) => { n.style.fontFamily = "Georgia"; }],
  ["style.fontWeight", (n) => { n.style.fontWeight = 800; }],
  ["style.italic", (n) => { n.style.italic = true; }],
  ["style.shape (circle)", (n) => { n.style.shape = "circle"; }],
  ["style.shape (diamond)", (n) => { n.style.shape = "diamond"; }],
  ["run bold", (n) => { n.titleRuns = [{ text: TEXT, bold: true }]; }],
  ["run italic", (n) => { n.titleRuns = [{ text: TEXT, italic: true }]; }],
  ["run fontSize", (n) => { n.titleRuns = [{ text: TEXT, fontSize: 30 }]; }],
  ["run listIndent", (n) => { n.titleRuns = [{ text: TEXT, listIndent: 1 }]; }],
];

describe("extent cache — every measured field is in the key", () => {
  for (const [what, mutate] of AFFECTS) {
    it(`${what} changes the extent`, () => {
      const n = fresh();
      const before = measureNode(n, FONT_SENSITIVE);
      mutate(n);
      const after = measureNode(n, FONT_SENSITIVE);
      expect(`${after.w}x${after.h}`).not.toBe(`${before.w}x${before.h}`);
    });
  }

  it("paraGap between two runs changes the extent", () => {
    const n = fresh();
    n.titleRuns = [{ text: "one" }, { text: "two" }];
    n.title = "onetwo";
    const before = measureNode(n, FONT_SENSITIVE);
    n.titleRuns = [{ text: "one" }, { text: "two", paraGap: true }];
    const after = measureNode(n, FONT_SENSITIVE);
    expect(after.h).toBeGreaterThan(before.h);
  });

  it("a resized image changes the extent, and imageWidth overrides it", () => {
    const n = fresh();
    n.style.image = "a1";
    const small = measureNode(n, FONT_SENSITIVE, () => ({ w: 100, h: 50 }));
    const tall = measureNode(n, FONT_SENSITIVE, () => ({ w: 100, h: 400 }));
    expect(tall.h).toBeGreaterThan(small.h);
    const narrowed = measureNode(n, FONT_SENSITIVE, () => ({ w: 100, h: 50 }));
    expect(narrowed).toEqual(small); // same inputs → same answer (the cache hit)
    n.style.imageWidth = 60;
    const shrunk = measureNode(n, FONT_SENSITIVE, () => ({ w: 100, h: 50 }));
    expect(shrunk.h).toBeLessThan(small.h);
  });

  it("two measurers do not share entries", () => {
    const n = fresh();
    const heuristic = measureNode(n, HEURISTIC_MEASURER);
    const wide = measureNode(n, WIDE);
    // WIDE needs more lines for the same text, so the heights must differ.
    expect(wide.h).toBeGreaterThan(heuristic.h);
    expect(measureNode(n, HEURISTIC_MEASURER)).toEqual(heuristic); // and the first is unpolluted
  });

  it("colour and underline are deliberately NOT in the key", () => {
    // They change how the text looks, not how much room it needs. Keying on
    // them would throw away good entries on every recolour.
    const n = fresh();
    n.titleRuns = [{ text: TEXT }];
    const plain = measureNode(n, FONT_SENSITIVE);
    n.titleRuns = [{ text: TEXT, color: "#ff0000", underline: true }];
    expect(measureNode(n, FONT_SENSITIVE)).toEqual(plain);
  });
});
