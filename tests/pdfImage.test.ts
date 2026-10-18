import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeForPdf, pdfImageSource } from "../src/export/pdfImage";
import type { AssetStore } from "../src/persist/assets";

afterEach(() => vi.unstubAllGlobals());

describe("lossless PDF image export", () => {
  it("uses original JPEG bytes and falls back to large only if the original is absent", async () => {
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1000, height: 500, close }));
    const get = vi.fn(async (_id, level) => level === "large" ? new Blob([bytes]) : null);
    const store = { get, meta: async () => ({ mime: "image/jpeg" }) } as unknown as AssetStore;
    const image = await pdfImageSource(store, "picture", { original: true, lossless: true });
    expect(get.mock.calls.map(call => call[1])).toEqual(["original", "large"]);
    expect(image?.jpeg).toEqual(bytes);
    expect(close).toHaveBeenCalledOnce();
  });

  it("never calls the JPEG encoder for an opaque PNG in lossless mode", async () => {
    const toBlob = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", async () => ({ width: 2, height: 1, close }));
    vi.stubGlobal("document", { createElement: () => ({ toBlob, getContext: () => ({
      drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([10,20,30,255,40,50,60,255]) }),
    }) }) });
    const image = await decodeForPdf(new Blob(), "image/png", true);
    expect(image?.rgb).toEqual(new Uint8Array([10,20,30,40,50,60]));
    expect(image?.jpeg).toBeUndefined();
    expect(toBlob).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
