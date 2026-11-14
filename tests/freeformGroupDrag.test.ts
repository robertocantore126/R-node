import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { FREEFORM_HEADER, FREEFORM_PADDING } from "../src/core/freeform";
import { EditorStore } from "../src/editor/store";

function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  const a = store.createFreeformItem(board.id, board.position.x + 100, board.position.y + 100, "", undefined, "rect")!;
  const b = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 200, "", undefined, "rect")!;
  store.cancelEdit?.();
  return { store, board, a, b };
}

const pos = (store: EditorStore, id: string) => ({ ...store.doc.requireNode(id).style.freeformPosition! });

describe("freeform multi-selection drag", () => {
  it("moves every selected item by the same amount in one undo step", () => {
    const { store, a, b } = setup();
    const pa = pos(store, a), pb = pos(store, b);
    store.beginGroupDrag([a, b]);
    store.setGroupDragDraft(40, 25);
    expect(pos(store, a)).toEqual({ x: pa.x + 40, y: pa.y + 25 });
    store.commitGroupDrag(50, 30);
    expect(pos(store, a)).toEqual({ x: pa.x + 50, y: pa.y + 30 });
    expect(pos(store, b)).toEqual({ x: pb.x + 50, y: pb.y + 30 });
    store.undo();
    expect(pos(store, a)).toEqual(pa);
    expect(pos(store, b)).toEqual(pb);
  });

  it("stops at the left margin and under the title band", () => {
    const { store, a, b } = setup();
    const pa = pos(store, a);
    store.beginGroupDrag([a, b]);
    store.commitGroupDrag(-5000, -5000);
    expect(pos(store, a)).toEqual({ x: FREEFORM_PADDING, y: FREEFORM_HEADER + FREEFORM_PADDING });
    expect(pa.x).toBeGreaterThan(FREEFORM_PADDING);
  });

  it("grows the canvas when the group is pushed past its edge", () => {
    const { store, board, a, b } = setup();
    const w0 = store.doc.requireNode(board.id).style.width ?? 720;
    store.beginGroupDrag([a, b]);
    store.commitGroupDrag(900, 0);
    expect(store.doc.requireNode(board.id).style.width!).toBeGreaterThan(w0);
  });

  it("cancel restores the items; only same-canvas selections form a group", () => {
    const { store, board, a, b } = setup();
    const pa = pos(store, a);
    store.beginGroupDrag([a, b]);
    store.setGroupDragDraft(80, 80);
    store.cancelGroupDrag();
    expect(pos(store, a)).toEqual(pa);
    expect(store.freeformGroup([a, b])).toEqual({ canvasId: board.id, roots: [a, b] });
    expect(store.freeformGroup([a, board.id])).toBeNull();
    expect(store.freeformGroup([a])).toBeNull();
  });
});
