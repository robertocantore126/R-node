import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { validateSheet } from "../src/core/validate";
import { handleShortcut } from "../src/editor/shortcuts";
import { topicClipboardHtml, topicClipboardFromHtml } from "../src/editor/topicClipboard";
import { getAssetStore } from "../src/persist/assets";

class Item {
  types: string[];
  constructor(readonly data: Record<string, Blob>) { this.types=Object.keys(data); }
  async getType(type:string) { if(!this.data[type]) throw new Error("missing type");return this.data[type]; }
}
function clipboard(plainOnly=false) {
  let plain="", items: Item[]=[];
  vi.stubGlobal("ClipboardItem",Item);
  const api={
    write:vi.fn(async (values:Item[])=>{ if(plainOnly) throw new Error("custom formats blocked");items=values;plain=await values[0].getType("text/plain").then((b)=>b.text()); }),
    writeText:vi.fn(async (value:string)=>{plain=value;items=[];}),
    read:vi.fn(async ()=>items), readText:vi.fn(async ()=>plain),
  };
  vi.stubGlobal("navigator",{clipboard:api});
  return {api, externalText(value:string){plain=value;items=[];}, items:()=>items};
}
function setup() {
  const store=new EditorStore({label:"test",async load(){return [];},async save(){}});
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board=store.doc.requireNode(store.getSnapshot().selection[0]);
  return {store,board};
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("diagram clipboard",()=>{
  it("preserves selected nodes, styles, relative layout and cross-selection links",async()=>{
    clipboard();const {store,board}=setup();
    const a=store.createFreeformItem(board.id,board.position.x+80,board.position.y+100,"One")!;
    const b=store.createFreeformItem(board.id,board.position.x+300,board.position.y+200,"Two")!;
    store.setNodeStyle(a,{fill:"#123456",fontSize:80});store.createRelationship(a,b);
    store.sheet.relationships.at(-1)!.connector="elbow";
    store.selectMany([a,b]);await store.copySelection();await store.paste();
    const copies=store.getSnapshot().selection.map((id)=>store.doc.requireNode(id));
    expect(copies).toHaveLength(2);expect(copies.map((n)=>n.title)).toEqual(["One","Two"]);
    expect(copies[0].parentId).toBe(board.id);expect(copies[1].parentId).toBe(board.id);
    expect(copies[0].style.fill).toBe("#123456");expect(copies[0].style.fontSize).toBe(80);
    expect(copies[1].position.x-copies[0].position.x).toBe(220);
    expect(copies[1].position.y-copies[0].position.y).toBe(100);
    expect(copies[0].position.x-store.doc.requireNode(a).position.x).toBe(24);
    expect(store.sheet.relationships.some((r)=>r.fromId===copies[0].id&&r.toId===copies[1].id&&r.connector==="elbow")).toBe(true);
    store.undo();expect(store.doc.node(copies[0].id)).toBeUndefined();expect(store.doc.node(copies[1].id)).toBeUndefined();
    store.redo();validateSheet(store.sheet);
  });
  it("copies a selected image independently, and repeated pastes do not overlap",async()=>{
    clipboard();const {store,board}=setup();
    const id=store.createFreeformItem(board.id,board.position.x+80,board.position.y+100,"", "asset")!;
    store.doc.requireNode(id).notes="Do not copy the image topic's annotations";
    store.selectImage(id);await store.copySelection();await store.paste();
    const copy=store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(copy.parentId).toBe(board.id);expect(copy.style.image).toBe("asset");expect(copy.notes).toBe("");
    expect(copy.id).not.toBe(id);expect(board.childrenIds).toHaveLength(2);
    await store.paste();const second=store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(second.position.x-copy.position.x).toBe(24);validateSheet(store.sheet);
  });
  it("copies only the selected side image and gallery cell",async()=>{
    clipboard();const {store,board}=setup();
    const source=store.createFreeformItem(board.id,undefined,undefined,"Source","top-image")!;
    store.setNodeStyle(source,{imageLeft:"left-image",gallery:{items:[{id:"cell-image",caption:"Cell"}]}});
    store.selectImage(source,"left");await store.copySelection();await store.paste();
    expect(store.doc.requireNode(store.getSnapshot().selection[0]).style.image).toBe("left-image");
    store.selectGalleryCell(source,0);await store.copySelection();store.select(board.id);await store.paste();
    const cellCopy=store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(cellCopy.style.image).toBe("cell-image");expect(cellCopy.title).toBe("Cell");
  });
  it("falls back internally when the browser supports only plain text and preserves external text",async()=>{
    const cb=clipboard(true);const {store,board}=setup();
    const id=store.createFreeformItem(board.id,undefined,undefined,"Original")!;
    store.setNodeStyle(id,{fill:"#123456"});store.select(id);await store.copySelection();await store.paste();
    expect(store.doc.requireNode(store.getSnapshot().selection[0]).style.fill).toBe("#123456");
    cb.externalText("Copied from another app");await store.paste();
    const pasted=store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(pasted.title).toBe("Copied from another app");expect(pasted.parentId).toBe(board.id);
    expect(pasted.style.fill).toBeUndefined();
  });
  it("uses standard HTML to paste into another store with attachment metadata",async()=>{
    clipboard();const first=setup();
    first.store.sheet.attachments.push({id:"asset",mime:"image/avif",w:300,h:200,bytes:15});
    const id=first.store.createFreeformItem(first.board.id,undefined,undefined,"","asset")!;
    first.store.selectImage(id);await first.store.copySelection();
    const second=setup();second.store.select(second.board.id);await second.store.paste();
    expect(second.store.sheet.attachments.some((c)=>c.id==="asset"&&c.mime==="image/avif")).toBe(true);
    expect(second.store.doc.requireNode(second.store.getSnapshot().selection[0]).style.image).toBe("asset");
  });
  it("restores copied image bytes after deleting the original asset",async()=>{
    clipboard();const {store,board}=setup(),assets=getAssetStore();
    const blob=new Blob(["original avif bytes"],{type:"image/avif"});
    const levels={original:{blob,w:200,h:100},large:{blob,w:200,h:100},small:{blob,w:200,h:100}};
    const asset=await assets.put(levels,{mime:"image/avif",w:200,h:100,bytes:blob.size});
    store.sheet.attachments.push((await assets.meta(asset))!);
    const id=store.createFreeformItem(board.id,undefined,undefined,"",asset)!;
    store.selectImage(id);await store.copySelection();
    // Let the snapshot read all levels before simulating GC.
    await (store as unknown as {copiedElements:{assets:Promise<unknown>}}).copiedElements.assets;
    await assets.delete(asset);store.deleteNodes([id]);store.select(board.id);await store.paste();
    expect(await (await assets.get(asset,"original"))!.text()).toBe("original avif bytes");
    expect(store.doc.requireNode(store.getSnapshot().selection[0]).style.image).toBe(asset);
  });
  it("retains a subtree when the parent and a descendant are both selected",async()=>{
    clipboard();const {store,board}=setup();
    const parent=store.createFreeformItem(board.id,undefined,undefined,"Parent")!;
    const child=store.createChildOf(parent)!;store.commitEdit();store.selectMany([parent,child]);
    await store.copySelection();await store.paste();
    expect(store.getSnapshot().selection).toHaveLength(1);
    const copied=store.doc.requireNode(store.getSnapshot().selection[0]);expect(copied.childrenIds).toHaveLength(1);
    expect(store.doc.requireNode(copied.childrenIds[0]).parentId).toBe(copied.id);validateSheet(store.sheet);
  });
  it("handles Ctrl+C for an image without allowing native browser copy to overwrite it",async()=>{
    const cb=clipboard();const {store,board}=setup();
    const id=store.createFreeformItem(board.id,undefined,undefined,"","asset")!;store.selectImage(id);
    const e={key:"c",ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,preventDefault:vi.fn()} as unknown as KeyboardEvent;
    expect(handleShortcut(store,e,1000,700)).toBe(true);expect(e.preventDefault).toHaveBeenCalled();
    await vi.waitFor(()=>expect(cb.api.write).toHaveBeenCalled());
  });
  it("uses the session clipboard when all browser clipboard access is denied",async()=>{
    const cb=clipboard(true);cb.api.writeText.mockRejectedValue(new Error("denied"));cb.api.read.mockRejectedValue(new Error("denied"));cb.api.readText.mockRejectedValue(new Error("denied"));
    const {store,board}=setup();const id=store.createFreeformItem(board.id,undefined,undefined,"Offline")!;
    store.select(id);await store.copySelection();await store.paste();
    expect(store.doc.requireNode(store.getSnapshot().selection[0]).title).toBe("Offline");
    expect(board.childrenIds).toHaveLength(2);
  });
  it("cancels the async keyboard fallback when a native paste supplies data",async()=>{
    clipboard();const {store,board}=setup();store.select(board.id);
    vi.useFakeTimers();
    try {
      const e={key:"v",ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,preventDefault:vi.fn()} as unknown as KeyboardEvent;
      expect(handleShortcut(store,e,1000,700)).toBe(false);expect(e.preventDefault).not.toHaveBeenCalled();
      store.cancelPendingPaste();await store.paste(undefined,"Native clipboard text");
      await vi.advanceTimersByTimeAsync(200);
      expect(board.childrenIds).toHaveLength(1);
      expect(store.doc.requireNode(board.childrenIds[0]).title).toBe("Native clipboard text");
    } finally {vi.useRealTimers();}
  });
  it("pastes once through the async fallback when the webview emits no native event",async()=>{
    const cb=clipboard();cb.externalText("Fallback text");
    const {store,board}=setup();store.select(board.id);vi.useFakeTimers();
    try {
      store.requestPaste();await vi.advanceTimersByTimeAsync(200);
      expect(board.childrenIds).toHaveLength(1);
      expect(store.doc.requireNode(board.childrenIds[0]).title).toBe("Fallback text");
    } finally {vi.useRealTimers();}
  });
  it("keeps rapid repeated paste gestures when native events are unavailable",async()=>{
    const cb=clipboard();cb.externalText("Repeat");const {store,board}=setup();store.select(board.id);
    vi.useFakeTimers();
    try {store.requestPaste();store.requestPaste();await vi.advanceTimersByTimeAsync(200);expect(board.childrenIds).toHaveLength(2);}
    finally {vi.useRealTimers();}
  });
  it("ignores malformed map payloads without throwing or partially creating nodes",async()=>{
    const {store}=setup();const count=Object.keys(store.sheet.nodes).length;
    await expect(store.paste(undefined,JSON.stringify({app:"r-node",payload:{rootId:"broken",nodes:[{id:"broken"}]}}))).resolves.toBeUndefined();
    expect(Object.keys(store.sheet.nodes)).toHaveLength(count);
  });
  it("round-trips the HTML marker without exposing raw JSON as plain text",()=>{
    const raw=JSON.stringify({app:"r-node",payload:{title:'<label> "quote"'}});
    const html=topicClipboardHtml(raw,"<label> & text");
    expect(topicClipboardFromHtml(html)).toBe(raw);expect(html).toContain("&lt;label&gt; &amp; text");
    expect(topicClipboardFromHtml("<p>External text</p>")).toBeNull();
  });
});
