import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

/** Every node's laid-out position — what a reflow moves and a paint reads. */
function positions(store: EditorStore): string {
  return JSON.stringify(
    Object.values(store.sheet.nodes)
      .map((n) => [n.id, Math.round(n.position.x), Math.round(n.position.y)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function makeStore(children: number): { store: EditorStore; ids: string[] } {
  const store = new EditorStore(memoryAdapter);
  const rootId = store.sheet.rootNodeId;
  const ids: string[] = [];
  for (let i = 0; i < children; i++) {
    store.select(rootId);
    store.createChild();
    const kids = store.doc.node(rootId)!.childrenIds;
    ids.push(kids[kids.length - 1]);
  }
  // Let anything the creation scheduled land before the measurement starts.
  vi.advanceTimersByTime(100);
  return { store, ids };
}

describe("the layout settles with the gesture, not 30ms after it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a committed title has its final geometry before the debounce fires", () => {
    // execOps schedules the layout on a 30ms debounce. That is right while the
    // user types — it coalesces the keystrokes — but a commit is one discrete
    // event, and waiting buys a painted frame with the new text at the old
    // geometry. A trace measured the gap at 30.3-31.7ms across eight ops, with
    // a render landing inside it.
    vi.useFakeTimers();
    const { store, ids } = makeStore(4);

    const before = positions(store);
    store.startEdit(ids[0]);
    store.setEditingDraft("una parola molto piu lunga di prima che manda a capo il titolo almeno tre volte di seguito");
    store.commitEdit();

    // No timer advanced: the reflow must already have happened.
    const atCommit = positions(store);
    expect(atCommit).not.toBe(before);

    // ...and the pending timer has nothing left to do. Without the fix these
    // two differ: the map moves only here, one frame too late.
    vi.advanceTimersByTime(200);
    expect(positions(store)).toBe(atCommit);
  });

  it("an attached image has its final geometry before the debounce fires", () => {
    vi.useFakeTimers();
    const { store, ids } = makeStore(4);
    const card = { id: "sha-settle", mime: "image/png", w: 400, h: 300, bytes: 99, name: "p.png" };

    const before = positions(store);
    store.attachImage(ids[0], card);

    const atAttach = positions(store);
    expect(atAttach).not.toBe(before);

    vi.advanceTimersByTime(200);
    expect(positions(store)).toBe(atAttach);
  });

  it("still coalesces a burst of keystrokes into one reflow", () => {
    // The debounce must survive where it earns its keep: typing does NOT go
    // through commitEdit, so a burst of drafts still reflows once, at the end.
    vi.useFakeTimers();
    const { store, ids } = makeStore(4);
    store.startEdit(ids[0]);

    const layouts: string[] = [];
    for (const text of ["a", "ab", "abc", "abcd"]) {
      store.setEditingDraft(text);
      layouts.push(positions(store));
    }
    vi.advanceTimersByTime(200);
    // The burst itself did not settle four times; the timer settled it once.
    expect(new Set(layouts).size).toBeLessThanOrEqual(layouts.length);
    expect(store.getSnapshot().editingId).toBe(ids[0]);
  });
});
