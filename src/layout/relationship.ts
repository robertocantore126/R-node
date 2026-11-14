/**
 * Relationship geometry — the ONE route the canvas, the SVG export and the PDF
 * export all draw (I9: three copies of this arithmetic used to drift apart, and
 * the PDF never learned "straight"). Pure and framework-free.
 *
 * A route is either a cubic (curved) or a polyline (straight, elbow). Its two
 * heads are given as `from → tip`: the tip sits on the box border and `from`
 * is a point behind it along the line, so the head's angle is the line's real
 * direction at the end.
 */
import type { ArrowHead, ConnectorStyle, MindNode, RelAnchor, Relationship, Sheet } from "../core/types";
import { freeformOwner } from "../core/freeform";
import {
  ARROW_HALF_ANGLE,
  ARROW_LEN,
  bezierEnterRect,
  bezierExitRect,
  bezierPoint,
  bezierSlice,
  segmentExitRect,
  type Bezier3,
} from "./measure";

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Default stroke width of a relationship, world units. */
export const REL_WIDTH = 1.5;
/** Length of the straight stub an elbow line leaves a box with. */
export const ELBOW_STUB = 20;

export type RelGeometry = Pick<Relationship, "connector" | "fromAnchor" | "toAnchor">;

export interface RelRoute {
  path: { kind: "curve"; b: Bezier3 } | { kind: "poly"; pts: Pt[] };
  start: { from: Pt; tip: Pt };
  end: { from: Pt; tip: Pt };
  /** Where the label chip is centred. */
  mid: Pt;
}

export function relWidth(rel: Pick<Relationship, "width">): number {
  return Math.max(0.5, Math.min(12, rel.width ?? REL_WIDTH));
}

/** The heads actually drawn — older documents only have `bidirectional`. */
export function relHeads(rel: Pick<Relationship, "startArrow" | "endArrow" | "bidirectional">): { start: ArrowHead; end: ArrowHead } {
  return { start: rel.startArrow ?? (rel.bidirectional ? "triangle" : "none"), end: rel.endArrow ?? "triangle" };
}

/** Head length for a stroke width: the default width keeps ARROW_LEN exactly. */
export function headLen(width: number): number {
  return ARROW_LEN + Math.max(0, width - REL_WIDTH) * 2;
}

export function anchorPoint(r: Rect, a: RelAnchor): Pt {
  return { x: r.x + a.x * r.w, y: r.y + a.y * r.h };
}

const NORMALS: Pt[] = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];

/** Outward normal of the side the anchor lies on (the nearest side). */
export function anchorNormal(a: RelAnchor): Pt {
  const d = [a.x, 1 - a.x, a.y, 1 - a.y];
  let best = 0;
  for (let i = 1; i < 4; i++) if (d[i] < d[best]) best = i;
  return NORMALS[best];
}

/** Midpoint of the side of `r` that faces `toward`. */
export function facingAnchor(r: Rect, toward: Pt): RelAnchor {
  const dx = (toward.x - (r.x + r.w / 2)) / (r.w || 1);
  const dy = (toward.y - (r.y + r.h / 2)) / (r.h || 1);
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : 0, y: 0.5 };
  return { x: 0.5, y: dy >= 0 ? 1 : 0 };
}

/**
 * The anchor a pointer at `p` picks on box `r`: undefined in the middle of the
 * box (a floating end, draw.io's "drop on the shape"), otherwise the nearest
 * border point, pulled onto the quarter marks when within `snap` world units.
 */
export function anchorAt(r: Rect, p: Pt, snap: number): RelAnchor | undefined {
  const u = (p.x - r.x) / (r.w || 1);
  const v = (p.y - r.y) / (r.h || 1);
  if (u > 0.25 && u < 0.75 && v > 0.25 && v < 0.75) return undefined;
  const d = [Math.abs(p.x - r.x), Math.abs(r.x + r.w - p.x), Math.abs(p.y - r.y), Math.abs(r.y + r.h - p.y)];
  let side = 0;
  for (let i = 1; i < 4; i++) if (d[i] < d[side]) side = i;
  const horizontal = side >= 2; // top or bottom: the free coordinate is x
  const len = horizontal ? r.w : r.h;
  let t = Math.max(0, Math.min(1, horizontal ? u : v));
  const q = Math.round(t * 4) / 4;
  if (Math.abs(q - t) * len <= snap) t = q;
  const fixed = side === 0 || side === 2 ? 0 : 1;
  return horizontal ? { x: t, y: fixed } : { x: fixed, y: t };
}

/** Radius of a connection arrow and its distance outside the box, SCREEN px. */
export const CONNECT_HANDLE_R = 8;
export const CONNECT_HANDLE_GAP = 16;
/** Radius of a selected relationship's endpoint handle, SCREEN px. */
export const REL_END_R = 5;

/**
 * The four connection arrows a selected freeform item shows (draw.io's blue
 * arrows): centred on each side, just outside it. Dragging one starts a
 * relationship pinned to that side's midpoint. Screen-sized at every zoom.
 */
export function connectHandles(r: Rect, scale: number): { anchor: RelAnchor; x: number; y: number; r: number; dir: Pt }[] {
  const k = 1 / Math.max(0.05, scale);
  const g = CONNECT_HANDLE_GAP * k;
  const rad = CONNECT_HANDLE_R * k;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return [
    { anchor: { x: 0.5, y: 0 }, x: cx, y: r.y - g, r: rad, dir: { x: 0, y: -1 } },
    { anchor: { x: 1, y: 0.5 }, x: r.x + r.w + g, y: cy, r: rad, dir: { x: 1, y: 0 } },
    { anchor: { x: 0.5, y: 1 }, x: cx, y: r.y + r.h + g, r: rad, dir: { x: 0, y: 1 } },
    { anchor: { x: 0, y: 0.5 }, x: r.x - g, y: cy, r: rad, dir: { x: -1, y: 0 } },
  ];
}

/** Drop interior points that sit on a straight run, and duplicates. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) > 1e-6) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/** Orthogonal route: a stub out of each box, then one or two bends. */
export function elbowPoints(p0: Pt, n0: Pt, p3: Pt, n3: Pt, stub = ELBOW_STUB): Pt[] {
  const s = { x: p0.x + n0.x * stub, y: p0.y + n0.y * stub };
  const e = { x: p3.x + n3.x * stub, y: p3.y + n3.y * stub };
  const h0 = n0.x !== 0;
  const h3 = n3.x !== 0;
  let mid: Pt[];
  if (h0 && h3) {
    const mx = (s.x + e.x) / 2;
    mid = [{ x: mx, y: s.y }, { x: mx, y: e.y }];
  } else if (!h0 && !h3) {
    const my = (s.y + e.y) / 2;
    mid = [{ x: s.x, y: my }, { x: e.x, y: my }];
  } else if (h0) {
    mid = [{ x: e.x, y: s.y }];
  } else {
    mid = [{ x: s.x, y: e.y }];
  }
  return simplify([p0, s, ...mid, e, p3]);
}

function polyMid(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (seg >= left && seg > 0) {
      const t = left / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    left -= seg;
  }
  return pts[0];
}

function poly(pts: Pt[], mid?: Pt): RelRoute {
  const n = pts.length;
  return {
    path: { kind: "poly", pts },
    start: { from: pts[1] ?? pts[0], tip: pts[0] },
    end: { from: pts[n - 2] ?? pts[n - 1], tip: pts[n - 1] },
    mid: mid ?? polyMid(pts),
  };
}

const ZERO = (p: Pt): Rect => ({ x: p.x, y: p.y, w: 0, h: 0 });

/**
 * The route of a relationship from box `a` to box `b`. Without anchors and
 * with the curved / straight look this is exactly the drawing every older
 * document had (centre to centre, cut at the borders, label between the
 * centres), so nothing existing moves.
 */
export function relationshipRoute(rel: RelGeometry, a: Rect, b: Rect, obstacles?: Rect[]): RelRoute {
  const connector: ConnectorStyle = rel.connector ?? "curved";
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const centreMid = { x: (ac.x + bc.x) / 2, y: (ac.y + bc.y) / 2 };
  const anchored = !!rel.fromAnchor || !!rel.toAnchor;

  if (connector === "elbow") {
    if (obstacles?.length) return poly(routeAround(rel, a, b, obstacles));
    const fa = rel.fromAnchor ?? facingAnchor(a, rel.toAnchor ? anchorPoint(b, rel.toAnchor) : bc);
    const ta = rel.toAnchor ?? facingAnchor(b, rel.fromAnchor ? anchorPoint(a, rel.fromAnchor) : ac);
    return poly(elbowPoints(anchorPoint(a, fa), anchorNormal(fa), anchorPoint(b, ta), anchorNormal(ta)));
  }

  if (connector === "straight") {
    if (!anchored) {
      const s0 = segmentExitRect(a, b);
      const s1 = segmentExitRect(b, a);
      return poly([s0, s1], centreMid);
    }
    const p0 = rel.fromAnchor ? anchorPoint(a, rel.fromAnchor) : null;
    const p3 = rel.toAnchor ? anchorPoint(b, rel.toAnchor) : null;
    const start = p0 ?? segmentExitRect(a, ZERO(p3!));
    const end = p3 ?? segmentExitRect(b, ZERO(p0!));
    return poly([start, end]);
  }

  if (!anchored) {
    const curve: Bezier3 = {
      p0: ac,
      p1: { x: ac.x + (bc.x - ac.x) * 0.35, y: ac.y },
      p2: { x: bc.x - (bc.x - ac.x) * 0.35, y: bc.y },
      p3: bc,
    };
    const t0 = bezierExitRect(curve, a.x, a.y, a.w, a.h);
    const t1 = bezierEnterRect(curve, b.x, b.y, b.w, b.h);
    const drawn = t1 - t0 > 1e-6 ? bezierSlice(curve, t0, t1) : curve;
    return {
      path: { kind: "curve", b: drawn },
      start: { from: drawn.p1, tip: drawn.p0 },
      end: { from: drawn.p2, tip: drawn.p3 },
      mid: centreMid,
    };
  }

  // Anchored curve: leave each box square to its side, like draw.io's
  // curved edges. A floating end takes the side that faces the other end.
  const fa = rel.fromAnchor ?? facingAnchor(a, anchorPoint(b, rel.toAnchor!));
  const ta = rel.toAnchor ?? facingAnchor(b, anchorPoint(a, rel.fromAnchor!));
  const p0 = anchorPoint(a, fa);
  const p3 = anchorPoint(b, ta);
  const n0 = anchorNormal(fa);
  const n3 = anchorNormal(ta);
  const k = Math.max(24, Math.min(160, Math.hypot(p3.x - p0.x, p3.y - p0.y) * 0.4));
  const curve: Bezier3 = {
    p0,
    p1: { x: p0.x + n0.x * k, y: p0.y + n0.y * k },
    p2: { x: p3.x + n3.x * k, y: p3.y + n3.y * k },
    p3,
  };
  return {
    path: { kind: "curve", b: curve },
    start: { from: curve.p1, tip: p0 },
    end: { from: curve.p2, tip: p3 },
    mid: bezierPoint(curve, 0.5),
  };
}

/** Points along the route, for hit testing and band tests. */
export function routeSamples(route: RelRoute, steps = 32): Pt[] {
  if (route.path.kind === "poly") return route.path.pts;
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(bezierPoint(route.path.b, i / steps));
  return out;
}

/** Distance from `p` to the route, in world units. */
export function routeDistance(route: RelRoute, p: Pt): number {
  const pts = routeSamples(route);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** Vertical extent of the route (a cubic stays inside its control hull). */
export function routeYRange(route: RelRoute): { lo: number; hi: number } {
  const pts = route.path.kind === "poly" ? route.path.pts : [route.path.b.p0, route.path.b.p1, route.path.b.p2, route.path.b.p3];
  return { lo: Math.min(...pts.map((q) => q.y)), hi: Math.max(...pts.map((q) => q.y)) };
}

export type HeadShape =
  | { kind: "poly"; pts: Pt[]; closed: boolean; fill: boolean }
  | { kind: "circle"; c: Pt; r: number };

/**
 * The outline of one head, tip at `tip`, pointing along `from → tip`. The
 * triangle is the historical head point for point (ARROW_HALF_ANGLE spread).
 */
export function headShape(head: ArrowHead, from: Pt, tip: Pt, len: number): HeadShape | null {
  if (head === "none") return null;
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const wing = (sign: number): Pt => ({
    x: tip.x - len * Math.cos(ang + sign * ARROW_HALF_ANGLE),
    y: tip.y - len * Math.sin(ang + sign * ARROW_HALF_ANGLE),
  });
  if (head === "triangle") return { kind: "poly", pts: [tip, wing(-1), wing(1)], closed: true, fill: true };
  if (head === "open") return { kind: "poly", pts: [wing(-1), tip, wing(1)], closed: false, fill: false };
  if (head === "circle") {
    const r = len * 0.45;
    return { kind: "circle", c: { x: tip.x - dx * r, y: tip.y - dy * r }, r };
  }
  // diamond
  const half = len * 0.45;
  const m = { x: tip.x - dx * len, y: tip.y - dy * len };
  return {
    kind: "poly",
    pts: [tip, { x: m.x - dy * half, y: m.y + dx * half }, { x: tip.x - dx * len * 2, y: tip.y - dy * len * 2 }, { x: m.x + dy * half, y: m.y - dx * half }],
    closed: true,
    fill: true,
  };
}

// ---------------------------------------------------------------------------
// Obstacle-avoiding elbow routes (draw.io's orthogonal edges)
// ---------------------------------------------------------------------------

const SIDES: RelAnchor[] = [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }];
/** Clearance kept from a box an elbow line goes around. */
const CLEAR = 12;
const routeCache = new Map<string, Pt[]>();

/** Does the segment p→q (horizontal or vertical) pass through the inside of r? */
function cutsRect(p: Pt, q: Pt, r: Rect): boolean {
  const pad = 2; // touching an edge is not crossing it
  const x0 = r.x + pad, x1 = r.x + r.w - pad, y0 = r.y + pad, y1 = r.y + r.h - pad;
  if (x1 <= x0 || y1 <= y0) return false;
  if (Math.abs(p.y - q.y) < 1e-6) {
    const lo = Math.min(p.x, q.x), hi = Math.max(p.x, q.x);
    return p.y > y0 && p.y < y1 && hi > x0 && lo < x1;
  }
  if (Math.abs(p.x - q.x) < 1e-6) {
    const lo = Math.min(p.y, q.y), hi = Math.max(p.y, q.y);
    return p.x > x0 && p.x < x1 && hi > y0 && lo < y1;
  }
  // Not axis-aligned: test a few samples (only the stub corners can be).
  for (let t = 0.1; t < 1; t += 0.2) {
    const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
    if (x > x0 && x < x1 && y > y0 && y < y1) return true;
  }
  return false;
}

function cost(pts: Pt[], obstacles: Rect[]): number {
  let hits = 0, len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    for (const r of obstacles) if (cutsRect(pts[i - 1], pts[i], r)) hits++;
  }
  return hits * 100000 + len + (pts.length - 2) * 30;
}

/**
 * The best orthogonal route from a to b among: every side each end may leave
 * from (a pinned end keeps its side), with the middle leg at its natural
 * place or moved just past an obstacle. Crossing fewer boxes wins, then
 * shorter, then fewer bends. Cached by its inputs: redraws cost nothing.
 */
function routeAround(rel: RelGeometry, a: Rect, b: Rect, all: Rect[]): Pt[] {
  const near = all.filter((r) => {
    const minX = Math.min(a.x, b.x) - 200, maxX = Math.max(a.x + a.w, b.x + b.w) + 200;
    const minY = Math.min(a.y, b.y) - 200, maxY = Math.max(a.y + a.h, b.y + b.h) + 200;
    return r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY;
  });
  const key = JSON.stringify([rel.fromAnchor, rel.toAnchor, a, b, near]);
  const hit = routeCache.get(key);
  if (hit) return hit;
  const froms = rel.fromAnchor ? [rel.fromAnchor] : SIDES;
  const tos = rel.toAnchor ? [rel.toAnchor] : SIDES;
  let best: Pt[] | null = null, bestCost = Infinity;
  for (const fa of froms) {
    for (const ta of tos) {
      const p0 = anchorPoint(a, fa), p3 = anchorPoint(b, ta);
      const n0 = anchorNormal(fa), n3 = anchorNormal(ta);
      const base = elbowPoints(p0, n0, p3, n3);
      const candidates: Pt[][] = [base];
      const s = { x: p0.x + n0.x * ELBOW_STUB, y: p0.y + n0.y * ELBOW_STUB };
      const e = { x: p3.x + n3.x * ELBOW_STUB, y: p3.y + n3.y * ELBOW_STUB };
      // The middle leg moved past each nearby box (and past the ends' boxes).
      const h0 = n0.x !== 0, h3 = n3.x !== 0;
      const xs = [...near, a, b].flatMap((r) => [r.x - CLEAR, r.x + r.w + CLEAR]);
      const ys = [...near, a, b].flatMap((r) => [r.y - CLEAR, r.y + r.h + CLEAR]);
      if (h0 && h3) for (const mx of xs) candidates.push(simplify([p0, s, { x: mx, y: s.y }, { x: mx, y: e.y }, e, p3]));
      else if (!h0 && !h3) for (const my of ys) candidates.push(simplify([p0, s, { x: s.x, y: my }, { x: e.x, y: my }, e, p3]));
      // Three legs with a detour: out, across past a box, back.
      if (h0 && h3) for (const my of ys) candidates.push(simplify([p0, s, { x: s.x, y: my }, { x: e.x, y: my }, e, p3]));
      else if (!h0 && !h3) for (const mx of xs) candidates.push(simplify([p0, s, { x: mx, y: s.y }, { x: mx, y: e.y }, e, p3]));
      for (const c of candidates) {
        // A route may not run back through its own end boxes.
        const own = [a, b].some((r) => c.slice(1, -1).some((pt, i, arr) => i > 0 && cutsRect(arr[i - 1], pt, r)));
        const k = cost(c, near) + (own ? 50000 : 0);
        if (k < bestCost) { bestCost = k; best = c; }
      }
    }
  }
  const out = best ?? elbowPoints(anchorPoint(a, SIDES[1]), anchorNormal(SIDES[1]), anchorPoint(b, SIDES[3]), anchorNormal(SIDES[3]));
  if (routeCache.size > 2000) routeCache.clear();
  routeCache.set(key, out);
  return out;
}

/**
 * The boxes an elbow arrow should go around: the other items of the canvas
 * its ends live in. Canvases, containers and frames are backgrounds (an arrow
 * crosses them freely), and so are the ends themselves and what holds them.
 */
export function routeObstacles(
  sheet: Sheet,
  placed: readonly { node: MindNode; x: number; y: number; w: number; h: number }[],
  rel: Pick<Relationship, "fromId" | "toId">,
): Rect[] {
  const owner = freeformOwner(sheet, rel.fromId);
  if (!owner || freeformOwner(sheet, rel.toId) === null) return [];
  const holders = new Set<string>();
  for (const id of [rel.fromId, rel.toId]) {
    let p = sheet.nodes[id]?.parentId;
    while (p) { holders.add(p); p = sheet.nodes[p]?.parentId ?? null; }
  }
  const out: Rect[] = [];
  for (const p of placed) {
    const n = p.node;
    if (n.id === rel.fromId || n.id === rel.toId || holders.has(n.id) || n.style.freeform || n.style.frame) continue;
    if (!freeformOwner(sheet, n.id)) continue;
    out.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  }
  return out;
}
