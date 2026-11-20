import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { isBarePicture, isFreeTransform } from "../src/core/freeform";
import { EditorStore } from "../src/editor/store";
import { positionedImageSlots } from "../src/layout/measure";

/** A canvas holding one pasted picture (400×600 original, shown 180 wide). */
function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  store.sheet.attachments.push({ id: "img", mime: "image/png", w: 400, h: 600, bytes: 1 });
  // Far enough inside that a nw drag stays within the canvas (it would grow).
  const id = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 300, "", "img")!;
  store.cancelEdit?.();
  return { store, board, id };
}

describe("a picture in a canvas is the picture itself", () => {
  it("has a box exactly the image's size, the image edge to edge, no padding", () => {
    const { store, id } = setup();
    const n = store.doc.requireNode(id);
    expect(isBarePicture(n)).toBe(true);
    expect(isFreeTransform(store.sheet, n)).toBe(true);
    const g = store.itemGeometry(id)!;
    expect([g.w, g.h]).toEqual([180, 270]);
    const it0 = positionedImageSlots({ x: 0, y: 0, w: g.w, h: g.h }, n, (k) => (k === "img" ? { w: 400, h: 600 } : null)).items[0];
    expect([it0.x, it0.y, it0.size.w, it0.size.h]).toEqual([0, 0, 180, 270]);
  });

  it("scales from a corner with Shift, keeping the aspect ratio and the opposite corner", () => {
    const { store, id } = setup();
    const g = store.itemGeometry(id)!;
    store.beginItemResize(id, "nw");
    store.setItemResizeDraft(-90, -135, true);
    store.commitItemResize();
    const s = store.doc.requireNode(id).style;
    expect(s.imageWidth).toBe(270);
    expect(s.imageHeight).toBeUndefined();
    const g1 = store.itemGeometry(id)!;
    expect([g1.x + g1.w, g1.y + g1.h]).toEqual([g.x + g.w, g.y + g.h]);
  });

  it("stretches from an edge, and undoes in one step", () => {
    const { store, id } = setup();
    const g = store.itemGeometry(id)!;
    store.beginItemResize(id, "e");
    store.setItemResizeDraft(180, 0);
    store.commitItemResize();
    expect(store.itemGeometry(id)!.w).toBe(360);
    expect(store.itemGeometry(id)!.h).toBe(270);
    expect(store.doc.requireNode(id).style.imageHeight).toBe(270);
    store.undo();
    expect([store.itemGeometry(id)!.w, store.itemGeometry(id)!.h]).toEqual([g.w, g.h]);
  });

  it("a picture pasted onto a canvas item becomes a new free picture, not part of the item", async () => {
    const { store, board } = setup();
    const text = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 100, "Note")!;
    store.cancelEdit?.();
    const before = store.doc.requireNode(board.id).childrenIds.length;
    // Same path as paste/drop onto the selected item, without the image worker.
    (store as unknown as { importToCard: () => Promise<unknown> }).importToCard = async () => ({ ok: true, card: { id: "img", mime: "image/png", w: 400, h: 600, bytes: 1 } });
    const res = await store.attachImageFile(text, new Blob([]));
    expect(res.ok).toBe(true);
    expect(store.doc.requireNode(text).style.image).toBeUndefined();
    const kids = store.doc.requireNode(board.id).childrenIds;
    expect(kids.length).toBe(before + 1);
    expect(isBarePicture(store.doc.requireNode(kids[kids.length - 1]))).toBe(true);
  });

  it("a picture with a title is a normal item again", () => {
    const { store, id } = setup();
    const n = store.doc.requireNode(id);
    expect(isBarePicture({ ...n, title: "Caption" })).toBe(false);
  });
});
