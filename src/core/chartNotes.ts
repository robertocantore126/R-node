/**
 * Notes on chart slots (`GalleryItem.noteId` ↔ `Style.chartNote`).
 *
 * A note is a real floating topic, so editing, styling, undo and save need
 * nothing new. What is new is that it belongs to ONE slot: the layout places
 * it beside that slot and the renderer only draws it while it is "open".
 * Both directions of the link are checked everywhere, because each side can
 * survive without the other — a copied chart keeps `noteId` but not the
 * note, and a deleted note leaves the id behind until the batch that clears
 * it is undone.
 */
import type { MindNode, Sheet } from "./types";

export function isChartNote(n: MindNode | undefined | null): boolean {
  return !!n?.style.chartNote;
}

/** The note node of slot `index` of chart `chartId`, or null when it has none. */
export function chartSlotNote(sheet: Sheet, chartId: string, index: number): MindNode | null {
  const chart = sheet.nodes[chartId];
  const noteId = chart?.style.gallery?.chart ? chart.style.gallery.items[index]?.noteId : undefined;
  if (!noteId) return null;
  const note = sheet.nodes[noteId];
  return note && note.style.chartNote?.chartId === chartId ? note : null;
}

/** Where a note hangs: its chart and the slot that names it, or null. */
export function chartNoteSlot(sheet: Sheet, noteId: string): { chartId: string; index: number } | null {
  const chartId = sheet.nodes[noteId]?.style.chartNote?.chartId;
  const items = chartId ? sheet.nodes[chartId]?.style.gallery?.items : undefined;
  if (!chartId || !items) return null;
  const index = items.findIndex((it) => it.noteId === noteId);
  return index >= 0 ? { chartId, index } : null;
}

/**
 * The one note on screen, derived from the selection — so there is no
 * "open" flag to save, undo or forget to clear. A selected slot opens its
 * note; the note stays open while it is itself selected or being edited.
 */
export function openChartNote(
  sheet: Sheet,
  sel: { gallerySel?: { nodeId: string; index: number } | null; editingId?: string | null; selection: Iterable<string> },
): string | null {
  if (sel.gallerySel) {
    const n = chartSlotNote(sheet, sel.gallerySel.nodeId, sel.gallerySel.index);
    if (n) return n.id;
  }
  if (sel.editingId && isChartNote(sheet.nodes[sel.editingId])) return sel.editingId;
  let last: string | null = null;
  for (const id of sel.selection) last = id;
  return last && isChartNote(sheet.nodes[last]) ? last : null;
}

/** Every note owned by a chart, valid links only. */
export function chartNoteIds(sheet: Sheet, chartId: string): string[] {
  const items = sheet.nodes[chartId]?.style.gallery?.items ?? [];
  const out: string[] = [];
  items.forEach((_, i) => {
    const n = chartSlotNote(sheet, chartId, i);
    if (n) out.push(n.id);
  });
  return out;
}
