import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { EditorStore, docFileBaseName, portableFileKey } from "../src/editor/store";
import { makeOp, type Op } from "../src/core/ops";
import { getAssetStore, IndexedDbAssetStore } from "../src/persist/assets";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

describe("portableFileKey", () => {
  it("derives a distinct key per format for the same document", () => {
    const json = portableFileKey("doc-1", "json");
    const zip = portableFileKey("doc-1", "zip");
    expect(json).not.toBe(zip);
    expect(json).toBe("r-node.file-handle.doc-1:json");
    expect(zip).toBe("r-node.file-handle.doc-1:zip");
  });

  it("does not collide across documents", () => {
    expect(portableFileKey("doc-1", "json")).not.toBe(portableFileKey("doc-2", "json"));
  });
});

describe("docFileBaseName", () => {
  it("makes a filesystem-safe name out of the GUI title", () => {
    // Spaces and dashes SURVIVE. The old rule replaced everything outside
    // [\w-], which was invisible while the file name was write-only; now that
    // opening a file adopts its name as the title, "Vacation Plan" would come
    // back as "Vacation_Plan" and degrade further on every save/open cycle.
    expect(docFileBaseName("Vacation Plan")).toBe("Vacation Plan");
    expect(docFileBaseName("R-node — Roadmap")).toBe("R-node — Roadmap");
    // Only what the filesystem actually refuses is removed.
    expect(docFileBaseName("a:b*?c\"d<e>f|g")).toBe("a b c d e f g");
    expect(docFileBaseName("")).toBe("Untitled map");
    // Windows drops trailing dots and spaces silently, which would leave the
    // title and the real file name disagreeing the moment they were bound.
    expect(docFileBaseName("Report. ")).toBe("Report");
    // CON, PRN, AUX… are device names: no file can carry them.
    expect(docFileBaseName("con")).toBe("Untitled map");
  });
});

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

  it("shows a cancellable progress state while a save with images runs, and cancel aborts it", async () => {
    // A save that builds a .rnode.zip must expose state.op so the status bar
    // can render a progress bar + cancel button, and cancelLongOp() must
    // abort the heavy work and report it instead of leaving the UI blocked.
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const a = root.childrenIds[0];
    store.attachImage(a, { id: "a".repeat(64), mime: "image/png", w: 10, h: 10, bytes: 3 });
    const blobs: Blob[] = [];
    vi.spyOn(store as unknown as { download: (blob: Blob) => void }, "download")
      .mockImplementation((blob: Blob) => { blobs.push(blob); });

    // Gate the first asset read so the save is provably in flight when we
    // inspect the state and cancel.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const assetStore = getAssetStore();
    const realGet = assetStore.get.bind(assetStore);
    const getSpy = vi.spyOn(assetStore, "get").mockImplementation(async (id, level) => {
      await gate;
      return realGet(id, level);
    });
    try {
      const saving = store.saveNow();
      await vi.waitFor(() => expect(getSpy).toHaveBeenCalled());

      const mid = store.getSnapshot();
      expect(mid.op).not.toBeNull();
      expect(mid.op!.kind).toBe("save");
      expect(mid.op!.cancellable).toBe(true);

      store.cancelLongOp(); // the user presses Cancel
      release();
      await saving;

      const after = store.getSnapshot();
      expect(after.op).toBeNull();
      expect(after.sync).toBe("dirty");
      expect(after.message).toBe("Save cancelled");
      expect(blobs).toHaveLength(0); // nothing was downloaded
    } finally {
      getSpy.mockRestore();
    }
  });

  it("two concurrent saveNow run the queue ONCE more, with the most recent content", async () => {
    // The first save is slow (a real slow disk would be), and the content
    // changes between the two Ctrl+S presses: dropping the second request
    // would report "Saved" while the file holds a stale version. The queue
    // re-runs exactly once, with the content of THAT moment.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const captured: string[] = [];
    const slowAdapter: StorageAdapter = {
      label: "test",
      async load() { return []; },
      async save(docs) {
        // Serialize NOW: the running save captured the document BEFORE the
        // edit, exactly like a slow write that started earlier.
        captured.push(JSON.stringify(docs));
        await gate;
      },
    };
    const store = new EditorStore(slowAdapter);
    const blobs: Blob[] = [];
    vi.spyOn(store as unknown as { download: (blob: Blob) => void }, "download")
      .mockImplementation((blob: Blob) => { blobs.push(blob); });

    const root = store.doc.node(store.sheet.rootNodeId)!;
    store.createChild();
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;

    const first = store.saveNow(); // in flight, blocked on the gate
    store.execOps([
      makeOp<Op & { type: "setTitle" }>("setTitle", {
        id: main.id,
        title: "Versione corrente",
        prev: main.title,
      }),
    ]);
    const second = store.saveNow(); // arrives mid-save → queued, NOT dropped
    expect(captured).toHaveLength(1); // only the first write has started
    expect(JSON.parse(captured[0])[0].sheets[0].nodes[main.id].title).not.toBe("Versione corrente");

    release(); // the first save may now complete…
    await first;
    await second;

    // …and the queued re-run writes exactly ONE more time, newest content.
    // (blobs = the portable file, written after the adapter write: waiting on
    // it means the whole second save finished, download included.)
    await vi.waitFor(() => expect(blobs).toHaveLength(2));
    expect(captured).toHaveLength(2);
    expect(JSON.parse(captured[0])[0].sheets[0].nodes[main.id].title).not.toBe("Versione corrente");
    expect(JSON.parse(captured[1])[0].sheets[0].nodes[main.id].title).toBe("Versione corrente");
  });
});

describe("image selection, delete and move", () => {
  const IMG_ID = "f".repeat(64);
  const card = { id: IMG_ID, mime: "image/png", w: 10, h: 10, bytes: 3 };

  function twoMainTopics(store: EditorStore): [string, string] {
    store.createChild();
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    return [root.childrenIds[0], root.childrenIds[1]];
  }

  it("selects the image exclusively: clears node selection, and a node select clears it", () => {
    const store = new EditorStore(memoryAdapter);
    const [a] = twoMainTopics(store);
    store.attachImage(a, card);

    store.select(a);
    expect(store.getSnapshot().selection).toEqual([a]);

    store.selectImage(a);
    const s = store.getSnapshot();
    expect(s.imageSel).toBe(a);
    expect(s.selection).toEqual([]);

    // Selecting the node again drops the image selection.
    const root = store.sheet.rootNodeId;
    store.select(root);
    expect(store.getSnapshot().imageSel).toBeNull();
  });

  it("deleteSelectedImage removes only the image (node survives) and undo restores it", () => {
    const store = new EditorStore(memoryAdapter);
    const [a] = twoMainTopics(store);
    store.attachImage(a, card);
    store.selectImage(a);

    store.deleteSelectedImage();
    const node = store.doc.node(a)!;
    expect(node.style.image).toBeUndefined();
    expect(node).toBeDefined(); // the node itself is NOT deleted
    expect(store.getSnapshot().imageSel).toBeNull();
    // The attachment card stays: GC is explicit (collectOrphans).
    expect(store.sheet.attachments.some((c) => c.id === IMG_ID)).toBe(true);

    store.undo();
    expect(store.doc.node(a)!.style.image).toBe(IMG_ID);
  });

  it("deleteSelectedImage on a node without an image is a no-op", () => {
    const store = new EditorStore(memoryAdapter);
    // The root has no image and the store still has zero ops in history.
    store.selectImage(store.sheet.rootNodeId);
    store.deleteSelectedImage();
    expect(store.getSnapshot().canUndo).toBe(false); // no op was created
  });

  it("assignImageToNode moves the image between nodes as ONE undoable batch", () => {
    const store = new EditorStore(memoryAdapter);
    const [a, b] = twoMainTopics(store);
    store.attachImage(a, card);

    store.assignImageToNode(a, b);
    expect(store.doc.node(a)!.style.image).toBeUndefined();
    expect(store.doc.node(b)!.style.image).toBe(IMG_ID);
    // The image on the target stays selected.
    expect(store.getSnapshot().imageSel).toBe(b);

    store.undo();
    expect(store.doc.node(a)!.style.image).toBe(IMG_ID);
    expect(store.doc.node(b)!.style.image).toBeUndefined();
    store.redo();
    expect(store.doc.node(a)!.style.image).toBeUndefined();
    expect(store.doc.node(b)!.style.image).toBe(IMG_ID);
  });

  it("assignImageToNode no-ops for the same node, an image-less source, or a missing target", () => {
    const store = new EditorStore(memoryAdapter);
    const rootId = store.sheet.rootNodeId;
    store.createChild();
    const main = store.doc.node(rootId)!.childrenIds[0];
    store.attachImage(main, card);
    expect(store.doc.node(main)!.style.image).toBe(IMG_ID);

    store.assignImageToNode(main, main); // same node
    store.assignImageToNode("missing", main); // missing source
    store.assignImageToNode(rootId, main); // image-less source
    expect(store.doc.node(main)!.style.image).toBe(IMG_ID);

    // None of the no-ops pushed history: one undo reverts the attach itself.
    store.undo();
    expect(store.doc.node(main)!.style.image).toBeUndefined();
    store.redo();
    expect(store.doc.node(main)!.style.image).toBe(IMG_ID);
  });
});

describe("canvas resize drag", () => {
  it("commits a live width drag as ONE setStyle op with exact undo", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const id = root.id;
    const before = { ...store.doc.node(id)!.style };

    store.beginResize(id);
    store.setResizeDraft(id, 200);
    store.setResizeDraft(id, 180);
    expect(store.doc.node(id)!.style.width).toBe(180);
    store.commitResize();

    // exactly one op in history (two live drafts collapsed into one commit)
    expect(store.getSnapshot().canUndo).toBe(true);
    const node = store.doc.node(id)!;
    expect(node.style.width).toBe(180);

    store.undo();
    expect(store.doc.node(id)!.style.width).toBeUndefined();
    expect(store.doc.node(id)!.style).toEqual(before);
  });

  it("clamps the width to the allowed range and no-ops on a click without drag", () => {
    const store = new EditorStore(memoryAdapter);
    const id = store.sheet.rootNodeId;
    store.beginResize(id);
    store.setResizeDraft(id, 5); // below MIN_TOPIC_W
    expect(store.doc.node(id)!.style.width).toBe(84);
    store.setResizeDraft(id, 5000); // above the 640 cap
    expect(store.doc.node(id)!.style.width).toBe(640);
    store.commitResize();
    expect(store.doc.node(id)!.style.width).toBe(640);

    // a pointer-down/up with no move must not create an op
    const before = { ...store.doc.node(id)!.style };
    store.beginResize(id);
    store.commitResize();
    expect(store.doc.node(id)!.style).toEqual(before);
    const historyOps = store.getSnapshot().canUndo;
    store.undo();
    store.undo();
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(historyOps).toBe(true);
  });

  it("left-edge drag anchors the right edge: floating node keeps width + position, one undo restores both", () => {
    const store = new EditorStore(memoryAdapter);
    store.createFloatingAt(500, 200);
    store.cancelEdit(); // leave the auto-opened editor
    const f = Object.values(store.sheet.nodes).find((n) => n.type === "floating")!;
    store.select(f.id);
    store.beginResize(f.id);
    store.setResizeDraft(f.id, 220, { anchorRight: true, x: 480 }); // dragged 20 left
    store.commitResize();

    const node = store.doc.node(f.id)!;
    expect(node.style.width).toBe(220);
    expect(node.position.x).toBe(480);
    expect(node.position.manual).toBe(true);

    store.undo();
    const undone = store.doc.node(f.id)!;
    expect(undone.style.width).toBeUndefined();
    expect(undone.position.x).toBe(500);
  });

  it("left-edge drag on an auto-layout node keeps the width but returns the position to the layout slot", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    const origX = main.position.x;
    store.beginResize(main.id);
    store.setResizeDraft(main.id, 260, { anchorRight: true, x: origX - 40 });
    store.commitResize();

    const node = store.doc.node(main.id)!;
    expect(node.style.width).toBe(260);
    // auto node: position restored (not manual) — width is what survives
    expect(node.position.x).toBe(origX);
    expect(node.position.manual).toBe(false);

    store.undo();
    expect(store.doc.node(main.id)!.style.width).toBeUndefined();
  });

  it("commits an image width drag as ONE setStyle op with exact undo", () => {
    const store = new EditorStore(memoryAdapter);
    const id = store.sheet.rootNodeId;
    const before = { ...store.doc.node(id)!.style };

    store.beginImageResize(id);
    store.setImageResizeDraft(id, 200);
    store.setImageResizeDraft(id, 180);
    expect(store.doc.node(id)!.style.imageWidth).toBe(180);
    store.commitImageResize();

    const node = store.doc.node(id)!;
    expect(node.style.imageWidth).toBe(180);

    store.undo();
    expect(store.doc.node(id)!.style).toEqual(before);
  });

  it("clamps the image width to 48px minimum and no-ops on a click without drag", () => {
    const store = new EditorStore(memoryAdapter);
    const id = store.sheet.rootNodeId;
    store.beginImageResize(id);
    store.setImageResizeDraft(id, 10); // below the 48 floor
    expect(store.doc.node(id)!.style.imageWidth).toBe(48);
    store.commitImageResize();
    expect(store.doc.node(id)!.style.imageWidth).toBe(48);

    // pointer-down/up with no move must not create an op
    const before = { ...store.doc.node(id)!.style };
    store.beginImageResize(id);
    store.commitImageResize();
    expect(store.doc.node(id)!.style).toEqual(before);
  });

  it("resetImageWidth removes the custom width in one undoable op", () => {
    const store = new EditorStore(memoryAdapter);
    const id = store.sheet.rootNodeId;
    store.beginImageResize(id);
    store.setImageResizeDraft(id, 220);
    store.commitImageResize();
    expect(store.doc.node(id)!.style.imageWidth).toBe(220);

    store.resetImageWidth(id);
    expect(store.doc.node(id)!.style.imageWidth).toBeUndefined();

    store.undo();
    expect(store.doc.node(id)!.style.imageWidth).toBe(220);
  });

  it("dragging a subtopic onto empty canvas does not pin an absolute position", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);
    store.createChild();
    const sub = store.doc.node(main.childrenIds[0])!;
    const orig = { ...sub.position };

    store.dropAt(sub.id, null, "floating", 999, 888);

    const after = store.doc.node(sub.id)!;
    expect(after.position.manual).toBe(false);
    expect(after.position.x).toBe(orig.x);
    expect(after.position.y).toBe(orig.y);
  });

  it("dragging a main topic pins it and releases manual pins on its descendants so they follow", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);
    store.createChild();
    const sub = store.doc.node(main.childrenIds[0])!;
    // a legacy/previous manual pin on the subtopic
    store.doc.node(sub.id)!.position = { x: 300, y: 200, manual: true };

    store.dropAt(main.id, null, "floating", 700, 350);

    const moved = store.doc.node(main.id)!;
    const child = store.doc.node(sub.id)!;
    expect(moved.position.manual).toBe(true);
    expect(moved.position.x).toBe(700);
    expect(child.position.manual).toBe(false);
    // one undo restores the whole batch (main back to auto, child pinned again)
    store.undo();
    expect(store.doc.node(main.id)!.position.manual).toBe(false);
    expect(store.doc.node(sub.id)!.position.manual).toBe(true);
    expect(store.doc.node(sub.id)!.position.x).toBe(300);
  });

  it("floating topics keep being freely movable to an absolute position", () => {
    const store = new EditorStore(memoryAdapter);
    store.createFloatingAt(500, 200);
    store.cancelEdit(); // leave the auto-opened editor
    const f = Object.values(store.sheet.nodes).find((n) => n.type === "floating")!;

    store.dropAt(f.id, null, "floating", 400, 300);

    const after = store.doc.node(f.id)!;
    expect(after.position.manual).toBe(true);
    expect(after.position.x).toBe(400);
    expect(after.position.y).toBe(300);
  });

  describe("live node drag (fluid repositioning)", () => {
    it("a main topic follows the cursor and commits at the drop point, subtree settled immediately, one undo", () => {
      const store = new EditorStore(memoryAdapter);
      store.createChild();
      store.cancelEdit(); // leave the auto-opened editor
      const root = store.doc.node(store.sheet.rootNodeId)!;
      const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
      // give the main a child
      store.select(main.id);
      store.createChild();
      store.cancelEdit();
      const child = store.doc.node(main.childrenIds[0])!;
      // Pin the main at a known spot and settle the child relative to it:
      // fresh nodes carry pre-layout positions, so the baseline must come
      // from a settled layout.
      store.doc.node(main.id)!.position = { x: 200, y: 100, manual: true };
      store.beginNodeDrag(main.id);
      store.setNodeDragDraft(main.id, 200, 100); // same spot, but settles the layout
      store.resetNodeDragDraft(main.id); // no-op: nothing changed, child stays settled
      const offBefore = { x: child.position.x - 200, y: child.position.y - 100 };

      store.beginNodeDrag(main.id);
      store.setNodeDragDraft(main.id, 700, 350);
      // live follow: the main is pinned at the draft spot and the subtree
      // keeps its offset (it slid with the pointer)
      expect(store.doc.node(main.id)!.position.x).toBe(700);
      expect(store.doc.node(main.id)!.position.y).toBe(350);
      const offDuring = { x: child.position.x - 700, y: child.position.y - 350 };
      expect(offDuring).toEqual(offBefore);

      store.commitNodeDrag(main.id, null, "floating", 700, 350);

      const after = store.doc.node(main.id)!;
      expect(after.position).toEqual({ x: 700, y: 350, manual: true });
      // the subtree is settled IMMEDIATELY — no 30ms debounce window where
      // the child is still anchored to the main's old slot (release glitch)
      const offAfter = { x: child.position.x - 700, y: child.position.y - 350 };
      expect(offAfter).toEqual(offDuring);

      // one undo restores the exact pre-drag state
      store.undo();
      expect(store.doc.node(main.id)!.position).toEqual({ x: 200, y: 100, manual: true });
    });

    it("leaving the free-position zone mid-drag restores the pinned position", () => {
      const store = new EditorStore(memoryAdapter);
      store.createChild();
      store.cancelEdit(); // leave the auto-opened editor
      const root = store.doc.node(store.sheet.rootNodeId)!;
      const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
      store.doc.node(main.id)!.position = { x: 123, y: 456, manual: true };

      store.beginNodeDrag(main.id);
      store.setNodeDragDraft(main.id, 700, 350);
      store.resetNodeDragDraft(main.id);
      expect(store.doc.node(main.id)!.position).toEqual({ x: 123, y: 456, manual: true });
    });

    it("a subtopic drag never pins an absolute position (deep nodes stay in the auto layout)", () => {
      const store = new EditorStore(memoryAdapter);
      store.createChild();
      store.cancelEdit();
      const root = store.doc.node(store.sheet.rootNodeId)!;
      const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
      store.select(main.id);
      store.createChild();
      store.cancelEdit();
      const sub = store.doc.node(main.childrenIds[0])!;

      store.beginNodeDrag(sub.id);
      store.setNodeDragDraft(sub.id, 999, 888);
      store.commitNodeDrag(sub.id, null, "floating", 999, 888);

      const after = store.doc.node(sub.id)!;
      expect(after.position.manual).toBe(false);
      expect(after.position.x).not.toBe(999);
      expect(after.position.y).not.toBe(888);
    });
  });

  it("creates a group only from at least two sibling topics, undoable", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const first = store.doc.node(root.childrenIds[0])!;
    store.select(store.sheet.rootNodeId);
    store.createChild();
    const second = root.childrenIds.find((id) => id !== first.id)!;

    // single selection → rejected
    store.select(second);
    store.createGroupFromSelection();
    expect(store.sheet.boundaries).toHaveLength(0);

    store.selectMany([first.id, second]);
    store.createGroupFromSelection();
    expect(store.sheet.boundaries).toHaveLength(1);
    expect(store.sheet.boundaries[0].memberIds).toEqual(expect.arrayContaining([first.id, second]));

    store.undo();
    expect(store.sheet.boundaries).toHaveLength(0);
  });

  it("groups ANY selected topics, not just siblings, undoable", () => {
    const store = new EditorStore(memoryAdapter);
    // two children of the root, then a grandchild of the first: not siblings
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const first = store.doc.node(root.childrenIds[0])!;
    store.select(first.id);
    store.createChild();
    const grandchild = store.doc.node(first.childrenIds[0])!;

    store.selectMany([first.id, grandchild.id]);
    store.createGroupFromSelection();
    expect(store.sheet.boundaries).toHaveLength(1);
    expect(store.sheet.boundaries[0].memberIds).toEqual(expect.arrayContaining([first.id, grandchild.id]));

    store.undo();
    expect(store.sheet.boundaries).toHaveLength(0);

    // but a summary still needs siblings
    store.selectMany([first.id, grandchild.id]);
    store.createSummaryFromSelection();
    expect(store.sheet.summaries).toHaveLength(0);
  });

  it("creates a summary from sibling selection, undoable", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const first = store.doc.node(root.childrenIds[0])!;
    store.select(store.sheet.rootNodeId);
    store.createChild();
    const second = root.childrenIds.find((id) => id !== first.id)!;

    store.selectMany([first.id, second]);
    store.createSummaryFromSelection();
    expect(store.sheet.summaries).toHaveLength(1);
    expect(store.sheet.summaries[0].memberIds).toEqual(expect.arrayContaining([first.id, second]));

    store.undo();
    expect(store.sheet.summaries).toHaveLength(0);
  });

  it("deleting a main topic drops groups/summaries over its subtree", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.select(main.id);
    store.createChild();
    store.createChild(); // same parent stays selected → two subtopics
    const subs = [...main.childrenIds];
    store.selectMany(subs);
    store.createGroupFromSelection();
    store.createSummaryFromSelection();
    expect(store.sheet.boundaries).toHaveLength(1);
    expect(store.sheet.summaries).toHaveLength(1);

    store.deleteNodes([main.id]);
    expect(store.sheet.boundaries).toHaveLength(0);
    expect(store.sheet.summaries).toHaveLength(0);
  });

  it("relationship label edits are undoable and deletable", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const first = store.doc.node(root.childrenIds[0])!;
    store.select(store.sheet.rootNodeId);
    store.createChild();
    const second = root.childrenIds.find((id) => id !== first.id)!;
    store.createRelationship(first.id, second);
    const relId = store.sheet.relationships[0].id;

    store.setRelationship(relId, { label: "causes" });
    expect(store.sheet.relationships[0].label).toBe("causes");
    store.undo();
    expect(store.sheet.relationships[0].label).toBeUndefined();

    store.selectRelationship(relId);
    store.deleteSelectedRelationship();
    expect(store.sheet.relationships).toHaveLength(0);
    store.undo();
    expect(store.sheet.relationships).toHaveLength(1);
  });

  it("copySelectionOutline writes an indented hierarchy to the clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t: string) => { writes.push(t); } } },
      configurable: true,
    });
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.doc.node(main.id)!.title = "A";
    store.select(main.id);
    store.createChild();
    const sub = store.doc.node(main.childrenIds[0])!;
    store.doc.node(sub.id)!.title = "A1";
    store.select(store.sheet.rootNodeId);
    store.createChild();
    const other = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    store.doc.node(other.id)!.title = "B";

    store.selectMany([main.id, other.id]);
    await store.copySelectionOutline();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("A\n  A1\nB");
  });

  it("attachImage registers the card once and undo removes the reference, keeping the card", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const main = store.doc.node(root.childrenIds[root.childrenIds.length - 1])!;
    const card = { id: "sha-img", mime: "image/png", w: 400, h: 300, bytes: 1234, name: "pic.png" };

    store.attachImage(main.id, card);
    expect(store.sheet.attachments).toHaveLength(1);
    expect(store.doc.node(main.id)!.style.image).toBe("sha-img");

    // Same image on a second node: still one card.
    store.attachImage(root.id, card);
    expect(store.sheet.attachments).toHaveLength(1);
    expect(store.doc.node(root.id)!.style.image).toBe("sha-img");

    // One undo per op removes the references, and the shared card stays —
    // removing it on undo could break another user of the same image;
    // collectOrphans is the GC.
    store.undo();
    expect(store.doc.node(root.id)!.style.image).toBeUndefined();
    store.undo();
    expect(store.doc.node(main.id)!.style.image).toBeUndefined();
    expect(store.sheet.attachments).toHaveLength(1);

    // No image bytes ever entered the document.
    expect(JSON.stringify(store.sheet.attachments)).not.toContain("\"image\":");
  });
});

describe("orphan GC (T21-A)", () => {
  /** Three levels whose exact weight the size() accounting can assert on. */
  async function putAsset(store: IndexedDbAssetStore): Promise<string> {
    return store.put(
      {
        original: { blob: new Blob(["ORIGINAL"]), w: 1200, h: 800 },
        large: { blob: new Blob(["LARGE"]), w: 1024, h: 683 },
        small: { blob: new Blob(["SMALL"]), w: 256, h: 171 },
      },
      { mime: "image/png", w: 1200, h: 800, bytes: 8 }
    );
  }

  it("reports and recovers an asset orphaned by deleting its node", async () => {
    const assetStore = new IndexedDbAssetStore(`gc-test-${Date.now()}-${Math.random()}`);
    const id = await putAsset(assetStore);
    const expectedBytes = await assetStore.size(id);
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal("window", { confirm });

    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const nodeId = root.childrenIds[root.childrenIds.length - 1];
    store.attachImage(nodeId, { id, mime: "image/png", w: 1200, h: 800, bytes: 8 });
    store.deleteNodes([nodeId]);

    await store.gcOrphans(assetStore);

    // The confirmation asked first, with cards + blobs + BYTES and the
    // non-undoable declaration.
    expect(confirm).toHaveBeenCalledTimes(1);
    const prompt = confirm.mock.calls[0][0] as string;
    expect(prompt).toMatch(/1 card and 1 image blob/);
    expect(prompt).toContain("NOT undoable");
    expect(prompt).toContain(`${expectedBytes}`);

    // The card is gone from the document and the bytes from the store.
    expect(store.sheet.attachments).toHaveLength(0);
    expect(await assetStore.list()).toEqual([]);
    expect(await assetStore.size(id)).toBe(0);

    // The trap made explicit: undo restores the CARD, never the bytes.
    store.undo();
    expect(store.sheet.attachments).toHaveLength(1);
    expect(await assetStore.size(id)).toBe(0);
    vi.unstubAllGlobals();
  });

  it("does not ask when there is nothing to collect", async () => {
    const assetStore = new IndexedDbAssetStore(`gc-none-${Date.now()}-${Math.random()}`);
    const id = await putAsset(assetStore);
    const confirm = vi.fn((_message: string) => true);
    vi.stubGlobal("window", { confirm });

    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const root = store.doc.node(store.sheet.rootNodeId)!;
    const nodeId = root.childrenIds[root.childrenIds.length - 1];
    store.attachImage(nodeId, { id, mime: "image/png", w: 1200, h: 800, bytes: 8 });

    await store.gcOrphans(assetStore);

    expect(confirm).not.toHaveBeenCalled();
    expect(store.getSnapshot().message).toMatch(/Nothing to collect/);
    // Nothing was touched.
    expect(store.sheet.attachments).toHaveLength(1);
    expect(await assetStore.list()).toEqual([id]);
    vi.unstubAllGlobals();
  });
});
