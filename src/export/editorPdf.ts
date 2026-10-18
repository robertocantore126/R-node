/** Print the whole map through the exact Canvas2D painter used by the editor. */
import { Renderer, type RenderState } from "../render/renderer";
import { getAssetStore, type AssetStore } from "../persist/assets";
import { canvasMapToPdf, type CanvasPdfOptions } from "./canvasPdf";

export async function editorMapToPdf(state: RenderState, options: CanvasPdfOptions & { assetStore?: AssetStore } = {}) {
  const canvas=document.createElement("canvas");
  const printer=new Renderer(canvas,{assetStore:options.assetStore??getAssetStore()});
  const snapshot:RenderState={...state,sheet:structuredClone(state.sheet),rev:undefined,showHidden:false};
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const bounds=printer.printBounds(snapshot);
    // Preserve CSS-pixel strokes and arrowheads while sampling at print DPI.
    const pixelRatio=(options.dpi??300)/96;
    return await canvasMapToPdf(bounds,async(tile)=>{
      canvas.width=tile.w;canvas.height=tile.h;
      await printer.renderForPrint({...snapshot,camera:{x:tile.world.x+tile.world.w/2,y:tile.world.y+tile.world.h/2,scale:tile.scale/pixelRatio},viewW:tile.w/pixelRatio,viewH:tile.h/pixelRatio},pixelRatio);
      const context=canvas.getContext("2d");
      if(!context) throw new Error("Print canvas is unavailable");
      const rgba=context.getImageData(0,0,tile.w,tile.h).data;
      const rgb=new Uint8Array(tile.w*tile.h*3);
      for(let from=0,to=0;from<rgba.length;from+=4) { rgb[to++]=rgba[from];rgb[to++]=rgba[from+1];rgb[to++]=rgba[from+2]; }
      return rgb;
    },options);
  } finally {
    printer.dispose();canvas.width=1;canvas.height=1;
  }
}
