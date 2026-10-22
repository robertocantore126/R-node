/**
 * Group boundary geometry (pure, framework-free).
 *
 * One function answers "where is each group's box" for the canvas, the hit
 * test and the PDF, so the three cannot draw a box in three places. The layout
 * reserves room for exactly these boxes (see GROUP_PAD in measure.ts).
 *
 * A box encloses each member's whole visible branch — not just the member's
 * own topic — and every group nested inside it, so an inner box never sits on
 * the outer one's line.
 */
import { groupLabel, type GroupShape, type Sheet } from "../core/types";
import { GROUP_LABEL_H, GROUP_PAD } from "./measure";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GroupBox {
  /** Where the boundary line runs. */
  box: Box;
  /** The line plus the half of the title tab that sticks out above it. */
  occupied: Box;
  /** How many placed topics the group encloses (its members' branches). */
  covered: Set<string>;
}

function union(a: Box | null, b: Box): Box {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Every group's box, keyed by group id. `placed` holds the topics that are on
 * the map right now (a collapsed branch's children are simply absent, so the
 * box shrinks with the branch). A group none of whose topics are placed has
 * no entry.
 */
export function groupBoxes(sheet: Sheet, placed: Map<string, Box>): Map<string, GroupBox> {
  const covers = sheet.boundaries.map((g) => {
    const covered = new Set<string>();
    const visit = (id: string, depth: number): void => {
      if (depth > 256 || covered.has(id)) return;
      const n = sheet.nodes[id];
      if (!n) return;
      if (placed.has(id)) covered.add(id);
      for (const c of n.childrenIds) visit(c, depth + 1);
    };
    for (const id of g.memberIds) visit(id, 0);
    return { g, covered };
  });
  // Inner groups first: a group's box must already exist when an enclosing
  // group asks for it.
  covers.sort((a, b) => a.covered.size - b.covered.size);
  const out = new Map<string, GroupBox>();
  const done: { covered: Set<string>; occupied: Box }[] = [];
  for (const { g, covered } of covers) {
    let r: Box | null = null;
    for (const id of covered) r = union(r, placed.get(id)!);
    if (!r) continue;
    for (const inner of done) {
      if (inner.covered.size > covered.size || inner.covered.size === 0) continue;
      let inside = true;
      for (const id of inner.covered) if (!covered.has(id)) { inside = false; break; }
      // Same topics, different group: the two would nest by array order.
      // Only a strictly smaller set counts as "inside".
      if (inside && inner.covered.size < covered.size) r = union(r, inner.occupied);
    }
    const box = { x: r.x - GROUP_PAD, y: r.y - GROUP_PAD, w: r.w + GROUP_PAD * 2, h: r.h + GROUP_PAD * 2 };
    const lift = groupLabel(g) ? GROUP_LABEL_H / 2 : 0;
    const occupied = { x: box.x, y: box.y - lift, w: box.w, h: box.h + lift };
    out.set(g.id, { box, occupied, covered });
    done.push({ covered, occupied });
  }
  return out;
}

/**
 * The "wave" outline as a closed polyline: each edge carries whole periods of
 * a sine so the corners meet at zero amplitude and the line closes cleanly.
 * `amp` and `period` are in world units.
 */
export function wavePoints(b: Box, amp = 3, period = 18): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number): void => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const waves = Math.max(1, Math.round(len / period));
    const steps = waves * 8;
    // outward normal for a clockwise walk in screen coordinates (y down)
    const nx = (y1 - y0) / len;
    const ny = -(x1 - x0) / len;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const o = Math.sin(t * waves * Math.PI * 2) * amp;
      pts.push({ x: x0 + (x1 - x0) * t + nx * o, y: y0 + (y1 - y0) * t + ny * o });
    }
  };
  const { x, y, w, h } = b;
  edge(x, y, x + w, y);
  edge(x + w, y, x + w, y + h);
  edge(x + w, y + h, x, y + h);
  edge(x, y + h, x, y);
  return pts;
}

/** Corner radius of a group outline, in world units. */
export function groupRadius(shape: GroupShape | undefined): number {
  return shape === "rect" ? 0 : 12;
}
