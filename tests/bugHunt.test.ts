/**
 * Regression tests for the externally reported bug hunt (Oct 2026). One block
 * per confirmed defect; each fails on the code before its fix.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { handleShortcut } from "../src/editor/shortcuts";
import { topicClipboardFromHtml, topicClipboardHtml } from "../src/editor/topicClipboard";
import { collectOrphans, type AssetStore } from "../src/persist/assets";
import { DocumentLoadError, readForOverwrite, type StorageAdapter } from "../src/persist/storage";
import { layoutSheet } from "../src/layout/mindmap";
import { measureTopic, wrapRunLines, type TextMeasurer } from "../src/layout/measure";
import type { MindNode, RnodeDocument, Sheet } from "../src/core/types";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

/** 10 px per character at any size: line breaks become arithmetic. */
const MONO: TextMeasurer = {
  measure: (t) => ({ width: t.length * 10 }),
  metrics: (s) => ({ ascent: s.fontSize * 0.8, descent: s.fontSize * 0.2 }),
};

function storeWithKids(n: number): { store: EditorStore; root: string; kids: string[] } {
  const store = new EditorStore(memoryAdapter);
  const root = store.sheet.rootNodeId;
  const kids: string[] = [];
  for (let i = 0; i < n; i++) kids.push(store.createChildOf(root)!);
  return { store, root, kids };
}

const key = (k: string, mods: { ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent =>
  ({ key: k, ctrlKey: !!mods.ctrl, metaKey: false, shiftKey: !!mods.shift, altKey: false, preventDefault() {} }) as unknown as KeyboardEvent;

describe("1 — cut of a selected gallery cell", () => {
  it("removes the cell, never the topic", async () => {
    const { store, kids } = storeWithKids(1);
    const id = kids[0];
    store.doc.node(id)!.style.gallery = { items: [{ id: "a" }, { id: "b" }] };
    store.selectGalleryCell(id, 0);
    await store.cutSelection();
    expect(store.doc.node(id)).toBeTruthy();
    expect(store.doc.node(id)!.style.gallery!.items.map((i) => i.id)).toEqual(["b"]);
  });
});

describe("2 — selecting an image after a gallery cell", () => {
  it("clears the cell selection, so Delete hits the image", () => {
    const { store, kids } = storeWithKids(1);
    const id = kids[0];
    store.doc.node(id)!.style.gallery = { items: [{ id: "a" }] };
    store.doc.node(id)!.style.image = "img";
    store.selectGalleryCell(id, 0);
    store.selectImage(id, "top");
    expect(store.getSnapshot().gallerySel).toBeNull();
  });
});

describe("3–5 — undo of a multi-topic delete", () => {
  it("does not duplicate a relationship joining two deleted topics", () => {
    const { store, kids } = storeWithKids(2);
    store.createRelationship(kids[0], kids[1]);
    expect(store.sheet.relationships).toHaveLength(1);
    store.deleteNodes([kids[0], kids[1]]);
    expect(store.sheet.relationships).toHaveLength(0);
    store.undo();
    expect(store.sheet.relationships).toHaveLength(1);
  });

  it("restores a child-then-ancestor selection without duplicating the child", () => {
    const { store, kids } = storeWithKids(1);
    const parent = kids[0];
    const child = store.createChildOf(parent)!;
    store.deleteNodes([child, parent]);
    store.undo();
    expect(store.doc.node(parent)!.childrenIds).toEqual([child]);
  });

  it("restores siblings in their original order", () => {
    const { store, root, kids } = storeWithKids(3);
    const before = [...store.doc.node(root)!.childrenIds];
    store.deleteNodes(kids);
    store.undo();
    expect(store.doc.node(root)!.childrenIds).toEqual(before);
  });
});

describe("6 — Shift + letter shortcuts", () => {
  it("fires Mod+Shift+Z (redo) even though e.key is upper-case", () => {
    const { store, kids } = storeWithKids(1);
    store.undo();
    expect(store.doc.node(kids[0])).toBeUndefined();
    handleShortcut(store, key("Z", { ctrl: true, shift: true }), 800, 600);
    expect(store.doc.node(kids[0])).toBeTruthy();
  });
});

describe("7 — the HTML clipboard payload", () => {
  it("survives an apostrophe in a title", () => {
    const payload = JSON.stringify({ title: "L'idea" });
    expect(topicClipboardFromHtml(topicClipboardHtml(payload, "L'idea"))).toBe(payload);
  });

  it("still reads a value re-serialised in single quotes", () => {
    const payload = JSON.stringify({ title: "L'idea" });
    const html = topicClipboardHtml(payload, "x").replace(/"([^"]*)"/, "'$1'");
    expect(topicClipboardFromHtml(html)).toBe(payload);
  });
});

describe("8 — asset GC with a shared blob store", () => {
  it("keeps the blobs another sheet references", async () => {
    const { store } = storeWithKids(0);
    const other: Sheet = JSON.parse(JSON.stringify(store.sheet));
    const anyNode = Object.values(other.nodes)[0] as MindNode;
    anyNode.style.image = "theirs";
    const assets = { list: async () => ["theirs", "nobody"] } as unknown as AssetStore;
    const report = await collectOrphans(store.sheet, assets, [other]);
    expect(report.blobs).toEqual(["nobody"]);
  });
});

describe("10 — a gallery wider than the text clamp", () => {
  it("measures the title at the box's final width, as the canvas wraps it", () => {
    const node = (title: string): MindNode => ({
      id: "n", type: "subtopic", parentId: null, childrenIds: [], title, titleRuns: [{ text: title }],
      position: { x: 0, y: 0, manual: false },
      style: { gallery: { items: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}` })) } },
      collapsed: false, labels: [], markers: [], notes: "", task: null, metadata: { createdAt: "", updatedAt: "" },
    });
    // 40 chars = 400px: two lines at the 254px text clamp, one line at the
    // ~490px the five-cell grid makes the box.
    const long = measureTopic(node("x".repeat(40)), MONO);
    const short = measureTopic(node("x".repeat(5)), MONO);
    expect(long.h).toBe(short.h);
  });
});

describe("15 — a stored document that cannot open", () => {
  it("falls back to the sample instead of throwing out of init", async () => {
    const bad = { documentId: "d1", title: "broken", sheets: [] } as unknown as RnodeDocument;
    const store = new EditorStore({ label: "test", async load() { return [bad]; }, async save() {} });
    await expect(store.init()).resolves.toBeUndefined();
    expect(store.doc.rootNode).toBeTruthy();
  });

  it("skips a document whose root node is missing", async () => {
    const good = new EditorStore(memoryAdapter).doc.doc;
    const broken: RnodeDocument = JSON.parse(JSON.stringify(good));
    broken.documentId = "broken";
    delete broken.sheets[0].nodes[broken.sheets[0].rootNodeId];
    const store = new EditorStore({ label: "test", async load() { return [broken, good]; }, async save() {} });
    await store.init();
    expect(store.doc.doc.documentId).toBe(good.documentId);
  });
});

describe("16 — Save as over an unreadable file", () => {
  it("refuses when the file exists but cannot be read", async () => {
    const res = await readForOverwrite({ readDocumentAt: async () => { throw new DocumentLoadError("corrupt", "bad"); } }, "x.rnode");
    expect(res.ok).toBe(false);
  });

  it("treats a missing file as empty", async () => {
    const res = await readForOverwrite({ readDocumentAt: async () => { throw new DocumentLoadError("not-found", "none"); } }, "x.rnode");
    expect(res).toEqual({ ok: true, doc: null });
  });
});

describe("18 — a dragged topic in a hierarchical layout", () => {
  it("anchors its children at its manual position", () => {
    const { store, kids } = storeWithKids(1);
    const a = kids[0];
    const b = store.createChildOf(a)!;
    const sheet = store.sheet;
    sheet.structure.structureType = "logic";
    sheet.nodes[a].position = { x: 2000, y: 1500, manual: true };
    const { positions } = layoutSheet(sheet);
    const pb = positions.get(b)!;
    expect(pb.x).toBeGreaterThan(2000);
    expect(Math.abs(pb.y - 1500)).toBeLessThan(200);
  });
});

describe("19 — a word split across runs", () => {
  it("wraps as one word instead of breaking between its runs", () => {
    // "aaaa " (50) + "he" (20) fits 80; "llo" would not — the whole word goes.
    const lines = wrapRunLines([{ text: "aaaa " }, { text: "he", bold: true }, { text: "llo" }], 80, MONO, {});
    expect(lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["aaaa", "hello"]);
  });
});
