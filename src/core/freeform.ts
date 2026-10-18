import type { Sheet } from "./types";
export const FREEFORM_HEADER = 36;
export const FREEFORM_PADDING = 16;
/** Nearest enclosing canvas, excluding the topic itself. */
export function freeformOwner(sheet: Sheet, id: string): string | null {
  let parentId = sheet.nodes[id]?.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = sheet.nodes[parentId];
    if (!parent) break;
    if (parent.style.freeform) return parent.id;
    parentId = parent.parentId;
  }
  return null;
}
