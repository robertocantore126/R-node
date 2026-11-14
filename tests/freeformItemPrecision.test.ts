// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { handleShortcut } from "../src/editor/shortcuts";

function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  const a = store.createFreeformItem(board.id, board.position.x + 200, board.position.y + 150, "", undefined, "rect")!;
  const b = store.createFreeformItem(board.id, board.position.x + 400, board.position.y + 150, "", undefined, "rect")!;
  store.cancelEdit?.();
  return { store, board, a, b };
}

describe("canvas items: precise geometry", () => {
  it("X / Y / W / H read and write the item's box, one undo step each", () => {
    const { store, a } = setup();
    const g = store.itemGeometry(a)!;
    expect(g).toMatchObject({ x: 200 - 60, y: 150 - 30, w: 120, h: 60 });
    store.setItemGeometry(a, { x: 100, y: 90 });
    expect(store.itemGeometry(a)).toMatchObject({ x: 100, y: 90, w: 120, h: 60 });
    store.setItemGeometry(a, { w: 40, h: 200 });
    expect(store.itemGeometry(a)).toMatchObject({ w: 40, h: 200 });
    store.undo();
    expect(store.itemGeometry(a)).toMatchObject({ w: 120, h: 60 });
  });

  it("the arrow keys nudge selected items: 1 px, 10 with Shift; the map is not walked", () => {
    const { store, a, b } = setup();
    store.selectMany([a, b]);
    const ga = store.itemGeometry(a)!, gb = store.itemGeometry(b)!;
    expect(store.canNudgeSelection()).toBe(true);
    const key = (k: string, shiftKey = false) => handleShortcut(store, new KeyboardEvent("keydown", { key: k, shiftKey }), 800, 600);
    key("ArrowRight");
    key("ArrowDown", true);
    expect(store.itemGeometry(a)).toMatchObject({ x: ga.x + 1, y: ga.y + 10 });
    expect(store.itemGeometry(b)).toMatchObject({ x: gb.x + 1, y: gb.y + 10 });
    expect(store.getSnapshot().selection).toEqual([a, b]);
  });

  it("a corner drag resizes width and height together; the opposite corner stays; Shift keeps proportions", () => {
    const { store, a } = setup();
    const g = store.itemGeometry(a)!;
    store.beginItemResize(a, "nw");
    store.setItemResizeDraft(-30, -20);
    store.commitItemResize();
    expect(store.itemGeometry(a)).toEqual({ x: g.x - 30, y: g.y - 20, w: g.w + 30, h: g.h + 20 });
    store.undo();
    store.beginItemResize(a, "se");
    store.setItemResizeDraft(120, 0, true);
    store.commitItemResize();
    expect(store.itemGeometry(a)).toMatchObject({ x: g.x, y: g.y, w: 240, h: 120 });
  });

  it("Escape during a corner drag puts the item back", () => {
    const { store, a } = setup();
    const g = store.itemGeometry(a)!;
    store.beginItemResize(a, "sw");
    store.setItemResizeDraft(-50, 50);
    store.cancelItemResize();
    expect(store.itemGeometry(a)).toEqual(g);
  });
});

describe("canvas items: arrange", () => {
  function three() {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const ids = [[100, 100], [300, 180], [600, 140]].map(([x, y]) => store.createFreeformItem(board.id, board.position.x + x, board.position.y + y, "", undefined, "rect")!);
    store.cancelEdit?.();
    store.selectMany(ids);
    return { store, board, ids };
  }

  it("aligns left edges and vertical centres, one undo step each", () => {
    const { store, ids } = three();
    store.alignSelection("left");
    expect(new Set(ids.map((id) => store.itemGeometry(id)!.x)).size).toBe(1);
    store.alignSelection("middle");
    const mids = ids.map((id) => { const g = store.itemGeometry(id)!; return g.y + g.h / 2; });
    expect(new Set(mids).size).toBe(1);
    store.undo();
    (store as unknown as { settleLayoutNow(): void }).settleLayoutNow();
    expect(new Set(ids.map((id) => store.itemGeometry(id)!.y)).size).toBe(3);
  });

  it("distributes with equal gaps, the outer two staying put", () => {
    const { store, ids } = three();
    store.setItemGeometry(ids[1], { x: 200 });
    const before = ids.map((id) => store.itemGeometry(id)!);
    store.distributeSelection("h");
    const g = ids.map((id) => store.itemGeometry(id)!);
    expect(g[0].x).toBe(before[0].x);
    expect(g[2].x).toBe(before[2].x);
    expect(g[1].x - (g[0].x + g[0].w)).toBe(g[2].x - (g[1].x + g[1].w));
  });

  it("to front / to back change the draw order, one undo step", () => {
    const { store, board, ids } = three();
    store.selectMany([ids[0]]);
    store.reorderSelection("front");
    expect(board.childrenIds.at(-1)).toBe(ids[0]);
    store.selectMany([ids[2]]);
    store.reorderSelection("back");
    expect(board.childrenIds[0]).toBe(ids[2]);
    store.undo();
    expect(board.childrenIds.at(-1)).toBe(ids[0]);
  });

  it("snapping: a group drag lands the grabbed item on the 10 px grid", () => {
    const { store, ids } = three();
    store.setItemGeometry(ids[0], { x: 103, y: 77 });
    store.selectMany(ids);
    store.beginGroupDrag(ids);
    const d = store.snapGroupDelta(ids[0], 14, 6, 10);
    store.commitGroupDrag(d.dx, d.dy);
    expect(store.itemGeometry(ids[0])).toMatchObject({ x: 120, y: 80 });
  });
});
