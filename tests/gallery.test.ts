/**
 * Gallery topics (T25) — the grid, the captions, and the two things that go
 * silently wrong when a new kind of image reference is added to the schema:
 * the asset garbage collector stops seeing it, and undo stops covering it.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { nodeImageIds } from "../src/core/ops";
import { referencedAssetIds } from "../src/persist/assets";
import {
  GALLERY_CAPTION_GAP,
  GALLERY_CAPTION_SIZE,
  GALLERY_CELL_W,
  GALLERY_GAP,
  LINE_HEIGHT_FACTOR,
  coverCrop,
  ellipsizeToWidth,
  galleryExtent,
  galleryInsertIndex,
  measureTopic,
  positionedImageSlots,
} from "../src/layout/measure";
import type { GalleryItem, MindNode, Sheet } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

function firstChild(store: EditorStore): string {
  const root = store.doc.node(store.sheet.rootNodeId)!;
  return root.childrenIds[root.childrenIds.length - 1];
}

/** A bare node carrying nothing but the gallery under test. */
function galleryNode(items: GalleryItem[], extra: { cellW?: number; cols?: number; aspect?: number; width?: number } = {}): MindNode {
  return {
    id: "n",
    type: "subtopic",
    parentId: null,
    childrenIds: [],
    title: "",
    position: { x: 0, y: 0, manual: false },
    style: { gallery: { items, cellW: extra.cellW, cols: extra.cols, aspect: extra.aspect }, width: extra.width },
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "", updatedAt: "" },
  };
}

/** Every picture 200x100 unless told otherwise — deliberately NOT square, so a
 *  crop that quietly does nothing cannot pass. */
const resolve = (sizes: Record<string, { w: number; h: number }> = {}) =>
  (id: string): { w: number; h: number } | null => sizes[id] ?? { w: 200, h: 100 };

const cells = (n: number): GalleryItem[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));

describe("gallery geometry", () => {
  it("is nothing at all when the node has no gallery, or an empty one", () => {
    expect(galleryExtent(galleryNode([]), resolve())).toBeNull();
    const plain = galleryNode([]);
    delete plain.style.gallery;
    expect(galleryExtent(plain, resolve())).toBeNull();
  });

  it("lays six default cells in one row and sizes the grid from them", () => {
    const g = galleryExtent(galleryNode(cells(6)), resolve())!;
    expect(g.cols).toBe(6);
    expect(g.rows).toBe(1);
    expect(g.w).toBe(6 * GALLERY_CELL_W + 5 * GALLERY_GAP);
    expect(g.h).toBe(GALLERY_CELL_W);
    expect(g.captionH).toBe(0);
  });

  it("wraps to the column count when one is set", () => {
    const g = galleryExtent(galleryNode(cells(7), { cols: 3 }), resolve())!;
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(3); // 3 + 3 + 1
    expect(g.h).toBe(3 * GALLERY_CELL_W + 2 * GALLERY_GAP);
  });

  it("never opens more columns than it has pictures", () => {
    expect(galleryExtent(galleryNode(cells(2), { cols: 8 }), resolve())!.cols).toBe(2);
  });

  it("wraps into an explicit node width instead of overflowing it", () => {
    // 200px of box, 10px padding either side: three 40px cells fit, forty do not.
    const g = galleryExtent(galleryNode(cells(40), { cellW: 40, width: 200 }), resolve())!;
    expect(g.cols).toBeLessThanOrEqual(4);
    expect(g.rows).toBe(Math.ceil(40 / g.cols));
  });

  it("reserves the caption band on EVERY cell as soon as ONE is captioned", () => {
    const items = cells(4);
    items[2].caption = "Batman";
    const g = galleryExtent(galleryNode(items), resolve())!;
    const band = GALLERY_CAPTION_GAP + Math.round(GALLERY_CAPTION_SIZE * LINE_HEIGHT_FACTOR);
    expect(g.captionH).toBe(band);
    // The pitch of a row grows by the band — a grid whose rows are staggered
    // by which cell happens to be captioned stops reading as a grid.
    expect(g.cellH).toBe(GALLERY_CELL_W + band);
  });

  it("treats a whitespace-only caption as no caption", () => {
    const items = cells(2);
    items[0].caption = "   ";
    expect(galleryExtent(galleryNode(items), resolve())!.captionH).toBe(0);
  });

  it("derives the columns from the node alone, never from the placed box", () => {
    // The property that keeps the canvas and the two exports agreeing: the
    // grid must not answer differently when asked about a wider box, or the
    // measure and the painter can disagree on how many pictures fit a row.
    const n = galleryNode(cells(9));
    const a = positionedImageSlots({ x: 0, y: 0, w: 300, h: 200 }, n, resolve());
    const b = positionedImageSlots({ x: 0, y: 0, w: 3000, h: 200 }, n, resolve());
    expect(a.gallery!.cols).toBe(b.gallery!.cols);
    expect(a.gallery!.w).toBe(b.gallery!.w);
  });
});

describe("gallery cells", () => {
  it("crops a wide picture to its centred square", () => {
    // 200x100 into a square cell: the middle 100x100 shows, so half the width
    // is used, starting a quarter in.
    const c = positionedImageSlots({ x: 0, y: 0, w: 400, h: 200 }, galleryNode(cells(1)), resolve())!.cells[0];
    expect(c.crop).toEqual({ sx: 0.25, sy: 0, sw: 0.5, sh: 1 });
  });

  it("crops a tall picture the other way", () => {
    const c = positionedImageSlots(
      { x: 0, y: 0, w: 400, h: 200 },
      galleryNode(cells(1)),
      resolve({ a0: { w: 100, h: 400 } }),
    )!.cells[0];
    expect(c.crop).toEqual({ sx: 0, sy: 0.375, sw: 1, sh: 0.25 });
  });

  it("leaves a square picture uncropped", () => {
    const c = positionedImageSlots(
      { x: 0, y: 0, w: 400, h: 200 },
      galleryNode(cells(1)),
      resolve({ a0: { w: 512, h: 512 } }),
    )!.cells[0];
    expect(c.crop).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 });
  });

  it("marks a cell whose card is missing rather than dropping it", () => {
    // The layout already paid for the space; a silent hole explains nothing.
    const pos = positionedImageSlots({ x: 0, y: 0, w: 400, h: 200 }, galleryNode(cells(1)), () => null);
    expect(pos.cells).toHaveLength(1);
    expect(pos.cells[0].crop).toBeNull();
    expect(pos.cells[0].w).toBe(GALLERY_CELL_W);
  });

  it("places cells left to right, then top to bottom, with the gap between", () => {
    const pos = positionedImageSlots({ x: 0, y: 0, w: 400, h: 400 }, galleryNode(cells(4), { cols: 2 }), resolve());
    const [c0, c1, c2, c3] = pos.cells;
    expect(c1.x - c0.x).toBe(GALLERY_CELL_W + GALLERY_GAP);
    expect(c1.y).toBe(c0.y);
    expect(c2.x).toBe(c0.x);
    expect(c2.y - c0.y).toBe(GALLERY_CELL_W + GALLERY_GAP);
    expect(c3.x).toBe(c1.x);
  });

  it("puts the caption band directly under its own cell", () => {
    const items = cells(2);
    items[0].caption = "Velma";
    const pos = positionedImageSlots({ x: 0, y: 0, w: 400, h: 300 }, galleryNode(items), resolve());
    for (const c of pos.cells) {
      expect(c.captionY).toBe(c.y + c.h + GALLERY_CAPTION_GAP);
      expect(c.captionH).toBeGreaterThan(0);
    }
    expect(pos.cells[0].caption).toBe("Velma");
    expect(pos.cells[1].caption).toBe("");
  });

  it("keeps the grid inside the box the measure computed for it", () => {
    const items = cells(7);
    items[0].caption = "one";
    const n = galleryNode(items, { cols: 3 });
    const m = measureTopic(n, undefined, resolve());
    const pos = positionedImageSlots({ x: 0, y: 0, w: m.w, h: m.h }, n, resolve());
    for (const c of pos.cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(m.w + 0.001);
      expect(c.captionY + c.captionH).toBeLessThanOrEqual(m.h + 0.001);
    }
  });
});

describe("the gallery in the box", () => {
  it("makes the topic tall enough for the grid, under the title", () => {
    // Both titled, so the two heights differ by the grid alone: an untitled
    // topic still measures one strut line, and comparing against that would
    // be measuring the strut, not the grid.
    const bare = galleryNode([]);
    bare.title = "Buffed";
    delete bare.style.gallery;
    const withGrid = galleryNode(cells(3));
    withGrid.title = "Buffed";

    const a = measureTopic(bare, undefined, resolve());
    const b = measureTopic(withGrid, undefined, resolve());
    expect(b.h).toBeGreaterThanOrEqual(a.h + GALLERY_CELL_W);
    expect(b.w).toBeGreaterThanOrEqual(3 * GALLERY_CELL_W + 2 * GALLERY_GAP);
  });

  it("grows the box when a caption appears, and shrinks it back when it goes", () => {
    const without = measureTopic(galleryNode(cells(3)), undefined, resolve());
    const items = cells(3);
    items[1].caption = "Finn";
    const with_ = measureTopic(galleryNode(items), undefined, resolve());
    expect(with_.h).toBeGreaterThan(without.h);
    // And the extent cache must not have served the first answer for the
    // second: the caption's presence is part of the key.
    expect(measureTopic(galleryNode(cells(3)), undefined, resolve()).h).toBe(without.h);
  });

  it("does not touch a topic that has no gallery", () => {
    const plain = galleryNode([]);
    delete plain.style.gallery;
    const before = measureTopic(plain, undefined, resolve());
    expect(before.w).toBeGreaterThan(0);
    expect(before.h).toBeGreaterThan(0);
  });

  it("reserves the grid from the BOTTOM, so the title still fits above it", () => {
    const n = galleryNode(cells(4));
    n.title = "Buffed";
    const pos = positionedImageSlots({ x: 0, y: 0, w: 400, h: 300 }, n, resolve());
    expect(pos.insets.bottom).toBeGreaterThanOrEqual(pos.gallery!.h);
    // The text column keeps its full width: a grid reserves vertically only.
    expect(pos.insets.left).toBe(0);
    expect(pos.insets.right).toBe(0);
  });
});

describe("ellipsizeToWidth", () => {
  // 10 units per character, so the arithmetic is visible in the assertions.
  const measure = (s: string): number => s.length * 10;

  it("leaves a caption that fits exactly alone", () => {
    expect(ellipsizeToWidth("abcde", 50, measure)).toBe("abcde");
  });

  it("cuts and marks a caption that does not fit", () => {
    // 3 characters plus the ellipsis is 40; four plus one would be 50 > 45.
    expect(ellipsizeToWidth("abcdefgh", 45, measure)).toBe("abc…");
  });

  it("degrades to the ellipsis alone rather than overflowing", () => {
    expect(ellipsizeToWidth("abcdefgh", 5, measure)).toBe("…");
  });

  it("passes the empty string straight through", () => {
    expect(ellipsizeToWidth("", 0, measure)).toBe("");
  });
});

describe("gallery images are real references", () => {
  it("counts as a reference for the asset garbage collector", () => {
    // The failure this pins is silent and late: an id the GC cannot see is an
    // id no node claims, and collectOrphans deletes the bytes behind it.
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    store.attachImage(id, { id: "sha-slot", mime: "image/png", w: 4, h: 4, bytes: 1 }, "top");

    const node = store.doc.node(id)!;
    node.style = { ...node.style, gallery: { items: [{ id: "sha-cell", caption: "Jake" }] } };

    expect(nodeImageIds(node)).toContain("sha-cell");
    expect(nodeImageIds(node)).toContain("sha-slot");
    expect(referencedAssetIds(store.sheet as Sheet).has("sha-cell")).toBe(true);
  });

  it("stops being a reference once the cell is removed", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    const node = store.doc.node(id)!;
    node.style = { ...node.style, gallery: { items: [{ id: "sha-cell" }] } };
    expect(referencedAssetIds(store.sheet as Sheet).has("sha-cell")).toBe(true);

    store.removeGalleryItem(id, 0);
    expect(referencedAssetIds(store.sheet as Sheet).has("sha-cell")).toBe(false);
  });
});

describe("gallery editing", () => {
  function seeded(): { store: EditorStore; id: string } {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    const node = store.doc.node(id)!;
    node.style = {
      ...node.style,
      gallery: { items: [{ id: "a", caption: "Alpha" }, { id: "b" }, { id: "c", caption: "Gamma" }] },
    };
    return { store, id };
  }

  const ids = (store: EditorStore, id: string): string[] =>
    (store.doc.node(id)!.style.gallery?.items ?? []).map((i) => i.id);

  it("retitles a cell and undoes it", () => {
    const { store, id } = seeded();
    store.setGalleryCaption(id, 1, "Beta");
    expect(store.doc.node(id)!.style.gallery!.items[1].caption).toBe("Beta");
    store.undo();
    expect(store.doc.node(id)!.style.gallery!.items[1].caption).toBeUndefined();
  });

  it("drops the caption field entirely when it is cleared", () => {
    const { store, id } = seeded();
    store.setGalleryCaption(id, 0, "   ");
    expect(store.doc.node(id)!.style.gallery!.items[0]).toEqual({ id: "a" });
  });

  it("reorders a cell and undoes it", () => {
    const { store, id } = seeded();
    store.moveGalleryItem(id, 0, 2);
    expect(ids(store, id)).toEqual(["b", "c", "a"]);
    store.undo();
    expect(ids(store, id)).toEqual(["a", "b", "c"]);
  });

  it("clamps a reorder past the ends instead of losing the cell", () => {
    const { store, id } = seeded();
    store.moveGalleryItem(id, 0, 99);
    expect(ids(store, id)).toEqual(["b", "c", "a"]);
    store.moveGalleryItem(id, 2, -5);
    expect(ids(store, id)).toEqual(["a", "b", "c"]);
  });

  it("removes a cell and undoes it", () => {
    const { store, id } = seeded();
    store.removeGalleryItem(id, 1);
    expect(ids(store, id)).toEqual(["a", "c"]);
    store.undo();
    expect(ids(store, id)).toEqual(["a", "b", "c"]);
  });

  it("drops the gallery field when the last cell goes, rather than keeping an empty one", () => {
    const { store, id } = seeded();
    store.removeGalleryItem(id, 0);
    store.removeGalleryItem(id, 0);
    store.removeGalleryItem(id, 0);
    expect(store.doc.node(id)!.style.gallery).toBeUndefined();
    store.undo();
    expect(store.doc.node(id)!.style.gallery!.items).toHaveLength(1);
  });

  it("keeps the attachment card when a cell is removed — the picture may be shared", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    store.attachImage(id, { id: "shared", mime: "image/png", w: 4, h: 4, bytes: 1 }, "left");
    const node = store.doc.node(id)!;
    node.style = { ...node.style, gallery: { items: [{ id: "shared" }] } };

    store.removeGalleryItem(id, 0);
    expect(store.sheet.attachments.some((a) => a.id === "shared")).toBe(true);
    expect(store.doc.node(id)!.style.imageLeft).toBe("shared");
  });

  it("reshapes the grid and undoes that too", () => {
    const { store, id } = seeded();
    store.setGalleryLayout(id, { cellW: 120 });
    expect(store.doc.node(id)!.style.gallery!.cellW).toBe(120);
    store.setGalleryLayout(id, { cols: 2 });
    // Changing one knob must not clear the other.
    expect(store.doc.node(id)!.style.gallery!.cellW).toBe(120);
    expect(store.doc.node(id)!.style.gallery!.cols).toBe(2);
    store.undo();
    expect(store.doc.node(id)!.style.gallery!.cols).toBeUndefined();
    expect(store.doc.node(id)!.style.gallery!.cellW).toBe(120);
  });

  it("ignores an edit aimed at a cell that is not there", () => {
    const { store, id } = seeded();
    store.setGalleryCaption(id, 9, "nowhere");
    store.removeGalleryItem(id, -1);
    store.moveGalleryItem(id, 42, 0);
    expect(ids(store, id)).toEqual(["a", "b", "c"]);
  });
});

describe("uniform cell shape", () => {
  it("gives every cell the same rect whatever the pictures are", () => {
    // The property the tier list depends on: three sources at three aspect
    // ratios must come out as three identical boxes.
    const n = galleryNode(cells(3));
    const pos = positionedImageSlots({ x: 0, y: 0, w: 600, h: 300 }, n, resolve({
      a0: { w: 320, h: 160 },
      a1: { w: 160, h: 320 },
      a2: { w: 256, h: 256 },
    }));
    const shapes = new Set(pos.cells.map((c) => `${c.w}x${c.h}`));
    expect(shapes.size).toBe(1);
  });

  it("makes cells square by default", () => {
    const g = galleryExtent(galleryNode(cells(2)), resolve())!;
    expect(g.cellPicH).toBe(g.cellW);
  });

  it("takes the height from the aspect when one is set", () => {
    const g = galleryExtent(galleryNode(cells(2), { cellW: 120, aspect: 4 / 3 }), resolve())!;
    expect(g.cellW).toBe(120);
    expect(g.cellPicH).toBe(90);
  });

  it("falls back to square on a nonsense aspect rather than dividing by zero", () => {
    for (const aspect of [0, -2, Number.NaN]) {
      const g = galleryExtent(galleryNode(cells(1), { cellW: 80, aspect }), resolve())!;
      expect(g.cellPicH).toBe(80);
    }
  });
});

describe("coverCrop", () => {
  it("trims the sides of a source wider than the cell", () => {
    expect(coverCrop({ w: 200, h: 100 }, 1)).toEqual({ sx: 0.25, sy: 0, sw: 0.5, sh: 1 });
  });

  it("trims the top and bottom of a source taller than the cell", () => {
    expect(coverCrop({ w: 100, h: 200 }, 1)).toEqual({ sx: 0, sy: 0.25, sw: 1, sh: 0.5 });
  });

  it("takes the whole source when the ratios already match", () => {
    expect(coverCrop({ w: 400, h: 300 }, 4 / 3)).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 });
  });

  it("keeps the crop centred, so the middle of the picture always survives", () => {
    for (const nat of [{ w: 900, h: 100 }, { w: 100, h: 900 }, { w: 640, h: 480 }]) {
      for (const aspect of [1, 4 / 3, 3 / 4, 16 / 9]) {
        const c = coverCrop(nat, aspect)!;
        expect(c.sx + c.sw / 2).toBeCloseTo(0.5, 10);
        expect(c.sy + c.sh / 2).toBeCloseTo(0.5, 10);
        expect(c.sw).toBeGreaterThan(0);
        expect(c.sh).toBeGreaterThan(0);
        expect(c.sw).toBeLessThanOrEqual(1);
        expect(c.sh).toBeLessThanOrEqual(1);
      }
    }
  });

  it("refuses to guess when the size is unknown or degenerate", () => {
    expect(coverCrop(null, 1)).toBeNull();
    expect(coverCrop({ w: 0, h: 10 }, 1)).toBeNull();
    expect(coverCrop({ w: 10, h: 10 }, 0)).toBeNull();
  });
});

describe("galleryInsertIndex", () => {
  // One row of four 100-wide cells at y=0..100, gaps ignored for clarity.
  const row = [0, 100, 200, 300].map((x) => ({ x, y: 0, w: 100, h: 100 }));

  it("inserts before the first cell when the pointer is left of its middle", () => {
    expect(galleryInsertIndex(row, 10, 50)).toBe(0);
  });

  it("inserts after the last cell when the pointer is past its middle", () => {
    expect(galleryInsertIndex(row, 390, 50)).toBe(4);
  });

  it("splits each cell at its own centre", () => {
    expect(galleryInsertIndex(row, 140, 50)).toBe(1); // left half of cell 1
    expect(galleryInsertIndex(row, 160, 50)).toBe(2); // right half of cell 1
  });

  it("picks the row before the column in a grid", () => {
    // Two rows of two. A pointer in the SECOND row must not insert into the
    // first just because a first-row cell is horizontally nearer.
    const grid = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 100, y: 0, w: 100, h: 100 },
      { x: 0, y: 100, w: 100, h: 100 },
      { x: 100, y: 100, w: 100, h: 100 },
    ];
    expect(galleryInsertIndex(grid, 10, 150)).toBe(2);
    expect(galleryInsertIndex(grid, 190, 150)).toBe(4);
  });

  it("answers 0 for an empty grid", () => {
    expect(galleryInsertIndex([], 50, 50)).toBe(0);
  });
});

describe("moving a cell between tiers", () => {
  function tiers(): { store: EditorStore; buffed: string; nerfed: string } {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const buffed = firstChild(store);
    store.createChild();
    const nerfed = firstChild(store);
    const set = (id: string, list: string[]): void => {
      const n = store.doc.node(id)!;
      n.style = { ...n.style, gallery: { items: list.map((i) => ({ id: i })), cellW: 80 } };
    };
    set(buffed, ["harley", "garnet"]);
    set(nerfed, ["velma", "batman", "jake"]);
    return { store, buffed, nerfed };
  }

  const ids = (store: EditorStore, id: string): string[] =>
    (store.doc.node(id)!.style.gallery?.items ?? []).map((i) => i.id);

  it("promotes a picture from one tier to another at the chosen gap", () => {
    const { store, buffed, nerfed } = tiers();
    store.moveGalleryCellTo(nerfed, 1, buffed, 1); // batman between harley and garnet
    expect(ids(store, nerfed)).toEqual(["velma", "jake"]);
    expect(ids(store, buffed)).toEqual(["harley", "batman", "garnet"]);
  });

  it("undoes a cross-tier move in ONE step, not two", () => {
    // The trap this pins: two separate edits would leave an undo that takes
    // the picture out of the destination and strands it in neither tier.
    const { store, buffed, nerfed } = tiers();
    store.moveGalleryCellTo(nerfed, 0, buffed, 0);
    store.undo();
    expect(ids(store, nerfed)).toEqual(["velma", "batman", "jake"]);
    expect(ids(store, buffed)).toEqual(["harley", "garnet"]);
  });

  it("reorders inside one tier, counting the gap before the lift", () => {
    const { store, nerfed } = tiers();
    // Drop velma into the gap after jake: gap 3 of [velma, batman, jake].
    store.moveGalleryCellTo(nerfed, 0, nerfed, 3);
    expect(ids(store, nerfed)).toEqual(["batman", "jake", "velma"]);
  });

  it("treats a drop into the cell's own gap as no move at all", () => {
    const { store, nerfed } = tiers();
    store.moveGalleryCellTo(nerfed, 1, nerfed, 1);
    store.moveGalleryCellTo(nerfed, 1, nerfed, 2);
    expect(ids(store, nerfed)).toEqual(["velma", "batman", "jake"]);
  });

  it("keeps the destination tier's own cell size, not the source's", () => {
    const { store, buffed, nerfed } = tiers();
    store.setGalleryLayout(buffed, { cellW: 140 });
    store.moveGalleryCellTo(nerfed, 0, buffed, 0);
    expect(store.doc.node(buffed)!.style.gallery!.cellW).toBe(140);
    expect(store.doc.node(nerfed)!.style.gallery!.cellW).toBe(80);
  });

  it("starts a new grid when the target topic has none yet", () => {
    const { store, nerfed } = tiers();
    store.createChild();
    const plain = firstChild(store);
    expect(store.doc.node(plain)!.style.gallery).toBeUndefined();

    store.moveGalleryCellTo(nerfed, 0, plain, 0);
    expect(ids(store, plain)).toEqual(["velma"]);
    store.undo();
    expect(store.doc.node(plain)!.style.gallery).toBeUndefined();
    expect(ids(store, nerfed)).toEqual(["velma", "batman", "jake"]);
  });

  it("drops the source's gallery when its last cell leaves", () => {
    const { store, buffed, nerfed } = tiers();
    store.moveGalleryCellTo(buffed, 0, nerfed, 0);
    store.moveGalleryCellTo(buffed, 0, nerfed, 0);
    expect(store.doc.node(buffed)!.style.gallery).toBeUndefined();
    expect(ids(store, nerfed)).toHaveLength(5);
  });

  it("ignores a move naming a cell or a topic that is not there", () => {
    const { store, buffed, nerfed } = tiers();
    store.moveGalleryCellTo(nerfed, 9, buffed, 0);
    store.moveGalleryCellTo("nope", 0, buffed, 0);
    store.moveGalleryCellTo(nerfed, 0, "nope", 0);
    expect(ids(store, nerfed)).toEqual(["velma", "batman", "jake"]);
    expect(ids(store, buffed)).toEqual(["harley", "garnet"]);
  });

  it("clamps an out-of-range destination gap instead of losing the picture", () => {
    const { store, buffed, nerfed } = tiers();
    store.moveGalleryCellTo(nerfed, 0, buffed, 99);
    expect(ids(store, buffed)).toEqual(["harley", "garnet", "velma"]);
  });
});
