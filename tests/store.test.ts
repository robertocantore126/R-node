import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

describe("new topic defaults", () => {
  it("gives every newly created topic a useful editable title", () => {
    const store = new EditorStore(memoryAdapter);

    store.createChild();
    expect(store.selectionNode?.type).toBe("main");
    expect(store.selectionNode?.title).toMatch(/^Main Topic \d+$/);

    store.createChild();
    expect(store.selectionNode?.type).toBe("subtopic");
    expect(store.selectionNode?.title).toBe("Subtopic 1");
  });

  it("keeps a manually pinned main topic pinned when reordered among root children", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const first = store.selectionNode;
    expect(first).toBeTruthy();
    if (!first) return;

    store.createChild();
    const second = store.selectionNode;
    expect(second).toBeTruthy();
    if (!second) return;

    store.doc.node(first.id)!.position = { x: 200, y: 100, manual: true };
    store.dropAt(first.id, second.id, "after", 250, 100);

    const moved = store.doc.node(first.id)!;
    expect(moved.position.manual).toBe(true);
    expect(moved.position.x).toBe(200);
    expect(moved.position.y).toBe(100);
  });
});
