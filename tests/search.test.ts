import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { makeOp, type Op } from "../src/core/ops";
import { plainToRuns } from "../src/core/text";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() {
    return [];
  },
  async save() {
    /* no-op */
  },
};

function setTitle(store: EditorStore, id: string, title: string): void {
  const n = store.doc.requireNode(id);
  store.execOps([
    makeOp<Op & { type: "setTitle" }>("setTitle", {
      id,
      title,
      prev: n.title,
      titleRuns: plainToRuns(title),
      prevRuns: n.titleRuns,
    }),
  ]);
}

/** root -> branch("Alpha branch") -> leaf("Beta leaf"), branch collapsed. */
function collapsedBranch(store: EditorStore): { branch: string; leaf: string } {
  const root = store.doc.node(store.sheet.rootNodeId)!;
  store.select(root.id);
  store.createChild();
  const branch = root.childrenIds[root.childrenIds.length - 1];
  setTitle(store, branch, "Alpha branch");
  store.select(branch);
  store.createChild();
  const leaf = store.doc.requireNode(branch).childrenIds[0];
  setTitle(store, leaf, "Beta leaf");
  store.toggleCollapsed(branch);
  return { branch, leaf };
}

describe("in-map search (Ctrl+F)", () => {
  it("finds a match hidden inside a collapsed ancestor, not just visible nodes", () => {
    const store = new EditorStore(memoryAdapter);
    const { branch, leaf } = collapsedBranch(store);
    expect(store.doc.requireNode(branch).collapsed).toBe(true);
    // Precondition the old implementation depended on: the leaf is NOT visible.
    expect(store.doc.visibleIds(store.sheet.rootNodeId)).not.toContain(leaf);

    store.setSearch("beta");

    expect(store.getSnapshot().searchResults).toContain(leaf);
  });

  it("expands the collapsed ancestors of a match when jumping to it", () => {
    const store = new EditorStore(memoryAdapter);
    const { branch, leaf } = collapsedBranch(store);

    store.setSearch("beta");

    expect(store.doc.requireNode(branch).collapsed).toBe(false);
    expect(store.doc.visibleIds(store.sheet.rootNodeId)).toContain(leaf);
    expect(store.getSnapshot().selection).toEqual([leaf]);
  });

  it("searches notes as well as titles, case-insensitively", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.doc.node(store.sheet.rootNodeId)!;
    store.select(root.id);
    store.createChild();
    const node = root.childrenIds[root.childrenIds.length - 1];
    const n = store.doc.requireNode(node);
    store.execOps([
      makeOp<Op & { type: "setNotes" }>("setNotes", { id: node, notes: "Region Pair, 300 miles", prev: n.notes }),
    ]);

    store.setSearch("REGION PAIR");

    expect(store.getSnapshot().searchResults).toContain(node);
  });

  it("closeSearch clears the query, the results, the index and the open flag", () => {
    const store = new EditorStore(memoryAdapter);
    collapsedBranch(store);

    store.openSearch();
    store.setSearch("beta");
    expect(store.getSnapshot().searchOpen).toBe(true);

    store.closeSearch();
    const s = store.getSnapshot();
    expect(s.searchOpen).toBe(false);
    expect(s.search).toBe("");
    expect(s.searchResults).toEqual([]);
    expect(s.searchIndex).toBe(0);
  });
});
