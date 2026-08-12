import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriAssetStore, type AssetMeta } from "../src/persist/assets";
import { TauriStorageAdapter } from "../src/persist/storage";
import { EditorStore } from "../src/editor/store";
import type { RnodeDocument } from "../src/core/types";

type InvokeArgs = Record<string, unknown>;

/** Install a fake window.__TAURI__.core.invoke; records every call. */
function installTauri(impl: (cmd: string, args: InvokeArgs) => Promise<unknown>): { cmd: string; args: InvokeArgs }[] {
  const calls: { cmd: string; args: InvokeArgs }[] = [];
  const invoke = vi.fn(async (cmd: string, args: InvokeArgs) => {
    calls.push({ cmd, args });
    return impl(cmd, args);
  });
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: { core: { invoke } } };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.restoreAllMocks();
});

const ID = "a".repeat(64);
const meta: AssetMeta = { id: ID, mime: "image/png", w: 10, h: 10, bytes: 3, name: "x.png" };
const metaBytes = [...new TextEncoder().encode(JSON.stringify(meta))];

/** Raw bytes as Tauri actually delivers them: an ArrayBuffer. */
function raw(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

describe("TauriAssetStore", () => {
  it("passes the current path to every command", async () => {
    const calls = installTauri(async (cmd, args) => {
      if (cmd === "default_document_path") return "C:/default";
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset") return raw([1, 2, 3]);
      return null;
    });
    const store = new TauriAssetStore();
    await store.get(ID, "large");
    await store.meta(ID);
    await store.list();
    const paths = calls.filter((c) => c.cmd !== "default_document_path").map((c) => c.args.path);
    expect(paths.every((p) => p === "C:/default")).toBe(true);
  });

  it("get returns a Blob from raw IPC bytes (ArrayBuffer)", async () => {
    installTauri(async (cmd, args) => {
      if (cmd === "default_document_path") return "C:/default";
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset") return raw([1, 2, 3]);
      return null;
    });
    const store = new TauriAssetStore();
    const blob = await store.get(ID, "large");
    expect(blob).not.toBeNull();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("get of a missing asset returns null (empty body)", async () => {
    installTauri(async (cmd) => (cmd === "default_document_path" ? "C:/default" : new ArrayBuffer(0)));
    const store = new TauriAssetStore();
    expect(await store.get(ID, "large")).toBeNull();
  });

  it("setRoot switches the SAME instance to a new path (the Renderer trap)", async () => {
    const calls = installTauri(async () => null);
    const store = new TauriAssetStore();

    store.setRoot("C:/mapA.rnode");
    await store.get(ID, "large");
    store.setRoot("C:/mapB.rnode");
    await store.get(ID, "large");

    const reads = calls.filter((c) => c.cmd === "get_asset").map((c) => c.args.path);
    expect(reads).toEqual(["C:/mapA.rnode", "C:/mapB.rnode"]);
  });

  it("adoptFile copies every referenced asset to the new file BEFORE switching", async () => {
    const OLD = "C:/old";
    const NEW = "C:/new.rnode";
    const calls = installTauri(async (cmd, args) => {
      if (cmd === "default_document_path") return OLD;
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset" && args.level === "original") return raw([1, 2, 3]);
      if (cmd === "get_asset" && args.level === "large") return raw([4, 5]);
      if (cmd === "get_asset" && args.level === "small") return raw([6]);
      return null;
    });
    const store = new TauriAssetStore();
    await store.adoptFile(NEW, [ID]);

    // Reads happened against the OLD path…
    const reads = calls.filter((c) => c.cmd === "get_asset").map((c) => c.args.path);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((p) => p === OLD)).toBe(true);

    // …and the writes went to the NEW one: all four levels per asset.
    const puts = calls.filter((c) => c.cmd === "put_asset");
    expect(puts).toHaveLength(4);
    expect(puts.every((p) => p.args.path === NEW)).toBe(true);
    expect(puts.map((p) => p.args.level).sort()).toEqual(["large", "meta", "original", "small"]);

    // After the switch, reads come from the new file.
    calls.length = 0;
    await store.get(ID, "large");
    expect(calls.find((c) => c.cmd === "get_asset")?.args.path).toBe(NEW);
  });

  it("adoptFile with no referenced assets just switches the path", async () => {
    const calls = installTauri(async (cmd) => (cmd === "default_document_path" ? "C:/default" : null));
    const store = new TauriAssetStore();
    await store.adoptFile("C:/fresh.rnode", []);
    expect(calls.filter((c) => c.cmd === "put_asset")).toHaveLength(0);
    calls.length = 0;
    await store.list();
    expect(calls.find((c) => c.cmd === "list_assets")?.args.path).toBe("C:/fresh.rnode");
  });
});

describe("TauriStorageAdapter", () => {
  const doc = {
    documentId: "d1",
    title: "M",
    sheets: [{ rootNodeId: "r", nodes: {} }],
  } as unknown as RnodeDocument;

  it("starts without a root and reports it after setRoot", () => {
    installTauri(async () => null);
    const a = new TauriStorageAdapter();
    expect(a.hasRoot).toBe(false);
    a.setRoot("C:/map.rnode");
    expect(a.hasRoot).toBe(true);
  });

  it("save writes the document row of the current file", async () => {
    const calls = installTauri(async () => null);
    const a = new TauriStorageAdapter();
    a.setRoot("C:/map.rnode");
    await a.save([doc]);
    const write = calls.find((c) => c.cmd === "write_document");
    expect(write?.args.path).toBe("C:/map.rnode");
    expect(JSON.parse(write?.args.data as string)).toEqual(doc);
  });

  it("save without a path throws instead of guessing", async () => {
    installTauri(async () => null);
    const a = new TauriStorageAdapter();
    await expect(a.save([doc])).rejects.toThrow(/no document file/);
  });

  it("load returns the document of the current file", async () => {
    installTauri(async (cmd) => (cmd === "read_document" ? JSON.stringify(doc) : null));
    const a = new TauriStorageAdapter();
    a.setRoot("C:/map.rnode");
    expect(await a.load()).toEqual([doc]);
  });

  it("load returns [] before a path is chosen, without any command", async () => {
    const calls = installTauri(async () => null);
    const a = new TauriStorageAdapter();
    expect(await a.load()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("readDocumentAt reads a file without switching the path", async () => {
    installTauri(async (cmd) => (cmd === "read_document" ? JSON.stringify(doc) : null));
    const a = new TauriStorageAdapter();
    expect(await a.readDocumentAt("C:/other.rnode")).toEqual(doc);
    expect(a.hasRoot).toBe(false);
  });

  it("readDocumentAt returns null only for 'nothing to read' (no document row)", async () => {
    installTauri(async () => null);
    const a = new TauriStorageAdapter();
    expect(await a.readDocumentAt("C:/empty.rnode")).toBeNull();
  });

  it("readDocumentAt throws invalid-json when the document row is not JSON", async () => {
    installTauri(async () => "not-json{{");
    const a = new TauriStorageAdapter();
    await expect(a.readDocumentAt("C:/bad.rnode")).rejects.toMatchObject({
      name: "DocumentLoadError",
      kind: "invalid-json",
    });
  });

  it("readDocumentAt throws incompatible-schema when JSON is not a document", async () => {
    installTauri(async () => JSON.stringify({ documentId: "d1", title: "M" }));
    const a = new TauriStorageAdapter();
    await expect(a.readDocumentAt("C:/notdoc.rnode")).rejects.toMatchObject({ kind: "incompatible-schema" });
  });

  it("readDocumentAt surfaces the backend error with a kind instead of null", async () => {
    installTauri(async () => {
      throw new Error("file is not a database");
    });
    const a = new TauriStorageAdapter();
    await expect(a.readDocumentAt("C:/corrupt.rnode")).rejects.toMatchObject({ kind: "corrupt" });
  });
});

describe("desktop save flow", () => {
  it("first save without a file is cancelled when the picker is dismissed", async () => {
    installTauri(async (cmd) => (cmd === "pick_document_file" ? null : null));
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow();
    expect(store.getSnapshot().sync).toBe("dirty");
  });

  it("first save adopts the scratch assets into the chosen file and writes the document", async () => {
    const calls = installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/MiaMappa.rnode";
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow();
    expect(store.getSnapshot().sync).toBe("saved");
    // The empty sample map has no referenced assets: adoptFile writes nothing.
    expect(calls.filter((c) => c.cmd === "put_asset")).toHaveLength(0);
    const write = calls.find((c) => c.cmd === "write_document");
    expect(write?.args.path).toBe("C:/MiaMappa.rnode");
    // The picker for the save mode carries the mode argument and the document
    // title as the suggested file name — the filesystem dialog already knows it.
    const pick = calls.find((c) => c.cmd === "pick_document_file");
    expect(pick?.args.mode).toBe("save");
    expect(pick?.args.suggestedName).toBe("R-node_Roadmap");
  });

  it("renaming the document renames the REAL file on the next save", async () => {
    const calls = installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/Docs/Old.rnode";
      if (cmd === "document_file_exists") return false;
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow(); // first save -> C:/Docs/Old.rnode
    store.renameDocument(store.getSnapshot().activeDocId, "Vacation");
    await store.saveNow();

    const writes = calls.filter((c) => c.cmd === "write_document");
    // The second save wrote to the NEW name, not the old file.
    expect(writes[writes.length - 1].args.path).toBe("C:/Docs/Vacation.rnode");
    // The old file was removed only after the new one was written.
    const removals = calls.filter((c) => c.cmd === "remove_document");
    expect(removals).toHaveLength(1);
    expect(removals[0].args.path).toBe("C:/Docs/Old.rnode");
    const writeIdx = writes.findIndex((w) => w.args.path === "C:/Docs/Vacation.rnode");
    const removeIdx = calls.findIndex((c) => c.cmd === "remove_document");
    expect(writeIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(writeIdx); // remove comes after the write
    // The rename did not re-ask where to save.
    expect(calls.filter((c) => c.cmd === "pick_document_file")).toHaveLength(1);
  });

  it("opening a file whose title differs from its name does NOT rename it on save", async () => {
    const doc = {
      documentId: "d1",
      title: "Internal Title",
      sheets: [{ rootNodeId: "r", nodes: { r: { id: "r", title: "r", childrenIds: [] } } }],
    };
    const calls = installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/Docs/FileOnDisk.rnode";
      if (cmd === "read_document") return JSON.stringify(doc);
      if (cmd === "document_file_exists") return false;
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.loadFile(); // open FileOnDisk.rnode (internal title: Internal Title)
    expect(store.getSnapshot().docs.length).toBe(2);
    await store.saveNow();

    const writes = calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/Docs/FileOnDisk.rnode");
    expect(calls.filter((c) => c.cmd === "remove_document")).toHaveLength(0);
  });

  it("openDesktop reports the corrupt-file reason instead of a generic error", async () => {
    installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/corrupt.rnode";
      if (cmd === "read_document") throw new Error("file is not a database");
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    expect(await store.openDesktop()).toBe(false);
    expect(store.getSnapshot().message).toMatch(/corrupt/i);
    expect(store.getSnapshot().sync).toBe("dirty"); // nothing was opened
  });

  it("a later save overwrites the same file without asking again", async () => {
    const calls = installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/MiaMappa.rnode";
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow();
    await store.saveNow();
    const picks = calls.filter((c) => c.cmd === "pick_document_file");
    expect(picks).toHaveLength(1); // the picker ran only for the first save
    expect(calls.filter((c) => c.cmd === "write_document")).toHaveLength(2);
  });
});
