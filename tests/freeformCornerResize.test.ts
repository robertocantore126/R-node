import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { FREEFORM_HEADER, FREEFORM_PADDING } from "../src/core/freeform";
import { EditorStore } from "../src/editor/store";

function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  const a = store.createFreeformItem(board.id, board.position.x + 200, board.position.y + 150, "", undefined, "rect")!;
  store.cancelEdit?.();
  return { store, board, a };
}
const size = (store: EditorStore, id: string) => {
  const s = store.doc.requireNode(id).style;
  return [s.width ?? 720, s.height ?? 480];
};
/** Where a node sits on screen, in world units relative to the camera. */
const screen = (store: EditorStore, id: string) => {
  const n = store.doc.requireNode(id), cam = store.getSnapshot().camera;
  return [Math.round(n.position.x - cam.x), Math.round(n.position.y - cam.y)];
};
const drag = (store: EditorStore, id: string, corner: "nw" | "ne" | "sw" | "se", dx: number, dy: number) => {
  store.beginCanvasResize(id, corner);
  store.setCanvasResizeDraft(dx / 2, dy / 2); // a move on the way
  store.setCanvasResizeDraft(dx, dy);
  store.commitCanvasResize();
};

describe("canvas resize from every corner", () => {
  it("the bottom-right corner moves the right and bottom edges", () => {
    const { store, board } = setup();
    drag(store, board.id, "se", 100, 60);
    expect(size(store, board.id)).toEqual([820, 540]);
  });

  it("the top-left corner moves the left and top edges; the items stay where they are on screen", () => {
    const { store, board, a } = setup();
    const before = screen(store, a);
    drag(store, board.id, "nw", -100, -60);
    expect(size(store, board.id)).toEqual([820, 540]);
    expect(screen(store, a)).toEqual(before);
    store.undo();
    expect(size(store, board.id)).toEqual([720, 480]);
  });

  it("top-right and bottom-left mix the two", () => {
    const { store, board, a } = setup();
    const before = screen(store, a);
    drag(store, board.id, "ne", 40, -30);
    expect(size(store, board.id)).toEqual([760, 510]);
    drag(store, board.id, "sw", -50, 20);
    expect(size(store, board.id)).toEqual([810, 530]);
    expect(screen(store, a)).toEqual(before);
  });

  it("shrinking from the left or top stops at the content", () => {
    const { store, board, a } = setup();
    const at = store.doc.requireNode(a).style.freeformPosition!;
    drag(store, board.id, "nw", 5000, 5000);
    expect(store.doc.requireNode(a).style.freeformPosition).toEqual({ x: FREEFORM_PADDING, y: FREEFORM_HEADER + FREEFORM_PADDING });
    expect(size(store, board.id)).toEqual([720 - (at.x - FREEFORM_PADDING), 480 - (at.y - FREEFORM_HEADER - FREEFORM_PADDING)]);
  });

  it("an empty canvas shrinks to its smallest size from any corner", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const id = store.getSnapshot().selection[0];
    drag(store, id, "nw", 5000, 5000);
    expect(size(store, id)).toEqual([240, 160]);
  });

  it("Escape puts everything back, the view included", () => {
    const { store, board, a } = setup();
    const cam = { ...store.getSnapshot().camera }, pos = { ...store.doc.requireNode(a).style.freeformPosition! };
    store.beginCanvasResize(board.id, "nw");
    store.setCanvasResizeDraft(-120, -80);
    store.cancelCanvasResize();
    expect(size(store, board.id)).toEqual([720, 480]);
    expect(store.doc.requireNode(a).style.freeformPosition).toEqual(pos);
    expect(store.getSnapshot().camera).toMatchObject({ x: cam.x, y: cam.y });
  });

  it("a container inside a canvas grows left within it", () => {
    const { store, board } = setup();
    const c = store.createFreeformContainer(board.id, board.position.x + 450, board.position.y + 300)!;
    const at = { ...store.doc.requireNode(c).style.freeformPosition! };
    drag(store, c, "nw", -30, -20);
    expect(size(store, c)).toEqual([290, 190]);
    expect(store.doc.requireNode(c).style.freeformPosition).toEqual({ x: at.x - 30, y: at.y - 20 });
  });
});
