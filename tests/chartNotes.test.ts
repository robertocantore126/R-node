/**
 * Chart titles, box notes and the box menu's placeholder box. The traps: a
 * note's position leaking into an op (I6), a note left behind as an orphan
 * when its slot or chart goes, a slot rewrite that drops `noteId`, and a
 * board that loses its `cols` multiple when a box is inserted.
 */
import "fake-indexeddb/auto";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { chartNoteSlot, chartSlotNote, openChartNote } from "../src/core/chartNotes";
import { CHART_COLS, CHART_NOTE_GAP, CHART_ROWS, positionedImageSlots, imageResolver, measureNode } from "../src/layout/measure";
import { IndexedDbAssetStore } from "../src/persist/assets";
import { buildRnodeFile, readRnodeFile } from "../src/persist/rnodeFile";
import { applyLayout } from "../src/layout/mindmap";
import type { AttachmentInfo } from "../src/core/types";
import type { Op } from "../src/core/ops";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

function seeded(): { store: EditorStore; id: string } {
  const store = new EditorStore(memoryAdapter);
  const root = store.sheet.rootNodeId;
  store.createChartTopic(root);
  const kids = store.doc.node(root)!.childrenIds;
  const id = kids[kids.length - 1];
  (store as unknown as { importToCard: (f: File) => Promise<{ ok: true; card: AttachmentInfo }> }).importToCard = async (f) => ({
    ok: true,
    card: { id: `id:${f.name}`, mime: "image/png", w: 240, h: 240, bytes: 1, name: f.name },
  });
  return { store, id };
}

const ids = (store: EditorStore, id: string): string[] => store.doc.node(id)!.style.gallery!.items.map((i) => i.id);
const openNote = (store: EditorStore): string | null => {
  const s = store.getSnapshot();
  return openChartNote(store.sheet, { gallerySel: s.gallerySel, editingId: s.editingId, selection: s.selection });
};

describe("chart title", () => {
  it("opens the editor on a chart and renames it", () => {
    const { store, id } = seeded();
    store.startEdit(id);
    expect(store.getSnapshot().editingId).toBe(id);
    store.setEditingDraft("Albums of 2026");
    store.commitEdit();
    expect(store.doc.node(id)!.title).toBe("Albums of 2026");
    store.undo();
    expect(store.doc.node(id)!.title).toBe("Chart");
  });

  it("still refuses a plain gallery, and typing over a selected box", () => {
    const { store, id } = seeded();
    store.createGalleryTopic(store.sheet.rootNodeId);
    const gallery = store.getSnapshot().selection[0];
    store.startEdit(gallery);
    expect(store.getSnapshot().editingId).toBeNull();
    store.selectGalleryCell(id, 0);
    store.typeToEdit("x");
    expect(store.getSnapshot().editingId).toBeNull();
  });
});

describe("box notes", () => {
  it("adds a note as a floating topic linked both ways, and edits it", () => {
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 1)!;
    const note = store.doc.node(noteId)!;
    expect(note.type).toBe("floating");
    expect(note.parentId).toBeNull();
    expect(note.style.chartNote).toEqual({ chartId: id });
    expect(store.doc.node(id)!.style.gallery!.items[1].noteId).toBe(noteId);
    expect(chartSlotNote(store.sheet, id, 1)?.id).toBe(noteId);
    expect(chartNoteSlot(store.sheet, noteId)).toEqual({ chartId: id, index: 1 });
    expect(store.getSnapshot().editingId).toBe(noteId);
  });

  it("is placed right of its slot by the layout, never by an op", () => {
    const { store, id } = seeded();
    const ops: Op[] = [];
    const exec = store.execOps.bind(store);
    store.execOps = (o, opts) => { ops.push(...o); exec(o, opts); };
    const noteId = store.addChartNote(id, 4)!;
    expect(ops.some((o) => o.type === "setPosition")).toBe(false);
    const chart = store.doc.node(id)!;
    const m = measureNode(chart, undefined, imageResolver(store.sheet));
    const { cells } = positionedImageSlots({ x: chart.position.x, y: chart.position.y, w: m.w, h: m.h }, chart, imageResolver(store.sheet));
    const note = store.doc.node(noteId)!;
    expect(note.position.x).toBeCloseTo(cells[4].x + cells[4].w + CHART_NOTE_GAP);
    expect(note.position.y).toBeCloseTo(cells[4].y);
  });

  it("opens with its slot and closes when the selection leaves", () => {
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 0)!;
    store.commitEdit();
    store.selectGalleryCell(id, 0);
    expect(openNote(store)).toBe(noteId);
    store.selectGalleryCell(id, 1);
    expect(openNote(store)).toBeNull();
    store.select(noteId);
    expect(openNote(store)).toBe(noteId);
    store.select(id);
    expect(openNote(store)).toBeNull();
  });

  it("is added and removed with one undo step each", () => {
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 2)!;
    store.commitEdit();
    store.undo();
    expect(store.doc.node(noteId)).toBeUndefined();
    expect(store.doc.node(id)!.style.gallery!.items[2].noteId).toBeUndefined();
    store.redo();
    expect(chartSlotNote(store.sheet, id, 2)?.id).toBe(noteId);

    store.removeChartNote(id, 2);
    expect(store.doc.node(noteId)).toBeUndefined();
    expect(store.doc.node(id)!.style.gallery!.items[2].noteId).toBeUndefined();
    expect(store.getSnapshot().gallerySel).toEqual({ nodeId: id, index: 2 });
    store.undo();
    expect(chartSlotNote(store.sheet, id, 2)?.id).toBe(noteId);
  });

  it("goes with its chart, and comes back with it", () => {
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 0)!;
    store.commitEdit();
    store.deleteNodes([id]);
    expect(store.doc.node(noteId)).toBeUndefined();
    store.undo();
    expect(chartSlotNote(store.sheet, id, 0)?.id).toBe(noteId);
  });

  it("refuses subtopics, which a floating note could never draw", () => {
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 0)!;
    store.commitEdit();
    store.select(noteId);
    store.createChild();
    expect(store.createChildOf(noteId)).toBeNull();
    expect(store.doc.node(noteId)!.childrenIds).toEqual([]);
  });

  it("survives the slot's picture being removed, swapped or the board resized", async () => {
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 0)!;
    store.commitEdit();
    await store.fillChartSlots(id, [new File([new Uint8Array([1])], "a.png", { type: "image/png" })], 0);
    expect(chartSlotNote(store.sheet, id, 0)?.id).toBe(noteId);
    store.removeGalleryItem(id, 0);
    expect(chartSlotNote(store.sheet, id, 0)?.id).toBe(noteId);
    store.resizeChart(id, 0, 1);
    expect(chartSlotNote(store.sheet, id, 0)?.id).toBe(noteId);
  });

  it("stays on its slot when a picture moves to another chart", async () => {
    const { store, id } = seeded();
    store.createChartTopic(store.sheet.rootNodeId);
    const other = store.getSnapshot().selection[0];
    await store.fillChartSlots(id, [new File([new Uint8Array([1])], "a.png", { type: "image/png" })], 0);
    const noteId = store.addChartNote(id, 0)!;
    store.commitEdit();
    store.moveGalleryCellTo(id, 0, other, 3);
    expect(ids(store, other)[3]).toBe("id:a.png");
    expect(chartSlotNote(store.sheet, id, 0)?.id).toBe(noteId);
    expect(store.doc.node(other)!.style.gallery!.items.every((it) => !it.noteId)).toBe(true);
  });

  it("round-trips through a .rnode file", async () => {
    const SQL: SqlJsStatic = await initSqlJs();
    const { store, id } = seeded();
    const noteId = store.addChartNote(id, 3)!;
    store.setEditingDraft("Saw them live");
    store.commitEdit();
    const { bytes } = await buildRnodeFile(store.doc.doc, store.sheet, new IndexedDbAssetStore("chart-notes-a"), { sql: SQL });
    const back = await readRnodeFile(bytes, new IndexedDbAssetStore("chart-notes-b"), { sql: SQL });
    if (!back.ok) throw new Error("file did not read back");
    const sheet = back.doc.sheets[0];
    applyLayout(sheet, false);
    expect(chartSlotNote(sheet, id, 3)?.title).toBe("Saw them live");
    expect(sheet.nodes[noteId].style.chartNote).toEqual({ chartId: id });
  });
});

describe("placeholder box", () => {
  it("inserts after the selected box and keeps the board's shape", async () => {
    const { store, id } = seeded();
    expect(await store.addChartPlaceholder(id, 1)).toBe(true);
    expect(ids(store, id)).toEqual(["", "", "id:placeholder.png", "", "", ""]);
    expect(store.chartShape(id)).toEqual({ cols: CHART_COLS, rows: CHART_ROWS });
    expect(store.getSnapshot().gallerySel).toEqual({ nodeId: id, index: 2 });
    expect(store.sheet.attachments.some((a) => a.id === "id:placeholder.png")).toBe(true);
    store.undo();
    expect(ids(store, id)).toEqual(["", "", "", "", "", ""]);
  });

  it("adds a row when the last box is in use", async () => {
    const { store, id } = seeded();
    store.doc.node(id)!.style.gallery!.items[5] = { id: "last" };
    await store.addChartPlaceholder(id, 0);
    expect(store.chartShape(id)).toEqual({ cols: CHART_COLS, rows: CHART_ROWS + 1 });
    expect(ids(store, id)).toEqual(["", "id:placeholder.png", "", "", "", "", "last", "", ""]);
  });
});
