import { describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import type { StorageAdapter } from "../src/persist/storage";
import { uid } from "../src/core/doc";
import { makeOp, type Op } from "../src/core/ops";
import { FREEFORM_SHAPES, FREEFORM_SHAPE_SIZES, type FreeformShape } from "../src/core/freeform";
import type { Style, TextRun } from "../src/core/types";
import { Renderer, type RenderState } from "../src/render/renderer";
import { makeTitle, seeded, words } from "../src/dev/stress";

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() {} };

function make2dCtx(log?: { calls: { name: string; args: unknown[] }[] }): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
  };
  return new Proxy(target, {
    get(_t, p) {
      if (p in _t) return _t[p];
      if (p === "measureText") return (text: string) => ({ width: text.length * 7 });
      if (p === "createLinearGradient") return () => ({ addColorStop() {} });
      if (p === "getImageData") return () => ({ data: new Uint8ClampedArray([120, 180, 240, 255]) });
      return (...args: unknown[]) => {
        if (log && typeof p === "string") log.calls.push({ name: p, args });
      };
    },
    set(_t, p, v) {
      target[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function makeFakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    width: 1280,
    height: 800,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

function buildStressDiagram(store: EditorStore, opts = { trees: 30, perTree: 40, branch: 4, loosePics: 1000, longTexts: 60 }) {
  const rnd = seeded(20261125);
  store.newDocument("diagram");
  const page = store.sheet.nodes[store.sheet.rootNodeId];
  const ops: Op[] = [];
  const shapeIds: string[] = [];
  const shapes = FREEFORM_SHAPES.map((s) => s.shape).filter((s) => s !== "actor");
  const pick = (): FreeformShape => shapes[Math.floor(rnd() * shapes.length)];
  const COLS = 6;

  for (let t = 0; t < opts.trees; t++) {
    const origin = { x: 120 + (t % COLS) * 2200, y: 200 + Math.floor(t / COLS) * 3600 };
    const queue: string[] = [];
    for (let k = 0; k < opts.perTree; k++) {
      const id = uid("n");
      const shape = pick();
      const size = FREEFORM_SHAPE_SIZES[shape];
      const { title, runs } = makeTitle(rnd, shapeIds.length);
      const style: Style = { shape, width: size.w, height: size.h, borderWidth: 1.5, align: "center", freeformPosition: { ...origin } };
      ops.push(makeOp<Op & { type: "createNode" }>("createNode", {
        id, nodeType: "subtopic", parentId: page.id, index: page.childrenIds.length + shapeIds.length,
        title, titleRuns: runs as TextRun[], style,
        position: { x: page.position.x + origin.x, y: page.position.y + origin.y, manual: false },
      }));
      if (k > 0) {
        const parent = queue[Math.floor((k - 1) / opts.branch)];
        ops.push(makeOp<Op & { type: "createRelationship" }>("createRelationship", {
          relationship: {
            id: uid("rel"), fromId: parent, toId: id, tree: true,
            connector: "elbow", lineStyle: "solid", endArrow: "triangle",
            fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 },
          },
        }));
      }
      queue.push(id);
      shapeIds.push(id);
    }
  }

  for (let i = 0; i < opts.longTexts; i++) {
    const idx = (i * 7919 + 53) % shapeIds.length;
    const text = Array.from({ length: 4 }, () => words(rnd, 100) + ".").join("\n");
    const op = ops.find((o): o is Op & { type: "createNode" } => o.type === "createNode" && o.id === shapeIds[idx]);
    if (op) {
      op.title = text;
      op.titleRuns = [{ text }];
    }
  }

  for (let i = 0; i < opts.loosePics; i++) {
    const imgId = `img-${i}`;
    store.sheet.attachments.push({ id: imgId, mime: "image/jpeg", w: 720, h: 480, bytes: 50_000, name: `${imgId}.jpg` });
    const id = uid("pic");
    const host = shapeIds[(i * 104729) % shapeIds.length];
    const hostOp = ops.find((o): o is Op & { type: "createNode" } => o.type === "createNode" && o.id === host);
    const basePos = hostOp?.style?.freeformPosition ?? { x: 100, y: 100 };
    const pos = { x: basePos.x + 24, y: basePos.y + 24 };
    ops.push(makeOp<Op & { type: "createNode" }>("createNode", {
      id, nodeType: "subtopic", parentId: page.id, index: page.childrenIds.length + shapeIds.length + i,
      title: "", titleRuns: [],
      style: { image: imgId, freeformPosition: pos, width: 220, height: 147 },
      position: { x: page.position.x + pos.x, y: page.position.y + pos.y, manual: false },
    }));
  }

  store.execOps(ops);
  return { pageId: page.id, shapeIds };
}

describe("diagram far-zoom LOD, zoom blit, and incremental execOps", () => {
  it("keeps 5% zoom frame fast with text greeking, avg-color image rects, and cached routes", { timeout: 60_000 }, () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const store = new EditorStore(memoryAdapter);
    const { pageId, shapeIds } = buildStressDiagram(store);
    const page = store.sheet.nodes[pageId];
    const renderer = new Renderer(makeFakeCanvas(ctx));
    const mid = {
      x: page.position.x + (page.style.width ?? 0) / 2,
      y: page.position.y + (page.style.height ?? 0) / 2,
    };
    const state: RenderState = {
      sheet: store.sheet,
      rev: store.revision,
      camera: { x: mid.x, y: mid.y, scale: 0.05 },
      selection: new Set(),
      editingId: null,
      hoverId: null,
      drop: null,
      themeName: "light",
      viewW: 1280,
      viewH: 800,
    };

    const pCold = renderer.profileFrame(state);
    const pWarm = renderer.profileFrame(state);

    // Measure pure execOps (setTitle on a deep node) vs diagramTab + undo
    const deep = shapeIds[39];
    const tEdit0 = performance.now();
    for (let i = 0; i < 5; i++) {
      store.execOps([makeOp<Op & { type: "setTitle" }>("setTitle", {
        id: deep, title: `Edit ${i}`, titleRuns: [{ text: `Edit ${i}` }],
        prev: store.sheet.nodes[deep].title, prevRuns: store.sheet.nodes[deep].titleRuns,
      })]);
    }
    const editExecAvgMs = (performance.now() - tEdit0) / 5;

    const tPaste0 = performance.now();
    for (let i = 0; i < 5; i++) {
      store.execOps([makeOp<Op & { type: "createNode" }>("createNode", {
        id: uid("p"), nodeType: "subtopic", parentId: pageId, index: store.sheet.nodes[pageId].childrenIds.length,
        title: "", titleRuns: [],
        style: { image: "img-0", imageWidth: 180, shape: "none", freeformPosition: { x: 400 + i * 10, y: 400 } },
        position: { x: page.position.x + 400 + i * 10, y: page.position.y + 400, manual: false },
      })]);
    }
    const pasteExecAvgMs = (performance.now() - tPaste0) / 5;

    console.log("[PROFILE cold 5%]", JSON.stringify(pCold));
    console.log("[PROFILE warm 5%]", JSON.stringify(pWarm));
    console.log(`[PROFILE execOps] setTitle avg=${editExecAvgMs.toFixed(2)}ms, createNode(img) avg=${pasteExecAvgMs.toFixed(2)}ms`);

    expect(pWarm.nodes).toBeGreaterThan(2000);
    expect(pWarm.textVector).toBe(0);
    expect(pWarm.textGreeked).toBeGreaterThan(500);
    expect(pWarm.imgSlotsDrawn).toBe(0);
    expect(pWarm.imgRectsDrawn).toBeGreaterThan(500);
    expect(pWarm.arrowsRouteMs).toBeLessThan(30);
    expect(pWarm.totalMs).toBeLessThan(100);
    expect(pasteExecAvgMs).toBeLessThan(20);
    renderer.dispose();
    vi.unstubAllGlobals();
  });

  it("skips nodes smaller than 1.5 px on screen at far zoom", () => {
    const ctx = make2dCtx();
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const store = new EditorStore(memoryAdapter);
    store.newDocument("diagram");
    const page = store.sheet.nodes[store.sheet.rootNodeId];
    // Add a tiny 20x20 shape: at scale 0.02 even its clamped box is < 1.5 px.
    store.execOps([makeOp<Op & { type: "createNode" }>("createNode", {
      id: "tiny", nodeType: "subtopic", parentId: page.id, index: page.childrenIds.length,
      title: "x", titleRuns: [{ text: "x" }],
      style: { shape: "rect", width: 20, height: 20, freeformPosition: { x: 100, y: 100 } },
      position: { x: 100, y: 100, manual: false },
    })]);
    const renderer = new Renderer(makeFakeCanvas(ctx));
    const prof = renderer.profileFrame({
      sheet: store.sheet, rev: store.revision,
      camera: { x: 200, y: 200, scale: 0.02 },
      selection: new Set(), editingId: null, hoverId: null, drop: null,
      themeName: "light", viewW: 1280, viewH: 800,
    });
    expect(prof.nodesSkippedTiny).toBeGreaterThanOrEqual(1);
    renderer.dispose();
    vi.unstubAllGlobals();
  });

  it("reuses the cached scene bitmap on wheel zoom-in, and repaints live on zoom-out to avoid gray borders", () => {
    const log = { calls: [] as { name: string; args: unknown[] }[] };
    const ctx = make2dCtx(log);
    vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
    const store = new EditorStore(memoryAdapter);
    store.newDocument("diagram");
    const renderer = new Renderer(makeFakeCanvas(ctx));
    const baseState: RenderState = {
      sheet: store.sheet, rev: store.revision,
      camera: { x: 400, y: 400, scale: 0.5 },
      selection: new Set(), editingId: null, hoverId: null, drop: null,
      themeName: "light", viewW: 1280, viewH: 800,
      sceneContentKey: "doc-1", moving: false, zooming: false,
    };
    // Warm the scene cache.
    renderer.render(baseState);
    log.calls.length = 0;

    // Active wheel zoom-in: cached scene covers 100% of viewport -> stretch-blit.
    renderer.render({ ...baseState, camera: { x: 400, y: 400, scale: 0.7 }, moving: true, zooming: true });
    expect(log.calls.some((c) => c.name === "drawImage")).toBe(true);
    expect(log.calls.some((c) => c.name === "fillText")).toBe(false);

    // Active wheel zoom-out: exposes areas outside cached scene -> paints live (no gray border flash).
    log.calls.length = 0;
    renderer.render({ ...baseState, camera: { x: 400, y: 400, scale: 0.35 }, moving: true, zooming: true });
    expect(log.calls.some((c) => c.name === "stroke")).toBe(true);
    renderer.dispose();
    vi.unstubAllGlobals();
  });

  it("incrementally grows and shrinks the diagram page when outer shapes are added, moved, or deleted", () => {
    const store = new EditorStore(memoryAdapter);
    store.newDocument("diagram");
    const pageId = store.sheet.rootNodeId;
    const initW = store.sheet.nodes[pageId].style.width!;

    // Add a far-right shape that expands the page width.
    const farId = uid("far");
    store.execOps([makeOp<Op & { type: "createNode" }>("createNode", {
      id: farId, nodeType: "subtopic", parentId: pageId, index: store.sheet.nodes[pageId].childrenIds.length,
      title: "Far", titleRuns: [{ text: "Far" }],
      style: { shape: "rect", width: 120, height: 60, freeformPosition: { x: 2000, y: 100 } },
      position: { x: 2000, y: 100, manual: false },
    })]);
    expect(store.sheet.nodes[pageId].style.width!).toBeGreaterThan(initW);

    // Delete the far-right shape: page must shrink back to initial width.
    store.deleteNodes([farId]);
    expect(store.sheet.nodes[pageId].style.width!).toBe(initW);

    // Undo brings it back and re-expands the page.
    store.undo();
    expect(store.sheet.nodes[pageId].style.width!).toBeGreaterThan(initW);
  });
});
