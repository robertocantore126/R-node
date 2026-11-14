import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { FREEFORM_HEADER, FREEFORM_PADDING } from "../src/core/freeform";
import { EditorStore } from "../src/editor/store";
import { makeOp, type Op } from "../src/core/ops";

function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  const a = store.createFreeformItem(board.id, board.position.x + 100, board.position.y + 100, "", undefined, "rect")!;
  const b = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 200, "", undefined, "rect")!;
  store.cancelEdit?.();
  return { store, board, a, b };
}

/** Run the pending layout now (the store does this on its own after a debounce). */
const settle = (store: EditorStore): void => (store as unknown as { settleLayoutNow(): void }).settleLayoutNow();

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

  it("past the left/top edge the canvas grows that way; nothing moves on screen; one undo", () => {
    const { store, board, a, b } = setup();
    const pa = pos(store, a), pb = pos(store, b);
    const w0 = store.doc.requireNode(board.id).style.width ?? 720, h0 = store.doc.requireNode(board.id).style.height ?? 480;
    const screen = (id: string) => {
      const n = store.doc.requireNode(id), cam = store.getSnapshot().camera;
      return { x: Math.round(n.position.x - cam.x), y: Math.round(n.position.y - cam.y) };
    };
    const before = screen(b);
    store.beginGroupDrag([a, b]);
    store.commitGroupDrag(-300, -200);
    const sb = screen(b);
    // b was dragged by (-300,-200): on screen it is exactly there, though the canvas moved under it.
    expect([sb.x - before.x, sb.y - before.y]).toEqual([-300, -200]);
    // The leftmost/topmost item lands on the margin; the other keeps its distance.
    expect(pos(store, a)).toEqual({ x: FREEFORM_PADDING, y: FREEFORM_HEADER + FREEFORM_PADDING });
    expect(pos(store, b)).toEqual({ x: FREEFORM_PADDING + pb.x - pa.x, y: FREEFORM_HEADER + FREEFORM_PADDING + pb.y - pa.y });
    const grown = store.doc.requireNode(board.id).style;
    expect(grown.width!).toBeGreaterThan(w0);
    expect(grown.height!).toBeGreaterThan(h0);
    store.undo();
    expect(pos(store, a)).toEqual(pa);
    expect(pos(store, b)).toEqual(pb);
    expect(store.doc.requireNode(board.id).style.width ?? 720).toBe(w0);
  });

  it("a container grows left inside its canvas: the container moves, its items stay put in the world", () => {
    const { store, board } = setup();
    const c = store.createFreeformContainer(board.id, board.position.x + 400, board.position.y + 300)!;
    const box = store.doc.requireNode(c);
    const item = store.createFreeformItem(c, box.position.x + 100, box.position.y + 100, "", undefined, "rect")!;
    const other = store.createFreeformItem(c, box.position.x + 150, box.position.y + 120, "", undefined, "rect")!;
    const world = (id: string) => ({ ...store.doc.requireNode(id).position });
    const w0 = world(other), c0 = { ...store.doc.requireNode(c).style.freeformPosition! }, cw = store.doc.requireNode(c).style.width!;
    store.moveIntoFreeform(item, c, box.position.x - 80, box.position.y + 100);
    settle(store);
    const grown = store.doc.requireNode(c).style;
    expect(grown.width!).toBeGreaterThan(cw);
    expect(grown.freeformPosition!.x).toBeLessThan(c0.x);
    expect(world(other)).toMatchObject({ x: w0.x, y: w0.y });
  });

  it("ink past the edge and a pinned canvas: strokes shift with the content, the canvas moves", () => {
    const { store, board, a } = setup();
    const node = store.doc.requireNode(board.id);
    store.addInkStroke(board.id, { path: [200, 100, 220, 120], width: 2 });
    store.execOps([makeOp<Op & { type: "setPosition" }>("setPosition", { id: board.id, x: node.position.x, y: node.position.y, manual: true, prev: { ...node.position } })]);
    settle(store);
    const p0 = { ...store.doc.requireNode(board.id).position }, aw = { ...store.doc.requireNode(a).position };
    store.addInkStroke(board.id, { path: [-40, 100, -20, 110], width: 2 });
    settle(store);
    const after = store.doc.requireNode(board.id);
    const dx = p0.x - after.position.x;
    expect(dx).toBeGreaterThan(0);
    expect(after.style.ink![0].path[0]).toBe(200 + dx);
    expect(store.doc.requireNode(a).position).toMatchObject({ x: aw.x, y: aw.y });
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
