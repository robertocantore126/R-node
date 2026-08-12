/**
 * Portable document with images — `.rnode.zip` (ROADMAP T15).
 *
 * The container follows the same shape as `.xmind` / `.docx`:
 *
 *   document.json     the document, byte-identical to today's .rnode.json
 *   manifest.json     { mode: "complete" | "compact" } — how the assets are stored
 *   assets/<id>.<ext> one file per referenced asset (id = SHA-256 hex)
 *
 * Two export modes, because the weight differs by an order of magnitude:
 *   - complete: the ORIGINAL bytes (faithful, can be hundreds of MB);
 *   - compact:  only the `large` (1024px) display level (tens of MB, visually
 *               identical on screen).
 *
 * The estimate is computed BEFORE generating (the UI shows it first), and is
 * within ~10% of the produced file because raster assets are incompressible.
 *
 * Import reconstructs the full three-level set from what the container
 * carries (via an injectable level generator — canvas in the browser, a stub
 * in node tests) and stores it under the id the document already references
 * (putUnderId: a compact export has no original, so the content address
 * cannot be re-derived). Ids are content hashes, so reimporting the same file
 * never duplicates anything.
 */
import type { RnodeDocument, Sheet } from "../core/types";
import {
  referencedAssetIds,
  type AssetBlob,
  type AssetLevel,
  type AssetMeta,
  type AssetStore,
} from "../persist/assets";
import { zip, unzip, deflateSync, strToU8, strFromU8 } from "fflate";

export type RnodeZipMode = "complete" | "compact";

// ---------------------------------------------------------------------------
// PNG export hook (pre-existing feature). CanvasView registers the renderer's
// exportPng as the handler on mount; Palette and TopBar trigger it. Kept here
// because this file is the app's export bridge — image and document alike.
// ---------------------------------------------------------------------------

let pngHandler: (() => void) | null = null;

export function setExportPngHandler(fn: (() => void) | null): void {
  pngHandler = fn;
}

export function runExportPng(): void {
  pngHandler?.();
}

/** Per-entry zip overhead (local header + central-directory entry + slack). */
const ZIP_ENTRY_OVERHEAD = 96;
/** Zip structure beyond the entries (end-of-central-directory, slack). */
const ZIP_BASE_OVERHEAD = 256;

/** Long side of the display levels the renderer ever requests. */
const LEVEL_LONG_SIDE: Record<Exclude<AssetLevel, "original">, number> = {
  large: 1024,
  small: 256,
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "bin";
}

function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, {}, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, files) => (err ? reject(err) : resolve(files)));
  });
}

/** The level an export mode stores per asset. */
function levelForMode(mode: RnodeZipMode): AssetLevel {
  return mode === "complete" ? "original" : "large";
}

/**
 * Estimated .rnode.zip size, BEFORE generating. The document is actually
 * deflated (it compresses well and would otherwise skew the total); the
 * asset levels are added raw because raster formats are incompressible and
 * deflate leaves them within a fraction of a percent. Entry overhead is
 * accounted per asset so the estimate holds for many small images too.
 */
export async function estimateRnodeZip(
  doc: RnodeDocument,
  sheet: Sheet,
  store: AssetStore,
  mode: RnodeZipMode
): Promise<number> {
  const docJson = deflateSync(strToU8(JSON.stringify(doc))).length;
  const manifest = deflateSync(strToU8(JSON.stringify({ mode }))).length;
  const ids = [...referencedAssetIds(sheet)];
  let assets = 0;
  const level = levelForMode(mode);
  for (const id of ids) {
    const blob = await store.get(id, level);
    if (blob) assets += blob.size;
  }
  return docJson + manifest + assets + ids.length * ZIP_ENTRY_OVERHEAD + ZIP_BASE_OVERHEAD;
}

/** Build the .rnode.zip bytes. Only assets the nodes reference are included. */
export async function buildRnodeZip(
  doc: RnodeDocument,
  sheet: Sheet,
  store: AssetStore,
  mode: RnodeZipMode
): Promise<Uint8Array> {
  const ids = [...referencedAssetIds(sheet)];
  // A referenced asset whose original is gone (compact import, I11): a
  // "complete" export of it is degraded — the zip carries the resized level.
  // The manifest says so, and the store warns the user before generating.
  const degraded = ids.some((id) => sheet.attachments.some((a) => a.id === id && a.originalLost));
  const files: Record<string, Uint8Array> = {
    "document.json": strToU8(JSON.stringify(doc)),
    "manifest.json": strToU8(
      JSON.stringify(degraded ? { mode, degraded: true } : { mode })
    ),
  };
  const level = levelForMode(mode);
  for (const id of ids) {
    const [meta, blob] = await Promise.all([store.meta(id), store.get(id, level)]);
    if (!meta || !blob) continue; // referenced but absent: the zip cannot carry it
    files[`assets/${id}.${extForMime(meta.mime)}`] = new Uint8Array(await blob.arrayBuffer());
  }
  return zipAsync(files);
}

/**
 * Reconstruct the full three-level set from a single available level.
 * Browser implementation (canvas): `original` is the source as-is, `large`
 * and `small` are downscaled copies. For a complete export the source IS the
 * original; for a compact export the source is the 1024px level, which then
 * doubles as `original` — visually identical, byte-wise best effort.
 */
export async function generateLevelsFromSource(
  blob: Blob,
  mime: string
): Promise<Record<AssetLevel, AssetBlob>> {
  const source = await createImageBitmap(blob);
  const srcW = source.width;
  const srcH = source.height;
  const levels = {
    original: { blob, w: srcW, h: srcH },
  } as Record<AssetLevel, AssetBlob>;
  const outMime =
    mime === "image/png" || mime === "image/webp" || mime === "image/gif" ? "image/png" : "image/jpeg";
  for (const [key, targetLong] of [
    ["large", LEVEL_LONG_SIDE.large],
    ["small", LEVEL_LONG_SIDE.small],
  ] as const) {
    const scale = targetLong / Math.max(srcW, srcH);
    if (scale >= 1) {
      // Already smaller than the target: the source IS the level.
      levels[key] = { blob, w: srcW, h: srcH };
      continue;
    }
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("offscreen 2d context unavailable");
    ctx.drawImage(source, 0, 0, w, h);
    levels[key] = { blob: await canvas.convertToBlob({ type: outMime, quality: 0.85 }), w, h };
  }
  source.close();
  return levels;
}

/** Test seam: node has no canvas, so the browser generator is injected. */
export type LevelGenerator = (
  blob: Blob,
  mime: string
) => Promise<Record<AssetLevel, AssetBlob>>;

/**
 * Open a .rnode.zip: extract every referenced asset into the store and return
 * the document. Returns null when the container is not a valid R-node zip.
 * Reimporting the same file twice stores each id once (content addressing +
 * first-write-wins putUnderId).
 */
export async function importRnodeZip(
  data: Uint8Array,
  store: AssetStore,
  generate: LevelGenerator = generateLevelsFromSource
): Promise<RnodeDocument | null> {
  let files: Record<string, Uint8Array>;
  try {
    files = await unzipAsync(data);
  } catch {
    return null;
  }
  const docRaw = files["document.json"];
  if (!docRaw) return null;

  // A compact container carries display levels only: the assets it restores
  // have NO original, and the document must say so — otherwise a later
  // "complete" export would claim to ship originals it does not have (I11).
  let mode: RnodeZipMode = "complete";
  const manifestRaw = files["manifest.json"];
  if (manifestRaw) {
    try {
      const parsed = JSON.parse(strFromU8(manifestRaw)) as { mode?: RnodeZipMode };
      if (parsed.mode === "compact") mode = "compact";
    } catch {
      // no readable manifest: assume the only level present is the original
    }
  }

  let doc: RnodeDocument;
  try {
    doc = JSON.parse(strFromU8(docRaw)) as RnodeDocument;
  } catch {
    return null;
  }
  const sheet = doc.sheets[0];
  if (!sheet) return null;

  const referenced = referencedAssetIds(sheet);
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.startsWith("assets/")) continue;
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const id = name.slice("assets/".length, dot);
    if (!referenced.has(id)) continue; // skip junk that no node points to
    const mime = mimeForExt(name.slice(dot + 1));
    // slice() copies into a fresh ArrayBuffer: a view over the zip's buffer
    // would keep the whole archive alive as long as the blob does.
    const blob = new Blob([bytes.slice().buffer], { type: mime });
    const levels = await generate(blob, mime);
    const card = sheet.attachments.find((a) => a.id === id);
    if (mode === "compact" && card) card.originalLost = true;
    const meta: AssetMeta = card ?? {
      id,
      mime,
      w: levels.original.w,
      h: levels.original.h,
      bytes: blob.size,
    };
    await store.putUnderId(id, levels, meta);
  }
  return doc;
}
