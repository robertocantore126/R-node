import { describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { makeOp, type Op } from "../src/core/ops";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

describe("new topic defaults", () => {
  it("gives every newly created topic a useful editable title", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const rootKidsBefore = root.childrenIds.length;

    // No selection → the child is created under the root as a main topic.
    store.createChild();
    expect(root.childrenIds.length).toBe(rootKidsBefore + 1);
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    expect(main.type).toBe("main");
    expect(main.title).toMatch(/^Main Topic \d+$/);

    // Tab keeps the source selected: with the main topic selected, the next
    // child is a subtopic of it — created under the same parent, no nesting.
    store.select(main.id);
    store.createChild();
    expect(main.childrenIds.length).toBe(1);
    const child = store.doc.node(main.childrenIds[0])!;
    expect(child.type).toBe("subtopic");
    expect(child.title).toBe("Subtopic 1");
  });

  it("keeps a manually pinned main topic pinned when reordered among root children", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const first = store.doc.node(root.childrenIds[0])!;

    // select the root so the next createChild makes a sibling main topic
    store.select(store.sheet.rootNodeId);
    store.createChild();
    const second = root.childrenIds.find((id) => id !== first.id);
    expect(second).toBeTruthy();
    if (!second) return;

    store.doc.node(first.id)!.position = { x: 200, y: 100, manual: true };
    store.dropAt(first.id, second, "after", 250, 100);

    const moved = store.doc.node(first.id)!;
    expect(moved.position.manual).toBe(true);
    expect(moved.position.x).toBe(200);
    expect(moved.position.y).toBe(100);
  });

  it("Tab adds children under the same parent without selecting or editing", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const parent = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(parent.id);

    // Tab 1: child created, selection stays on parent, editor NOT opened.
    store.createChild();
    expect(parent.childrenIds.length).toBe(1);
    expect(store.getSnapshot().selection).toEqual([parent.id]);
    expect(store.getSnapshot().editingId).toBeNull();

    // Tab 2: another child under the SAME parent (no nesting, no stealing).
    store.createChild();
    expect(parent.childrenIds.length).toBe(2);
    expect(store.getSnapshot().selection).toEqual([parent.id]);
    expect(store.sheet.nodes[parent.childrenIds[1]].parentId).toBe(parent.id);
  });
});

describe("type-to-edit", () => {
  it("starts editing the selected topic with the typed character", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);

    store.typeToEdit("H");
    const s = store.getSnapshot();
    expect(s.editingId).toBe(main.id);
    expect(s.selection).toEqual([main.id]);
    expect(s.pendingInsert).toBe("H");

    // TopicEditor consumes the pending insert once, then it is gone.
    expect(store.consumePendingInsert()).toBe("H");
    expect(store.consumePendingInsert()).toBeNull();
  });

  it("buffers extra keystrokes while the type-to-edit editor is mounting", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);

    // First character starts editing; the next one arrives before the
    // textarea has consumed the pending insert — it must be buffered, not lost.
    store.typeToEdit("f");
    expect(store.appendPendingInsert("a")).toBe(true);
    expect(store.appendPendingInsert("s")).toBe(true);
    expect(store.consumePendingInsert()).toBe("fas");

    // Once consumed (editor mounted), the textarea owns the keyboard: the
    // buffer is closed and keys must NOT be appended.
    expect(store.appendPendingInsert("t")).toBe(false);
  });

  it("commits the in-progress edit when the selection changes (click away)", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[0])!;
    store.select(main.id);
    store.typeToEdit("H");

    // TopicEditor keeps the store draft in sync with every keystroke.
    store.setEditingDraft("Hello typed text");

    // Clicking another node runs BEFORE the textarea blur: selection changes
    // must commit the draft instead of discarding it.
    store.select(root.id);
    expect(store.doc.node(main.id)!.title).toBe("Hello typed text");
    expect(store.getSnapshot().editingId).toBeNull();
  });

  it("commits the draft on commitEdit() and discards it on cancelEdit()", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[0])!;
    store.select(main.id);
    store.startEdit(main.id);
    store.setEditingDraft("Kept text");
    store.commitEdit();
    expect(store.doc.node(main.id)!.title).toBe("Kept text");

    store.startEdit(main.id);
    store.setEditingDraft("Discarded text");
    store.cancelEdit();
    expect(store.doc.node(main.id)!.title).toBe("Kept text");
    expect(store.getSnapshot().editingId).toBeNull();
  });

  it("Ctrl+S saves the in-progress draft without closing the editor", async () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[0])!;
    store.select(main.id);
    store.startEdit(main.id);
    store.setEditingDraft("Saved while typing");

    // first save downloads the .rnode.json — stub it (no DOM in node env)
    vi.spyOn(store as unknown as { download: () => void }, "download").mockImplementation(() => {});
    await store.saveNow();

    // The draft was committed to the document AND the editor stays open.
    expect(store.doc.node(main.id)!.title).toBe("Saved while typing");
    expect(store.getSnapshot().editingId).toBe(main.id);
    expect(store.getSnapshot().sync).toBe("saved");
  });

  it("commits a rich-text draft as a setTitle op with titleRuns", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);
    store.startEdit(main.id);

    // The Lexical overlay pushes runs on every keystroke (bold + color here).
    store.setEditingDraftRuns([
      { text: "Rich ", bold: true },
      { text: "text", color: "#ff0000" },
    ]);
    store.commitEdit();

    const node = store.doc.node(main.id)!;
    expect(node.title).toBe("Rich text");
    expect(node.titleRuns).toEqual([
      { text: "Rich ", bold: true },
      { text: "text", color: "#ff0000" },
    ]);
    expect(store.getSnapshot().editingId).toBeNull();
  });

  it("undo restores the exact pre-edit runs; redo reapplies them", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    // Give the node a rich baseline BEFORE editing.
    store.execOps([
      makeOp<Op & { type: "setTitle" }>("setTitle", {
        id: main.id,
        title: "Baseline",
        prev: main.title,
        titleRuns: [{ text: "Base", italic: true }],
        prevRuns: main.titleRuns,
      }),
    ]);
    const baselineRuns = store.doc.node(main.id)!.titleRuns;

    store.select(main.id);
    store.startEdit(main.id);
    store.setEditingDraftRuns([{ text: "Bold new title", bold: true }]);
    store.commitEdit();
    expect(store.doc.node(main.id)!.title).toBe("Bold new title");

    store.undo();
    // the original rich runs come back exactly
    expect(store.doc.node(main.id)!.title).toBe("Baseline");
    expect(store.doc.node(main.id)!.titleRuns).toEqual(baselineRuns);

    store.redo();
    expect(store.doc.node(main.id)!.title).toBe("Bold new title");
    expect(store.doc.node(main.id)!.titleRuns?.[0]?.bold).toBe(true);
  });

  it("cancelEdit discards rich runs and restores the original", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);
    store.startEdit(main.id);
    const before = store.doc.node(main.id)!.title;
    store.setEditingDraftRuns([{ text: "discarded", italic: true }]);
    store.cancelEdit();
    expect(store.doc.node(main.id)!.title).toBe(before);
    expect(store.getSnapshot().editingId).toBeNull();
  });

  it("pastes plain text into the selected topic (falls back from map paste)", async () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);

    vi.stubGlobal("navigator", { clipboard: { readText: async () => "plain pasted text" } });
    await store.paste();
    vi.unstubAllGlobals();

    const s = store.getSnapshot();
    expect(s.editingId).toBe(main.id);
    expect(s.pendingInsert).toBe("plain pasted text");
  });
});

describe("save / load file", () => {
  it("round-trips a document through the .rnode.json format", () => {
    const store = new EditorStore(memoryAdapter);
    const original = store.doc.doc;

    const json = JSON.stringify(original);
    const id = store.importDocumentFromJson(json);

    expect(id).toBe(original.documentId);
    // the same documentId replaces the existing entry instead of duplicating
    expect(store.getSnapshot().docs.length).toBe(1);
    expect(store.sheet.nodes[store.sheet.rootNodeId].title).toBe(original.sheets[0].nodes[original.sheets[0].rootNodeId].title);
  });

  it("imports a second document as an additional entry and switches to it", () => {
    const store = new EditorStore(memoryAdapter);
    const second = JSON.parse(JSON.stringify(store.doc.doc));
    second.documentId = "d_other";
    second.title = "Imported map";
    const id = store.importDocumentFromJson(JSON.stringify(second));

    expect(id).toBe("d_other");
    expect(store.getSnapshot().docs.length).toBe(2);
    expect(store.getSnapshot().activeDocId).toBe("d_other");
    expect(store.getSnapshot().docTitle).toBe("Imported map");
    // loaded from disk → needs a save to persist in app storage
    expect(store.getSnapshot().sync).toBe("dirty");
  });

  it("rejects malformed files", () => {
    const store = new EditorStore(memoryAdapter);
    expect(store.importDocumentFromJson("not json")).toBeNull();
    expect(store.importDocumentFromJson("{}")).toBeNull();
    expect(store.importDocumentFromJson(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(store.importDocumentFromJson(JSON.stringify({ documentId: "d_x" }))).toBeNull();
    expect(store.importDocumentFromJson(JSON.stringify({ documentId: "d_x", sheets: [] }))).toBeNull();
    expect(store.importDocumentFromJson(JSON.stringify({ documentId: "d_x", sheets: [{ rootNodeId: "r" }] }))).toBeNull();
    expect(store.importDocumentFromJson(JSON.stringify({ documentId: "d_x", sheets: [{ rootNodeId: "r", nodes: {} }] }))).toBeNull();
  });

  it("writes the CURRENT content on every save (download fallback without the File System Access API)", async () => {
    const store = new EditorStore(memoryAdapter);
    const blobs: Blob[] = [];
    const download = vi
      .spyOn(store as unknown as { download: (blob: Blob) => void }, "download")
      .mockImplementation((blob: Blob) => { blobs.push(blob); });

    const root = store.doc.node(store.sheet.rootNodeId)!;
    store.createChild();
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.execOps([
      { opId: "t", actorId: "t", ts: new Date().toISOString(), type: "setTitle", id: main.id, title: "Versione corrente", prev: main.title } as never,
    ]);

    await store.saveNow();
    await store.saveNow(); // second save must not be stale either

    expect(store.getSnapshot().sync).toBe("saved");
    expect(download).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(await blobs[1].text());
    expect(parsed.sheets[0].nodes[main.id].title).toBe("Versione corrente");
  });

  it("saves a document loaded from storage with current content after reload", async () => {
    const stored: StorageAdapter = {
      label: "test",
      async load() {
        return [new EditorStore(memoryAdapter).doc.doc];
      },
      async save() { /* no-op */ },
    };
    const store = new EditorStore(stored);
    await store.init();
    const blobs: Blob[] = [];
    vi.spyOn(store as unknown as { download: (blob: Blob) => void }, "download")
      .mockImplementation((blob: Blob) => { blobs.push(blob); });

    await store.saveNow();
    expect(blobs).toHaveLength(1); // the file is written with current content
    expect(store.getSnapshot().sync).toBe("saved");
  });
});
