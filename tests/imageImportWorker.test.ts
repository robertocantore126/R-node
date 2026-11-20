import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
describe("image worker import",()=>{
  it("preserves original AVIF bytes and generates WebP display levels for transparency",async()=>{
    const source={width:2048,height:1024,close:vi.fn()};
    const bitmap=vi.fn(async()=>source), converted=vi.fn(async()=>new Blob(["display WebP"],{type:"image/webp"}));
    const canvas=class {getContext(){return {drawImage:vi.fn()};} convertToBlob=converted;};
    let finish:(value:any)=>void=()=>{};
    const done=new Promise<any>((resolve)=>{finish=resolve;});
    const scope={onmessage:null as null|((e:MessageEvent)=>void),postMessage:vi.fn((value)=>finish(value))};
    vi.stubGlobal("self",scope);vi.stubGlobal("createImageBitmap",bitmap);vi.stubGlobal("OffscreenCanvas",canvas);
    await import("../src/editor/imageImport.worker");
    const blob=new Blob(["original AVIF fixture"],{type:"image/avif"});
    scope.onmessage!({data:{blob,mime:"image/avif",name:"photo.avif"}} as MessageEvent);
    const result=await done;
    expect(result.ok).toBe(true);expect(result.result.meta.mime).toBe("image/avif");
    expect(await result.result.levels.original.blob.text()).toBe("original AVIF fixture");
    expect(converted).toHaveBeenCalledTimes(2);
    expect(converted).toHaveBeenCalledWith({type:"image/webp",quality:0.9});
    expect(result.result.levels.large.blob.type).toBe("image/webp");
    expect(source.close).toHaveBeenCalledTimes(3);
  });

  it("probes PNG header dimensions without decoding the full original",async()=>{
    const resized={width:1024,height:512,close:vi.fn()};
    const bitmap=vi.fn(async()=>resized), converted=vi.fn(async()=>new Blob(["webp"],{type:"image/webp"}));
    const canvas=class {getContext(){return {drawImage:vi.fn()};} convertToBlob=converted;};
    let finish:(value:any)=>void=()=>{};
    const done=new Promise<any>((resolve)=>{finish=resolve;});
    const scope={onmessage:null as null|((e:MessageEvent)=>void),postMessage:vi.fn((value)=>finish(value))};
    vi.stubGlobal("self",scope);vi.stubGlobal("createImageBitmap",bitmap);vi.stubGlobal("OffscreenCanvas",canvas);
    await import("../src/editor/imageImport.worker");
    const pngHeader=new Uint8Array(24);
    pngHeader.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],0);
    const dv=new DataView(pngHeader.buffer);
    dv.setUint32(16,4000,false);dv.setUint32(20,2000,false);
    const blob=new Blob([pngHeader],{type:"image/png"});
    scope.onmessage!({data:{blob,mime:"image/png",name:"big.png"}} as MessageEvent);
    const result=await done;
    expect(result.ok).toBe(true);
    expect(result.result.meta.w).toBe(4000);
    expect(result.result.meta.h).toBe(2000);
    // A tiny orientation probe and the two level decodes, never a full-size decode.
    expect(bitmap).toHaveBeenCalledTimes(3);
    expect(bitmap).toHaveBeenNthCalledWith(1,blob,{resizeWidth:64,resizeQuality:"low"});
    expect(bitmap).toHaveBeenNthCalledWith(2,blob,{resizeWidth:1024,resizeHeight:512,resizeQuality:"high"});
    expect(bitmap).toHaveBeenNthCalledWith(3,blob,{resizeWidth:256,resizeHeight:128,resizeQuality:"high"});
  });

  it("swaps the header size of a JPEG the browser draws rotated (EXIF orientation)",async()=>{
    // Stored 4000x3000 (landscape), shown portrait: the probe decode is taller than wide.
    const bitmap=vi.fn(async(_b:Blob,o:{resizeWidth:number;resizeHeight?:number})=>({width:o.resizeWidth,height:o.resizeHeight??Math.round(o.resizeWidth*4/3),close:vi.fn()}));
    const converted=vi.fn(async()=>new Blob(["webp"],{type:"image/webp"}));
    const canvas=class {getContext(){return {drawImage:vi.fn()};} convertToBlob=converted;};
    let finish:(value:any)=>void=()=>{};
    const done=new Promise<any>((resolve)=>{finish=resolve;});
    const scope={onmessage:null as null|((e:MessageEvent)=>void),postMessage:vi.fn((value)=>finish(value))};
    vi.stubGlobal("self",scope);vi.stubGlobal("createImageBitmap",bitmap);vi.stubGlobal("OffscreenCanvas",canvas);
    await import("../src/editor/imageImport.worker");
    const jpg=new Uint8Array(40);
    jpg.set([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08],0);
    const dv=new DataView(jpg.buffer);
    dv.setUint16(7,3000,false);dv.setUint16(9,4000,false);
    const blob=new Blob([jpg],{type:"image/jpeg"});
    scope.onmessage!({data:{blob,mime:"image/jpeg",name:"phone.jpg"}} as MessageEvent);
    const result=await done;
    expect(result.ok).toBe(true);
    expect([result.result.meta.w,result.result.meta.h]).toEqual([3000,4000]);
    expect([result.result.levels.large.w,result.result.levels.large.h]).toEqual([768,1024]);
    expect(bitmap).toHaveBeenNthCalledWith(2,blob,{resizeWidth:768,resizeHeight:1024,resizeQuality:"high"});
  });
});
