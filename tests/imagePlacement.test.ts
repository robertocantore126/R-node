import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { nearestImageSide, SIDE_BAND } from "../src/ui/imageDrop";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

/** A topic much wider than tall — the common shape. */
const WIDE = { x: 0, y: 0, w: 200, h: 40 };
/** A narrow topic with several wrapped lines: taller than it is wide. */
const TALL = { x: 0, y: 0, w: 84, h: 140 };

function firstChild(store: EditorStore): string {
  const root = store.doc.node(store.sheet.rootNodeId)!;
  return root.childrenIds[root.childrenIds.length - 1];
}

describe("nearestImageSide", () => {
  it("sends a drop in the middle of a WIDE topic to the top slot", () => {
    expect(nearestImageSide(WIDE, 100, 20)).toBe("top");
  });

  it("sends a drop in the middle of a TALL topic to the top slot too", () => {
    // The regression this pins: measured in pixels the centre of an 84x140
    // box is 42px from a side and 70px from the top, so a plain nearest-edge
    // test answered "left" for a drop aimed squarely at the middle.
    expect(nearestImageSide(TALL, 42, 70)).toBe("top");
  });

  it("answers top for the whole middle band, whatever the aspect ratio", () => {
    for (const rect of [WIDE, TALL, { x: 0, y: 0, w: 120, h: 120 }]) {
      for (const fu of [0.3, 0.5, 0.7]) {
        for (const fv of [0.3, 0.5, 0.7]) {
          expect(nearestImageSide(rect, rect.x + rect.w * fu, rect.y + rect.h * fv)).toBe("top");
        }
      }
    }
  });

  it("picks the side the drop is actually near", () => {
    expect(nearestImageSide(WIDE, 4, 20)).toBe("left");
    expect(nearestImageSide(WIDE, 196, 20)).toBe("right");
    expect(nearestImageSide(WIDE, 100, 38)).toBe("bottom");
    expect(nearestImageSide(WIDE, 100, 2)).toBe("top");
    // And on the shape that used to get it wrong.
    expect(nearestImageSide(TALL, 4, 70)).toBe("left");
    expect(nearestImageSide(TALL, 80, 70)).toBe("right");
    expect(nearestImageSide(TALL, 42, 136)).toBe("bottom");
  });

  it("switches from side to middle exactly at the band", () => {
    const justInside = WIDE.x + WIDE.w * (SIDE_BAND - 0.01);
    const justOutside = WIDE.x + WIDE.w * (SIDE_BAND + 0.01);
    expect(nearestImageSide(WIDE, justInside, 20)).toBe("left");
    expect(nearestImageSide(WIDE, justOutside, 20)).toBe("top");
  });

  it("does not divide by zero on a degenerate box", () => {
    expect(nearestImageSide({ x: 0, y: 0, w: 0, h: 0 }, 0, 0)).toBe("top");
  });
});

describe("where an image lands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Ctrl+V attaches the clipboard image to the TOP slot, never to a side", async () => {
    // Paste has no way to express a side, and must not grow one: the user
    // cannot aim a keystroke. Dropping is the gesture that picks a side.
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    store.select(id);

    const item = {
      types: ["image/png"],
      getType: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    };
    vi.stubGlobal("navigator", { clipboard: { read: async () => [item] } });
    const attach = vi.spyOn(store, "attachImageFile").mockResolvedValue({ ok: true });

    await store.paste();

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toBe(id);
    // Either omitted (the default is "top") or explicitly "top".
    expect(attach.mock.calls[0][2] ?? "top").toBe("top");
  });

  it("moves an image between two slots of the SAME node in one undoable batch", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    const card = { id: "sha-side", mime: "image/png", w: 400, h: 300, bytes: 10, name: "p.png" };

    store.attachImage(id, card, "left");
    expect(store.doc.node(id)!.style.imageLeft).toBe("sha-side");

    store.assignImageToNode(id, id, "right", "left");
    expect(store.doc.node(id)!.style.imageLeft).toBeUndefined();
    expect(store.doc.node(id)!.style.imageRight).toBe("sha-side");

    store.undo();
    expect(store.doc.node(id)!.style.imageLeft).toBe("sha-side");
    expect(store.doc.node(id)!.style.imageRight).toBeUndefined();
  });

  it("is still a no-op when the image is dropped on the slot it already occupies", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    const card = { id: "sha-same", mime: "image/png", w: 400, h: 300, bytes: 10, name: "p.png" };

    store.attachImage(id, card, "left");
    store.assignImageToNode(id, id, "left", "left");
    expect(store.doc.node(id)!.style.imageLeft).toBe("sha-same");

    // One undo reaches past the no-op to the attach itself: the no-op must not
    // have pushed a history entry of its own.
    store.undo();
    expect(store.doc.node(id)!.style.imageLeft).toBeUndefined();
  });
});
