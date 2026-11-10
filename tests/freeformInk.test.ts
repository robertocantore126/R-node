import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { freeformContentBounds } from "../src/core/freeform";
import { appendInkSample, inkBounds, inkPolyline, inkStrokeHit, inkStrokes } from "../src/core/ink";
import type { InkStroke, MindNode, Sheet } from "../src/core/types";
import { DocumentModel } from "../src/core/doc";
import { EditorStore } from "../src/editor/store";
import { handleShortcut } from "../src/editor/shortcuts";
import { sheetToSvg } from "../src/export/svg";
import { sheetToPdf } from "../src/export/pdf";
import { HEURISTIC_MEASURER } from "../src/layout/measure";
import { applyLayout } from "../src/layout/mindmap";
import { THEMES } from "../src/render/theme";
import { latin1 } from "./latin1";

const line = (width = 3): InkStroke => ({ width, path: [100, 100, 120, 100, 140, 100] });

function storeWithCanvas(): { store: EditorStore; canvas: string } {
  const store = new EditorStore({ label: "test", load: async () => [], save: async () => {} });
  store.createFreeformTopic();
  store.cancelEdit();
  const canvas = Object.values(store.sheet.nodes).find((n) => n.style.freeform)!.id;
  return { store, canvas };
}

const inkOf = (store: EditorStore, id: string): InkStroke[] => store.doc.node(id)!.style.ink ?? [];

describe("stroke geometry", () => {
  it("skips samples closer than the minimum distance", () => {
    const path: number[] = [];
    appendInkSample(path, 0, 0, 1);
    appendInkSample(path, 0.2, 0, 1);
    appendInkSample(path, 5, 0, 1);
    expect(path).toEqual([0, 0, 5, 0]);
  });

  it("is exactly as thick as its width, everywhere", () => {
    const b = inkBounds({ width: 4, path: [0, 0, 50, 0] });
    expect(b.maxY - b.minY).toBe(4);
  });

  it("draws a single tap as a zero-length line, for the dot on an i", () => {
    expect(inkPolyline({ width: 4, path: [10, 10] })).toEqual([10, 10, 10, 10]);
  });

  it("smooths the corners but keeps both ends where the pen was", () => {
    const out = inkPolyline({ width: 3, path: [0, 0, 10, 0, 10, 10] });
    expect(out.slice(0, 2)).toEqual([0, 0]);
    expect(out.slice(-2)).toEqual([10, 10]);
    expect(out).not.toContainEqual(undefined);
    expect(out.length).toBeGreaterThan(6);
  });

  it("hits only near the stroke", () => {
    expect(inkStrokeHit(line(), 120, 101, 2)).toBe(true);
    expect(inkStrokeHit(line(), 120, 130, 2)).toBe(false);
  });

  it("skips malformed strokes from a damaged file", () => {
    const style = { ink: [line(), { width: 3, path: [1, 2, 3] }, null, { width: 3, path: [1, NaN] }, { width: 3 }] } as never;
    expect(inkStrokes(style)).toHaveLength(1);
    expect(inkStrokes({ ink: "nope" } as never)).toEqual([]);
  });
});

describe("store", () => {
  it("adds a stroke as one undo step", () => {
    const { store, canvas } = storeWithCanvas();
    store.addInkStroke(canvas, line());
    expect(inkOf(store, canvas)).toHaveLength(1);
    expect(store.getSnapshot().sync).toBe("dirty");
    store.undo();
    expect(inkOf(store, canvas)).toHaveLength(0);
    store.redo();
    expect(inkOf(store, canvas)).toHaveLength(1);
  });

  it("refuses a topic that is not a canvas", () => {
    const { store } = storeWithCanvas();
    store.addInkStroke(store.sheet.rootNodeId, line());
    expect(store.doc.node(store.sheet.rootNodeId)!.style.ink).toBeUndefined();
  });

  it("grows the canvas for writing past its edge, in the same undo step", () => {
    const { store, canvas } = storeWithCanvas();
    const before = store.doc.node(canvas)!.style.width ?? 720;
    store.addInkStroke(canvas, { width: 3, path: [100, 100, before + 200, 100] });
    expect(store.doc.node(canvas)!.style.width).toBeGreaterThan(before + 200);
    store.undo();
    expect(store.doc.node(canvas)!.style.width ?? 720).toBe(before);
  });

  it("counts ink as content when working out how small a canvas can be", () => {
    const { store, canvas } = storeWithCanvas();
    store.addInkStroke(canvas, { width: 3, path: [500, 400, 510, 400] });
    const bounds = freeformContentBounds(store.sheet, canvas, () => ({ w: 0, h: 0 }));
    expect(bounds.maxX).toBeGreaterThan(510);
    expect(bounds.maxY).toBeGreaterThan(400);
  });

  it("erases only the strokes it touched, in one undo step", () => {
    const { store, canvas } = storeWithCanvas();
    store.addInkStroke(canvas, line());
    store.addInkStroke(canvas, line(6));
    const [first, second] = inkOf(store, canvas);
    store.eraseInkStrokes(canvas, new Set([first]));
    expect(inkOf(store, canvas)).toEqual([second]);
    store.undo();
    expect(inkOf(store, canvas)).toHaveLength(2);
  });

  it("removes the field when the last stroke goes", () => {
    const { store, canvas } = storeWithCanvas();
    store.addInkStroke(canvas, line());
    store.clearInk(canvas);
    expect("ink" in store.doc.node(canvas)!.style).toBe(false);
  });

  it("survives a save and reload as plain JSON", () => {
    const { store, canvas } = storeWithCanvas();
    store.addInkStroke(canvas, { ...line(), color: "#ff0000" });
    const reread = JSON.parse(JSON.stringify(store.doc.doc));
    expect(reread.sheets[0].nodes[canvas].style.ink[0]).toEqual({ ...line(), color: "#ff0000" });
  });
});

describe("pen mode keys", () => {
  const press = (store: EditorStore, key: string): void => {
    handleShortcut(store, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, target: null } as unknown as KeyboardEvent, 1000, 800);
  };

  it("P toggles the pen on a selected canvas and Escape leaves it", () => {
    const { store, canvas } = storeWithCanvas();
    store.select(canvas);
    press(store, "p");
    expect(store.getSnapshot().mode).toBe("ink");
    expect(store.getSnapshot().selection).toEqual([canvas]);
    press(store, "Escape");
    expect(store.getSnapshot().mode).toBe("select");
    expect(store.getSnapshot().selection).toEqual([canvas]);
  });

  it("P on an ordinary topic still starts typing", () => {
    const { store } = storeWithCanvas();
    const topic = store.doc.node(store.sheet.rootNodeId)!;
    store.select(topic.id);
    press(store, "p");
    expect(store.getSnapshot().mode).toBe("select");
    expect(store.getSnapshot().editingId).toBe(topic.id);
  });
});

describe("export", () => {
  function sheetWithInk(): Sheet {
    const model = new DocumentModel(DocumentModel.blank("m"));
    const sheet = model.sheet;
    const id = "canvas";
    sheet.nodes[id] = {
      id, type: "subtopic", parentId: sheet.rootNodeId, childrenIds: [], title: "Notes",
      position: { x: 0, y: 0, manual: false },
      style: { freeform: true, width: 720, height: 480, ink: [{ ...line(), color: "#ff0000" }] },
      collapsed: false, labels: [], markers: [], notes: "", task: null,
      metadata: { createdAt: "", updatedAt: "" },
    } as unknown as MindNode;
    sheet.nodes[sheet.rootNodeId].childrenIds.push(id);
    applyLayout(sheet, true, HEURISTIC_MEASURER);
    return sheet;
  }
  const opts = { measurer: HEURISTIC_MEASURER, colorOf: () => ({ fill: "#ffffff", text: "#000000" }), linkColorOf: () => "#000000" };

  it("writes the stroke into the SVG", async () => {
    const out = await sheetToSvg(sheetWithInk(), { ...opts, imageDataUri: async () => null } as never);
    expect(out.svg).toMatch(/<path d="M[^"]+" fill="none" stroke="#ff0000" stroke-width="3" stroke-linecap="round"/);
  });

  it("writes the stroke into the PDF as a round-ended line", async () => {
    const out = await sheetToPdf(sheetWithInk(), { ...opts, theme: THEMES.light } as never);
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    const raw = latin1(bytes);
    let content = raw;
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index! + m[0].length;
      const end = raw.indexOf("endstream", start);
      try { content += latin1(unzlibSync(bytes.subarray(start, end))); } catch { /* not deflated */ }
    }
    expect(content).toMatch(/1(\.0+)? 0(\.0+)? 0(\.0+)? RG/);
    expect(content).toMatch(/1 J 1 j/);
    expect(content).toMatch(/ l S/);
  });
});
