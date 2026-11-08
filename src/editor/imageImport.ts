/**
 * Image import pipeline (T13-1).
 *
 * The heavy work — reading the file, SHA-256, decoding, and generating the
 * three levels — runs inside a Web Worker (imageImport.worker.ts) so a
 * multi-megabyte original never stalls the main thread. This module holds
 * the pure, testable contract: what is accepted, how the derived levels are
 * sized, and how the worker is dispatched. The bytes are stored through
 * AssetStore.put (ADR-001 §12): the original intact plus 1024px and 256px
 * levels on the long side.
 *
 * SVG is accepted as a SOURCE only. It is drawn to a canvas here and the
 * worker — and therefore the store, the renderer and every export — only ever
 * sees a PNG. Keeping the vector out of the store is what makes accepting it
 * safe: nothing ever renders an SVG document, so there is no script to run.
 */
import type { AssetBlob, AssetLevel, AssetMeta } from "../persist/assets";

/** Raster formats the store keeps as they are. */
export const IMAGE_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

/**
 * Accepted on input, never stored: rasterizeSvg turns it into a PNG first.
 * An SVG is an executable document, so it may cross the import boundary as a
 * picture but must not survive it as a document.
 */
export const SVG_MIME = "image/svg+xml";

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** Long side of each derived level, in pixels. */
export const LEVEL_LONG_SIDE: Record<Exclude<AssetLevel, "original">, number> = {
  large: 1024,
  small: 256,
};

/**
 * Long side of the PNG an SVG becomes, and the ceiling on its pixel count.
 *
 * The long side is generous because the raster REPLACES the vector: at 2048 the
 * icon still survives a zoom and a PDF export without going soft, and anything
 * smaller would bake the retired resolution into the original. The ceiling is
 * what keeps a pathological viewBox (100000 × 2) from allocating a canvas that
 * the browser refuses to create.
 */
export const SVG_RASTER_LONG_SIDE = 2048;
export const SVG_RASTER_MAX_PIXELS = 4096 * 4096;

export function isAllowedImageMime(mime: string): boolean {
  return mime === SVG_MIME || IMAGE_MIME_ALLOWLIST.includes(mime);
}

export function isSvgMime(mime: string): boolean {
  return mime === SVG_MIME;
}

/** Extension → MIME, for files whose type the platform forgot to set. */
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: SVG_MIME,
};

/** The MIME a file NAME claims, or null when the extension is unknown. */
export function mimeFromName(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT_TO_MIME[ext] ?? null;
}

export type ImageSourceValidation = { ok: true } | { ok: false; reason: string };

/** Reject unsupported formats and oversized files BEFORE any decoding. */
export function validateImageSource(mime: string, bytes: number): ImageSourceValidation {
  if (!isAllowedImageMime(mime)) return { ok: false, reason: `unsupported mime ${mime}` };
  if (bytes > MAX_SOURCE_BYTES) return { ok: false, reason: `too large ${bytes} bytes` };
  return { ok: true };
}

/**
 * Size a level so its long side is `targetLong` px, keeping the aspect
 * ratio. Images already smaller than the target are kept at natural size
 * (upscaling adds bytes, not information).
 */
export function computeLevelDims(w: number, h: number, targetLong: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 1, h: 1 };
  const scale = targetLong / Math.max(w, h);
  if (scale >= 1) return { w, h };
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * The size an SVG declares, in CSS px, read from its root tag.
 *
 * `width`/`height` win when they are absolute: that is the box the author drew
 * for the icon. `viewBox` is the fallback and the only source of PROPORTIONS
 * for an SVG sized at 100%: a percentage says nothing until something is laid
 * out, so it is dropped rather than read as 100. No declaration at all is
 * square, and the canvas below picks the real resolution either way.
 */
export function svgIntrinsicSize(svg: string): { w: number; h: number } {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  // Only absolute lengths: `100%` must fall through to the viewBox, not be
  // read as 100 px and distort the proportions.
  const length = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(?:px)?\\s*["']`, "i").exec(root);
    const v = m ? Number.parseFloat(m[1]) : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const box = /\bviewBox\s*=\s*["']\s*([^"']+)["']/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  const boxW = box && box.length === 4 && box[2] > 0 ? box[2] : null;
  const boxH = box && box.length === 4 && box[3] > 0 ? box[3] : null;

  const w = length("width") ?? boxW;
  const h = length("height") ?? boxH;
  if (w && h) return { w, h };
  if (w) return { w, h: w };
  if (h) return { w: h, h };
  return { w: 1, h: 1 };
}

/**
 * The pixel size an SVG is rasterized at. Unlike computeLevelDims this DOES
 * upscale: a 24px viewBox is a unit, not a resolution, and drawing it at 2048
 * is real information, not interpolation.
 */
export function svgRasterDims(w: number, h: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: SVG_RASTER_LONG_SIDE, h: SVG_RASTER_LONG_SIDE };
  let scale = SVG_RASTER_LONG_SIDE / Math.max(w, h);
  const pixels = w * h * scale * scale;
  if (pixels > SVG_RASTER_MAX_PIXELS) scale *= Math.sqrt(SVG_RASTER_MAX_PIXELS / pixels);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * Draw an SVG onto a canvas and encode it as a PNG.
 *
 * On the main thread on purpose: createImageBitmap in the worker is not
 * dependable for SVG, and a wrong decode there fails far from the cause. The
 * document is loaded as an IMAGE through a blob: URL, and image documents do
 * not run scripts — which is exactly why this compiles, in one place, with the
 * vector never reaching the store.
 */
export async function rasterizeSvg(file: Blob): Promise<Blob> {
  const text = await file.text();
  const intrinsic = svgIntrinsicSize(text);
  const { w, h } = svgRasterDims(intrinsic.w, intrinsic.h);
  const url = URL.createObjectURL(new Blob([text], { type: SVG_MIME }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg could not be decoded"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("svg could not be rasterized");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** What the import pipeline produces: a content-addressed id + the three levels + metadata. */
export interface ImportedImage {
  id: string;
  levels: Record<AssetLevel, AssetBlob>;
  meta: Omit<AssetMeta, "id">;
}

/**
 * Run the import in a Web Worker. Resolves with the three levels ready for
 * AssetStore.put; rejects with a message when the source is unusable.
 */
export async function importImageFile(file: Blob & { name?: string }, mime = file.type): Promise<ImportedImage> {
  // Resolve the type BEFORE choosing the path: a cross-app drag reports an
  // empty type and only the name knows it is an SVG.
  const sourceMime = mime || mimeFromName(file.name ?? "") || "";
  const prepared = isSvgMime(sourceMime) ? await rasterizeSvg(file) : file;
  const preparedMime = isSvgMime(sourceMime) ? "image/png" : sourceMime;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./imageImport.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { ok: boolean; result?: ImportedImage; error?: string };
      worker.terminate();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error ?? "image import failed"));
    };
    worker.onerror = (e: ErrorEvent) => {
      worker.terminate();
      reject(new Error(e.message ?? "image import worker crashed"));
    };
    worker.postMessage({ blob: prepared, mime: preparedMime, name: file.name });
  });
}
