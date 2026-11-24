import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import type { GalleryItem, MindNode } from "../src/core/types";
import { positionedImageSlots } from "../src/layout/measure";
import { THEMES } from "../src/render/theme";
import { DocumentModel } from "../src/core/doc";
import type { RenderState } from "../src/render/renderer";
import type { AssetStore } from "../src/persist/assets";

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
      if (p in _t) return _t[p];
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

describe("print rendering", () => {
  function setup(assetStore?: AssetStore) {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const renderer = new Renderer(makeFakeCanvas(ctx), { assetStore });
    const sheet = new DocumentModel(DocumentModel.blank("print")).sheet;
    const state: RenderState = { sheet, camera: { x: 100000, y: 100000, scale: 1 }, viewW: 100, viewH: 100,
      selection: new Set([sheet.rootNodeId]), editingId: sheet.rootNodeId, hoverId: sheet.rootNodeId,
      drop: null, themeName: "light", searchMatches: new Set([sheet.rootNodeId]) };
    return { renderer, state };
  }

  it("includes content outside the viewport while respecting collapsed branches", () => {
    const { renderer, state } = setup();
    const root = state.sheet.nodes[state.sheet.rootNodeId];
    const child = makeNode("far");
    child.parentId = root.id; child.position.x = 10000;
    root.childrenIds.push(child.id); state.sheet.nodes[child.id] = child;
    expect(renderer.printBounds(state).maxX).toBeGreaterThan(10000);
    root.collapsed = true;
    expect(renderer.printBounds(state).maxX).toBeLessThan(10000);
  });

  it("prints editing text and clears temporary rings without changing editor state", async () => {
    const { renderer, state } = setup();
    const paint = vi.spyOn(renderer, "render").mockImplementation(() => {});
    await renderer.renderForPrint(state, 3.125);
    const printed = paint.mock.calls[0][0];
    expect(printed.editingId).toBeNull();
    expect(printed.hoverId).toBeNull();
    expect(printed.selection.size).toBe(0);
    expect(printed.searchMatches).toBeUndefined();
    expect(state.selection.size).toBe(1);
    expect(state.editingId).toBe(state.sheet.rootNodeId);
  });

  it("stops export on missing images instead of silently printing placeholders", async () => {
    const get = vi.fn(async () => null);
    const { renderer, state } = setup({ get } as unknown as AssetStore);
    const root = state.sheet.nodes[state.sheet.rootNodeId];
    root.style.image = "missing";
    state.sheet.attachments.push({ id: "missing", w: 100, h: 100 } as never);
    state.camera = { x: root.position.x, y: root.position.y, scale: 1 };
    await expect(renderer.renderForPrint(state)).rejects.toThrow("Missing image");
    expect(get).toHaveBeenCalled();
    renderer.dispose();
  });
});

describe("image decode size", () => {
  function decoder(nat: { w: number; h: number } | null) {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const r = new Renderer(makeFakeCanvas(ctx)) as unknown as {
      resolveImage: (id: string) => { w: number; h: number } | null;
      imageDecodeSize: (id: string, px: number) => { bucket: number; level: string };
    };
    r.resolveImage = () => nat;
    return (px: number) => r.imageDecodeSize("img", px);
  }

  it("keeps the stored levels up to 1024 px, as before", () => {
    const at = decoder({ w: 4000, h: 3000 });
    expect(at(90)).toEqual({ bucket: 128, level: "small" });
    expect(at(300)).toEqual({ bucket: 512, level: "large" });
    expect(at(1024)).toEqual({ bucket: 1024, level: "large" });
  });

  it("decodes from the original past 1024 px, in half-octave steps", () => {
    const at = decoder({ w: 4000, h: 3000 });
    expect(at(1100)).toEqual({ bucket: 1448, level: "original" });
    expect(at(2400)).toEqual({ bucket: 2896, level: "original" });
  });

  it("never decodes wider than the source, nor past 8 MP", () => {
    expect(decoder({ w: 1300, h: 900 })(3000)).toEqual({ bucket: 1300, level: "original" });
    expect(decoder({ w: 900, h: 600 })(3000)).toEqual({ bucket: 1024, level: "large" });
    const square = decoder({ w: 8000, h: 8000 })(8000);
    expect(square.level).toBe("original");
    expect(square.bucket * square.bucket).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("stays on the large level when the image size is unknown", () => {
    expect(decoder(null)(3000)).toEqual({ bucket: 1024, level: "large" });
  });
});

describe("text from 50% zoom", () => {
  it("is drawn as vectors, never from a cached bitmap; below 50% the cache stays", () => {
    const ctx = make2dCtx();
    let created = 0;
    vi.stubGlobal("document", {
      createElement: () => {
        created += 1;
        return makeFakeCanvas(ctx);
      },
    });
    const renderer = new Renderer(makeFakeCanvas(ctx));
    created = 0;
    const r = renderer as unknown as {
      curScale: number;
      drawText: (_theme: unknown, p: { node: MindNode; x: number; y: number; w: number; h: number; visible: boolean }, color: string) => void;
      textCache: Map<string, unknown>;
    };
    const draw = (id: string): void => r.drawText(undefined, { node: makeNode(id), x: 0, y: 0, w: 120, h: 40, visible: true }, "#000");

    r.curScale = 2.5;
    draw("zoomed");
    expect(r.textCache.size).toBe(0);
    expect(created).toBe(0);

    r.curScale = 0.5;
    draw("half");
    expect(r.textCache.size).toBe(0);
    expect(created).toBe(0);

    r.curScale = 0.49;
    draw("far");
    expect(r.textCache.size).toBe(1);
  });
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
      curScale: number;
    };
    r.curScale = 0.25; // the bitmap cache only serves zooms below 50%
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
      structure: { structureType: "mindmap", orientation: "horizontal", padding: 18, compactMode: false, autoBalance: true, freePositioningBranches: false, allowManualPositioning: true, connectorStyle: "curved" },
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

  it("a camera move keeps the boxes but refreshes which are visible", () => {
    // Re-placing on every pan frame re-measured the whole sheet (400+ ms past
    // 20k topics). A pan changes visibility only, so the same placements come
    // back with their `visible` flags recomputed for the new camera.
    const { place, state } = setup();
    const vis = (p: unknown) => (p as { node: MindNode; visible: boolean }[]).map((x) => x.visible);
    const first = place(state(1));
    expect(vis(first)).toEqual([true, true]);
    const away = place(state(1, 5000));
    expect(away).toBe(first);
    expect(vis(away)).toEqual([false, false]);
    expect(vis(place(state(1)))).toEqual([true, true]);
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
      structure: { structureType: "mindmap", orientation: "horizontal", padding: 18, compactMode: false, autoBalance: true, freePositioningBranches: false, allowManualPositioning: true, connectorStyle: "curved" },
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

  const small = { node: makeNode("small"), x: 0, y: 300, w: 120, h: 40, visible: true };
  const tall = { node: makeNode("tall"), x: 0, y: 0, w: 200, h: 400, visible: true };
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

describe("hitTestGalleryCell — the caption band is a target of its own (T25)", () => {
  function rendererWithGalleryNode(items: GalleryItem[]): Renderer {
    const node = makeNode("g");
    node.style = { gallery: { items } };
    const r = new Renderer(makeFakeCanvas(make2dCtx()));
    (r as unknown as { placedNodes: () => unknown[] }).placedNodes = () => [
      { node, x: 0, y: 0, w: 500, h: 300, visible: true },
    ];
    return r;
  }

  function cellRect(): { x: number; y: number; w: number; h: number; captionY: number; captionH: number } {
    const node = makeNode("g");
    node.style = { gallery: { items: [{ id: "a0", caption: "Velma" }] } };
    const { cells } = positionedImageSlots({ x: 0, y: 0, w: 500, h: 300 }, node, () => ({ w: 200, h: 100 }));
    return cells[0];
  }

  it("reports the picture part on the picture itself", () => {
    const r = rendererWithGalleryNode([{ id: "a0", caption: "Velma" }]);
    const c = cellRect();
    const hit = r.hitTestGalleryCell({} as never, c.x + c.w / 2, c.y + c.h / 2);
    expect(hit?.nodeId).toBe("g");
    expect(hit?.index).toBe(0);
    expect(hit?.part).toBe("picture");
  });

  it("reports the caption part on the caption band under the picture", () => {
    const r = rendererWithGalleryNode([{ id: "a0", caption: "Velma" }]);
    const c = cellRect();
    expect(c.captionH).toBeGreaterThan(0);
    const hit = r.hitTestGalleryCell({} as never, c.x + c.w / 2, c.captionY + c.captionH / 2);
    expect(hit?.index).toBe(0);
    expect(hit?.part).toBe("caption");
  });

  it("is null in the gap between cells, so a drop between pictures still lands in the topic", () => {
    const r = rendererWithGalleryNode([{ id: "a0", caption: "Velma" }, { id: "a1" }]);
    const node = makeNode("g");
    node.style = { gallery: { items: [{ id: "a0", caption: "Velma" }, { id: "a1" }] } };
    const { cells } = positionedImageSlots({ x: 0, y: 0, w: 500, h: 300 }, node, () => ({ w: 200, h: 100 }));
    const mid = (cells[0].x + cells[0].w + cells[1].x) / 2;
    expect(r.hitTestGalleryCell({} as never, mid, cells[0].y + cells[0].h / 2)).toBeNull();
  });

  it("has no caption band to hit when no cell is captioned", () => {
    const r = rendererWithGalleryNode([{ id: "a0" }]);
    const node = makeNode("g");
    node.style = { gallery: { items: [{ id: "a0" }] } };
    const { cells } = positionedImageSlots({ x: 0, y: 0, w: 500, h: 300 }, node, () => ({ w: 200, h: 100 }));
    const c = cells[0];
    expect(c.captionH).toBe(0);
    expect(r.hitTestGalleryCell({} as never, c.x + c.w / 2, c.y + c.h + 4)).toBeNull();
  });
});

describe("image scale cache, fallback & priority queue", () => {
  function fakeBitmap(w: number, h: number) {
    return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
  }

  it("uses 32 px minimum bucket for tiny zoomed-out thumbnails", () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const r = new Renderer(makeFakeCanvas(ctx)) as unknown as {
      resolveImage: (id: string) => { w: number; h: number } | null;
      imageDecodeSize: (id: string, px: number) => { bucket: number; level: string };
    };
    r.resolveImage = () => ({ w: 1000, h: 1000 });
    expect(r.imageDecodeSize("img", 18)).toEqual({ bucket: 32, level: "small" });
    expect(r.imageDecodeSize("img", 50)).toEqual({ bucket: 64, level: "small" });
  });

  it("never evicts on-screen keys unless exceeding 2x hard ceiling", () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const r = new Renderer(makeFakeCanvas(ctx)) as unknown as {
      IMAGE_BUDGET: number;
      cacheImageBitmap: (key: string, imageId: string, bucket: number, bitmap: ImageBitmap) => number;
      frameKeys: Set<string>;
      imageCache: Map<string, { bitmap: ImageBitmap; bytes: number }>;
      evictToBudget: () => void;
    };
    // Put an on-screen 8192x4096 (128 MB) entry and an off-screen 4096x2048 (32 MB) entry.
    const onScreen = fakeBitmap(8192, 4096);
    const offScreen = fakeBitmap(4096, 2048);
    r.cacheImageBitmap("on@1024", "on", 1024, onScreen);
    r.cacheImageBitmap("off@512", "off", 512, offScreen);
    r.frameKeys.add("on@1024");
    r.evictToBudget();
    expect(r.imageCache.has("on@1024")).toBe(true);
    expect(r.imageCache.has("off@512")).toBe(false);
    expect((offScreen.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((onScreen.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("draws nearest cached fallback bucket on cache miss and enqueues exact bucket", () => {
    const ctx = make2dCtx();
    const drawImage = vi.fn();
    (ctx as unknown as Record<string, unknown>).drawImage = drawImage;
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const r = new Renderer(makeFakeCanvas(ctx)) as unknown as {
      resolveImage: (id: string) => { w: number; h: number } | null;
      cacheImageBitmap: (key: string, imageId: string, bucket: number, bitmap: ImageBitmap) => number;
      paintSlot: (p: { node: MindNode }, id: string, w: number, h: number, x: number, y: number) => void;
      decodeQueue: Map<string, { bucket: number; priority: number }>;
    };
    r.resolveImage = () => ({ w: 800, h: 600 });
    const smallBmp = fakeBitmap(128, 96);
    r.cacheImageBitmap("pic@128", "pic", 128, smallBmp);
    r.paintSlot({ node: makeNode("n1") }, "pic", 512, 384, 0, 0);
    expect(drawImage).toHaveBeenCalledWith(smallBmp, 0, 0, 512, 384);
    expect(r.decodeQueue.has("pic@512")).toBe(true);
  });

  it("prioritises missing-without-fallback over sharpening and drops off-screen queued items", () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const getMany = vi.fn(async () => new Map());
    const r = new Renderer(makeFakeCanvas(ctx), { assetStore: { getMany } as unknown as AssetStore }) as unknown as {
      visibleImageNodes: Set<string>;
      enqueueDecode: (key: string, imageId: string, nodeId: string, level: string, bucket: number, priority: number) => void;
      flushDecodeQueue: () => void;
      decodeQueue: Map<string, unknown>;
    };
    r.visibleImageNodes = new Set(["n-visible"]);
    r.enqueueDecode("off@64", "off", "n-offscreen", "small", 64, 1e12);
    r.enqueueDecode("vis@64", "vis", "n-visible", "small", 64, 100);
    r.flushDecodeQueue();
    expect(r.decodeQueue.size).toBe(0);
    expect(getMany).toHaveBeenCalledWith(["vis"], "small");
  });

  it("derives smaller original-level buckets from a larger cached bitmap without fetching", async () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const derivedBmp = fakeBitmap(1448, 1086);
    const createImageBitmapMock = vi.fn(async () => derivedBmp);
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    const getMany = vi.fn(async () => new Map());
    const r = new Renderer(makeFakeCanvas(ctx), { assetStore: { getMany } as unknown as AssetStore }) as unknown as {
      visibleImageNodes: Set<string>;
      cacheImageBitmap: (key: string, imageId: string, bucket: number, bitmap: ImageBitmap) => number;
      enqueueDecode: (key: string, imageId: string, nodeId: string, level: string, bucket: number, priority: number) => void;
      flushDecodeQueue: () => void;
      imageCache: Map<string, unknown>;
    };
    const bigBmp = fakeBitmap(2896, 2172);
    r.visibleImageNodes = new Set(["n1"]);
    r.cacheImageBitmap("big@2896", "big", 2896, bigBmp);
    r.enqueueDecode("big@1448", "big", "n1", "original", 1448, 100);
    r.flushDecodeQueue();
    await new Promise((res) => setTimeout(res, 10));
    expect(getMany).not.toHaveBeenCalled();
    expect(createImageBitmapMock).toHaveBeenCalledWith(bigBmp, { resizeWidth: 1448, resizeQuality: "high" });
    expect(r.imageCache.has("big@1448")).toBe(true);
  });

  it("uses spatial grid to cull visibility in O(visible) on maps > 128 nodes", () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const renderer = new Renderer(makeFakeCanvas(ctx));
    const sheet = new DocumentModel(DocumentModel.blank("grid")).sheet;
    const root = sheet.nodes[sheet.rootNodeId];
    for (let i = 0; i < 200; i++) {
      const n = makeNode(`n-${i}`);
      n.position = { x: i * 5000, y: 0, manual: true };
      root.childrenIds.push(n.id);
      sheet.nodes[n.id] = n;
    }
    const r = renderer as unknown as {
      visiblePlacedList: (s: RenderState) => { node: MindNode }[];
    };
    const state1: RenderState = {
      sheet,
      camera: { x: 10000, y: 0, scale: 1 },
      viewW: 400,
      viewH: 400,
      selection: new Set(),
      editingId: null,
      hoverId: null,
      drop: null,
      themeName: "light",
      rev: 1,
    };
    expect(r.visiblePlacedList(state1).map((p) => p.node.id)).toEqual(["n-2"]);
    const state2: RenderState = { ...state1, camera: { x: 500000, y: 0, scale: 1 } };
    expect(r.visiblePlacedList(state2).map((p) => p.node.id)).toEqual(["n-100"]);
    renderer.dispose();
  });
});
