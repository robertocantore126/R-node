/**
 * Handwriting on a freeform canvas: the geometry every renderer shares.
 *
 * A stroke is a line of constant width. `inkPolyline` smooths its samples, and
 * the canvas, the SVG export and the PDF export all draw that same line with
 * round ends, so a stroke cannot look different on paper than on screen.
 */
import type { InkStroke, Style } from "./types";

/** Stroke width in map units, which are pixels at 100% zoom. */
export const INK_MIN_WIDTH = 1;
export const INK_MAX_WIDTH = 24;
export const INK_DEFAULT_WIDTH = 2;

/** The strokes of a canvas; anything malformed in a loaded file is skipped. */
export function inkStrokes(style: Style): InkStroke[] {
  const ink = style.ink as unknown;
  if (!Array.isArray(ink)) return [];
  return ink.filter(
    (s: InkStroke) => !!s && Array.isArray(s.path) && s.path.length >= 2 && s.path.length % 2 === 0 && s.path.every(Number.isFinite) && Number.isFinite(s.width)
  );
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Add a sample, unless it is closer than `minDistance` to the last one: a
 * tablet reports far more points than a stroke needs at this zoom.
 */
export function appendInkSample(path: number[], x: number, y: number, minDistance: number): void {
  const n = path.length;
  if (n > 0 && Math.hypot(x - path[n - 2], y - path[n - 1]) < minDistance) return;
  path.push(round2(x), round2(y));
}

/**
 * The line to draw, `[x0, y0, x1, y1, ...]` in canvas-local units: one round of
 * corner cutting, keeping both ends where the pen was. A single tap comes back
 * as a zero-length line, which every renderer draws as a round dot.
 */
export function inkPolyline(stroke: InkStroke): number[] {
  const p = stroke.path;
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 4) return p;
  const out = [p[0], p[1]];
  for (let i = 0; i + 2 < p.length; i += 2) {
    for (const t of [0.25, 0.75]) out.push(p[i] + (p[i + 2] - p[i]) * t, p[i + 1] + (p[i + 3] - p[i + 1]) * t);
  }
  out.push(p[p.length - 2], p[p.length - 1]);
  return out;
}

/** The area a stroke covers, thickness included. */
export function inkBounds(stroke: InkStroke): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const p = stroke.path;
  for (let i = 0; i < p.length; i += 2) {
    minX = Math.min(minX, p[i]); minY = Math.min(minY, p[i + 1]);
    maxX = Math.max(maxX, p[i]); maxY = Math.max(maxY, p[i + 1]);
  }
  const r = stroke.width / 2;
  return { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Whether a point within `tolerance` of the stroke's edge touches it. */
export function inkStrokeHit(stroke: InkStroke, x: number, y: number, tolerance: number): boolean {
  const b = inkBounds(stroke);
  if (x < b.minX - tolerance || x > b.maxX + tolerance || y < b.minY - tolerance || y > b.maxY + tolerance) return false;
  const p = stroke.path;
  const reach = stroke.width / 2 + tolerance;
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i + 2 < p.length; i += 2) {
    if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
  }
  return false;
}
