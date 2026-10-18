/** Lossless tiled PDF of the editor renderer. No second text/shape renderer. */
import { zlibSync } from "fflate";
import { PAGE_SIZES, PT_PER_UNIT } from "./pdf";

export interface PrintBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface PrintTile {
  page: number;
  x: number; y: number; w: number; h: number;
  world: { x: number; y: number; w: number; h: number };
  scale: number;
}
export interface CanvasPdfOptions {
  page?: { w: number; h: number };
  margin?: number;
  dpi?: number;
  tileSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Full-width vertical pages, matching the existing print layout. */
export function planCanvasPdf(bounds: PrintBounds, options: CanvasPdfOptions = {}) {
  const paper = options.page ?? PAGE_SIZES.A1;
  const margin = options.margin ?? 28.35;
  const dpi = options.dpi ?? 300;
  const tileSize = options.tileSize ?? 2048;
  if (![paper.w, paper.h, margin, dpi, tileSize, ...Object.values(bounds)].every(Number.isFinite) ||
      paper.w <= margin * 2 || paper.h <= margin * 2 || margin < 0 || dpi < 36 || dpi > 600 || tileSize < 64 || tileSize > 2048 || !Number.isInteger(tileSize) ||
      bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw new Error("Invalid PDF print dimensions");
  const width = paper.w - margin * 2, height = paper.h - margin * 2;
  const scale = Math.min(PT_PER_UNIT, width / (bounds.maxX - bounds.minX));
  const bandH = height / scale;
  const pages = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / bandH));
  const raster = dpi / 72;
  const pixelW = Math.ceil(width * raster), pixelH = Math.ceil(height * raster);
  const columns = Math.ceil(pixelW / tileSize), rows = Math.ceil(pixelH / tileSize);
  if (pages > 10000 || pages * columns * rows > 100000) throw new Error("Map is too large for this print layout");
  return { paper, margin, dpi, tileSize: Math.floor(tileSize), scale, raster, bandH, pages, pixelW, pixelH, columns, rows, bounds };
}

/** RGB callback is sequential: at most one 2048 x 2048 raster is in flight. */
export async function canvasMapToPdf(bounds: PrintBounds, render: (tile: PrintTile) => Promise<Uint8Array>, options: CanvasPdfOptions = {}) {
  const started = performance.now();
  const plan = planCanvasPdf(bounds, options);
  const chunks: BlobPart[] = [], offsets: number[] = [0];
  let position = 0, nextId = 4, done = 0;
  const encoder = new TextEncoder();
  const put = (bytes: Uint8Array): void => { chunks.push(bytes as BlobPart); position += bytes.byteLength; };
  const str = (value: string): void => put(encoder.encode(value));
  const number = (value: number): string => Number(value.toFixed(5)).toString();
  const object = (id: number, dictionary: string, bytes?: Uint8Array): void => {
    offsets[id] = position;
    str(`${id} 0 obj\n${dictionary}\n`);
    if (bytes) { str("stream\n");put(bytes);str("\nendstream\n"); }
    str("endobj\n");
  };
  const tilesPerPage = plan.columns * plan.rows;
  const pageIds = Array.from({length:plan.pages},()=>{
    const page = nextId++, content = nextId++;
    const images = Array.from({length:tilesPerPage},()=>nextId++);
    return {page,content,images};
  });
  str("%PDF-1.7\n%R-node canvas print\n");
  object(1,"<< /Type /Catalog /Pages 2 0 R >>");
  object(2,`<< /Type /Pages /Count ${plan.pages} /Kids [${pageIds.map((ids)=>`${ids.page} 0 R`).join(" ")}] >>`);
  object(3,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page=0;page<plan.pages;page++) {
    const ids=pageIds[page];
    const commands=[`q ${number(plan.margin)} ${number(plan.margin)} ${number(plan.paper.w-plan.margin*2)} ${number(plan.paper.h-plan.margin*2)} re W n`];
    let index=0;
    for(let y=0;y<plan.pixelH;y+=plan.tileSize) for(let x=0;x<plan.pixelW;x+=plan.tileSize) {
      const w=Math.min(plan.tileSize,plan.pixelW-x),h=Math.min(plan.tileSize,plan.pixelH-y);
      const pixelScale=plan.scale*plan.raster;
      const tile:PrintTile={page,x,y,w,h,scale:pixelScale,world:{x:bounds.minX+x/pixelScale,y:bounds.minY+page*plan.bandH+y/pixelScale,w:w/pixelScale,h:h/pixelScale}};
      const rgb=await render(tile);
      if(rgb.length!==w*h*3) throw new Error("The editor returned an incomplete print tile");
      const compressed=zlibSync(rgb);
      object(ids.images[index],`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode /Length ${compressed.length} >>`,compressed);
      commands.push(`q ${number(w/plan.raster)} 0 0 ${number(h/plan.raster)} ${number(plan.margin+x/plan.raster)} ${number(plan.paper.h-plan.margin-(y+h)/plan.raster)} cm /Im${index} Do Q`);
      index++;done++;options.onProgress?.(done,plan.pages*tilesPerPage);
      // Let the modal/progress repaint between expensive lossless tiles.
      await new Promise<void>((resolve)=>setTimeout(resolve,0));
    }
    commands.push("Q",`BT /F1 8 Tf 0.4 0.4 0.4 rg ${number(plan.paper.w/2-12)} ${number(plan.margin/2)} Td (${page+1} / ${plan.pages}) Tj ET`);
    const stream=zlibSync(encoder.encode(commands.join("\n")));
    object(ids.content,`<< /Length ${stream.length} /Filter /FlateDecode >>`,stream);
    object(ids.page,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(plan.paper.w)} ${number(plan.paper.h)}] /Resources << /Font << /F1 3 0 R >> /XObject << ${ids.images.map((id,i)=>`/Im${i} ${id} 0 R`).join(" ")} >> >> /Contents ${ids.content} 0 R >>`);
  }
  const xref=position;
  str(`xref\n0 ${nextId}\n0000000000 65535 f \n`);
  for(let id=1;id<nextId;id++) str(`${String(offsets[id]).padStart(10,"0")} 00000 n \n`);
  str(`trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const blob=new Blob(chunks,{type:"application/pdf"});
  return {blob,bytes:blob.size,pages:plan.pages,tiles:done,dpi:plan.dpi,scale:plan.scale,ms:performance.now()-started};
}
