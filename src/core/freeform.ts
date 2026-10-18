import type { MindNode, Sheet } from "./types";
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

/** The same default offset used by layout and containment calculations. */
export function freeformOffset(node: MindNode, index: number): { x: number; y: number } {
  return node.style.freeformPosition ?? { x: FREEFORM_PADDING + index * 24, y: FREEFORM_HEADER + FREEFORM_PADDING + index * 24 };
}

/** Local bounds of all content. Nested canvases occupy their own rectangle. */
export function freeformContentBounds(sheet: Sheet, id: string, size: (node: MindNode) => { w: number; h: number }): { minX: number; minY: number; maxX: number; maxY: number } {
  const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const visited = new Set<string>();
  const visit = (parentId: string, x: number, y: number): void => {
    if (visited.has(parentId)) return;
    visited.add(parentId);
    const parent = sheet.nodes[parentId];
    if (!parent) return;
    const local = parent.style.freeform || freeformOwner(sheet, parentId);
    parent.childrenIds.forEach((childId, index) => {
      const child = sheet.nodes[childId];
      if (!child) return;
      const offset = local ? freeformOffset(child, index) : { x: child.position.x - parent.position.x, y: child.position.y - parent.position.y };
      const cx = x + offset.x, cy = y + offset.y;
      const extent = size(child);
      bounds.minX = Math.min(bounds.minX, cx); bounds.minY = Math.min(bounds.minY, cy);
      bounds.maxX = Math.max(bounds.maxX, cx + extent.w); bounds.maxY = Math.max(bounds.maxY, cy + extent.h);
      if (!child.style.freeform) visit(childId, cx, cy);
    });
  };
  visit(id, 0, 0);
  return bounds;
}
