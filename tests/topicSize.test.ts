import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { measureNode } from "../src/layout/measure";
import type { StorageAdapter } from "../src/persist/storage";
const adapter: StorageAdapter = { label: "test", async load() { return []; }, async save() {} };
function setup() {
  const store = new EditorStore(adapter);
  const id = store.createChildOf(store.sheet.rootNodeId)!;
  store.commitEdit(); store.select(id);
  return { store, node: store.doc.requireNode(id) };
}
describe("quick topic sizing", () => {
  it("makes a topic measurably larger and supports all three presets", () => {
    const {store, node} = setup();
    const before = measureNode(node);
    store.setSelectionTopicSize("heading");
    expect(node.style).toMatchObject({fontSize:200, padding:24, fontWeight:700});
    expect(measureNode(node).h).toBeGreaterThan(before.h);
    store.setSelectionTopicSize("large");
    expect(node.style).toMatchObject({fontSize:80, padding:16, fontWeight:600});
    store.setSelectionTopicSize("normal");
    expect(node.style).toMatchObject({fontSize:14, padding:10, fontWeight:400});
  });
  it("scales explicit inline font sizes and fixed geometry with undo/redo", () => {
    const {store, node} = setup();
    node.title = "Heading plain";
    node.titleRuns = [{text:"Heading",fontSize:28,bold:true,color:"#123456"},{text:" plain",italic:true}];
    node.style = {fontSize:14,width:210,height:70,padding:10};
    const before = JSON.parse(JSON.stringify(node));
    store.setSelectionTopicSize("large");
    expect(node.titleRuns?.[0]).toEqual({text:"Heading",fontSize:160,bold:true,color:"#123456"});
    expect(node.titleRuns?.[1]).toEqual({text:" plain",italic:true});
    expect(node.style).toMatchObject({width:1200,height:400});
    expect(node.titleRuns?.map((r)=>r.text).join("")).toBe(node.title);
    store.undo();
    expect(node.style).toEqual(before.style); expect(node.titleRuns).toEqual(before.titleRuns);
    store.redo(); expect(node.style.fontSize).toBe(80); expect(node.titleRuns?.[0].fontSize).toBe(160);
  });
  it("changes only selected ordinary topics in one undo step", () => {
    const {store, node} = setup();
    const child = store.createChildOf(node.id)!; store.commitEdit();
    const sibling = store.createChildOf(store.sheet.rootNodeId)!; store.commitEdit();
    const code = store.createChildOf(store.sheet.rootNodeId)!; store.commitEdit();
    store.setNodeStyle(code, {code:{lang:"text"}});
    const a = {...node.style}, b = {...store.doc.requireNode(sibling).style};
    store.selectMany([node.id,sibling,code]); store.setSelectionTopicSize("heading");
    expect(node.style.fontSize).toBe(200); expect(store.doc.requireNode(sibling).style.fontSize).toBe(200);
    expect(store.doc.requireNode(child).style.fontSize).toBeUndefined();
    expect(store.doc.requireNode(code).style.fontSize).toBeUndefined();
    store.undo(); expect(node.style).toEqual(a); expect(store.doc.requireNode(sibling).style).toEqual(b);
  });
  it("steps up and down, bounds repeated clicks and skips no-op history entries", () => {
    const {store, node} = setup();
    store.setSelectionTopicSize("larger"); expect(node.style.fontSize).toBe(18);
    store.setSelectionTopicSize("smaller"); expect(node.style.fontSize).toBe(14);
    store.setNodeStyle(node.id, {fontSize:160});
    store.setSelectionTopicSize("larger"); store.setSelectionTopicSize("larger");
    expect(node.style.fontSize).toBe(200);
    store.undo(); expect(node.style.fontSize).toBe(160);
    store.select(node.id);
    store.setNodeStyle(node.id, {fontSize:12});
    store.setSelectionTopicSize("smaller"); store.setSelectionTopicSize("smaller");
    expect(node.style.fontSize).toBe(10);
    store.undo(); expect(node.style.fontSize).toBe(12);
  });
  it("leaves special topics untouched", () => {
    const {store, node} = setup();
    for (const style of [{freeform:true,width:720,height:480},{gallery:{items:[]}},{shapeParts:[{d:"M0 0L1 1"}]}]) {
      node.style = style;
      const before = JSON.stringify(node.style);
      store.setSelectionTopicSize("heading");
      expect(JSON.stringify(node.style)).toBe(before);
    }
  });
});
