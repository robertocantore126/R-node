/**
 * Ctrl+V of a picture (pasteImageFile). The traps it guards: a diagram with
 * nothing selected dropping the paste in silence, a picture landing at the
 * page's top-left (thousands of px off screen on a big diagram), and a chart
 * inside a canvas getting a loose picture beside it instead of the picture
 * in its board — the canvas, not the selected item, used to be the target.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import type { AttachmentInfo, MindNode } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };

/** The image import (worker + decoder) is replaced by a 300x150 card. */
function withFakeImport(store: EditorStore): EditorStore {
  (store as unknown as { importToCard: (f: File) => Promise<{ ok: true; card: AttachmentInfo }> }).importToCard = async (f) => ({
    ok: true,
    card: { id: `id:${f.name}`, mime: "image/png", w: 300, h: 150, bytes: 1, name: f.name },
  });
  return store;
}

const file = (name: string): File => new File([new Uint8Array([1])], name, { type: "image/png" });

function diagram(): { store: EditorStore; page: string; first: string } {
  const store = withFakeImport(new EditorStore(memoryAdapter));
  store.newDocument("diagram");
  store.cancelEdit();
  const page = store.sheet.rootNodeId;
  return { store, page, first: store.sheet.nodes[page].childrenIds[0] };
}

const pictures = (store: EditorStore, page: string): MindNode[] =>
  store.sheet.nodes[page].childrenIds.map((id) => store.sheet.nodes[id]).filter((n) => n.style.image);

describe("pasting a picture into a diagram", () => {
  it("with nothing selected, lands on the page in the middle of the view", async () => {
    const { store, page } = diagram();
    store.clearSelection();
    expect(await store.pasteImageFile(file("a.png"))).toBe(true);
    const [pic] = pictures(store, page);
    expect(pic).toBeDefined();
    const cam = store.getSnapshot().camera;
    const p = store.sheet.nodes[page].position;
    // 180 px wide, 90 tall (300x150): centred on the camera.
    expect(pic.style.freeformPosition).toEqual({ x: cam.x - p.x - 90, y: cam.y - p.y - 45 });
  });

  it("with a shape selected, goes into the shape, above its text", async () => {
    const { store, page, first } = diagram();
    store.select(first);
    await store.pasteImageFile(file("b.png"));
    expect(pictures(store, page).filter((n) => n.id !== first)).toHaveLength(0);
    expect(store.sheet.nodes[first].style.image).toBe("id:b.png");
  });

  it("with a chart on the page selected, fills the chart instead of adding a loose picture", async () => {
    const { store, page, first } = diagram();
    store.createChartTopic(first);
    store.cancelEdit();
    const chart = store.sheet.nodes[page].childrenIds.map((id) => store.sheet.nodes[id]).find((n) => n.style.gallery?.chart)!;
    store.select(chart.id);
    await store.pasteImageFile(file("c.png"));
    expect(store.sheet.nodes[chart.id].style.gallery!.items.filter((i) => i.id)).toHaveLength(1);
    expect(pictures(store, page)).toHaveLength(0);
  });

  it("the shape being edited is the target when the editor passes it", async () => {
    const { store, first } = diagram();
    store.clearSelection();
    await store.pasteImageFile(file("d.png"), first);
    expect(store.sheet.nodes[first].style.image).toBe("id:d.png");
  });
});

describe("pasting a picture into a mind map", () => {
  it("goes into the selected topic", async () => {
    const store = withFakeImport(new EditorStore(memoryAdapter));
    store.newDocument("map");
    const root = store.sheet.rootNodeId;
    store.cancelEdit();
    store.select(root);
    expect(await store.pasteImageFile(file("e.png"))).toBe(true);
    expect(store.sheet.nodes[root].style.image).toBe("id:e.png");
  });

  it("with nothing selected, is refused (there is no canvas to drop it on)", async () => {
    const store = withFakeImport(new EditorStore(memoryAdapter));
    store.newDocument("map");
    store.cancelEdit();
    store.clearSelection();
    expect(await store.pasteImageFile(file("f.png"))).toBe(false);
  });
});
