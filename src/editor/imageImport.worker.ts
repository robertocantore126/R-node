/**
 * Image import worker (T13-1).
 *
 * Runs off the main thread: reads the original bytes, computes the content
 * address (SHA-256), decodes the image and draws the 1024px and 256px levels
 * onto OffscreenCanvases. The main thread receives { id, levels, meta } and
 * hands it to AssetStore.put — nothing image-sized ever blocks the UI.
 *
 * The worker keeps the original blob INTACT: it is the source of truth for
 * the T14 slider and high-quality export, never recompressed.
 */

type WorkerScope = {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
};

const scope = self as unknown as WorkerScope;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Display levels are WebP at quality 0.9 (keeps alpha, 3-10x smaller than PNG). */
const LEVEL_MIME = "image/webp";
const LEVEL_QUALITY = 0.9;

/**
 * Probe natural dimensions from image file headers without decoding pixels.
 * Supports PNG, GIF, JPEG, and WebP; returns null for other formats (e.g. AVIF).
 */
function probeDimensions(buf: ArrayBuffer): { w: number; h: number } | null {
  const b = new Uint8Array(buf);
  const v = new DataView(buf);
  // PNG: 8-byte signature + IHDR chunk (width @ 16, height @ 20)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const w = v.getUint32(16, false);
    const h = v.getUint32(20, false);
    if (w > 0 && h > 0) return { w, h };
  }
  // GIF: "GIF87a" or "GIF89a", little-endian uint16 width @ 6, height @ 8
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const w = v.getUint16(6, true);
    const h = v.getUint16(8, true);
    if (w > 0 && h > 0) return { w, h };
  }
  // WebP: "RIFF" + 4-byte size + "WEBP"
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8X") {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { w, h };
    }
    if (tag === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      const w = v.getUint16(26, true) & 0x3fff;
      const h = v.getUint16(28, true) & 0x3fff;
      if (w > 0 && h > 0) return { w, h };
    }
    if (tag === "VP8L" && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
      return { w, h };
    }
  }
  // JPEG: SOI (0xFF 0xD8), scan SOF markers (0xC0..0xCF except C4, C8, CC)
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i] !== 0xff) break;
      while (i < b.length && b[i] === 0xff) i++;
      if (i >= b.length) break;
      const marker = b[i++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 1 >= b.length) break;
      const len = v.getUint16(i, false);
      if (len < 2 || i + len > b.length) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof && i + 6 < b.length) {
        const h = v.getUint16(i + 3, false);
        const w = v.getUint16(i + 5, false);
        if (w > 0 && h > 0) return { w, h };
      }
      i += len;
    }
  }
  return null;
}

scope.onmessage = (e: MessageEvent) => {
  void (async () => {
    const { blob, mime, name } = e.data as {
      blob: Blob;
      mime: string;
      name?: string;
    };
    try {
      // Content address: SHA-256 of the ORIGINAL bytes — the same image
      // attached to N nodes occupies space exactly once.
      const originalBytes = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", originalBytes);
      const id = hex(digest);

      let dims = probeDimensions(originalBytes);
      if (dims && dims.w !== dims.h) {
        // The header gives the STORED size, but createImageBitmap applies the
        // EXIF orientation (its default): a portrait phone photo stored
        // landscape would get swapped sides — a squashed picture and a box of
        // the wrong shape. A tiny decode reports the drawn orientation.
        const probe = await createImageBitmap(blob, { resizeWidth: Math.min(64, dims.w), resizeQuality: "low" });
        try {
          if ((probe.width >= probe.height) !== (dims.w >= dims.h)) dims = { w: dims.h, h: dims.w };
        } finally {
          probe.close();
        }
      }
      if (!dims) {
        const full = await createImageBitmap(blob);
        try {
          dims = { w: full.width, h: full.height };
        } finally {
          full.close();
        }
      }
      const srcW = dims.w;
      const srcH = dims.h;

      const levels = {
        original: { blob, w: srcW, h: srcH },
      } as Record<
        "original" | "large" | "small",
        { blob: Blob; w: number; h: number }
      >;

      for (const [key, targetLong] of [
        ["large", 1024],
        ["small", 256],
      ] as const) {
        const scale = targetLong / Math.max(srcW, srcH);
        if (scale >= 1) {
          // Already smaller than the target: the original IS the level.
          levels[key] = { blob, w: srcW, h: srcH };
          continue;
        }
        const w = Math.max(1, Math.round(srcW * scale));
        const h = Math.max(1, Math.round(srcH * scale));
        // Decode straight to the target size so large originals never allocate
        // a full surface. Both sides are given: the oriented size is known.
        const resized = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
        try {
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("offscreen 2d context unavailable");
          ctx.drawImage(resized, 0, 0, w, h);
          levels[key] = {
            blob: await canvas.convertToBlob({ type: LEVEL_MIME, quality: LEVEL_QUALITY }),
            w,
            h,
          };
        } finally {
          resized.close();
        }
      }

      scope.postMessage({
        ok: true,
        result: {
          id,
          levels,
          meta: {
            mime,
            w: srcW,
            h: srcH,
            bytes: originalBytes.byteLength,
            name,
          },
        },
      });
    } catch (err) {
      scope.postMessage({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
