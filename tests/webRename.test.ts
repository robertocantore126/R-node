import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { EditorStore, portableFileKey } from "../src/editor/store";

const adapter = { label: "test", async load() { return []; }, async save() {} };

interface Internals {
  fileHandles: Map<string, FileSystemFileHandle>;
  renameChain: Promise<void>;
}

function withHandle(handle: object): { store: EditorStore; key: string; internals: Internals } {
  const store = new EditorStore(adapter);
  const key = portableFileKey(store.getSnapshot().activeDocId, "rnode");
  const internals = store as unknown as Internals;
  internals.fileHandles.set(key, handle as FileSystemFileHandle);
  return { store, key, internals };
}

it("renaming the map renames the file a web save wrote, where the browser can move it", async () => {
  const handle = { name: "Old map.rnode", async move(name: string) { this.name = name; } };
  const { store, key, internals } = withHandle(handle);
  store.renameDocument(store.getSnapshot().activeDocId, "Thesis: chapter 2");
  await internals.renameChain;
  expect(handle.name).toBe("Thesis chapter 2.rnode");
  expect(internals.fileHandles.get(key)).toBe(handle);
});

it("without move, forgets the handle so the next save asks for the new name", async () => {
  const handle = { name: "Old map.rnode" };
  const { store, key, internals } = withHandle(handle);
  store.renameDocument(store.getSnapshot().activeDocId, "New name");
  await internals.renameChain;
  expect(handle.name).toBe("Old map.rnode");
  expect(internals.fileHandles.has(key)).toBe(false);
});
