/**
 * Tier-list topics (T26) — the chart's geometry, the ranking edits, and the
 * two things that go wrong silently whenever a new kind of image reference is
 * added: the asset garbage collector stops seeing it, and undo stops covering
 * it. The pool is the easy one to forget in both.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { nodeImageIds } from "../src/core/ops";
import { referencedAssetIds } from "../src/persist/assets";
import {
  GALLERY_GAP,
  TIER_COLS,
  TIER_DEFAULT_ROWS,
  TIER_LABEL_W,
  gridCells,
  measureTopic,
  positionedTierList,
  tierListLayout,
} from "../src/layout/measure";
import type { MindNode, Sheet, TierItem, TierRow } from "../src/core/types";
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

const pics = (n: number, from = 0): TierItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `a${from + i}` }));

function tierNode(
  rows: { label: string; color: string; items: TierItem[] }[],
  pool: TierItem[] = [],
  extra: { cellW?: number; cols?: number; aspect?: number; labelW?: number } = {},
): MindNode {
  return {
    id: "n",
    type: "subtopic",
    parentId: null,
    childrenIds: [],
    title: "",
    position: { x: 0, y: 0, manual: false },
    style: {
      tierList: {
        rows: rows.map((r, i): TierRow => ({ id: `r${i}`, ...r })),
        pool,
        ...extra,
      },
    },
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "", updatedAt: "" },
  };
}

/** Sources are deliberately NOT square, so a crop that does nothing fails. */
const resolve = (sizes: Record<string, { w: number; h: number }> = {}) =>
  (id: string): { w: number; h: number } | null => sizes[id] ?? { w: 200, h: 100 };

describe("gridCells", () => {
  it("fills a row left to right, then wraps", () => {
    const g = gridCells(5, 3, 10, 20, 2, 100, 200);
    expect(g[0]).toEqual({ x: 100, y: 200, w: 10, h: 20 });
    expect(g[2]).toEqual({ x: 124, y: 200, w: 10, h: 20 });
    expect(g[3]).toEqual({ x: 100, y: 222, w: 10, h: 20 });
  });

  it("never divides by a zero column count", () => {
    expect(gridCells(2, 0, 10, 10, 2, 0, 0)).toHaveLength(2);
  });
});

describe("tier list geometry", () => {
  it("is nothing at all when the topic is not a tier list", () => {
    const plain = tierNode([]);
    delete plain.style.tierList;
    expect(tierListLayout(plain, resolve())).toBeNull();
  });

  it("gives every row the same width whatever it holds", () => {
    // The property the whole chart depends on: rows are comparable only if
    // they are the same size, so a full row grows TALLER, never wider.
    const l = tierListLayout(
      tierNode([
        { label: "S", color: "#f00", items: pics(1) },
        { label: "A", color: "#0f0", items: pics(20, 10) },
        { label: "B", color: "#00f", items: [] },
      ]),
      resolve(),
    )!;
    const widths = new Set(l.rows.map((r) => r.w));
    expect(widths.size).toBe(1);
    expect(l.rows[1].h).toBeGreaterThan(l.rows[0].h);
  });

  it("keeps an empty row one card tall, so it stays a drop target", () => {
    const l = tierListLayout(tierNode([{ label: "S", color: "#f00", items: [] }]), resolve())!;
    expect(l.rows[0].h).toBeGreaterThanOrEqual(l.cellH);
  });

  it("wraps a row at the column count, and grows a line at a time", () => {
    const one = tierListLayout(tierNode([{ label: "S", color: "#f00", items: pics(TIER_COLS) }]), resolve())!;
    const two = tierListLayout(tierNode([{ label: "S", color: "#f00", items: pics(TIER_COLS + 1) }]), resolve())!;
    expect(two.rows[0].h - one.rows[0].h).toBe(one.cellH + GALLERY_GAP);
  });

  it("puts the rank column at the left of every band, at one width", () => {
    const l = tierListLayout(
      tierNode([
        { label: "S", color: "#f00", items: pics(2) },
        { label: "A", color: "#0f0", items: [] },
      ]),
      resolve(),
    )!;
    expect(l.labelW).toBe(TIER_LABEL_W);
    for (const row of l.rows) expect(row.labelW).toBe(TIER_LABEL_W);
    // Cards start to the RIGHT of the rank column, never under it.
    for (const c of l.rows[0].cells) expect(c.x).toBeGreaterThanOrEqual(l.labelW);
  });

  it("stacks the rows top to bottom without overlapping", () => {
    const l = tierListLayout(
      tierNode([
        { label: "S", color: "#f00", items: pics(3) },
        { label: "A", color: "#0f0", items: pics(20, 10) },
        { label: "B", color: "#00f", items: [] },
      ]),
      resolve(),
    )!;
    for (let i = 1; i < l.rows.length; i++) {
      expect(l.rows[i].y).toBeGreaterThanOrEqual(l.rows[i - 1].y + l.rows[i - 1].h);
    }
    expect(l.pool.y).toBeGreaterThanOrEqual(l.rows[2].y + l.rows[2].h);
  });

  it("starts the pool at the left edge — it has no rank column to yield", () => {
    // The point is not that the pool fits more cards (whether it does depends
    // on how the label width divides into a cell), but that it is not indented
    // by a rank column it does not have.
    const l = tierListLayout(tierNode([{ label: "S", color: "#f00", items: pics(1) }], pics(3, 9)), resolve())!;
    expect(l.pool.w).toBe(l.w);
    expect(l.pool.cells[0].x).toBeLessThan(l.rows[0].cells[0].x);
    expect(l.pool.cols).toBeGreaterThanOrEqual(l.cols);
  });

  it("marks pool cards with rowIndex -1, which is how every caller names them", () => {
    const l = tierListLayout(tierNode([{ label: "S", color: "#f00", items: pics(1) }], pics(2, 5)), resolve())!;
    expect(l.rows[0].cells[0].rowIndex).toBe(0);
    for (const c of l.pool.cells) expect(c.rowIndex).toBe(-1);
  });

  it("crops every card to one shape whatever the sources are", () => {
    const l = tierListLayout(
      tierNode([{ label: "S", color: "#f00", items: pics(3) }]),
      resolve({ a0: { w: 320, h: 160 }, a1: { w: 160, h: 320 }, a2: { w: 256, h: 256 } }),
    )!;
    expect(new Set(l.rows[0].cells.map((c) => `${c.w}x${c.h}`)).size).toBe(1);
    for (const c of l.rows[0].cells) {
      expect(c.crop!.sx + c.crop!.sw / 2).toBeCloseTo(0.5, 10);
      expect(c.crop!.sy + c.crop!.sh / 2).toBeCloseTo(0.5, 10);
    }
  });

  it("leaves a text card with no crop at all", () => {
    const l = tierListLayout(tierNode([{ label: "S", color: "#f00", items: [{ text: "Batman" }] }]), resolve())!;
    expect(l.rows[0].cells[0].crop).toBeNull();
    expect(l.rows[0].cells[0].text).toBe("Batman");
    expect(l.rows[0].cells[0].id).toBeUndefined();
  });

  it("is derived from the node alone, never from the placed box", () => {
    const n = tierNode([{ label: "S", color: "#f00", items: pics(12) }]);
    const a = positionedTierList({ x: 0, y: 0, w: 300, h: 400 }, n, resolve())!;
    const b = positionedTierList({ x: 0, y: 0, w: 3000, h: 400 }, n, resolve())!;
    expect(a.cols).toBe(b.cols);
    expect(a.w).toBe(b.w);
    expect(a.rows[0].h).toBe(b.rows[0].h);
  });

  it("fits inside the box the measure computed for it", () => {
    const n = tierNode(
      [
        { label: "S", color: "#f00", items: pics(3) },
        { label: "A", color: "#0f0", items: pics(11, 10) },
      ],
      pics(4, 40),
    );
    n.title = "Multiversus";
    const m = measureTopic(n, undefined, resolve());
    const l = positionedTierList({ x: 0, y: 0, w: m.w, h: m.h }, n, resolve())!;
    for (const c of [...l.rows.flatMap((r) => r.cells), ...l.pool.cells]) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(m.w + 0.001);
      expect(c.y + c.h).toBeLessThanOrEqual(m.h + 0.001);
    }
  });

  it("re-measures when a row's card count changes, rather than serving a stale extent", () => {
    const small = measureTopic(tierNode([{ label: "S", color: "#f00", items: pics(2) }]), undefined, resolve());
    const big = measureTopic(
      tierNode([{ label: "S", color: "#f00", items: pics(TIER_COLS * 2) }]),
      undefined,
      resolve(),
    );
    expect(big.h).toBeGreaterThan(small.h);
    expect(measureTopic(tierNode([{ label: "S", color: "#f00", items: pics(2) }]), undefined, resolve()).h).toBe(small.h);
  });

  it("honours the four size knobs", () => {
    const l = tierListLayout(
      tierNode([{ label: "S", color: "#f00", items: pics(4) }], [], { cellW: 40, cols: 2, aspect: 2, labelW: 30 }),
      resolve(),
    )!;
    expect(l.cellW).toBe(40);
    expect(l.cellH).toBe(20);
    expect(l.cols).toBe(2);
    expect(l.labelW).toBe(30);
    expect(l.rows[0].cells).toHaveLength(4);
    expect(l.rows[0].h).toBeGreaterThan(l.cellH); // two lines of two
  });
});

describe("tier list assets", () => {
  it("counts cards in rows AND in the pool as references", () => {
    // The pool is the half that is easy to forget, and forgetting it has the
    // collector delete the picture of everything not yet ranked.
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    const node = store.doc.node(id)!;
    node.style = {
      ...node.style,
      tierList: {
        rows: [{ id: "r0", label: "S", color: "#f00", items: [{ id: "ranked" }] }],
        pool: [{ id: "waiting" }, { text: "no picture" }],
      },
    };
    expect(nodeImageIds(node)).toEqual(expect.arrayContaining(["ranked", "waiting"]));
    expect(nodeImageIds(node)).toHaveLength(2); // the text card contributes nothing
    const refs = referencedAssetIds(store.sheet as Sheet);
    expect(refs.has("ranked")).toBe(true);
    expect(refs.has("waiting")).toBe(true);
  });
});

describe("ranking edits", () => {
  function chart(): { store: EditorStore; id: string } {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    store.createTierList(id);
    const node = store.doc.node(id)!;
    node.style = {
      ...node.style,
      tierList: {
        ...node.style.tierList!,
        rows: node.style.tierList!.rows.map((r, i) =>
          i === 1 ? { ...r, items: [{ text: "velma" }, { text: "batman" }] } : r
        ),
        pool: [{ text: "jake" }],
      },
    };
    return { store, id };
  }

  const band = (store: EditorStore, id: string, row: number): string[] => {
    const t = store.doc.node(id)!.style.tierList!;
    return (row < 0 ? t.pool : t.rows[row].items).map((i) => i.text ?? i.id ?? "");
  };

  it("seeds the ladder everyone already knows", () => {
    const store = new EditorStore(memoryAdapter);
    store.createChild();
    const id = firstChild(store);
    store.createTierList(id);
    const t = store.doc.node(id)!.style.tierList!;
    expect(t.rows.map((r) => r.label)).toEqual(TIER_DEFAULT_ROWS.map((r) => r.label));
    expect(t.rows.every((r) => /^#/.test(r.color))).toBe(true);
    expect(t.pool).toEqual([]);
  });

  it("does not re-seed a topic that is already a tier list", () => {
    const { store, id } = chart();
    const before = store.doc.node(id)!.style.tierList!.rows.length;
    store.createTierList(id);
    expect(store.doc.node(id)!.style.tierList!.rows).toHaveLength(before);
  });

  it("promotes a card from one rank to another, and undoes in one step", () => {
    const { store, id } = chart();
    store.moveTierItem(id, 1, 1, 0, 0); // batman: A → top of S
    expect(band(store, id, 0)).toEqual(["batman"]);
    expect(band(store, id, 1)).toEqual(["velma"]);
    store.undo();
    expect(band(store, id, 0)).toEqual([]);
    expect(band(store, id, 1)).toEqual(["velma", "batman"]);
  });

  it("ranks a card out of the pool, and sends one back to it", () => {
    const { store, id } = chart();
    store.moveTierItem(id, -1, 0, 0, 0);
    expect(band(store, id, 0)).toEqual(["jake"]);
    expect(band(store, id, -1)).toEqual([]);
    store.moveTierItem(id, 0, 0, -1, 0);
    expect(band(store, id, -1)).toEqual(["jake"]);
  });

  it("reorders inside one row, counting the gap before the lift", () => {
    const { store, id } = chart();
    store.moveTierItem(id, 1, 0, 1, 2); // velma to the end of its own row
    expect(band(store, id, 1)).toEqual(["batman", "velma"]);
  });

  it("treats a drop into a card's own gap as no move", () => {
    const { store, id } = chart();
    store.moveTierItem(id, 1, 0, 1, 0);
    store.moveTierItem(id, 1, 0, 1, 1);
    expect(band(store, id, 1)).toEqual(["velma", "batman"]);
  });

  it("clamps an out-of-range gap instead of losing the card", () => {
    const { store, id } = chart();
    store.moveTierItem(id, 1, 0, 0, 99);
    expect(band(store, id, 0)).toEqual(["velma"]);
  });

  it("ignores a move naming a band or card that is not there", () => {
    const { store, id } = chart();
    store.moveTierItem(id, 9, 0, 0, 0);
    store.moveTierItem(id, 1, 9, 0, 0);
    expect(band(store, id, 1)).toEqual(["velma", "batman"]);
  });

  it("returns a deleted row's cards to the pool rather than discarding them", () => {
    // Losing a rank is a ranking decision; losing the pictures in it is not.
    const { store, id } = chart();
    store.removeTierRow(id, 1);
    expect(store.doc.node(id)!.style.tierList!.rows).toHaveLength(4);
    expect(band(store, id, -1)).toEqual(["jake", "velma", "batman"]);
    store.undo();
    expect(band(store, id, 1)).toEqual(["velma", "batman"]);
  });

  it("adds, renames, recolours and reorders rows, all undoable", () => {
    const { store, id } = chart();
    store.addTierRow(id);
    expect(store.doc.node(id)!.style.tierList!.rows).toHaveLength(6);

    store.setTierRow(id, 0, { label: "God", color: "#123456" });
    expect(store.doc.node(id)!.style.tierList!.rows[0].label).toBe("God");
    expect(store.doc.node(id)!.style.tierList!.rows[0].color).toBe("#123456");

    store.moveTierRow(id, 0, 2);
    expect(store.doc.node(id)!.style.tierList!.rows[2].label).toBe("God");
    store.undo();
    expect(store.doc.node(id)!.style.tierList!.rows[0].label).toBe("God");
  });

  it("keeps a row's identity across a rename and a move", () => {
    const { store, id } = chart();
    const wanted = store.doc.node(id)!.style.tierList!.rows[1].id;
    store.setTierRow(id, 1, { label: "renamed" });
    store.moveTierRow(id, 1, 3);
    expect(store.doc.node(id)!.style.tierList!.rows[3].id).toBe(wanted);
  });

  it("adds a text card to the pool and refuses an empty one", () => {
    const { store, id } = chart();
    store.addTierTextItem(id, "  superman  ");
    expect(band(store, id, -1)).toEqual(["jake", "superman"]);
    store.addTierTextItem(id, "   ");
    expect(band(store, id, -1)).toEqual(["jake", "superman"]);
  });

  it("retitles a card, and clearing the text leaves a bare picture", () => {
    const { store, id } = chart();
    const node = store.doc.node(id)!;
    node.style = {
      ...node.style,
      tierList: { ...node.style.tierList!, pool: [{ id: "sha", text: "old" }] },
    };
    store.setTierItemText(id, -1, 0, "new");
    expect(store.doc.node(id)!.style.tierList!.pool[0]).toEqual({ id: "sha", text: "new" });
    store.setTierItemText(id, -1, 0, "  ");
    expect(store.doc.node(id)!.style.tierList!.pool[0]).toEqual({ id: "sha" });
  });

  it("drops the whole chart only when it has no rows AND no cards", () => {
    const { store, id } = chart();
    for (let i = store.doc.node(id)!.style.tierList!.rows.length - 1; i >= 0; i--) {
      store.removeTierRow(id, i);
    }
    // Rows are gone but their cards are in the pool, so the chart remains.
    expect(store.doc.node(id)!.style.tierList).toBeDefined();
    const pool = store.doc.node(id)!.style.tierList!.pool.length;
    for (let i = pool - 1; i >= 0; i--) store.removeTierItem(id, -1, i);
    expect(store.doc.node(id)!.style.tierList).toBeUndefined();
  });

  it("reshapes the chart without disturbing its contents", () => {
    const { store, id } = chart();
    store.setTierLayout(id, { cellW: 48, cols: 4 });
    const t = store.doc.node(id)!.style.tierList!;
    expect(t.cellW).toBe(48);
    expect(t.cols).toBe(4);
    expect(t.rows[1].items).toHaveLength(2);
  });
});
