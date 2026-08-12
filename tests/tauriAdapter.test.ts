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

describe("TauriAssetStore", () => {
  it("passes the current root to every command", async () => {
    const calls = installTauri(async (cmd, args) => {
      if (cmd === "default_asset_root") return "C:/default";
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset") return [1, 2, 3];
      return null;
    });
    const store = new TauriAssetStore();
    await store.get(ID, "large");
    await store.meta(ID);
    await store.list();
    const roots = calls.filter((c) => c.cmd !== "default_asset_root").map((c) => c.args.root);
    expect(roots.every((r) => r === "C:/default")).toBe(true);
  });

  it("setRoot switches the SAME instance to a new folder (the Renderer trap)", async () => {
    const calls = installTauri(async () => null);
    const store = new TauriAssetStore();

    store.setRoot("C:/mapA");
    await store.get(ID, "large");
    store.setRoot("C:/mapB");
    await store.get(ID, "large");

    const reads = calls.filter((c) => c.cmd === "get_asset").map((c) => c.args.root);
    expect(reads).toEqual(["C:/mapA", "C:/mapB"]);
  });

  it("adoptRoot copies every referenced asset to the new folder BEFORE switching", async () => {
    const OLD = "C:/old";
    const NEW = "C:/new";
    const calls = installTauri(async (cmd, args) => {
      if (cmd === "default_asset_root") return OLD;
      if (cmd === "get_asset" && args.level === "meta") return metaBytes;
      if (cmd === "get_asset" && args.level === "original") return [1, 2, 3];
      if (cmd === "get_asset" && args.level === "large") return [4, 5];
      if (cmd === "get_asset" && args.level === "small") return [6];
      return null;
    });
    const store = new TauriAssetStore();
    await store.adoptRoot(NEW, [ID]);

    // Reads happened against the OLD root…
    const reads = calls.filter((c) => c.cmd === "get_asset").map((c) => c.args.root);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r === OLD)).toBe(true);

    // …and the writes went to the NEW one: all four files per asset.
    const puts = calls.filter((c) => c.cmd === "put_asset");
    expect(puts).toHaveLength(4);
    expect(puts.every((p) => p.args.root === NEW)).toBe(true);
    expect(puts.map((p) => p.args.level).sort()).toEqual(["large", "meta", "original", "small"]);

    // After the switch, reads come from the new folder.
    calls.length = 0;
    await store.get(ID, "large");
    expect(calls.find((c) => c.cmd === "get_asset")?.args.root).toBe(NEW);
  });

  it("adoptRoot with no referenced assets just switches the root", async () => {
    const calls = installTauri(async (cmd) => (cmd === "default_asset_root" ? "C:/default" : null));
    const store = new TauriAssetStore();
    await store.adoptRoot("C:/fresh", []);
    expect(calls.filter((c) => c.cmd === "put_asset")).toHaveLength(0);
    calls.length = 0;
    await store.list();
    expect(calls.find((c) => c.cmd === "list_assets")?.args.root).toBe("C:/fresh");
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
    a.setRoot("C:/map");
    expect(a.hasRoot).toBe(true);
  });

  it("save writes document.json under the current root", async () => {
    const calls = installTauri(async () => null);
    const a = new TauriStorageAdapter();
    a.setRoot("C:/map");
    await a.save([doc]);
    const write = calls.find((c) => c.cmd === "write_document");
    expect(write?.args.root).toBe("C:/map");
    expect(JSON.parse(write?.args.data as string)).toEqual(doc);
  });

  it("save without a root throws instead of guessing", async () => {
    installTauri(async () => null);
    const a = new TauriStorageAdapter();
    await expect(a.save([doc])).rejects.toThrow(/no document folder/);
  });

  it("load returns the document.json of the current root", async () => {
    installTauri(async (cmd) => (cmd === "read_document" ? JSON.stringify(doc) : null));
    const a = new TauriStorageAdapter();
    a.setRoot("C:/map");
    expect(await a.load()).toEqual([doc]);
  });

  it("load returns [] before a root is chosen, without any command", async () => {
    const calls = installTauri(async () => null);
    const a = new TauriStorageAdapter();
    expect(await a.load()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("readDocumentAt reads a folder without switching the root", async () => {
    installTauri(async (cmd) => (cmd === "read_document" ? JSON.stringify(doc) : null));
    const a = new TauriStorageAdapter();
    expect(await a.readDocumentAt("C:/other")).toEqual(doc);
    expect(a.hasRoot).toBe(false);
  });
});

describe("desktop save flow", () => {
  it("first save without a folder is cancelled when the picker is dismissed", async () => {
    installTauri(async (cmd) => (cmd === "pick_document_folder" ? null : null));
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow();
    expect(store.getSnapshot().sync).toBe("dirty");
  });
});
