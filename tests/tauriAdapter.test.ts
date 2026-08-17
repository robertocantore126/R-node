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
  // The adapter remembers the last document path ACROSS instances — that is
  // how the app reopens your file after a restart. Without this, one test's
  // saved path becomes the next test's starting state.
  TauriStorageAdapter.forgetLastDocument();
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

  it("size sums the exact byte lengths of every level (incl. the meta row)", async () => {
    installTauri(async (cmd, args) => {
      if (cmd === "default_document_path") return "C:/default";
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset" && args.level === "original") return raw([1, 2, 3]);
      if (cmd === "get_asset" && args.level === "large") return raw([4, 5]);
      if (cmd === "get_asset" && args.level === "small") return raw([6]);
      return null;
    });
    const store = new TauriAssetStore();
    // 3 (original) + 2 (large) + 1 (small) + the serialized meta row.
    expect(await store.size(ID)).toBe(3 + 2 + 1 + metaBytes.length);
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
    expect(await store.adoptFile("C:/fresh.rnode", [])).toBe(0);
    expect(calls.filter((c) => c.cmd === "put_asset")).toHaveLength(0);
    calls.length = 0;
    await store.list();
    expect(calls.find((c) => c.cmd === "list_assets")?.args.path).toBe("C:/fresh.rnode");
  });

  it("adoptFile reports how many referenced assets it could not copy", async () => {
    const MISSING = "b".repeat(64);
    const calls = installTauri(async (cmd, args) => {
      if (cmd === "default_document_path") return "C:/old";
      if (args?.id === MISSING) return new ArrayBuffer(0); // absent from the source
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset" && args.level === "original") return raw([1, 2, 3]);
      if (cmd === "get_asset" && args.level === "large") return raw([4, 5]);
      if (cmd === "get_asset" && args.level === "small") return raw([6]);
      return null;
    });
    const store = new TauriAssetStore();
    const skipped = await store.adoptFile("C:/new.rnode", [ID, MISSING]);

    expect(skipped).toBe(1); // the missing one is counted, not silently dropped
    // Only the present asset was copied: 4 levels (not 8).
    const puts = calls.filter((c) => c.cmd === "put_asset");
    expect(puts).toHaveLength(4);
    expect(puts.every((p) => p.args.path === "C:/new.rnode")).toBe(true);
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
    expect(pick?.args.suggestedName).toBe("R-node — Roadmap");
  });

  it("save reports how many referenced images could not be copied", async () => {
    installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/MiaMappa.rnode";
      if (cmd === "get_asset") return new ArrayBuffer(0); // every level absent
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    // A node references an image whose bytes are not in the source file:
    // adoptFile skips it, and the user must be told, with the number.
    const root = store.doc.node(store.sheet.rootNodeId)!;
    store.setNodeImage(root.childrenIds[0], "a".repeat(64));
    await store.saveNow();
    expect(store.getSnapshot().sync).toBe("saved");
    expect(store.getSnapshot().message).toMatch(/1 image could not be copied/);
  });

  it("renaming in the GUI renames the real file immediately, without copying it", async () => {
    const calls = installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/Docs/Old.rnode";
      if (cmd === "document_file_exists") return false;
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow(); // first save -> C:/Docs/Old.rnode
    store.renameDocument(store.getSnapshot().activeDocId, "Vacation");
    await Promise.resolve(); // the rename is fired and not awaited by the caller
    await Promise.resolve();

    // The file moved on the rename itself. Waiting for a Ctrl+S that may never
    // come is what left the GUI name and the name on disk disagreeing.
    const renames = calls.filter((c) => c.cmd === "rename_document");
    expect(renames).toHaveLength(1);
    expect(renames[0].args).toMatchObject({ from: "C:/Docs/Old.rnode", to: "C:/Docs/Vacation.rnode" });
    // A rename moves a directory entry: no asset is re-written and no file is
    // deleted. The old flow copied every image into a new file and removed the
    // old one, which cost as much as saving the whole map from scratch.
    expect(calls.filter((c) => c.cmd === "put_asset")).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "remove_document")).toHaveLength(0);
    // And it did not re-ask where to save.
    expect(calls.filter((c) => c.cmd === "pick_document_file")).toHaveLength(1);

    // The next save writes to the new path, with no further rename.
    await store.saveNow();
    const writes = calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/Docs/Vacation.rnode");
    expect(calls.filter((c) => c.cmd === "rename_document")).toHaveLength(1);
  });

  it("a name collision keeps the file and says so, without losing the typed title", async () => {
    const calls = installTauri(async (cmd) => {
      if (cmd === "pick_document_file") return "C:/Docs/Old.rnode";
      if (cmd === "rename_document") throw new Error("a file already exists at C:/Docs/Taken.rnode");
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow();
    store.renameDocument(store.getSnapshot().activeDocId, "Taken");
    await Promise.resolve();
    await Promise.resolve();

    // The title the user typed is kept — reverting what someone just wrote is
    // worse than a mismatch they have been told about.
    expect(store.getSnapshot().docs.find((d) => d.documentId === store.getSnapshot().activeDocId)?.title).toBe("Taken");
    // …and the document still saves to the file it actually has.
    await store.saveNow();
    const writes = calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/Docs/Old.rnode");
  });

  it("opening a file adopts its NAME as the title, and renames nothing", async () => {
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

    // The name in the GUI is the name of the file you opened. Showing the
    // stored "Internal Title" instead is what made the two disagree from the
    // very first moment, before the user had touched anything.
    const snap = store.getSnapshot();
    expect(snap.docs.find((d) => d.documentId === snap.activeDocId)?.title).toBe("FileOnDisk");

    await store.saveNow();
    const writes = calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/Docs/FileOnDisk.rnode");
    // Adopting the name is a read-side decision: nothing on disk moves.
    expect(calls.filter((c) => c.cmd === "rename_document")).toHaveLength(0);
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

describe("per-document files (two open maps cannot overwrite each other)", () => {
  const docB = {
    documentId: "doc-b",
    title: "B",
    sheets: [{ rootNodeId: "r", nodes: { r: { id: "r", title: "B", childrenIds: [] } } }],
  };

  /**
   * A tiny path-addressed backend that mirrors the stateless Rust side:
   * read/write/rename take the path from the caller and files persist in a
   * closure the test can assert on.
   */
  function memoryBackend(seed: Record<string, unknown>) {
    const files: Record<string, string> = {};
    for (const [p, d] of Object.entries(seed)) files[p] = JSON.stringify(d);
    const picks: string[] = [];
    const calls = installTauri(async (cmd, args) => {
      if (cmd === "pick_document_file") return picks.shift() ?? null;
      if (cmd === "read_document") return files[args.path as string] ?? null;
      if (cmd === "write_document") {
        files[args.path as string] = args.data as string;
        return null;
      }
      if (cmd === "rename_document") {
        const from = args.from as string;
        const to = args.to as string;
        if (files[to] !== undefined) throw new Error(`a file already exists at ${to}`);
        if (files[from] === undefined) throw new Error(`no file at ${from}`);
        files[to] = files[from];
        delete files[from];
        return null;
      }
      return null;
    });
    return { calls, files, queuePick: (p: string) => picks.push(p) };
  }

  it("saving a previously opened document writes to ITS OWN file, not the last opened one", async () => {
    const bk = memoryBackend({ "C:/B.rnode": docB });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    // First document: the sample, saved as A.rnode.
    bk.queuePick("C:/A.rnode");
    await store.saveNow();
    // Second document: B, opened from B.rnode.
    bk.queuePick("C:/B.rnode");
    await store.openDesktop();
    // Switch back to the first document and press Ctrl+S. The OLD behaviour
    // wrote the first document into B.rnode and renamed the file away; the
    // fixed behaviour writes the document's OWN file.
    const aId = store.getSnapshot().docs.find((d) => d.documentId !== "doc-b")!.documentId;
    store.switchToDoc(aId);
    await store.saveNow();
    const writes = bk.calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/A.rnode");
    // B.rnode still holds B — untouched.
    expect(JSON.parse(bk.files["C:/B.rnode"]).documentId).toBe("doc-b");
    expect(store.getSnapshot().sync).toBe("saved");
  });

  it("a brand-new document never inherits the previous file — its first save is a Save-as", async () => {
    const bk = memoryBackend({});
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    bk.queuePick("C:/A.rnode");
    await store.saveNow(); // sample -> A.rnode
    const aFile = bk.files["C:/A.rnode"];
    store.newDocument(); // never saved, has no file of its own
    bk.queuePick("C:/New.rnode");
    await store.saveNow(); // must open the picker again, not write A.rnode
    expect(bk.calls.filter((c) => c.cmd === "pick_document_file")).toHaveLength(2);
    const writes = bk.calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/New.rnode");
    // A.rnode still holds the first document's bytes.
    expect(bk.files["C:/A.rnode"]).toBe(aFile);
  });

  it("Save-as refuses a file that already contains a different document", async () => {
    const bk = memoryBackend({ "C:/Taken.rnode": docB });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    bk.queuePick("C:/Taken.rnode");
    await store.saveNow();
    expect(bk.calls.filter((c) => c.cmd === "write_document")).toHaveLength(0);
    expect(store.getSnapshot().sync).toBe("dirty");
    expect(store.getSnapshot().message).toMatch(/different document/);
    // B is still intact in its file.
    expect(JSON.parse(bk.files["C:/Taken.rnode"]).documentId).toBe("doc-b");
  });

  it("deleting the only open document clears the file pointer — the replacement blank saves as a NEW file", async () => {
    const bk = memoryBackend({});
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    bk.queuePick("C:/A.rnode");
    await store.saveNow(); // sample -> A.rnode (adapter root = A.rnode)
    const aFile = bk.files["C:/A.rnode"];
    // Trash the only open map: a fresh blank replaces it. It must NOT keep
    // pointing at A.rnode, or Ctrl+S would try to write the blank over the
    // old map (and the overwrite guard would refuse, stranding the new doc).
    store.deleteDocument(store.getSnapshot().activeDocId);
    bk.queuePick("C:/Fresh.rnode");
    await store.saveNow(); // must be a Save-as to a NEW file
    const writes = bk.calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/Fresh.rnode");
    // The old map's file is untouched — deleting only closes the document.
    expect(bk.files["C:/A.rnode"]).toBe(aFile);
    expect(store.getSnapshot().sync).toBe("saved");
  });

  it("renaming a NON-active document renames its own file and leaves the active one's file alone", async () => {
    const bk = memoryBackend({ "C:/B.rnode": docB });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    bk.queuePick("C:/A.rnode");
    await store.saveNow(); // sample -> A.rnode
    bk.queuePick("C:/B.rnode");
    await store.openDesktop(); // active is now B, root = B.rnode
    const aId = store.getSnapshot().docs.find((d) => d.documentId !== "doc-b")!.documentId;
    store.renameDocument(aId, "Renamed"); // rename the OTHER document
    await Promise.resolve();
    await Promise.resolve();
    const renames = bk.calls.filter((c) => c.cmd === "rename_document");
    expect(renames).toHaveLength(1);
    expect(renames[0].args).toMatchObject({ from: "C:/A.rnode", to: "C:/Renamed.rnode" });
    // The active document (B) still saves to B.rnode — its root was not dragged.
    await store.saveNow();
    const writes = bk.calls.filter((c) => c.cmd === "write_document");
    expect(writes[writes.length - 1].args.path).toBe("C:/B.rnode");
  });
});
