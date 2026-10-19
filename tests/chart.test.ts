/**
 * Chart topics (`Style.gallery.chart`) — a fixed board of slots, empty ones
 * included, that grows by rows and columns. The traps: a column added by
 * appending to the list (every row slides one place), a flag dropped by the
 * first gallery edit that rebuilds the object, and an empty slot ("" id)
 * leaking into the asset references.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { nodeImageIds } from "../src/core/ops";
import {
  CHART_COLS,
  CHART_GAP,
  CHART_ROWS,
  chartGrowHandles,
  chartSlotIndex,
  containRect,
  galleryExtent,
  positionedImageSlots,
} from "../src/layout/measure";
import type { AttachmentInfo } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

/** A store with one fresh chart, born through the real menu entry point. The
 *  image import (worker + decoder) is replaced by a card named after the
 *  file, so the slot logic is what is under test. */
function seeded(): { store: EditorStore; id: string } {
  const store = new EditorStore(memoryAdapter);
  const root = store.sheet.rootNodeId;
  store.createChartTopic(root);
  const kids = store.doc.node(root)!.childrenIds;
  const id = kids[kids.length - 1];
  (store as unknown as { importToCard: (f: File) => Promise<{ ok: true; card: AttachmentInfo }> }).importToCard = async (f) => ({
    ok: true,
    card: { id: `id:${f.name}`, mime: "image/png", w: 300, h: 450, bytes: 1, name: f.name },
  });
  return { store, id };
}

const file = (name: string): File => new File([new Uint8Array([1])], name, { type: "image/png" });
const ids = (store: EditorStore, id: string): string[] => store.doc.node(id)!.style.gallery!.items.map((i) => i.id);

describe("chart creation", () => {
  it("is born as a board of empty slots, flagged as a chart", () => {
    const { store, id } = seeded();
    const g = store.doc.node(id)!.style.gallery!;
    expect(g.chart).toBe(true);
    expect(g.items).toHaveLength(CHART_COLS * CHART_ROWS);
    expect(g.items.every((it) => it.id === "")).toBe(true);
    expect(store.chartShape(id)).toEqual({ cols: CHART_COLS, rows: CHART_ROWS });
  });

  it("never reports an empty slot as an asset reference", () => {
    const { store, id } = seeded();
    expect(nodeImageIds(store.doc.node(id)!)).toEqual([]);
  });
});

describe("chart geometry", () => {
  it("keeps every slot, empty or not, and reserves the title band from the start", () => {
    const { store, id } = seeded();
    const n = store.doc.node(id)!;
    const g = galleryExtent(n)!;
    expect(g.chart).toBe(true);
    expect(g.cols).toBe(CHART_COLS);
    expect(g.rows).toBe(CHART_ROWS);
    expect(g.captionH).toBeGreaterThan(0);
    expect(g.w).toBe(CHART_COLS * g.cellW + (CHART_COLS - 1) * CHART_GAP);
  });

  it("fits a picture whole inside its slot instead of cropping it", () => {
    const { store, id } = seeded();
    const n = store.doc.node(id)!;
    n.style.gallery!.items[0] = { id: "tall" };
    const { cells } = positionedImageSlots({ x: 0, y: 0, w: 1000, h: 1000 }, n, () => ({ w: 100, h: 200 }));
    const c = cells[0];
    expect(c.crop).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 });
    expect(c.pic.h).toBeCloseTo(c.h);
    expect(c.pic.w).toBeCloseTo(c.h / 2);
    expect(c.pic.x).toBeCloseTo(c.x + (c.w - c.pic.w) / 2);
    // An empty slot has no picture to fit.
    expect(cells[1].crop).toBeNull();
  });

  it("containRect centres and scales to touch two edges", () => {
    expect(containRect({ w: 400, h: 200 }, 0, 0, 100, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  it("drops onto the slot under the pointer, not between two", () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 0, w: 10, h: 10 },
      { x: 0, y: 20, w: 10, h: 10 },
      { x: 20, y: 20, w: 10, h: 10 },
    ];
    expect(chartSlotIndex(rects, 28, 3)).toBe(1);
    expect(chartSlotIndex(rects, 2, 27)).toBe(2);
  });

  it("puts the grow pills outside the box, larger in world units when zoomed out", () => {
    const { store, id } = seeded();
    const node = store.doc.node(id)!;
    const box = { x: 0, y: 0, w: 400, h: 300, node };
    const [col, row] = chartGrowHandles(box, 1);
    expect(col.grow).toBe("col");
    expect(col.x).toBeGreaterThan(box.w);
    expect(row.grow).toBe("row");
    expect(row.y).toBeGreaterThan(box.h);
    expect(chartGrowHandles(box, 0.5)[0].w).toBeCloseTo(col.w * 2);
    expect(chartGrowHandles(box, 2)[0].w).toBeCloseTo(col.w);
  });
});

describe("chart resizing", () => {
  it("adds a column to the end of EVERY row, so pictures keep their row and column", () => {
    const { store, id } = seeded();
    const items = store.doc.node(id)!.style.gallery!.items;
    items[2] = { id: "r0c2" };
    items[3] = { id: "r1c0" };
    store.resizeChart(id, 0, 1);
    expect(store.chartShape(id)).toEqual({ cols: 4, rows: 2 });
    expect(ids(store, id)).toEqual(["", "", "r0c2", "", "r1c0", "", "", ""]);
  });

  it("adds a row at the bottom and undoes it in one step", () => {
    const { store, id } = seeded();
    store.resizeChart(id, 1, 0);
    expect(store.chartShape(id)).toEqual({ cols: CHART_COLS, rows: CHART_ROWS + 1 });
    store.undo();
    expect(store.chartShape(id)).toEqual({ cols: CHART_COLS, rows: CHART_ROWS });
  });

  it("removes the right column and keeps the rest in place", () => {
    const { store, id } = seeded();
    const items = store.doc.node(id)!.style.gallery!.items;
    items[1] = { id: "r0c1" };
    items[4] = { id: "r1c1" };
    store.resizeChart(id, 0, -1);
    expect(ids(store, id)).toEqual(["", "r0c1", "", "r1c1"]);
  });

  it("never shrinks below one slot", () => {
    const { store, id } = seeded();
    store.resizeChart(id, -10, -10);
    expect(store.chartShape(id)).toEqual({ cols: 1, rows: 1 });
  });

  it("stays a chart after an edit that rebuilds the gallery object", () => {
    const { store, id } = seeded();
    store.setGalleryLayout(id, { cellW: 80 });
    store.setGalleryCaption(id, 0, "title");
    expect(store.doc.node(id)!.style.gallery!.chart).toBe(true);
  });
});

describe("filling a chart", () => {
  it("fills the first empty slots, titled by file name without the extension", async () => {
    const { store, id } = seeded();
    const res = await store.fillChartSlots(id, [file("blame!.png"), file("domu.jpg")]);
    expect(res.added).toBe(2);
    const items = store.doc.node(id)!.style.gallery!.items;
    expect(items[0]).toEqual({ id: "id:blame!.png", caption: "blame!" });
    expect(items[1]).toEqual({ id: "id:domu.jpg", caption: "domu" });
    expect(items[2].id).toBe("");
  });

  it("pastes into the SELECTED slot and leaves a clipboard picture untitled", async () => {
    const { store, id } = seeded();
    store.selectGalleryCell(id, 4);
    const res = await store.attachImageFile(id, file("pasted-image"));
    expect(res.ok).toBe(true);
    const items = store.doc.node(id)!.style.gallery!.items;
    expect(items[4]).toEqual({ id: "id:pasted-image" });
    expect(items.filter((it) => it.id)).toHaveLength(1);
  });

  it("keeps a title the user already typed for the slot", async () => {
    const { store, id } = seeded();
    store.setGalleryCaption(id, 0, "my title");
    await store.fillChartSlots(id, [file("cover.png")], 0);
    expect(store.doc.node(id)!.style.gallery!.items[0]).toEqual({ id: "id:cover.png", caption: "my title" });
  });

  it("grows by rows when the pictures outnumber the empty slots", async () => {
    const { store, id } = seeded();
    const files = Array.from({ length: CHART_COLS * CHART_ROWS + 1 }, (_, i) => file(`p${i}.png`));
    await store.fillChartSlots(id, files);
    expect(store.chartShape(id)).toEqual({ cols: CHART_COLS, rows: CHART_ROWS + 1 });
  });

  it("undoes a multi-file drop in one step", async () => {
    const { store, id } = seeded();
    await store.fillChartSlots(id, [file("a.png"), file("b.png")]);
    store.undo();
    expect(ids(store, id).every((x) => x === "")).toBe(true);
  });
});

describe("editing chart slots", () => {
  it("swaps two slots when a picture is dragged onto another", () => {
    const { store, id } = seeded();
    const items = store.doc.node(id)!.style.gallery!.items;
    items[0] = { id: "a" };
    items[5] = { id: "b" };
    store.moveGalleryCellTo(id, 0, id, 5);
    expect(ids(store, id)).toEqual(["", "", "", "", "", "a"].map((x, i) => (i === 0 ? "b" : x)));
  });

  it("moves a picture into an empty slot and leaves its old slot empty", () => {
    const { store, id } = seeded();
    store.doc.node(id)!.style.gallery!.items[0] = { id: "a" };
    store.moveGalleryCellTo(id, 0, id, 3);
    expect(ids(store, id)).toEqual(["", "", "", "a", "", ""]);
  });

  it("empties a slot on delete instead of closing the gap", () => {
    const { store, id } = seeded();
    store.doc.node(id)!.style.gallery!.items[1] = { id: "a", caption: "Alpha" };
    store.removeGalleryItem(id, 1);
    expect(store.doc.node(id)!.style.gallery!.items).toHaveLength(CHART_COLS * CHART_ROWS);
    expect(store.doc.node(id)!.style.gallery!.items[1]).toEqual({ id: "", caption: "Alpha" });
    store.removeGalleryItem(id, 1);
    expect(store.doc.node(id)!.style.gallery!.items[1]).toEqual({ id: "" });
  });

  it("swaps across two charts in one undo step", () => {
    const { store, id } = seeded();
    store.createChartTopic(store.sheet.rootNodeId);
    const kids = store.doc.node(store.sheet.rootNodeId)!.childrenIds;
    const other = kids[kids.length - 1];
    store.doc.node(id)!.style.gallery!.items[0] = { id: "a" };
    store.doc.node(other)!.style.gallery!.items[2] = { id: "b" };
    store.moveGalleryCellTo(id, 0, other, 2);
    expect(ids(store, id)[0]).toBe("b");
    expect(ids(store, other)[2]).toBe("a");
    store.undo();
    expect(ids(store, id)[0]).toBe("a");
    expect(ids(store, other)[2]).toBe("b");
  });
});
