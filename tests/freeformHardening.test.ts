import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { applyLayout } from "../src/layout/mindmap";
import { measureNode } from "../src/layout/measure";
import type { MindNode } from "../src/core/types";
import { Renderer, type RenderState } from "../src/render/renderer";
const adapter = {label:"audit",async load(){return [];},async save(){}};
function setup(){const store=new EditorStore(adapter);store.createFreeformTopic(store.sheet.rootNodeId);return {store,board:store.doc.requireNode(store.getSnapshot().selection[0])};}
describe("freeform hardening regressions",()=>{
  it("deleting an image preserves the topic, notes and quizzes",()=>{
    const {store,board}=setup();
    const id=store.createFreeformItem(board.id,undefined,undefined,"","asset-id")!;
    const item=store.doc.requireNode(id);
    item.notes="Keep these important annotations";
    item.style.quizzes=[{id:"quiz",questions:[{q:"Q",answers:["a","b","c","d"],correct:0}]}];
    store.selectImage(id,"top");store.deleteSelectedImage();
    expect(store.doc.requireNode(id).notes).toBe("Keep these important annotations");
    expect(item.style.quizzes).toHaveLength(1);
    expect(item.style.image).toBeUndefined();
    store.undo();expect(store.doc.requireNode(id).style.image).toBe("asset-id");
    store.redo();expect(store.doc.requireNode(id).notes).toBe("Keep these important annotations");
  });
  it("left resize preserves the right edge and local position through undo/redo",()=>{
    const {store,board}=setup();
    const id=store.createFreeformItem(board.id,board.position.x+80,board.position.y+100,"Text")!;
    store.setNodeStyle(id,{width:200});applyLayout(store.sheet,false);
    const item=store.doc.requireNode(id);const oldX=item.position.x;const oldRight=oldX+measureNode(item).w;
    store.beginResize(id);store.setResizeDraft(id,160,{anchorRight:true,x:oldX+40});
    applyLayout(store.sheet,false);store.commitResize();applyLayout(store.sheet,false);
    const newRight=item.position.x+measureNode(item).w;
    expect(item.position.x).toBe(oldX+40);expect(newRight).toBe(oldRight);
    store.undo();applyLayout(store.sheet,false);
    expect(item.position.x).toBe(oldX);expect(item.style.width).toBe(200);
    store.redo();applyLayout(store.sheet,false);
    expect(item.position.x).toBe(oldX+40);expect(item.position.x+measureNode(item).w).toBe(oldRight);
  });
  it("shrinking the canvas stops at its content bounds",()=>{
    const {store,board}=setup();
    const id=store.createFreeformItem(board.id,board.position.x+600,board.position.y+400,"Outside")!;
    store.beginResize(board.id);store.setResizeDraft(board.id,240,{height:160});store.commitResize();applyLayout(store.sheet,false);
    const item=store.doc.requireNode(id);
    expect(item.position.x+measureNode(item).w+16).toBeLessThanOrEqual(board.position.x+board.style.width!);
    expect(item.position.y+measureNode(item).h+16).toBeLessThanOrEqual(board.position.y+board.style.height!);
    const size={w:board.style.width,h:board.style.height};
    store.undo();expect(board.style.width).toBe(720);
    store.redo();expect(board.style.width).toBe(size.w);expect(board.style.height).toBe(size.h);
    store.setNodeStyle(board.id,{width:240,height:160});
    expect(board.style.width).toBe(size.w);expect(board.style.height).toBe(size.h);
  });
  it("internal drag preserves the parent relationship and its undo history",()=>{
    const {store,board}=setup();
    const parent=store.createFreeformItem(board.id,undefined,undefined,"Parent")!;
    const child=store.createChildOf(parent)!;store.commitEdit();
    expect(store.doc.requireNode(child).parentId).toBe(parent);
    const item=store.doc.requireNode(child);
    store.beginNodeDrag(child);store.setNodeDragDraft(child,item.position.x+20,item.position.y+20);
    store.commitNodeDrag(child,board.id,"child",item.position.x,item.position.y);
    expect(item.parentId).toBe(parent);
    expect(store.doc.requireNode(parent).childrenIds).toContain(child);
    const offset={...item.style.freeformPosition!};
    store.undo();applyLayout(store.sheet,false);expect(item.parentId).toBe(parent);
    store.redo();applyLayout(store.sheet,false);expect(item.parentId).toBe(parent);expect(item.style.freeformPosition).toEqual(offset);
  });
  it("grows enclosing canvases in the same undo step as content creation", () => {
    const {store, board} = setup();
    store.createFreeformTopic(board.id);
    const nested = store.doc.requireNode(store.getSnapshot().selection[0]);
    const before = {outer: {...board.style}, inner: {...nested.style}};
    const id = store.createFreeformItem(nested.id, nested.position.x + 900, nested.position.y + 700, "Far away")!;
    const item = store.doc.requireNode(id);
    expect(nested.style.width).toBeGreaterThanOrEqual(900 + measureNode(item).w + 16);
    expect(nested.position.x + nested.style.width! + 16).toBeLessThanOrEqual(board.position.x + board.style.width!);
    expect(nested.position.y + nested.style.height! + 16).toBeLessThanOrEqual(board.position.y + board.style.height!);
    expect(board.style.width).toBeGreaterThan(before.outer.width!);
    expect(board.style.height).toBeGreaterThan(before.outer.height!);
    const after = {outer: {...board.style}, inner: {...nested.style}};
    store.undo();
    expect(store.doc.node(id)).toBeUndefined();
    expect(board.style).toEqual(before.outer); expect(nested.style).toEqual(before.inner);
    store.redo();
    expect(board.style).toEqual(after.outer); expect(nested.style).toEqual(after.inner);
  });
  it("contains descendants on the left when capturing an ordinary subtree", () => {
    const {store, board} = setup();
    const parentId = store.createChildOf(store.sheet.rootNodeId)!; store.commitEdit();
    const childId = store.createChildOf(parentId)!; store.commitEdit();
    const parent = store.doc.requireNode(parentId), child = store.doc.requireNode(childId);
    parent.position = {x:300,y:300,manual:true}; child.position = {x:80,y:200,manual:true};
    // Stale offsets from an earlier visit must not override current external geometry.
    child.style.freeformPosition = {x:999,y:999};
    store.moveIntoFreeform(parentId,board.id,board.position.x + 20,board.position.y + 60);
    expect(child.position.x-parent.position.x).toBe(-220);
    expect(child.position.y-parent.position.y).toBe(-100);
    for (const node of [parent,child]) {
      expect(node.position.x).toBeGreaterThanOrEqual(board.position.x+16);
      expect(node.position.y).toBeGreaterThanOrEqual(board.position.y+52);
      expect(node.position.x+measureNode(node).w).toBeLessThanOrEqual(board.position.x+board.style.width!-16);
      expect(node.position.y+measureNode(node).h).toBeLessThanOrEqual(board.position.y+board.style.height!-16);
    }
  });
  it("resizing a descendant respects ancestor canvas bounds", () => {
    const {store,board}=setup();
    const parent=store.createFreeformItem(board.id,board.position.x+300,board.position.y+250,"Parent")!;
    const child=store.createChildOf(parent)!;store.commitEdit();
    store.setNodeStyle(child,{width:640,height:200});
    const item=store.doc.requireNode(child);applyLayout(store.sheet,false);
    expect(item.position.x+measureNode(item).w+16).toBeLessThanOrEqual(board.position.x+board.style.width!);
    store.setNodeStyle(board.id,{width:board.style.width!+100,height:board.style.height!+100});
    const old={...board.style};
    store.beginResize(board.id);store.setResizeDraft(board.id,240,{height:160});store.commitResize();applyLayout(store.sheet,false);
    expect(item.position.x+measureNode(item).w+16).toBeLessThanOrEqual(board.position.x+board.style.width!);
    store.undo();expect(board.style).toEqual(old);
  });
  it("left resize cannot pull a topic outside its canvas", () => {
    const {store,board}=setup();
    const id=store.createFreeformItem(board.id,board.position.x+80,board.position.y+100,"Text")!;
    store.setNodeStyle(id,{width:200});applyLayout(store.sheet,false);
    const item=store.doc.requireNode(id), oldRight=item.position.x+measureNode(item).w;
    store.beginResize(id);store.setResizeDraft(id,640,{anchorRight:true,x:item.position.x-440});
    store.commitResize();applyLayout(store.sheet,false);
    expect(item.position.x).toBeGreaterThanOrEqual(board.position.x+16);
    expect(item.position.x+measureNode(item).w).toBe(oldRight);
    store.undo();applyLayout(store.sheet,false);expect(item.style.freeformPosition?.x).toBe(80);
  });
  it("foreground topics receive hits before canvas backgrounds",()=>{
    const {store,board}=setup();
    const id=store.createChildOf(store.sheet.rootNodeId)!;store.commitEdit();
    const root=store.doc.rootNode;
    // Put a normal sibling earlier in BFS, within the later board's bounds.
    root.childrenIds=[id,board.id];board.position={x:100,y:100,manual:true};
    const item=store.doc.requireNode(id);item.position={x:200,y:200,manual:true};item.style={width:100,height:50};
    const calls:string[]=[];
    const ctx=new Proxy({}, {get:(_t,key)=>key==="measureText"?((text:string)=>({width:text.length*7,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3})):(()=>{}),set:()=>true}) as CanvasRenderingContext2D;
    const canvas={width:1200,height:900,getContext:()=>ctx} as unknown as HTMLCanvasElement;
    vi.stubGlobal("document",{createElement:()=>canvas});
    vi.stubGlobal("window",{devicePixelRatio:1});
    try {
      const renderer=new Renderer(canvas);
      const actual=renderer as unknown as {
        drawFreeform: (theme:unknown,p:{node:MindNode})=>void;
        drawNode: (theme:unknown,p:{node:MindNode},state:RenderState,paint?:boolean)=>void;
      };
      vi.spyOn(actual,"drawFreeform").mockImplementation((_t,p)=>calls.push("background:"+p.node.id));
      const original=actual.drawNode.bind(renderer);
      vi.spyOn(actual,"drawNode").mockImplementation((theme,p,state,paint)=>{if(!p.node.style.freeform)calls.push("foreground:"+p.node.id);return original(theme,p,state,paint);});
      const state:RenderState={sheet:store.sheet,camera:{x:400,y:300,scale:1},selection:new Set(),editingId:null,hoverId:null,drop:null,themeName:"light",viewW:1200,viewH:900};
      renderer.render(state);
      expect(calls.indexOf("background:"+board.id)).toBeLessThan(calls.indexOf("foreground:"+id));
      expect(renderer.hitTest(state,220,220)).toBe(id);
      expect(renderer.hitTest(state,220,220,(candidate)=>candidate===id)).toBe(board.id);
      expect(renderer.hitTest(state,400,400)).toBe(board.id);
    } finally {vi.unstubAllGlobals();vi.restoreAllMocks();}
  });
});
