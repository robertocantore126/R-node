import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { EditorStore } from "../src/editor/store";
import { applyLayout } from "../src/layout/mindmap";
import { sheetToSvg } from "../src/export/svg";
import { HEURISTIC_MEASURER } from "../src/layout/measure";
import { validateSheet } from "../src/core/validate";
import { freeformOwner } from "../src/core/freeform";
import type { StorageAdapter } from "../src/persist/storage";
const adapter: StorageAdapter = { label: "test", async load() { return []; }, async save() {} };
function setup() {
  const store = new EditorStore(adapter);
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  return { store, board };
}
describe("freeform topic", () => {
  it("creates a canvas and undoes/redoes its creation", () => {
    const {store, board} = setup();
    expect(board.style).toMatchObject({ freeform: true, width: 720, height: 480 });
    store.undo(); expect(store.doc.node(board.id)).toBeUndefined();
    store.redo(); expect(store.doc.node(board.id)?.style.freeform).toBe(true);
    validateSheet(store.sheet);
  });
  it("preserves local placement across auto layout, force reflow and canvas movement", () => {
    const {store, board} = setup();
    const id = store.createFreeformItem(board.id, board.position.x + 90, board.position.y + 120, "Label")!;
    const node = store.doc.requireNode(id);
    store.beginNodeDrag(board.id);
    store.commitNodeDrag(board.id, null, "floating", board.position.x + 150, board.position.y + 80);
    expect(node.position.x - board.position.x).toBe(90);
    expect(node.position.y - board.position.y).toBe(120);
    applyLayout(store.sheet, true, undefined, true);
    expect(node.position.x - board.position.x).toBe(90);
    expect(node.position.y - board.position.y).toBe(120);
    expect(node.titleRuns).toEqual([{text: "Label"}]);
    validateSheet(store.sheet);
  });
  it("captures an existing subtree and undoes the whole move in one step", () => {
    const {store, board} = setup();
    const id = store.createChildOf(store.sheet.rootNodeId)!;
    store.commitEdit();
    const childId = store.createChildOf(id)!; store.commitEdit();
    const node = store.doc.requireNode(id), child = store.doc.requireNode(childId);
    const oldParent = node.parentId;
    const dx = child.position.x - node.position.x, dy = child.position.y - node.position.y;
    store.moveIntoFreeform(id, board.id, board.position.x + 80, board.position.y + 100);
    expect(freeformOwner(store.sheet, childId)).toBe(board.id);
    expect(child.position.x - node.position.x).toBe(dx);
    expect(child.position.y - node.position.y).toBe(dy);
    store.undo();
    expect(node.parentId).toBe(oldParent);
    expect(node.style.freeformPosition).toBeUndefined();
    expect(child.style.freeformPosition).toBeUndefined();
    store.redo(); expect(node.parentId).toBe(board.id);
    validateSheet(store.sheet);
  });
  it("previews an internal drag without losing the original undo coordinates", () => {
    const {store, board} = setup();
    const id = store.createFreeformItem(board.id, board.position.x + 40, board.position.y + 80, "Text")!;
    const n = store.doc.requireNode(id);
    store.beginNodeDrag(id);
    store.setNodeDragDraft(id, board.position.x + 180, board.position.y + 160);
    expect(n.position.x - board.position.x).toBe(180);
    store.commitNodeDrag(id, board.id, "child", board.position.x + 180, board.position.y + 160);
    store.undo();
    expect(n.style.freeformPosition).toEqual({x:40, y:80});
    store.redo(); expect(n.style.freeformPosition).toEqual({x:180, y:160});
  });
  it("retains contents through JSON round trip and canvas deletion undo", () => {
    const {store, board} = setup();
    const id = store.createFreeformItem(board.id, board.position.x + 60, board.position.y + 90, "Saved text")!;
    const restored = JSON.parse(JSON.stringify(store.sheet));
    applyLayout(restored, true);
    expect(restored.nodes[id].position.x - restored.nodes[board.id].position.x).toBe(60);
    expect(restored.nodes[id].title).toBe("Saved text");
    store.deleteNodes([board.id]); expect(store.doc.node(id)).toBeUndefined();
    store.undo(); expect(store.doc.node(id)?.title).toBe("Saved text");
    validateSheet(store.sheet);
  });
  it("resizes both dimensions as one undoable gesture", () => {
    const {store, board} = setup();
    store.beginResize(board.id);
    store.setResizeDraft(board.id, 920, {height: 630});
    store.commitResize();
    expect(board.style).toMatchObject({width:920, height:630});
    store.undo(); expect(board.style).toMatchObject({width:720, height:480});
    store.redo(); expect(board.style).toMatchObject({width:920, height:630});
  });
  it("transfers an attached image as a freely positioned item in one undo step", () => {
    const {store, board} = setup();
    const sourceId = store.createChildOf(store.sheet.rootNodeId)!; store.commitEdit();
    store.setNodeImage(sourceId, "image-id");
    store.moveImageIntoFreeform(sourceId, "top", board.id, board.position.x + 100, board.position.y + 100);
    const item = store.doc.requireNode(board.childrenIds[0]);
    expect(item.style.image).toBe("image-id");
    expect(item.style.freeformPosition).toEqual({x:100,y:100});
    expect(store.doc.node(sourceId)?.style.image).toBeUndefined();
    store.undo();
    expect(store.doc.node(sourceId)?.style.image).toBe("image-id");
    expect(store.doc.node(item.id)).toBeUndefined();
    store.redo(); expect(store.doc.node(item.id)?.style.image).toBe("image-id");
    validateSheet(store.sheet);
  });
  it("lays out contents in a freeform sheet and nested canvases", () => {
    const {store, board} = setup();
    store.createFreeformTopic(board.id);
    const nested = store.doc.requireNode(store.getSnapshot().selection[0]);
    const id = store.createFreeformItem(nested.id, nested.position.x + 70, nested.position.y + 80, "Nested")!;
    store.sheet.structure.structureType = "freeform";
    applyLayout(store.sheet, true);
    expect(store.doc.requireNode(id).position.x - nested.position.x).toBe(70);
    expect(store.doc.requireNode(id).position.y - nested.position.y).toBe(80);
    validateSheet(store.sheet);
  });
  it("exports canvas backgrounds behind internal relationships and labels", async () => {
    const {store, board} = setup();
    const a = store.createFreeformItem(board.id, board.position.x + 50, board.position.y + 80, "First")!;
    const b = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 180, "Second")!;
    store.createRelationship(a,b);
    const out = await sheetToSvg(store.sheet, {background: "#ffffff", measurer:HEURISTIC_MEASURER, colorOf:()=>({fill:"#ffffff",text:"#000000"}), linkColorOf:()=>"#aaaaaa"});
    expect(out.report.coverage.relationships.emitted).toBe(1);
    expect(out.svg.indexOf('rx="12"')).toBeLessThan(out.svg.indexOf("First"));
    expect(out.svg).toContain("Freeform</text>");
  });
  it("rejects cyclic containment", () => {
    const {store, board} = setup();
    store.createFreeformTopic(board.id);
    const nested = store.getSnapshot().selection[0];
    store.moveIntoFreeform(board.id, nested, 0, 0);
    expect(board.parentId).toBe(store.sheet.rootNodeId);
    validateSheet(store.sheet);
  });
});
