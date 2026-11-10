/**
 * Gates for the data-loss and correctness fixes of the November 2026 review:
 * each test fails on the behaviour it replaces.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { DocumentModel } from "../src/core/doc";
import { applyOp, inverseOf, makeOp, type Op } from "../src/core/ops";
import { TauriStorageAdapter, type StorageAdapter } from "../src/persist/storage";

const memoryAdapter = (docs: unknown[] = []): StorageAdapter & { saved: unknown[][] } => {
  const saved: unknown[][] = [];
  return { label: "test", saved, async load() { return docs as never; }, async save(d) { saved.push(d); } };
};

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  TauriStorageAdapter.forgetLastDocument();
  vi.restoreAllMocks();
});

describe("layout commands are undoable", () => {
  it("Auto layout releases hand placements as ONE undo step", () => {
    const store = new EditorStore(memoryAdapter());
    const id = store.doc.rootNode.childrenIds[0];
    store.doc.node(id)!.position = { x: 900, y: 900, manual: true };
    store.autoLayoutAll();
    expect(store.doc.node(id)!.position.manual).toBe(false);
    expect(store.getSnapshot().sync).toBe("dirty");
    store.undo();
    expect(store.doc.node(id)!.position.manual).toBe(true);
  });

  it("a structure change brings the hand placements back with its undo", () => {
    const store = new EditorStore(memoryAdapter());
    const id = store.doc.rootNode.childrenIds[0];
    store.doc.node(id)!.position = { x: 900, y: 900, manual: true };
    store.setStructure({ structureType: "tree" } as never);
    expect(store.doc.node(id)!.position.manual).toBe(false);
    store.undo();
    expect(store.doc.node(id)!.position.manual).toBe(true);
    expect(store.sheet.structure.structureType).not.toBe("tree");
  });
});

describe("execOps is all or nothing", () => {
  it("a batch that throws half-way leaves the sheet as it was", () => {
    const store = new EditorStore(memoryAdapter());
    const id = store.doc.rootNode.childrenIds[0];
    const before = store.doc.node(id)!.title;
    expect(() =>
      store.execOps([
        makeOp<Op & { type: "setTitle" }>("setTitle", { id, title: "changed", prev: before }),
        makeOp<Op & { type: "setTitle" }>("setTitle", { id: "no-such-node", title: "x", prev: "" }),
      ])
    ).toThrow();
    expect(store.doc.node(id)!.title).toBe(before);
    expect(store.getSnapshot().canUndo).toBe(false);
  });
});

describe("one door for every load", () => {
  const cyclic = (): unknown => {
    const doc = DocumentModel.blank("Cycle");
    const sheet = doc.sheets[0];
    const a = DocumentModel.makeNode("main", sheet.rootNodeId, "A");
    const b = DocumentModel.makeNode("subtopic", a.id, "B");
    a.childrenIds.push(b.id);
    b.childrenIds.push(a.id); // B lists its own parent as a child
    sheet.nodes[a.id] = a;
    sheet.nodes[b.id] = b;
    sheet.nodes[sheet.rootNodeId].childrenIds.push(a.id);
    return doc;
  };

  it("File → Open refuses a document whose tree is not a tree", () => {
    const store = new EditorStore(memoryAdapter());
    expect(store.importDocumentFromJson(JSON.stringify(cyclic()))).toBeNull();
  });

  it("dangling references are dropped instead of refusing the map", () => {
    const doc = DocumentModel.sample();
    const sheet = doc.sheets[0];
    sheet.nodes[sheet.rootNodeId].childrenIds.push("ghost");
    sheet.relationships.push({ id: "r1", fromId: sheet.rootNodeId, toId: "ghost" } as never);
    const store = new EditorStore(memoryAdapter());
    expect(store.importDocumentFromJson(JSON.stringify(doc))).toBe(doc.documentId);
    expect(store.sheet.relationships).toHaveLength(0);
  });

  it("startup keeps a stored document it cannot open, and writes it back on save", async () => {
    const good = DocumentModel.sample();
    const bad = cyclic() as { documentId: string };
    const adapter = memoryAdapter([good, bad]);
    const store = new EditorStore(adapter);
    await store.init();
    expect(store.getSnapshot().docs.map((d) => d.documentId)).toEqual([good.documentId]);
    expect(store.getSnapshot().message).toMatch(/kept untouched/);
    // Settling an opened document writes browser storage: the bad one rides along.
    store.importDocumentFromJson(JSON.stringify(DocumentModel.blank("x")));
    await (store as unknown as { settleOpenedDocument(): Promise<void> }).settleOpenedDocument();
    const last = adapter.saved[adapter.saved.length - 1] as { documentId: string }[];
    expect(last.some((d) => d.documentId === bad.documentId)).toBe(true);
  });

  it("startup keeps every Position field (offsets, branchFree)", async () => {
    const doc = DocumentModel.sample();
    const id = doc.sheets[0].nodes[doc.sheets[0].rootNodeId].childrenIds[0];
    doc.sheets[0].nodes[id].position = { x: 1, y: 2, manual: true, branchFree: true, offsetX: 3, offsetY: 4 };
    const store = new EditorStore(memoryAdapter([doc]));
    await store.init();
    const p = store.doc.node(id)!.position;
    expect(p.branchFree).toBe(true);
    expect(p.offsetX).toBe(3);
  });
});

describe("ops", () => {
  it("the plain inverse of createNode removes the node from the map", () => {
    const doc = DocumentModel.blank();
    const sheet = doc.sheets[0];
    const create = makeOp<Op & { type: "createNode" }>("createNode", {
      id: "n1", nodeType: "main", parentId: sheet.rootNodeId, index: 0, title: "x",
    });
    applyOp(sheet, create);
    for (const inv of inverseOf(create)) applyOp(sheet, inv);
    expect(sheet.nodes.n1).toBeUndefined();
    expect(sheet.nodes[sheet.rootNodeId].childrenIds).not.toContain("n1");
  });
});

describe("desktop", () => {
  function installTauri(impl: (cmd: string, args: Record<string, unknown>) => unknown): { cmd: string; args: Record<string, unknown> }[] {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return impl(cmd, args);
    });
    (globalThis as unknown as { window?: unknown }).window = { __TAURI__: { core: { invoke } } };
    return calls;
  }

  it("startup clears the scratch file of a previous session", async () => {
    const calls = installTauri(() => null);
    await new EditorStore(new TauriStorageAdapter()).init();
    expect(calls[0]?.cmd).toBe("clear_scratch");
  });

  it("duplicating a saved map copies its images into the copy's scratch file", async () => {
    const calls = installTauri((cmd) => {
      if (cmd === "pick_document_file") return "C:/Maps/A.rnode";
      if (cmd === "default_document_path") return "C:/AppData/scratch.rnode";
      if (cmd === "copy_assets") return 0;
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    store.setNodeImage(store.doc.rootNode.childrenIds[0], "a".repeat(64));
    await store.saveNow(); // A.rnode
    calls.length = 0;
    await store.duplicateDocument(store.getSnapshot().activeDocId);
    const copy = calls.find((c) => c.cmd === "copy_assets");
    expect(copy?.args).toEqual({ from: "C:/Maps/A.rnode", to: "C:/AppData/scratch.rnode", ids: ["a".repeat(64)] });
  });

  it("a plain save asks the backend not to create the file; Save as may", async () => {
    const calls = installTauri((cmd) => (cmd === "pick_document_file" ? "C:/Maps/A.rnode" : null));
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow(); // Save as
    await store.saveNow(); // plain save
    const writes = calls.filter((c) => c.cmd === "write_document").map((c) => c.args.create);
    expect(writes).toEqual([true, false]);
  });

  it("a save whose file vanished fails with the reason, and stays unsaved", async () => {
    installTauri((cmd) => {
      if (cmd === "pick_document_file") return "C:/Maps/A.rnode";
      return null;
    });
    const store = new EditorStore(new TauriStorageAdapter());
    await store.init();
    await store.saveNow();
    (globalThis as unknown as { window: { __TAURI__: { core: { invoke: unknown } } } }).window.__TAURI__.core.invoke = async (cmd: string) => {
      if (cmd === "write_document") throw "the document file is missing: C:/Maps/A.rnode (moved, renamed or deleted outside R-node)";
      return null;
    };
    store.createChildOf(store.sheet.rootNodeId);
    await store.saveNow();
    expect(store.getSnapshot().sync).toBe("dirty");
    expect(store.getSnapshot().message).toMatch(/file is missing/);
  });
});
