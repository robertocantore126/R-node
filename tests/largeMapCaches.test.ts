/**
 * Large-map cache gates (perf/large-maps).
 *
 * The extent cache used to be a single FIFO map capped at 20,000 entries. The
 * layout visits nodes in the same order every run, so past 20,000 topics each
 * entry was evicted just before it was needed again: zero hits, a no-change
 * layout 5x slower, every pan frame re-measuring the sheet. These gates count
 * measurements instead of timing them, so they cannot flake.
 */
import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { DocumentModel, uid } from "../src/core/doc";
import { applyWithInverse, makeOp, type Op } from "../src/core/ops";
import { layoutSheet } from "../src/layout/mindmap";
import { HEURISTIC_MEASURER, type TextMeasurer } from "../src/layout/measure";
import { EditorStore } from "../src/editor/store";

function build(count: number): DocumentModel {
  const model = new DocumentModel(DocumentModel.blank("Large"));
  const rootId = model.sheet.rootNodeId;
  const queue = [rootId];
  let created = 0;
  while (created < count && queue.length) {
    const parentId = queue.shift()!;
    for (let i = 0; i < 8 && created < count; i++) {
      const id = uid("n");
      applyWithInverse(model.sheet, makeOp<Op & { type: "createNode" }>("createNode", {
        id, nodeType: parentId === rootId ? "main" : "subtopic", parentId, index: i,
        title: `Topic ${created}`, // distinct text: one cache entry per topic
      }));
      queue.push(id);
      created++;
    }
  }
  return model;
}

function counting(): TextMeasurer & { calls: number } {
  const m = {
    calls: 0,
    measure(t: string, s: Parameters<TextMeasurer["measure"]>[1]) { m.calls++; return HEURISTIC_MEASURER.measure(t, s); },
    metrics: HEURISTIC_MEASURER.metrics,
  };
  return m;
}

it("re-laying out an unchanged 25k-topic map measures nothing", { timeout: 60_000 }, () => {
  const model = build(25_000);
  const m = counting();
  layoutSheet(model.sheet, false, m);
  expect(m.calls).toBeGreaterThan(25_000);
  m.calls = 0;
  layoutSheet(model.sheet, false, m);
  expect(m.calls).toBe(0);
});

it("pan, zoom and hover move the view only: same revision, same chrome snapshot", () => {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.select(store.sheet.rootNodeId); // a first notify(): the initial snapshot IS the live state object
  const rev = store.revision;
  const full = store.getSnapshot();
  const cam0 = { ...full.camera };
  const ui = store.getUiSnapshot();
  let calls = 0;
  store.subscribe(() => calls++);
  store.panBy(30, -10);
  store.zoomAt(100, 100, 1.2, 800, 600);
  store.setHover(store.sheet.rootNodeId);
  expect(calls).toBe(3); // the canvas still hears every move
  expect(store.revision).toBe(rev); // placement cache stays valid
  expect(store.getUiSnapshot()).toBe(ui); // App does not re-render
  expect(store.getSnapshot()).not.toBe(full);
  expect(store.getSnapshot().camera).not.toEqual(cam0);
  expect(store.getSnapshot().hoverId).toBe(store.sheet.rootNodeId);
  // A real change still moves both, and the chrome sees the latest camera.
  store.toggleSidebar();
  expect(store.revision).toBeGreaterThan(rev);
  expect(store.getUiSnapshot()).not.toBe(ui);
  expect(store.getUiSnapshot().camera).toEqual(store.getSnapshot().camera);
});

it("an edited topic is measured again, the others are not", () => {
  const model = build(2_000);
  const m = counting();
  layoutSheet(model.sheet, false, m);
  const id = model.sheet.nodes[model.sheet.rootNodeId].childrenIds[0];
  model.sheet.nodes[id].title = "A much longer title than before";
  m.calls = 0;
  const before = layoutSheet(model.sheet, false, m);
  expect(m.calls).toBeGreaterThan(0);
  expect(m.calls).toBeLessThan(20);
  void before;
});
