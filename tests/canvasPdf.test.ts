import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { canvasMapToPdf, planCanvasPdf, type PrintTile } from "../src/export/canvasPdf";

const bounds = { minX: -100, minY: -50, maxX: 900, maxY: 1950 };
const options = { page: { w: 200, h: 160 }, margin: 10, dpi: 72, tileSize: 64 };

describe("editor canvas PDF", () => {
  it("keeps the full width and world coordinates continuous across tiles and pages", async () => {
    const plan = planCanvasPdf(bounds, options);
    const tiles: PrintTile[] = [];
    const progress: number[] = [];
    const out = await canvasMapToPdf(bounds, async tile => {
      tiles.push(tile);
      return new Uint8Array(tile.w * tile.h * 3).fill(240);
    }, { ...options, onProgress: done => progress.push(done) });
    expect(out.pages).toBe(3);
    expect(out.tiles).toBe(27);
    expect(progress).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    expect(tiles[0].world.x).toBe(bounds.minX);
    expect(tiles[1].world.x).toBeCloseTo(tiles[0].world.x + tiles[0].world.w);
    expect(tiles[3].world.y).toBeCloseTo(tiles[0].world.y + tiles[0].world.h);
    expect(tiles[9].world.y).toBeCloseTo(bounds.minY + plan.bandH);
    expect(tiles[2].world.x + tiles[2].world.w).toBeCloseTo(bounds.maxX);

    // Check actual byte offsets and decoded image payload, not just PDF tokens.
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    const text = Array.from(bytes, b => String.fromCharCode(b)).join("");
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const rows = text.slice(xref).split("\n");
    const count = Number(rows[1].split(" ")[1]);
    for (let id = 1; id < count; id++) {
      const offset = Number(rows[id + 2].slice(0, 10));
      expect(text.slice(offset).startsWith(`${id} 0 obj\n`)).toBe(true);
    }
    const image = /\/Subtype \/Image[^]*?\/Length (\d+) >>\nstream\n/.exec(text)!;
    const start = image.index + image[0].length;
    const rgb = unzlibSync(bytes.slice(start, start + Number(image[1])));
    expect(rgb.length).toBe(64 * 64 * 3);
    expect(rgb.every(b => b === 240)).toBe(true);
  });

  it("rejects invalid geometry and incomplete or failed image rendering", async () => {
    expect(() => planCanvasPdf({ ...bounds, maxX: -100 })).toThrow();
    expect(() => planCanvasPdf(bounds, { dpi: 0 })).toThrow();
    expect(() => planCanvasPdf(bounds, { tileSize: 1 })).toThrow();
    await expect(canvasMapToPdf(bounds, async () => new Uint8Array(3), options)).rejects.toThrow("incomplete");
    await expect(canvasMapToPdf(bounds, async () => { throw new Error("Missing image"); }, options)).rejects.toThrow("Missing image");
  });
});
