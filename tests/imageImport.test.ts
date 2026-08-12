import { describe, expect, it } from "vitest";
import {
  computeLevelDims,
  IMAGE_MIME_ALLOWLIST,
  isAllowedImageMime,
  MAX_SOURCE_BYTES,
  validateImageSource,
} from "../src/editor/imageImport";

describe("image source validation (T13-1)", () => {
  it("accepts the allowed raster formats", () => {
    for (const mime of IMAGE_MIME_ALLOWLIST) {
      expect(isAllowedImageMime(mime)).toBe(true);
      expect(validateImageSource(mime, 100)).toEqual({ ok: true });
    }
  });

  it("rejects SVG — an executable document, not a raster", () => {
    expect(isAllowedImageMime("image/svg+xml")).toBe(false);
    expect(validateImageSource("image/svg+xml", 100)).toEqual({
      ok: false,
      reason: "unsupported mime image/svg+xml",
    });
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
