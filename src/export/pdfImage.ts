/**
 * Asset bytes -> the two encodings a PDF image XObject can carry.
 *
 * The browser-side half of the PDF export. `src/export/pdf.ts` is format-only
 * and runs in node tests, so it never decodes anything: it takes JPEG bytes or
 * raw RGB and writes the object. Deciding WHICH, and producing the pixels, is
 * a job for something that has a canvas, which is what this file is.
 *
 * The rule it applies, and why:
 *
 *   - JPEG passes through untouched. Re-encoding it would lose a generation
 *     for nothing; DCTDecode takes the file's own bytes.
 *   - Anything opaque is re-encoded as JPEG. A 1024px picture is 3MB of raw
 *     RGB and deflate barely dents a photograph, so the lossless path would
 *     turn a ten-image map into a PDF of tens of megabytes. 0.92 keeps
 *     screenshots and diagrams clean.
 *   - Anything with transparency goes in lossless, as RGB plus an alpha plane.
 *     JPEG has no alpha, and compositing the colour of a cut-out through a
 *     mask it no longer matches is what produces halos around a logo. Those
 *     images are graphics rather than photographs, so deflate does well on
 *     them anyway.
 *
 * Everything the browser can decode is therefore embeddable, which is the
 * point: the version this replaces took JPEG only, and a pasted screenshot —
 * the most common image in a map by a distance — is a PNG.
 */
import type { PdfImageSource } from "./pdf";
import type { AssetLevel, AssetStore } from "../persist/assets";

/**
 * Display levels, best first.
 *
 * `large` (1024px long side), not `small` (256px). The screen redraws a topic
 * at 100-200px and `small` is right for it; a sheet of A1 prints the same
 * topic 4 inches across, where 256px is 64dpi and visibly mushy. `original`
 * is the fallback rather than the first choice because it can be a 12MP photo
 * that no page will ever show at that resolution.
 */
const LEVEL_ORDER: AssetLevel[] = ["large", "original", "small"];

/** JPEG quality for a re-encode. High enough that text in a screenshot does
 *  not ring; low enough that a photo is a few hundred KB, not a few MB. */
const JPEG_QUALITY = 0.92;

/** Decode one asset into the form `sheetToPdf` embeds, or null if unreadable. */
export async function pdfImageSource(store: AssetStore, assetId: string): Promise<PdfImageSource | null> {
  const meta = await store.meta(assetId);
  if (!meta) return null;
  let blob: Blob | null = null;
  for (const level of LEVEL_ORDER) {
    blob = await store.get(assetId, level);
    if (blob) break;
  }
  if (!blob) return null;
  return decodeForPdf(blob, meta.mime);
}

/** The decode itself, separated so it can be driven from a blob directly. */
export async function decodeForPdf(blob: Blob, mime: string): Promise<PdfImageSource | null> {
  // A JPEG still needs decoding, but only to learn its pixel size: the bytes
  // that go into the file are the file's own.
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width;
  const h = bitmap.height;
  try {
    if (mime === "image/jpeg") {
      return { w, h, jpeg: new Uint8Array(await blob.arrayBuffer()) };
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);

    // getImageData is UN-premultiplied by spec, so these RGB values are the
    // ones an /SMask composites — no dividing by alpha, and no dark fringe
    // from forgetting to.
    const rgb = new Uint8Array(w * h * 3);
    const alpha = new Uint8Array(w * h);
    let opaque = true;
    for (let px = 0; px < w * h; px++) {
      const i = px * 4;
      const j = px * 3;
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
      alpha[px] = data[i + 3];
      if (data[i + 3] !== 255) opaque = false;
    }
    if (!opaque) return { w, h, rgb, alpha };

    const jpegBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    // A canvas that will not encode is not a reason to lose the picture: the
    // raw pixels are already in hand and deflate takes them.
    if (!jpegBlob) return { w, h, rgb };
    return { w, h, jpeg: new Uint8Array(await jpegBlob.arrayBuffer()) };
  } finally {
    bitmap.close();
  }
}
