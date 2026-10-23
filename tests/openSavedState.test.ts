import "fake-indexeddb/auto";
import initSqlJs from "sql.js";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentModel } from "../src/core/doc";
import { EditorStore } from "../src/editor/store";
import { IndexedDbAssetStore } from "../src/persist/assets";
import { buildRnodeFile } from "../src/persist/rnodeFile";
import type { RnodeDocument } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

afterEach(() => vi.unstubAllGlobals());

/** Hand `loadFile` this file through the File System Access picker. */
function pick(bytes: BlobPart, name: string): void {
  const file = new File([bytes], name);
  vi.stubGlobal("window", {
    showOpenFilePicker: async () => [{ name, getFile: async () => file }],
  });
}

function adapter(save: (docs: RnodeDocument[]) => Promise<void> = async () => {}): StorageAdapter & { saved: number } {
  const a = { label: "test", saved: 0, async load() { return []; }, async save(docs: RnodeDocument[]) { a.saved++; await save(docs); } };
  return a;
}

it("a .rnode opened on the web reads as saved, and is in app storage", async () => {
  const doc = DocumentModel.blank("Thesis");
  const { bytes } = await buildRnodeFile(doc, doc.sheets[0], new IndexedDbAssetStore("open-saved-1"), { sql: await initSqlJs() });
  const storage = adapter();
  const store = new EditorStore(storage);
  pick(bytes.slice().buffer as ArrayBuffer, "Thesis.rnode");
  await store.loadFile();
  expect(store.getSnapshot().activeDocId).toBe(doc.documentId);
  expect(store.getSnapshot().sync).toBe("saved");
  expect(storage.saved).toBe(1);
});

it("a .rnode.json opened on the web reads as saved", async () => {
  const doc = DocumentModel.blank("Notes");
  const store = new EditorStore(adapter());
  pick(JSON.stringify(doc), "Notes.rnode.json");
  await store.loadFile();
  expect(store.getSnapshot().activeDocId).toBe(doc.documentId);
  expect(store.getSnapshot().sync).toBe("saved");
});

it("stays unsaved when app storage refuses the copy", async () => {
  const doc = DocumentModel.blank("Notes");
  const store = new EditorStore(adapter(async () => { throw new Error("quota"); }));
  pick(JSON.stringify(doc), "Notes.rnode.json");
  await store.loadFile();
  expect(store.getSnapshot().sync).toBe("dirty");
});

it("stays unsaved when the map is edited while the copy runs", async () => {
  const doc = DocumentModel.blank("Notes");
  let store!: EditorStore;
  store = new EditorStore(adapter(async () => {
    store.select(store.sheet.rootNodeId);
    store.createChild();
  }));
  pick(JSON.stringify(doc), "Notes.rnode.json");
  await store.loadFile();
  expect(store.getSnapshot().sync).toBe("dirty");
});
