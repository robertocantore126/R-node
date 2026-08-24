import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import { THEMES } from "../src/render/theme";
import { DEFAULT_GROUP_BORDER_WIDTH, type Group } from "../src/core/types";

/**
 * A group boundary carries its own colour and thickness (Group.color /
 * Group.borderWidth). `groupStroke` is the whole rule, returned as values so
 * these assertions need no canvas — the same shape as the nodeColors tests.
 */

const DIMS = { w: 800, h: 600 };

function make2dCtx(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(_t, p) {
      if (p === "measureText") return (text: string) => ({ width: text.length * 8 });
      return () => {};
    },
    set(_t, p, v) {
      target[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function makeFakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    get width() {
      return DIMS.w;
    },
    set width(_v: number) {},
    get height() {
      return DIMS.h;
    },
    set height(_v: number) {},
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

function makeRenderer(): Renderer {
  const ctx = make2dCtx();
  vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
  return new Renderer(makeFakeCanvas(ctx));
}

function group(patch: Partial<Group> = {}): Group {
  return { id: "g1", memberIds: ["a", "b"], ...patch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a group without a style is the boundary it always was", () => {
  it("unselected: the theme’s muted hairline, dashed 7/5", () => {
    const s = makeRenderer().groupStroke(THEMES.light, group(), false);
    expect(s.color).toBe(THEMES.light.textMuted);
    expect(s.width).toBe(DEFAULT_GROUP_BORDER_WIDTH);
    expect(s.dash).toEqual([7, 5]);
  });

  it("selected: the selection colour, one pixel thicker", () => {
    const s = makeRenderer().groupStroke(THEMES.light, group(), true);
    expect(s.color).toBe(THEMES.light.selection);
    expect(s.width).toBe(2.5);
  });

  it("the default is read off the theme, not written into the renderer", () => {
    // There is one theme today. The assertion that survives a second one is
    // that the colour comes from the argument — hence the doctored copy.
    const other = { ...THEMES.light, textMuted: "#010203", selection: "#040506" };
    const r = makeRenderer();
    expect(r.groupStroke(other, group(), false).color).toBe("#010203");
    expect(r.groupStroke(other, group(), true).color).toBe("#040506");
  });
});

describe("a group that was given a style keeps it", () => {
  it("the chosen colour survives selection — only the width says ‘selected’", () => {
    const r = makeRenderer();
    const g = group({ color: "#ff8800" });
    expect(r.groupStroke(THEMES.light, g, false).color).toBe("#ff8800");
    expect(r.groupStroke(THEMES.light, g, true).color).toBe("#ff8800");
  });

  it("the chosen thickness is drawn, at every offered weight", () => {
    const r = makeRenderer();
    for (const w of [1, 1.5, 2.5, 4, 6]) {
      expect(r.groupStroke(THEMES.light, group({ borderWidth: w }), false).width).toBe(w);
    }
  });

  it("selecting a thick group never makes it thinner", () => {
    const r = makeRenderer();
    for (const w of [1, 1.5, 2.5, 4, 6]) {
      const g = group({ borderWidth: w });
      const idle = r.groupStroke(THEMES.light, g, false).width;
      const sel = r.groupStroke(THEMES.light, g, true).width;
      expect(sel).toBeGreaterThan(idle);
    }
  });

  it("the dash grows with the line, so a heavy boundary is not a row of blobs", () => {
    const r = makeRenderer();
    const thin = r.groupStroke(THEMES.light, group({ borderWidth: 1.5 }), false);
    const heavy = r.groupStroke(THEMES.light, group({ borderWidth: 6 }), false);
    expect(thin.dash).toEqual([7, 5]); // unchanged from the fixed pattern
    expect(heavy.dash[0]).toBeGreaterThan(thin.dash[0]);
    expect(heavy.dash[1]).toBeGreaterThan(thin.dash[1]);
    // gap still shorter than the dash: the box reads as a line, not as dots
    expect(heavy.dash[1]).toBeLessThan(heavy.dash[0]);
  });
});
