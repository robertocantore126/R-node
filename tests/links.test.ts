import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { layoutSheet } from "../src/layout/mindmap";
import { groupShown } from "../src/layout/groups";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };

/** A map whose root has `n` children; returns their ids. */
function mapWithChildren(n: number): { store: EditorStore; kids: string[] } {
  const store = new EditorStore(memoryAdapter);
  const root = store.sheet.rootNodeId;
  for (let i = 0; i < n; i++) {
    store.select(root);
    store.createChild();
  }
  return { store, kids: [...store.sheet.nodes[root].childrenIds] };
}

describe("links (invisible groups)", () => {
  it("Link makes a group flagged link, with the selected topics", () => {
    const { store, kids } = mapWithChildren(3);
    store.select(kids[0]);
    store.select(kids[2], { additive: true });
    store.createLinkFromSelection();
    const g = store.sheet.boundaries.at(-1)!;
    expect(g.link).toBe(true);
    expect(g.memberIds).toEqual([kids[0], kids[2]]);
    store.undo();
    expect(store.sheet.boundaries.length).toBe(0);
  });

  it("takes no room in the layout, where a group does", () => {
    const { store, kids } = mapWithChildren(4);
    const at = () => JSON.stringify([...layoutSheet(store.sheet, true).positions]);
    const before = at();
    store.select(kids[1]);
    store.select(kids[2], { additive: true });
    store.createLinkFromSelection();
    expect(at()).toBe(before);
    store.undo();
    store.select(kids[1]);
    store.select(kids[2], { additive: true });
    store.createGroupFromSelection();
    expect(at()).not.toBe(before);
  });

  it("shows only with a member or the link selected, or with Show links on", () => {
    const g = { id: "g", memberIds: ["a", "b"], link: true };
    const none = new Set<string>();
    expect(groupShown(g, { selection: none })).toBe(false);
    expect(groupShown(g, { selection: new Set(["b"]) })).toBe(true);
    expect(groupShown(g, { selection: none, groupSel: "g" })).toBe(true);
    expect(groupShown(g, { selection: none, showLinks: true })).toBe(true);
    // An ordinary group is always shown.
    expect(groupShown({ id: "h", memberIds: ["a"] }, { selection: none })).toBe(true);
  });

  it("Show links toggles, and hiding drops a link selection nobody could see", () => {
    const { store, kids } = mapWithChildren(2);
    store.select(kids[0]);
    store.createLinkFromSelection();
    const id = store.sheet.boundaries[0].id;
    store.toggleShowLinks();
    expect(store.getSnapshot().showLinks).toBe(true);
    store.clearSelection();
    (store as unknown as { state: { groupSel: string | null } }).state.groupSel = id;
    store.toggleShowLinks();
    expect(store.getSnapshot().showLinks).toBe(false);
    expect(store.getSnapshot().groupSel).toBe(null);
  });
});
