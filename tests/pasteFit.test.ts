import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { createCanvasTextMeasurer, measureNode } from "../src/layout/measure";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };
const measurer = createCanvasTextMeasurer();

const PARAGRAPH =
  "La filosofia morale studia il bene e il male, il giusto e l'ingiusto, e le ragioni per cui agiamo. " +
  "Kant fonda la morale sul dovere e sulla ragione pratica; Aristotele sulla virtù come giusto mezzo; " +
  "gli utilitaristi sulle conseguenze delle azioni e sul massimo benessere per il maggior numero. ";
const LONG = PARAGRAPH.repeat(6);

function size(store: EditorStore, id: string): { w: number; h: number } {
  return measureNode(store.sheet.nodes[id], measurer);
}

function paste(store: EditorStore, id: string, text: string): void {
  store.select(id);
  store.startEdit(id);
  store.setEditingDraft(text);
  store.commitEdit();
}

describe("long pasted text gets a reading width", () => {
  it("a mind-map topic becomes landscape, not a tower, in one undo step", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.rootNodeId;
    store.select(root);
    store.createChild();
    const id = store.sheet.nodes[root].childrenIds.at(-1)!;
    paste(store, id, PARAGRAPH.repeat(2));
    const s = size(store, id);
    expect(store.sheet.nodes[id].style.width).toBeGreaterThan(280);
    expect(s.w).toBeLessThanOrEqual(640);
    expect(s.h).toBeLessThanOrEqual(s.w * 0.75 + 1);
    store.undo();
    expect(store.sheet.nodes[id].style.width).toBeUndefined();
    expect(store.sheet.nodes[id].title).toBe("");
  });

  it("very long text takes the widest reading width and is far shorter", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.rootNodeId;
    store.select(root);
    store.createChild();
    const id = store.sheet.nodes[root].childrenIds.at(-1)!;
    const tower = measureNode({ ...store.sheet.nodes[id], title: LONG, titleRuns: [{ text: LONG }] }, measurer).h;
    paste(store, id, LONG);
    expect(store.sheet.nodes[id].style.width).toBeGreaterThan(560);
    expect(store.sheet.nodes[id].style.width).toBeLessThanOrEqual(640);
    expect(size(store, id).h).toBeLessThan(tower / 2);
  });

  it("short text keeps the box it had", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.rootNodeId;
    store.select(root);
    store.createChild();
    const id = store.sheet.nodes[root].childrenIds.at(-1)!;
    paste(store, id, "Etica");
    expect(store.sheet.nodes[id].style.width).toBeUndefined();
  });

  it("a list of short lines gets only as wide as its longest line", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.rootNodeId;
    store.select(root);
    store.createChild();
    const id = store.sheet.nodes[root].childrenIds.at(-1)!;
    const list = Array.from({ length: 30 }, (_, i) => `voce numero ${i + 1}`).join("\n");
    paste(store, id, list);
    // Widening cannot shorten it: no width is forced on it.
    expect(store.sheet.nodes[id].style.width ?? 0).toBeLessThan(400);
  });

  it("a diagram shape widens and its tree makes room", () => {
    const store = new EditorStore(memoryAdapter);
    store.newDocument("diagram");
    const page = store.sheet.rootNodeId;
    const first = store.sheet.nodes[page].childrenIds[0];
    const b = store.diagramTab(first)!;
    const c = store.diagramTab(first)!;
    paste(store, b, LONG);
    expect(store.sheet.nodes[b].style.width).toBeGreaterThan(120);
    const p = store.sheet.nodes[page];
    const rect = (id: string) => {
      const at = store.sheet.nodes[id].style.freeformPosition!;
      return { x: p.position.x + at.x, y: p.position.y + at.y, ...size(store, id) };
    };
    const rb = rect(b), rc = rect(c);
    const overlap = rb.x < rc.x + rc.w && rc.x < rb.x + rb.w && rb.y < rc.y + rc.h && rc.y < rb.y + rb.h;
    expect(overlap).toBe(false);
  });

  it("text pasted onto a canvas lands as a wide item", () => {
    const store = new EditorStore(memoryAdapter);
    store.newDocument("diagram");
    const page = store.sheet.rootNodeId;
    const id = store.createFreeformItem(page, 300, 300, LONG)!;
    const s = size(store, id);
    expect(s.h).toBeLessThanOrEqual(s.w * 0.75 + 1);
  });
});
