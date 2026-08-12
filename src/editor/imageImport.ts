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
 */
import type { AssetBlob, AssetLevel, AssetMeta } from "../persist/assets";

/** Raster formats only. SVG is an executable document: excluded (XSS hardening is deferred). */
export const IMAGE_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** Long side of each derived level, in pixels. */
export const LEVEL_LONG_SIDE: Record<Exclude<AssetLevel, "original">, number> = {
  large: 1024,
  small: 256,
};

export function isAllowedImageMime(mime: string): boolean {
  return IMAGE_MIME_ALLOWLIST.includes(mime);
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
export function importImageFile(file: Blob & { name?: string }): Promise<ImportedImage> {
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
    worker.postMessage({ blob: file, mime: file.type, name: file.name });
  });
}
