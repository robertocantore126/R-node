/**
 * R-node — custom shape artwork (T24): validation and paint resolution.
 *
 * Pure and canvas-free so it can be tested without a DOM, and so the SVG export
 * and the renderer resolve a paint the same way. What arrives here is an LLM's
 * output on its way into a document: everything is checked, nothing is trusted.
 */

import type { ShapePaint, ShapePart, Style } from "./types";

export const MAX_PARTS = 12;
/**
 * Floor for the label's square, as a fraction of the shape's size. On a 220px
 * node 0.18 is 40px — around five characters a line, cramped but readable.
 *
 * Calibrated against a real drawing rather than chosen: the largest square
 * inside a hand-drawn crescent measured 0.203, so a higher floor would reject
 * ordinary concave shapes. An earlier 0.22 came from a RECTANGLE that fit the
 * same crescent — squares cost width, which is the price of the simpler rule.
 */
export const MIN_TEXTBOX_SIDE = 0.18;
export const MAX_PART_CHARS = 4000;
export const MAX_TOTAL_CHARS = 12000;

/** Commands, digits, separators, signs, exponents — and nothing else. A path is
 *  data, never code, but a path full of junk is still a path full of junk. */
const PATH_RE = /^[MLHVCSQTAZmlhvcsqtaz0-9\s,.+-eE]*$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const TOKENS = new Set(["accent", "surface", "text", "muted"]);

export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ShapeArtInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapeArtInvalid";
  }
}

function checkPaint(value: unknown, where: string): ShapePaint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ShapeArtInvalid(`${where} must be a colour or a theme token.`);
  if (TOKENS.has(value) || HEX_RE.test(value)) return value;
  throw new ShapeArtInvalid(`${where}: "${value}" is neither a #hex colour nor one of accent, surface, text, muted.`);
}

/** Throws `ShapeArtInvalid` with a message meant for the person pasting. */
export function validateShapeParts(raw: unknown): ShapePart[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ShapeArtInvalid('A shape needs a non-empty "parts" array.');
  }
  if (raw.length > MAX_PARTS) {
    throw new ShapeArtInvalid(`Too many parts: ${raw.length}, the limit is ${MAX_PARTS}. This is an icon, not a traced photograph.`);
  }
  let total = 0;
  const out: ShapePart[] = [];
  raw.forEach((p, i) => {
    const at = `Part ${i + 1}`;
    if (!p || typeof p !== "object") throw new ShapeArtInvalid(`${at} is not an object.`);
    const part = p as Record<string, unknown>;
    const d = part.d;
    if (typeof d !== "string" || d.trim() === "") throw new ShapeArtInvalid(`${at} has no path data.`);
    if (d.length > MAX_PART_CHARS) throw new ShapeArtInvalid(`${at} is ${d.length} characters, the limit is ${MAX_PART_CHARS}.`);
    if (!PATH_RE.test(d)) throw new ShapeArtInvalid(`${at} contains something that is not SVG path data.`);
    if (!/[Mm]/.test(d)) throw new ShapeArtInvalid(`${at} never starts a subpath — a path begins with M.`);
    if (/NaN|Infinity/.test(d)) throw new ShapeArtInvalid(`${at} contains a coordinate that is not a number.`);
    total += d.length;
    if (total > MAX_TOTAL_CHARS) throw new ShapeArtInvalid(`The parts together exceed ${MAX_TOTAL_CHARS} characters.`);
    const rule = part.rule;
    if (rule !== undefined && rule !== "nonzero" && rule !== "evenodd") {
      throw new ShapeArtInvalid(`${at}: "rule" must be "nonzero" or "evenodd".`);
    }
    const sw = part.strokeWidth;
    if (sw !== undefined && (typeof sw !== "number" || !Number.isFinite(sw) || sw < 0 || sw > 1)) {
      throw new ShapeArtInvalid(`${at}: "strokeWidth" is in the same 0..1 units as the path.`);
    }
    out.push({
      d,
      fill: checkPaint(part.fill, `${at} fill`),
      stroke: checkPaint(part.stroke, `${at} stroke`),
      strokeWidth: sw as number | undefined,
      rule: rule as ShapePart["rule"],
    });
  });
  return out;
}

/**
 * The largest SQUARE centred on the drawing that fits inside it.
 *
 * Derived, never authored. Asked to supply a text box an LLM gets it wrong in
 * both directions — a rectangle in the hollow of a crescent, then a cautious
 * 0.15 x 0.14 that wrapped the label one letter per line — and neither mistake
 * is one it can see. The shape is the only thing it should be drawing.
 *
 * "Centred" means the CENTROID OF THE FILLED AREA, not the middle of the
 * bounding box: for a crescent those are different points, and the second one
 * is in the hole. The centroid lands in the belly, which is where a label goes.
 *
 * `probe` answers "is this point painted?" — injected so the geometry can be
 * tested without a canvas, and so a DOM-less environment degrades to the
 * fallback instead of pretending.
 */
export function computeTextBox(parts: ShapePart[], probe: (d: string, x: number, y: number, rule: CanvasFillRule) => boolean): TextBox | null {
  const first = parts[0];
  if (!first) return null;
  const rule = first.rule ?? "nonzero";
  const inside = (x: number, y: number): boolean => probe(first.d, x, y, rule);

  // Sample the drawing once onto a grid, then find the largest all-inside
  // square by the standard dynamic programme: the biggest square ending at a
  // cell is one more than the smallest of its three neighbours. O(N²) probes
  // and O(N²) work, against the millions a per-point search would cost.
  const N = 64;
  const on: boolean[] = new Array(N * N);
  let hits = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = inside((i + 0.5) / N, (j + 0.5) / N);
      on[j * N + i] = v;
      if (v) hits++;
    }
  }
  if (hits === 0) return null;

  const dp: number[] = new Array(N * N).fill(0);
  let best = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!on[j * N + i]) continue;
      const v = i === 0 || j === 0 ? 1 : 1 + Math.min(dp[(j - 1) * N + i], dp[j * N + i - 1], dp[(j - 1) * N + i - 1]);
      dp[j * N + i] = v;
      if (v > best) best = v;
    }
  }
  if (best === 0) return null;

  // Several placements usually tie at the maximum — a wide shape holds the same
  // square anywhere along it. Taking the first one found puts the label against
  // the left edge of a symmetric drawing, so the tie breaks toward the centroid,
  // which is where a label looks like it belongs.
  //
  // The centroid does NOT decide the SIZE, only which of the equal-best squares
  // wins. Centring the square on it was the first attempt and it is wrong: on a
  // crescent the centroid sits near the inner edge, and a square centred there
  // measured 0.128 against the 0.22 that fits further into the belly.
  let cxSum = 0;
  let cySum = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (on[j * N + i]) {
        cxSum += i;
        cySum += j;
      }
    }
  }
  const cx = cxSum / hits;
  const cy = cySum / hits;
  let bestI = 0;
  let bestJ = 0;
  let bestD = Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (dp[j * N + i] !== best) continue;
      const sqCx = i + 0.5 - best / 2;
      const sqCy = j + 0.5 - best / 2;
      const d = (sqCx - cx) ** 2 + (sqCy - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }

  // Measured between cell CENTRES, not cell edges: only the centres were
  // sampled, so a box drawn to the edges can overhang the outline by half a
  // cell — which showed up as a corner landing outside the silhouette.
  const x0 = (bestI + 1 - best + 0.5) / N;
  const y0 = (bestJ + 1 - best + 0.5) / N;
  const side = (best - 1) / N;
  if (side <= 0) return null;
  return { x: x0, y: y0, w: side, h: side };
}

/** Build a probe backed by a real canvas, or null where there is no DOM. */
export function makeSilhouetteProbe(): ((d: string, x: number, y: number, rule: CanvasFillRule) => boolean) | null {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const cache = new Map<string, Path2D>();
  // Sampled in a 1000x1000 space: isPointInPath works in device pixels, and a
  // unit square would put every sample inside the same one.
  const S = 1000;
  return (d, x, y, rule) => {
    let p = cache.get(d);
    if (!p) {
      p = new Path2D();
      p.addPath(new Path2D(d), new DOMMatrix().scaleNonUniform(S, S));
      cache.set(d, p);
    }
    return ctx.isPointInPath(p, x * S, y * S, rule);
  };
}

/**
 * Resolve a part's paint. A token follows the palette; a hex is the drawing's
 * own colour and passes straight through.
 *
 * The four token names are the vocabulary the prompt teaches an LLM, mapped
 * here onto what a `RenderTheme` actually carries — the alternative was making
 * the prompt name internal fields like `selection`, which would tie a saved
 * shape to this app's theme structure.
 */
export function resolvePaint(
  paint: ShapePaint | undefined,
  theme: { selection: string; background: string; text: string; textMuted: string },
  fallback: string,
): string {
  if (!paint) return fallback;
  switch (paint) {
    case "accent":
      return theme.selection;
    case "surface":
      return theme.background;
    case "text":
      return theme.text;
    case "muted":
      return theme.textMuted;
    default:
      return paint;
  }
}

/** The insets a shape's text box implies, in world units — the same shape the
 *  image slots produce, so both go through `textInsets` and cannot disagree. */
export function shapeTextInsets(style: Style, w: number, h: number): { top: number; bottom: number; left: number; right: number } | null {
  const b = style.shapeTextBox;
  if (!b) return null;
  return {
    left: b.x * w,
    right: (1 - (b.x + b.w)) * w,
    top: b.y * h,
    bottom: (1 - (b.y + b.h)) * h,
  };
}
