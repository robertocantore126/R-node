import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeLevelDims,
  IMAGE_MIME_ALLOWLIST,
  importImageFile,
  isAllowedImageMime,
  isSvgMime,
  MAX_SOURCE_BYTES,
  mimeFromName,
  rasterizeSvg,
  SVG_MIME,
  SVG_RASTER_LONG_SIDE,
  SVG_RASTER_MAX_PIXELS,
  svgIntrinsicSize,
  svgRasterDims,
  validateImageSource,
} from "../src/editor/imageImport";

describe("image source validation (T13-1)", () => {
  it("accepts the allowed raster formats", () => {
    for (const mime of IMAGE_MIME_ALLOWLIST) {
      expect(isAllowedImageMime(mime)).toBe(true);
      expect(validateImageSource(mime, 100)).toEqual({ ok: true });
    }
  });

  it("accepts SVG as a source while keeping the store raster-only", () => {
    expect(isSvgMime(SVG_MIME)).toBe(true);
    expect(validateImageSource(SVG_MIME, 100)).toEqual({ ok: true });
    // The vector is rasterized on import: it must never reach the store as one.
    expect(IMAGE_MIME_ALLOWLIST).not.toContain(SVG_MIME);
    expect(isAllowedImageMime("text/html")).toBe(false);
  });

  it("rejects files over MAX_SOURCE_BYTES with a message", () => {
    expect(validateImageSource("image/png", MAX_SOURCE_BYTES + 1)).toEqual({
      ok: false,
      reason: `too large ${MAX_SOURCE_BYTES + 1} bytes`,
    });
    expect(validateImageSource("image/png", MAX_SOURCE_BYTES)).toEqual({ ok: true });
  });
});

describe("mimeFromName (T13-1)", () => {
  it("sniffs a MIME from a known image extension, case-insensitively", () => {
    expect(mimeFromName("photo.png")).toBe("image/png");
    expect(mimeFromName("PHOTO.JPG")).toBe("image/jpeg");
    expect(mimeFromName("pic.jpeg")).toBe("image/jpeg");
    expect(mimeFromName("anim.gif")).toBe("image/gif");
    expect(mimeFromName("sticker.webp")).toBe("image/webp");
    expect(mimeFromName("PHOTO.AVIF")).toBe("image/avif");
    expect(mimeFromName("icon.svg")).toBe(SVG_MIME);
    expect(validateImageSource("image/avif", 100)).toEqual({ ok: true });
  });

  it("returns null for an unknown extension or no extension", () => {
    expect(mimeFromName("archive.zip")).toBeNull();
    expect(mimeFromName("noext")).toBeNull();
  });
});

describe("computeLevelDims (T13-1)", () => {
  it("scales the long side to the target keeping proportions", () => {
    expect(computeLevelDims(4000, 3000, 1024)).toEqual({ w: 1024, h: 768 });
    expect(computeLevelDims(4000, 3000, 256)).toEqual({ w: 256, h: 192 });
  });

  it("keeps the natural size when the image is already below the target", () => {
    expect(computeLevelDims(200, 100, 1024)).toEqual({ w: 200, h: 100 });
    expect(computeLevelDims(1024, 683, 1024)).toEqual({ w: 1024, h: 683 });
  });

  it("handles portrait images (the height is the long side)", () => {
    expect(computeLevelDims(3000, 4000, 1024)).toEqual({ w: 768, h: 1024 });
    expect(computeLevelDims(3000, 4000, 256)).toEqual({ w: 192, h: 256 });
  });

  it("never returns zero-size levels", () => {
    expect(computeLevelDims(0, 0, 1024)).toEqual({ w: 1, h: 1 });
    expect(computeLevelDims(1, 1, 256)).toEqual({ w: 1, h: 1 });
  });
});

describe("svgIntrinsicSize (T13-1)", () => {
  it("reads absolute width/height", () => {
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"></svg>')).toEqual({
      w: 64,
      h: 32,
    });
  });

  it("falls back to the viewBox when the size is a percentage or absent", () => {
    expect(svgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 24 12"></svg>')).toEqual({ w: 24, h: 12 });
    expect(svgIntrinsicSize('<svg viewBox="0 0 512 512"></svg>')).toEqual({ w: 512, h: 512 });
  });

  it("accepts px, decimals and comma-separated viewBox values", () => {
    expect(svgIntrinsicSize('<svg width="40px" height="20.5px"></svg>')).toEqual({ w: 40, h: 20.5 });
    expect(svgIntrinsicSize('<svg viewBox="0,0,300,150"></svg>')).toEqual({ w: 300, h: 150 });
  });

  it("is square when the file declares nothing usable", () => {
    expect(svgIntrinsicSize("<svg></svg>")).toEqual({ w: 1, h: 1 });
    expect(svgIntrinsicSize('<svg viewBox="0 0 0 0"></svg>')).toEqual({ w: 1, h: 1 });
  });
});

describe("svgRasterDims (T13-1)", () => {
  it("upscales a small viewBox to the raster long side, keeping proportions", () => {
    expect(svgRasterDims(24, 24)).toEqual({ w: SVG_RASTER_LONG_SIDE, h: SVG_RASTER_LONG_SIDE });
    expect(svgRasterDims(64, 32)).toEqual({ w: SVG_RASTER_LONG_SIDE, h: SVG_RASTER_LONG_SIDE / 2 });
    expect(svgRasterDims(300, 600)).toEqual({ w: 1024, h: SVG_RASTER_LONG_SIDE });
  });

  it("never allocates more than SVG_RASTER_MAX_PIXELS or a zero side", () => {
    const wide = svgRasterDims(100000, 10000);
    expect(wide.w * wide.h).toBeLessThanOrEqual(SVG_RASTER_MAX_PIXELS);
    expect(wide.h).toBeGreaterThanOrEqual(1);
  });
});

describe("SVG rasterization on import (T13-1)", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32"/></svg>';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stand-in for the browser pieces rasterizeSvg needs, recording what was drawn. */
  function stubDom() {
    const drawn: { w: number; h: number }[] = [];
    let canvas: { width: number; height: number; getContext: unknown; toBlob: unknown };
    canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_img: unknown, _x: number, _y: number, w: number, h: number) => {
          drawn.push({ w, h });
        },
        imageSmoothingQuality: "low",
      }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["png-bytes"], { type: "image/png" })),
    };
    vi.stubGlobal("document", { createElement: () => canvas });
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_url: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = () => "blob:svg";
        static revokeObjectURL = () => {};
      },
    );
    return { drawn, canvas };
  }

  it("draws the SVG at the raster size and returns PNG bytes", async () => {
    const { drawn, canvas } = stubDom();
    const file = Object.assign(new Blob([svg], { type: SVG_MIME }), { name: "icon.svg" });
    const png = await rasterizeSvg(file);
    expect(drawn).toEqual([{ w: SVG_RASTER_LONG_SIDE, h: SVG_RASTER_LONG_SIDE / 2 }]);
    expect({ w: canvas.width, h: canvas.height }).toEqual({ w: SVG_RASTER_LONG_SIDE, h: SVG_RASTER_LONG_SIDE / 2 });
    expect(png.type).toBe("image/png");
    expect(await png.text()).toBe("png-bytes");
  });

  it("hands the worker a PNG, never the vector", async () => {
    stubDom();
    const posted: { blob: Blob; mime: string; name?: string }[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        postMessage(msg: { blob: Blob; mime: string; name?: string }) {
          posted.push(msg);
          queueMicrotask(() =>
            this.onmessage?.({
              data: {
                ok: true,
                result: { id: "id", levels: {}, meta: { mime: msg.mime, w: 1, h: 1, bytes: 1, name: msg.name } },
              },
            } as MessageEvent),
          );
        }
        terminate() {}
      },
    );
    const file = Object.assign(new Blob([svg], { type: SVG_MIME }), { name: "icon.svg" });
    const imported = await importImageFile(file, SVG_MIME);
    expect(posted).toHaveLength(1);
    expect(posted[0].mime).toBe("image/png");
    expect(posted[0].blob.type).toBe("image/png");
    expect(await posted[0].blob.text()).toBe("png-bytes");
    expect(imported.meta.mime).toBe("image/png");
  });

  it("rasterizes a dragged .svg whose type the platform forgot", async () => {
    stubDom();
    const posted: { blob: Blob; mime: string }[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        postMessage(msg: { blob: Blob; mime: string; name?: string }) {
          posted.push(msg);
          queueMicrotask(() =>
            this.onmessage?.({
              data: { ok: true, result: { id: "id", levels: {}, meta: { mime: msg.mime, w: 1, h: 1, bytes: 1 } } },
            } as MessageEvent),
          );
        }
        terminate() {}
      },
    );
    // This is the shape a browser → app drag arrives in: no type, name says .svg.
    const file = Object.assign(new Blob([svg]), { name: "aws-ec2.svg" });
    expect(file.type).toBe("");
    await importImageFile(file);
    expect(posted[0].mime).toBe("image/png");
    expect(await posted[0].blob.text()).toBe("png-bytes");
  });
});
