export interface RibbonBezier {
  x0: number;
  y0: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x1: number;
  y1: number;
}

export interface ConnectorRibbon {
  forward: RibbonBezier;
  backward: RibbonBezier;
  w0: number;
  w1: number;
}

export function taperWidthsForDepth(depth: number): [number, number] {
  if (depth <= 1) return [7, 3];
  if (depth === 2) return [3.2, 1.6];
  if (depth === 3) return [2, 1.2];
  return [1.6, 1];
}

/**
 * Compute the two cubic Beziers forming a tapered branch ribbon.
 *
 * Each edge is the curve offset along its NORMAL (Tiller-Hanson: offset the
 * three legs of the control polygon and intersect them). Offsetting only in
 * Y — as this did first — gives a ribbon of the right width where the curve
 * runs flat, but on a steep middle leg the true width is h·cos(angle): with
 * short level gaps and tall columns the ribbon pinched into two hairlines.
 * `vertical` is kept for callers; the normal handles both orientations.
 */
export function connectorRibbon(
  sx: number,
  sy: number,
  cp1x: number,
  cp1y: number,
  cp2x: number,
  cp2y: number,
  ex: number,
  ey: number,
  depth: number,
  vertical: boolean
): ConnectorRibbon {
  const [w0, w1] = taperWidthsForDepth(depth);
  const h0 = w0 * 0.5;
  const h1 = w1 * 0.5;
  const hm = (h0 + h1) / 2;
  const P: Pt[] = [{ x: sx, y: sy }, { x: cp1x, y: cp1y }, { x: cp2x, y: cp2y }, { x: ex, y: ey }];
  // Leg normals. A zero-length leg (control point on its end point) borrows
  // the chord's direction, or the orientation's default when that is zero too.
  const chord = unit(ex - sx, ey - sy) ?? (vertical ? { x: 0, y: 1 } : { x: 1, y: 0 });
  const t01 = unit(P[1].x - P[0].x, P[1].y - P[0].y) ?? chord;
  const t12 = unit(P[2].x - P[1].x, P[2].y - P[1].y) ?? chord;
  const t23 = unit(P[3].x - P[2].x, P[3].y - P[2].y) ?? chord;
  const edge = (sign: 1 | -1): Pt[] => {
    const n01 = normal(t01, sign * h0);
    const n12 = normal(t12, sign * hm);
    const n23 = normal(t23, sign * h1);
    const a0 = { x: P[0].x + n01.x, y: P[0].y + n01.y };
    const a3 = { x: P[3].x + n23.x, y: P[3].y + n23.y };
    const a1 = meet({ x: P[1].x + n01.x, y: P[1].y + n01.y }, t01, { x: P[1].x + n12.x, y: P[1].y + n12.y }, t12, P[1], sign * hm);
    const a2 = meet({ x: P[2].x + n12.x, y: P[2].y + n12.y }, t12, { x: P[2].x + n23.x, y: P[2].y + n23.y }, t23, P[2], sign * hm);
    return [a0, a1, a2, a3];
  };
  const [f0, f1, f2, f3] = edge(1);
  const [g0, g1, g2, g3] = edge(-1);
  return {
    w0,
    w1,
    forward: { x0: f0.x, y0: f0.y, cp1x: f1.x, cp1y: f1.y, cp2x: f2.x, cp2y: f2.y, x1: f3.x, y1: f3.y },
    backward: { x0: g3.x, y0: g3.y, cp1x: g2.x, cp1y: g2.y, cp2x: g1.x, cp2y: g1.y, x1: g0.x, y1: g0.y },
  };
}

interface Pt {
  x: number;
  y: number;
}

function unit(x: number, y: number): Pt | null {
  const l = Math.hypot(x, y);
  return l < 1e-6 ? null : { x: x / l, y: y / l };
}

/** The left-hand normal of `t`, scaled by `h` (negative = the other side). */
function normal(t: Pt, h: number): Pt {
  return { x: t.y * h, y: -t.x * h };
}

/**
 * Where the offset line through `a` (direction `da`) meets the one through
 * `b` (direction `db`). Parallel or near-parallel legs — a straight connector,
 * or a corner so sharp the lines meet far away — fall back to offsetting the
 * control point itself along the averaged normal.
 */
function meet(a: Pt, da: Pt, b: Pt, db: Pt, ctrl: Pt, h: number): Pt {
  const cross = da.x * db.y - da.y * db.x;
  const fallback = (): Pt => {
    const m = unit(da.x + db.x, da.y + db.y) ?? da;
    const n = normal(m, h);
    return { x: ctrl.x + n.x, y: ctrl.y + n.y };
  };
  if (Math.abs(cross) < 1e-6) return fallback();
  const s = ((b.x - a.x) * db.y - (b.y - a.y) * db.x) / cross;
  const p = { x: a.x + da.x * s, y: a.y + da.y * s };
  return Math.hypot(p.x - ctrl.x, p.y - ctrl.y) > 4 * Math.abs(h) + 1e-6 ? fallback() : p;
}
