import { describe, expect, it } from "vitest";
import { computeTextBox, MIN_TEXTBOX_SIDE } from "../src/core/shapeArt";
import type { ShapePart } from "../src/core/types";

/**
 * The label's square is DERIVED, so its geometry is what needs pinning — not an
 * LLM's guess at it. `computeTextBox` takes the "is this point painted?" test as
 * an argument, so these run without a canvas: each case supplies the predicate
 * for a shape whose right answer can be worked out on paper.
 */

const part = (d: string): ShapePart[] => [{ d }];

/** A disc of radius r centred at (cx, cy) in the 0..1 box. */
function discProbe(cx: number, cy: number, r: number) {
  return (_d: string, x: number, y: number): boolean => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
/** An axis-aligned rectangle. */
function rectProbe(x0: number, y0: number, x1: number, y1: number) {
  return (_d: string, x: number, y: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
/** A crescent: a disc with a second disc bitten out of its right side. */
function crescentProbe() {
  const outer = discProbe(0.5, 0.5, 0.45);
  const bite = discProbe(0.78, 0.5, 0.42);
  return (d: string, x: number, y: number): boolean => outer(d, x, y) && !bite(d, x, y);
}

describe("computeTextBox — the square is derived, not authored", () => {
  it("centres on a disc and fills it as far as a square can", () => {
    // Largest square inside a circle of radius r has side r·√2.
    const box = computeTextBox(part("M0,0 Z"), discProbe(0.5, 0.5, 0.4))!;
    expect(box.w).toBeCloseTo(box.h, 5); // square, not a rectangle
    expect(box.x + box.w / 2).toBeCloseTo(0.5, 1);
    expect(box.y + box.h / 2).toBeCloseTo(0.5, 1);
    expect(box.w).toBeCloseTo(0.4 * Math.SQRT2, 1);
  });

  it("follows an off-centre shape instead of the middle of the box", () => {
    const box = computeTextBox(part("M0,0 Z"), rectProbe(0.05, 0.4, 0.45, 0.6))!;
    expect(box.x + box.w / 2).toBeCloseTo(0.25, 1);
    expect(box.y + box.h / 2).toBeCloseTo(0.5, 1);
  });

  it("puts a crescent's square in the BELLY, not in the hollow", () => {
    // The reason the centroid is used rather than the bounding box's centre:
    // for a crescent those are different points and the second one is in the
    // hole, which is where the first attempt at this feature put the label.
    const probe = crescentProbe();
    const box = computeTextBox(part("M0,0 Z"), probe)!;
    const cx = box.x + box.w / 2;
    expect(cx).toBeLessThan(0.5); // left of centre — the thick side
    // and every corner really is painted
    for (const [px, py] of [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x, box.y + box.h],
      [box.x + box.w, box.y + box.h],
    ]) {
      expect(probe("", px, py)).toBe(true);
    }
  });

  it("reports a shape too thin to write in, rather than inventing a fit", () => {
    // A hairline: the caller turns this into "make the drawing fatter".
    const box = computeTextBox(part("M0,0 Z"), rectProbe(0.48, 0.1, 0.52, 0.9));
    expect(box === null || box.w < MIN_TEXTBOX_SIDE).toBe(true);
  });

  it("returns null when nothing is painted at all", () => {
    expect(computeTextBox(part("M0,0 Z"), () => false)).toBeNull();
    expect(computeTextBox([], () => true)).toBeNull();
  });

  it("never leaves the unit square", () => {
    const box = computeTextBox(part("M0,0 Z"), () => true)!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(1.0001);
    expect(box.y + box.h).toBeLessThanOrEqual(1.0001);
  });
});

