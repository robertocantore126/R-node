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
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Level blobs are PNG when the source can carry alpha, JPEG otherwise. */
function levelMime(sourceMime: string): string {
  return sourceMime === "image/png" || sourceMime === "image/webp" || sourceMime === "image/gif"
    ? "image/png"
    : "image/jpeg";
}

scope.onmessage = (e: MessageEvent) => {
  void (async () => {
    const { blob, mime, name } = e.data as { blob: Blob; mime: string; name?: string };
    try {
      // Content address: SHA-256 of the ORIGINAL bytes — the same image
      // attached to N nodes occupies space exactly once.
      const originalBytes = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", originalBytes);
      const id = hex(digest);

      const source = await createImageBitmap(blob);
      const srcW = source.width;
      const srcH = source.height;
      const levels = {
        original: { blob, w: srcW, h: srcH },
      } as Record<"original" | "large" | "small", { blob: Blob; w: number; h: number }>;

      const outMime = levelMime(mime);
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
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("offscreen 2d context unavailable");
        ctx.drawImage(source, 0, 0, w, h);
        levels[key] = { blob: await canvas.convertToBlob({ type: outMime, quality: 0.85 }), w, h };
      }
      source.close();

      scope.postMessage({
        ok: true,
        result: {
          id,
          levels,
          meta: { mime, w: srcW, h: srcH, bytes: originalBytes.byteLength, name },
        },
      });
    } catch (err) {
      scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
