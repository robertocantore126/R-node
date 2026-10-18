/** Whole-map vector printing, plus the explicit raster rendering utility. */
import { Renderer, type RenderState } from "../render/renderer";
import { getAssetStore, type AssetStore } from "../persist/assets";
import { canvasMapToPdf, type CanvasPdfOptions } from "./canvasPdf";
import { sheetToPdf } from "./pdf";
import { pdfImageSource } from "./pdfImage";
import { createCanvasTextMeasurer } from "../layout/measure";
import { THEMES } from "../render/theme";

type EditorPdfOptions = Pick<CanvasPdfOptions, "page" | "margin"> & { assetStore?: AssetStore };

/** Vector map printing: only attached pictures are raster images. */
export async function editorMapToPdf(state: RenderState, options: EditorPdfOptions = {}) {
  const snapshot: RenderState={...state,sheet:structuredClone(state.sheet),rev:undefined};
  const assetStore=options.assetStore??getAssetStore();
  const renderer=new Renderer(document.createElement("canvas"),{assetStore});
  try {
    if(document.fonts?.ready) await document.fonts.ready;
    const theme=THEMES[snapshot.themeName];
    return await sheetToPdf(snapshot.sheet,{
      page:options.page,margin:options.margin,measurer:createCanvasTextMeasurer(),theme,grid:true,background:theme.background,
      colorOf:id=>renderer.nodeColors(snapshot,id),
      linkColorOf:id=>renderer.branchColorOf(snapshot,id),
      relColorOf:id=>snapshot.sheet.relationships.find(rel=>rel.id===id)?.color??theme.selection,
      imageBytes:async id=>{
        const image=await pdfImageSource(assetStore,id,{lossless:true,original:true});
        if(!image) throw new Error(`Cannot print image ${id}`);
        return image;
      },
    });
  } finally { renderer.dispose(); }
}


export async function editorMapToRasterPdf(state: RenderState, options: CanvasPdfOptions & { assetStore?: AssetStore } = {}) {
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
