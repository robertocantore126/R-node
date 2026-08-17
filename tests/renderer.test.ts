import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import type { MindNode } from "../src/core/types";
import { THEMES } from "../src/render/theme";

/**
 * Every offscreen canvas reports the SAME fixed dimensions (2048×2048 → exactly
 * 16 MB per bitmap), ignoring the width/height assignments renderTextBitmap
 * makes. That lets the test drive the byte accounting without rendering real
 * text: the cache key (node id) varies, the byte weight does not.
 */
const DIMS = { w: 2048, h: 2048 };
const ENTRY_BYTES = DIMS.w * DIMS.h * 4; // 16 MB

function makeNode(id: string): MindNode {
  return {
    id,
    type: "subtopic",
    parentId: "root",
    childrenIds: [],
    title: "Same title for every node",
    titleRuns: [{ text: "Same title for every node" }],
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

/** A 2d context that accepts every call and answers measureText deterministically. */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("text cache (T21-D)", () => {
  it("evicts by byte budget and refreshes recency on hit (true LRU)", () => {
    const ctx = make2dCtx();
    let created = 0;
    vi.stubGlobal("document", {
      createElement: () => {
        created += 1;
        return makeFakeCanvas(ctx);
      },
    });

    const renderer = new Renderer(makeFakeCanvas(ctx));
    created = 0; // the measurer's internal canvas is not cache accounting
    const r = renderer as unknown as {
      drawText: (
        _theme: unknown,
        p: { node: MindNode; x: number; y: number; w: number; h: number; visible: boolean },
        color: string
      ) => void;
      textCache: Map<string, { bytes: number }>;
      textBytes: number;
    };
    const draw = (id: string): void =>
      r.drawText(undefined, { node: makeNode(id), x: 0, y: 0, w: 120, h: 40, visible: true }, "#000");

    // A + B + C = 48 MB — under the 64 MB budget, nothing evicted.
    draw("A");
    draw("B");
    draw("C");
    expect(r.textCache.size).toBe(3);
    expect(created).toBe(3);

    // Hit A → recency refreshed: {B, C, A}. No new bitmap was rendered.
    draw("A");
    expect(created).toBe(3);
    expect(r.textCache.size).toBe(3);

    // D fits exactly (64 MB); E pushes to 80 MB → the LEAST RECENTLY USED
    // (B — A was refreshed) is evicted, not the first inserted.
    draw("D");
    draw("E");
    expect(r.textCache.size).toBe(4);
    expect(r.textBytes).toBe(64 * 1024 * 1024);
    expect(created).toBe(5);

    // A survived because its earlier hit refreshed it: still a cache hit.
    draw("A");
    expect(created).toBe(5);
    // B was evicted: re-drawing it renders a fresh bitmap.
    draw("B");
    expect(created).toBe(6);

    // Every insert stays within the byte budget.
    expect(r.textBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(r.textBytes).toBe(64 * 1024 * 1024); // exactly 4 entries after the eviction
    expect(ENTRY_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("placement cache", () => {
  /**
   * placedNodes measures every node in the sheet, so it is cached for the turn.
   * The whole risk lives in the invalidation: node objects are MUTATED IN
   * PLACE, so neither the sheet's identity nor a node's identity changes when
   * a box moves. The key is the store revision, and these tests pin the two
   * halves of that contract — it reuses within a revision, and it never reuses
   * across one.
   */
  function setup() {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const renderer = new Renderer(makeFakeCanvas(ctx));
    const root = makeNode("root");
    root.parentId = null;
    root.childrenIds = ["a"];
    const a = makeNode("a");
    const sheet = {
      sheetId: "s",
      title: "t",
      structure: { structureType: "mindmap", orientation: "horizontal", spacing: 180, branchSpacing: 14, padding: 18, compactMode: false, autoBalance: true, freePositioningBranches: false, allowManualPositioning: true, connectorStyle: "curved" },
      rootNodeId: "root",
      nodes: { root, a },
      relationships: [], boundaries: [], summaries: [], callouts: [], labels: [], zones: [], attachments: [], comments: [], presentation: {},
    } as never;
    const state = (rev: number | undefined, camX = 0) => ({
      sheet, camera: { x: camX, y: 0, scale: 1 }, selection: new Set<string>(), editingId: null,
      hoverId: null, drop: null, themeName: "light", viewW: 800, viewH: 600, rev,
    }) as never;
    const place = (s: never) => (renderer as unknown as { placedNodes: (s: never) => { node: MindNode; x: number }[] }).placedNodes(s);
    return { place, state, a };
  }

  it("reuses the placement within one revision", () => {
    const { place, state } = setup();
    const first = place(state(1));
    expect(place(state(1))).toBe(first); // same array, not merely equal
  });

  it("never reuses it across a revision, however the node changed", () => {
    const { place, state, a } = setup();
    place(state(1));
    // A move the old way: same sheet object, same node object, new coordinates.
    // Anything keyed on identity would hand back the previous position here.
    a.position = { x: 999, y: 42, manual: true };
    const after = place(state(2));
    expect(after.find((p) => p.node.id === "a")?.x).toBe(999);
  });

  it("recomputes when the camera moves, since visibility is part of the answer", () => {
    const { place, state } = setup();
    const first = place(state(1));
    expect(place(state(1, 5000))).not.toBe(first);
  });

  it("caches nothing when the caller omits the revision", () => {
    // The opt-out for states assembled by hand (tests, exports): no revision
    // means no way to know when it went stale, so it must not be trusted.
    const { place, state } = setup();
    const first = place(state(undefined));
    expect(place(state(undefined))).not.toBe(first);
  });
});

describe("resize", () => {
  /** A canvas whose width/height behave like the real ones: writable, and
   *  every write counted — a write is what wipes the backing store. */
  function countingCanvas(ctx: CanvasRenderingContext2D): { canvas: HTMLCanvasElement; writes: () => number } {
    let w = 300;
    let h = 150;
    let writes = 0;
    const canvas = {
      get width() { return w; },
      set width(v: number) { w = v; writes += 1; },
      get height() { return h; },
      set height(v: number) { h = v; writes += 1; },
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    return { canvas, writes: () => writes };
  }

  it("does not touch width or height when the size has not changed", () => {
    // Assigning canvas.width clears the canvas even when the value is
    // identical. The ResizeObserver fires on layout passes that leave the box
    // unchanged, so an unconditional assignment blanked the map for a frame on
    // every selection.
    const ctx = make2dCtx();
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const { canvas, writes } = countingCanvas(ctx);
    const renderer = new Renderer(canvas);

    renderer.resize(canvas, 800, 600);
    const afterFirst = writes();
    expect(afterFirst).toBeGreaterThan(0); // the real resize did happen

    renderer.resize(canvas, 800, 600);
    renderer.resize(canvas, 800, 600);
    expect(writes()).toBe(afterFirst);
  });

  it("still resizes when the size really changes", () => {
    const ctx = make2dCtx();
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const { canvas, writes } = countingCanvas(ctx);
    const renderer = new Renderer(canvas);

    renderer.resize(canvas, 800, 600);
    const afterFirst = writes();
    renderer.resize(canvas, 801, 600);
    expect(writes()).toBeGreaterThan(afterFirst);
    expect(canvas.width).toBe(801);
  });
});

describe("the rings drawn around a topic", () => {
  /** A context that records the rectangles it is asked to stroke. */
  function recordingCtx(): { ctx: CanvasRenderingContext2D; rects: number[][] } {
    const rects: number[][] = [];
    const target: Record<string | symbol, unknown> = {};
    const ctx = new Proxy(target, {
      get(_t, p) {
        if (p === "measureText") return (text: string) => ({ width: text.length * 8 });
        if (p === "strokeRect") return (...args: number[]) => void rects.push(args);
        return () => {};
      },
      set(_t, p, v) {
        target[p] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, rects };
  }

  const BOX = { x: 100, y: 50, w: 160, h: 40 };

  function ringsFor(over: Record<string, unknown>): number[][] {
    const { ctx, rects } = recordingCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const renderer = new Renderer(makeFakeCanvas(ctx));
    const root = makeNode("root");
    root.parentId = null;
    root.childrenIds = ["a"];
    const a = makeNode("a");
    const sheet = {
      sheetId: "s", title: "t",
      structure: { structureType: "mindmap", orientation: "horizontal", spacing: 180, branchSpacing: 14, padding: 18, compactMode: false, autoBalance: true, freePositioningBranches: false, allowManualPositioning: true, connectorStyle: "curved" },
      rootNodeId: "root", nodes: { root, a },
      relationships: [], boundaries: [], summaries: [], callouts: [], labels: [], zones: [], attachments: [], comments: [], presentation: {},
    } as never;
    const state = {
      sheet, camera: { x: 0, y: 0, scale: 1 }, selection: new Set<string>(), editingId: null,
      hoverId: null, drop: null, themeName: "light", viewW: 800, viewH: 600, rev: 1, ...over,
    } as never;
    const placed = { node: a, ...BOX, visible: true } as never;
    (renderer as unknown as { drawNode: (t: unknown, p: never, s: never) => void }).drawNode(THEMES.light, placed, state);
    return rects;
  }

  it("puts the hover ring and the selection ring on exactly the same rectangle", () => {
    // They used to differ — hover at pad 2, selection at pad 3 — so the outline
    // jumped a pixel outward the instant a hovered topic was clicked. Nothing
    // in the document changed there, which is why no op, no layout and no cache
    // counter in a trace could show it: the flicker lived only in the paint.
    const hover = ringsFor({ hoverId: "a" });
    const selected = ringsFor({ selection: new Set(["a"]) });

    expect(hover.length).toBeGreaterThan(0);
    expect(selected.length).toBeGreaterThan(0);
    expect(hover[0]).toEqual(selected[0]);
  });

  it("draws the marquee preview ring on that same rectangle too", () => {
    const marquee = ringsFor({ marqueeSel: new Set(["a"]) });
    const selected = ringsFor({ selection: new Set(["a"]) });
    expect(marquee[0]).toEqual(selected[0]);
  });

  it("keeps the ring outside the box on every side", () => {
    const [ring] = ringsFor({ selection: new Set(["a"]) });
    const [x, y, w, h] = ring;
    expect(x).toBeLessThan(BOX.x);
    expect(y).toBeLessThan(BOX.y);
    expect(x + w).toBeGreaterThan(BOX.x + BOX.w);
    expect(y + h).toBeGreaterThan(BOX.y + BOX.h);
  });
});

describe("hitTest — what a drag is allowed to land on", () => {
  /**
   * A tall topic overlapping a short one below it: the geometry of a special
   * node (box frozen at insert size, often 300px+) dragged over a normal
   * topic. Later in the array means painted later, so `tall` is on top and
   * wins an unfiltered hit test even where it only overlaps.
   */
  function rendererWith(placed: unknown[]): Renderer {
    const r = new Renderer(makeFakeCanvas(make2dCtx()));
    (r as unknown as { placedNodes: () => unknown[] }).placedNodes = () => placed;
    return r;
  }

  const small = { node: { id: "small" }, x: 0, y: 300, w: 120, h: 40, visible: true };
  const tall = { node: { id: "tall" }, x: 0, y: 0, w: 200, h: 400, visible: true };
  // Inside both boxes, in the LOWER half of `small` — the "drop after" zone.
  const PX = 60;
  const PY = 332;

  it("returns the topmost topic when nothing is skipped", () => {
    expect(rendererWith([small, tall]).hitTest({} as never, PX, PY)).toBe("tall");
  });

  it("finds the topic behind the one being dragged", () => {
    // The dragged node tracks the cursor, so it sits under the pointer for the
    // whole gesture. Answering its own hit test made the drop fall through to
    // "floating", which kept it following, which kept it covering: a tall node
    // could be dropped ABOVE a topic but never below one.
    expect(rendererWith([small, tall]).hitTest({} as never, PX, PY, (id) => id === "tall")).toBe("small");
  });

  it("still reports nothing when the skipped node was the only candidate", () => {
    expect(rendererWith([tall]).hitTest({} as never, PX, PY, (id) => id === "tall")).toBeNull();
  });
});
