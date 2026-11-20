import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DocumentModel } from "../src/core/doc";
import type { RnodeDocument } from "../src/core/types";
import { BrowserLibraryAdapter, IndexedDbLibrary, MemoryLibrary } from "../src/persist/library";
import type { StorageAdapter } from "../src/persist/storage";
import { EditorStore } from "../src/editor/store";

const uniqueDb = (): string => `lib-${Date.now()}-${Math.random()}`;

function legacyWith(docs: RnodeDocument[]): StorageAdapter & { saves: number } {
  return {
    label: "legacy",
    saves: 0,
    async load() {
      return JSON.parse(JSON.stringify(docs)) as RnodeDocument[];
    },
    async save() {
      this.saves++;
    },
  };
}

function withPicture(title: string, imageId: string): RnodeDocument {
  const d = DocumentModel.blank(title);
  d.sheets[0].nodes[d.sheets[0].rootNodeId].style.image = imageId;
  return d;
}

describe("IndexedDbLibrary", () => {
  it("stores entries and bodies apart; put serializes at the call", async () => {
    const lib = new IndexedDbLibrary(uniqueDb());
    const doc = DocumentModel.blank("First");
    const write = lib.put(doc, { unsaved: true });
    doc.title = "changed after the call";
    await write;
    expect((await lib.get(doc.documentId))?.title).toBe("First");
    expect(await lib.list()).toEqual([expect.objectContaining({ documentId: doc.documentId, title: "First", unsaved: true })]);
  });

  it("an entry without a body lists but returns no body", async () => {
    const lib = new IndexedDbLibrary(uniqueDb());
    const doc = DocumentModel.blank("Filed");
    await lib.put(doc, { body: false });
    expect((await lib.list()).map((e) => e.documentId)).toEqual([doc.documentId]);
    expect(await lib.get(doc.documentId)).toBeNull();
  });

  it("answers the images of every map but one", async () => {
    const lib = new IndexedDbLibrary(uniqueDb());
    const a = withPicture("A", "img-a");
    const b = withPicture("B", "img-b");
    await lib.put(a);
    await lib.put(b);
    expect([...(await lib.assetIds(a.documentId))]).toEqual(["img-b"]);
    await lib.remove(b.documentId);
    expect([...(await lib.assetIds(a.documentId))]).toEqual([]);
  });
});

describe("BrowserLibraryAdapter", () => {
  it("migrates the old single-key store once and opens ONE map", async () => {
    const a = DocumentModel.blank("Alpha");
    const b = DocumentModel.blank("Beta");
    const legacy = legacyWith([a, b]);
    const adapter = new BrowserLibraryAdapter(new IndexedDbLibrary(uniqueDb()), legacy);
    const loaded = await adapter.load();
    expect(loaded.map((d) => d.documentId)).toEqual([a.documentId]);
    expect((await adapter.library.list()).map((e) => e.title).sort()).toEqual(["Alpha", "Beta"]);
    // The old store is read, never written: it stays as a backup.
    expect(legacy.saves).toBe(0);
  });

  it("save upserts: saving the open map never drops the others", async () => {
    const a = DocumentModel.blank("Alpha");
    const b = DocumentModel.blank("Beta");
    const adapter = new BrowserLibraryAdapter(new IndexedDbLibrary(uniqueDb()), legacyWith([a, b]));
    await adapter.load();
    b.title = "Beta edited";
    await adapter.save([b]);
    const titles = (await adapter.library.list()).map((e) => e.title).sort();
    expect(titles).toEqual(["Alpha", "Beta edited"]);
    // The map saved last is the one that reopens.
    expect((await adapter.load()).map((d) => d.documentId)).toEqual([b.documentId]);
  });
});

describe("one document at a time", () => {
  it("the editor holds a single map; the others are library entries loaded on demand", async () => {
    const a = DocumentModel.blank("Alpha");
    const b = DocumentModel.blank("Beta");
    const c = DocumentModel.blank("Gamma");
    const adapter = new BrowserLibraryAdapter(new IndexedDbLibrary(uniqueDb()), legacyWith([a, b, c]));
    const store = new EditorStore(adapter);
    await store.init();
    expect(store.getSnapshot().docs).toHaveLength(1);
    expect(store.getSnapshot().library.map((e) => e.title).sort()).toEqual(["Alpha", "Beta", "Gamma"]);

    await store.switchToDoc(b.documentId);
    expect(store.getSnapshot().docs.map((d) => d.documentId)).toEqual([b.documentId]);
    expect(store.getSnapshot().docTitle).toBe("Beta");
  });

  it("leaving a map with unsaved edits parks them, flagged, and they come back after a restart", async () => {
    const a = DocumentModel.blank("Alpha");
    const b = DocumentModel.blank("Beta");
    const lib = new IndexedDbLibrary(uniqueDb());
    const store = new EditorStore(new BrowserLibraryAdapter(lib, legacyWith([a, b])));
    await store.init();
    const nodes = Object.keys(store.sheet.nodes).length;
    store.createChildOf(store.sheet.rootNodeId);
    await store.switchToDoc(b.documentId);
    expect((await lib.list()).find((e) => e.documentId === a.documentId)?.unsaved).toBe(true);

    // A new session, reopening Alpha.
    await lib.setLastOpen(a.documentId);
    const again = new EditorStore(new BrowserLibraryAdapter(lib, legacyWith([])));
    await again.init();
    expect(again.getSnapshot().activeDocId).toBe(a.documentId);
    expect(Object.keys(again.sheet.nodes).length).toBe(nodes + 1);
    expect(again.getSnapshot().sync).toBe("dirty");
  });

  it("a session library keeps parked maps without their live objects", async () => {
    const lib = new MemoryLibrary();
    const doc = DocumentModel.blank("Kept");
    await lib.put(doc);
    const back = await lib.get(doc.documentId);
    expect(back).not.toBe(doc);
    expect(back?.title).toBe("Kept");
  });
});
