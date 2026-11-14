import type { MindNode, Sheet, TopicShape } from "./types";
import { inkBounds, inkStrokes } from "./ink";
export const FREEFORM_HEADER = 36;
export const FREEFORM_PADDING = 16;

/** The base shapes the double-click picker offers in a canvas (draw.io style). */
export type FreeformShape = Extract<
  TopicShape,
  "rect" | "rounded" | "capsule" | "circle" | "diamond" | "hexagon" | "ellipse" | "cylinder" | "document" | "parallelogram" | "triangle" | "process" | "note"
>;
export const FREEFORM_SHAPES: { shape: FreeformShape; label: string }[] = [
  { shape: "rect", label: "Rectangle" },
  { shape: "rounded", label: "Rounded" },
  { shape: "capsule", label: "Capsule (start / end)" },
  { shape: "circle", label: "Circle" },
  { shape: "ellipse", label: "Ellipse" },
  { shape: "diamond", label: "Diamond (decision)" },
  { shape: "hexagon", label: "Hexagon" },
  { shape: "parallelogram", label: "Data (parallelogram)" },
  { shape: "process", label: "Process" },
  { shape: "document", label: "Document" },
  { shape: "cylinder", label: "Database" },
  { shape: "triangle", label: "Triangle" },
  { shape: "note", label: "Note" },
];
/** Starting box of each shape; the user resizes it like any item. */
export const FREEFORM_SHAPE_SIZES: Record<FreeformShape, { w: number; h: number }> = {
  rect: { w: 120, h: 60 },
  rounded: { w: 120, h: 60 },
  capsule: { w: 120, h: 48 },
  circle: { w: 80, h: 80 },
  diamond: { w: 120, h: 80 },
  hexagon: { w: 120, h: 70 },
  ellipse: { w: 120, h: 70 },
  cylinder: { w: 70, h: 90 },
  document: { w: 120, h: 70 },
  parallelogram: { w: 130, h: 60 },
  triangle: { w: 90, h: 80 },
  process: { w: 130, h: 60 },
  note: { w: 110, h: 80 },
};
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
  // Handwriting is content too: the canvas grows to hold it and cannot shrink past it.
  const canvas = sheet.nodes[id];
  if (canvas) {
    for (const stroke of inkStrokes(canvas.style)) {
      const b = inkBounds(stroke);
      bounds.minX = Math.min(bounds.minX, b.minX); bounds.minY = Math.min(bounds.minY, b.minY);
      bounds.maxX = Math.max(bounds.maxX, b.maxX); bounds.maxY = Math.max(bounds.maxY, b.maxY);
    }
  }
  return bounds;
}
