import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
describe("AVIF worker import",()=>{
  it("preserves original AVIF bytes and generates PNG display levels for transparency",async()=>{
    const source={width:2048,height:1024,close:vi.fn()};
    const bitmap=vi.fn(async()=>source), converted=vi.fn(async()=>new Blob(["display PNG"],{type:"image/png"}));
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
    expect(converted).toHaveBeenCalledWith({type:"image/png",quality:0.85});
    expect(result.result.levels.large.blob.type).toBe("image/png");
    expect(source.close).toHaveBeenCalledTimes(1);
  });
});
