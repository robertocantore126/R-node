import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import { THEMES } from "../src/render/theme";
import { EditorStore } from "../src/editor/store";
import { sheetToSvg } from "../src/export/svg";
import { HEURISTIC_MEASURER } from "../src/layout/measure";
import { applyLayout } from "../src/layout/mindmap";
import { BRANCH_STROKE, DEFAULT_NODE_BORDER_WIDTH, type Sheet, type Style } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

/**
 * Topic outlines (C1–C4). `Renderer.nodeBorder` is the whole rule, returned as
 * values; the canvas, the SVG and the PDF all paint what it returns.
 */

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() {} };

function make2dCtx(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(_t, p) {
      if (p === "measureText") return (text: string) => ({ width: text.length * 8 });
      return () => {};
    },
    set(_t, p, v) { target[p] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

function makeRenderer(): Renderer {
  const ctx = make2dCtx();
  const canvas = { width: 800, height: 600, getContext: () => ctx } as unknown as HTMLCanvasElement;
  vi.stubGlobal("document", { createElement: () => canvas });
  return new Renderer(canvas);
}

/** A store with root → main → child; returns the child id. */
function setup(): { store: EditorStore; main: string; child: string } {
  const store = new EditorStore(memoryAdapter);
  store.createChild();
  const root = store.doc.node(store.sheet.rootNodeId)!;
  const main = root.childrenIds[root.childrenIds.length - 1];
  store.select(main);
  store.createChild();
  const child = store.doc.node(main)!.childrenIds[0];
  return { store, main, child };
}

function stateOf(sheet: Sheet) {
  return { sheet, camera: { x: 0, y: 0, scale: 1 }, selection: new Set<string>(), editingId: null, hoverId: null, drop: null, themeName: "light" as const, viewW: 800, viewH: 600 };
}

function styled(store: EditorStore, id: string, patch: Partial<Style>): Sheet {
  store.setSelectionBorder(patch, [id]);
  return store.sheet;
}

afterEach(() => vi.unstubAllGlobals());

describe("nodeBorder: the outline rule", () => {
  it("a topic with no outline of its own wears the theme hairline", () => {
    const { store, child } = setup();
    const b = makeRenderer().nodeBorder(stateOf(store.sheet), child)!;
    expect(b).toEqual({ color: THEMES.light.nodeBorder, width: 1, dash: [], cap: "butt", double: false });
  });

  it("ONE field is enough: a dash style alone draws a dashed outline", () => {
    // The old rule needed colour AND width, so picking only a style did nothing.
    const { store, child } = setup();
    const b = makeRenderer().nodeBorder(stateOf(styled(store, child, { borderStyle: "dashed" })), child)!;
    expect(b.width).toBe(DEFAULT_NODE_BORDER_WIDTH);
    expect(b.dash.length).toBe(2);
  });

  it("a colour alone draws a solid outline at the default width", () => {
    const { store, child } = setup();
    const b = makeRenderer().nodeBorder(stateOf(styled(store, child, { stroke: "#ff0000" })), child)!;
    expect(b).toMatchObject({ color: "#ff0000", width: DEFAULT_NODE_BORDER_WIDTH, dash: [] });
  });

  it("the branch token resolves to the branch colour, which is what the connector wears", () => {
    const { store, child } = setup();
    const r = makeRenderer();
    const s = stateOf(styled(store, child, { stroke: BRANCH_STROKE, borderWidth: 3 }));
    expect(r.nodeBorder(s, child)!.color).toBe(r.branchColorOf(s, child));
    // and an absent colour on a custom outline means the same
    const s2 = stateOf(styled(store, child, { stroke: undefined }));
    expect(r.nodeBorder(s2, child)!.color).toBe(r.branchColorOf(s2, child));
  });

  it("'none' removes even the theme hairline", () => {
    const { store, child } = setup();
    expect(makeRenderer().nodeBorder(stateOf(styled(store, child, { borderStyle: "none" })), child)).toBeNull();
  });

  it("dashes grow with the line, and dotted/dash-dot use round caps", () => {
    const { store, child } = setup();
    const r = makeRenderer();
    const thin = r.nodeBorder(stateOf(styled(store, child, { borderStyle: "dashed", borderWidth: 1 })), child)!;
    const thick = r.nodeBorder(stateOf(styled(store, child, { borderWidth: 6 })), child)!;
    expect(thick.dash[0]).toBeGreaterThan(thin.dash[0]);
    for (const style of ["dotted", "dashdot"] as const) {
      expect(r.nodeBorder(stateOf(styled(store, child, { borderStyle: style })), child)!.cap).toBe("round");
    }
  });

  it("double never goes thinner than 3, or its two lines blur into one", () => {
    const { store, child } = setup();
    const b = makeRenderer().nodeBorder(stateOf(styled(store, child, { borderStyle: "double", borderWidth: 1 })), child)!;
    expect(b.double).toBe(true);
    expect(b.width).toBe(3);
  });

  it("a text-only topic gets no hairline, but does get an outline it was given", () => {
    const { store, child } = setup();
    store.setNodeStyle(child, { shape: "none" });
    const r = makeRenderer();
    expect(r.nodeBorder(stateOf(store.sheet), child)).toBeNull();
    expect(r.nodeBorder(stateOf(styled(store, child, { borderStyle: "dotted" })), child)).not.toBeNull();
  });
});

describe("setSelectionBorder", () => {
  it("outlines every selected topic in one undo step, and reset clears all three fields", () => {
    const { store, main, child } = setup();
    store.setSelectionBorder({ stroke: "#00ff00", borderStyle: "dashed", borderWidth: 4 }, [main, child]);
    expect(store.doc.node(main)!.style).toMatchObject({ stroke: "#00ff00", borderStyle: "dashed", borderWidth: 4 });
    expect(store.doc.node(child)!.style.borderStyle).toBe("dashed");
    store.undo();
    expect(store.doc.node(main)!.style.borderStyle).toBeUndefined();
    expect(store.doc.node(child)!.style.borderStyle).toBeUndefined();
    store.redo();
    store.resetSelectionBorder([main, child]);
    for (const id of [main, child]) {
      const st = store.doc.node(id)!.style;
      expect("stroke" in st || "borderWidth" in st || "borderStyle" in st).toBe(false);
    }
  });
});

describe("SVG export draws the resolved outline", () => {
  it("emits stroke, width and dasharray from borderOf", async () => {
    const { store, child } = setup();
    store.setSelectionBorder({ stroke: "#123456", borderStyle: "dashed", borderWidth: 3 }, [child]);
    const sheet = store.sheet;
    applyLayout(sheet, true, HEURISTIC_MEASURER);
    const r = makeRenderer();
    const s = stateOf(sheet);
    const out = await sheetToSvg(sheet, {
      measurer: HEURISTIC_MEASURER,
      colorOf: () => ({ fill: "#ffffff", text: "#000000" }),
      linkColorOf: () => "#888888",
      borderOf: (id) => r.nodeBorder(s, id),
      background: null,
    });
    expect(out.svg).toMatch(/stroke="#123456" stroke-width="3" stroke-dasharray="[\d.]+ [\d.]+"/);
  });
});
