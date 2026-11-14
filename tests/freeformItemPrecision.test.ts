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
