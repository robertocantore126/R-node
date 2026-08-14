/**
 * R-node — custom shape artwork (T24): validation and paint resolution.
 *
 * Pure and canvas-free so it can be tested without a DOM, and so the SVG export
 * and the renderer resolve a paint the same way. What arrives here is an LLM's
 * output on its way into a document: everything is checked, nothing is trusted.
 */

import type { ShapePaint, ShapePart, Style } from "./types";

export const MAX_PARTS = 12;
/** Floor for the label's box, as a fraction of the shape. Below this the text
 *  wraps to one letter per line and the shape is unusable as a topic. */
export const MIN_TEXTBOX_W = 0.22;
export const MIN_TEXTBOX_H = 0.16;
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

/** The box must sit in the unit square. Whether it sits inside the SILHOUETTE
 *  needs a canvas, and is checked separately by `textBoxFitsSilhouette`. */
export function validateTextBox(raw: unknown): TextBox {
  const b = raw as Partial<TextBox> | undefined;
  if (!b || typeof b !== "object") throw new ShapeArtInvalid('A shape needs a "textBox".');
  const nums = [b.x, b.y, b.w, b.h];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new ShapeArtInvalid('"textBox" needs numeric x, y, w and h.');
  }
  const { x, y, w, h } = b as TextBox;
  if (w <= 0 || h <= 0) throw new ShapeArtInvalid('"textBox" has no area.');
  if (x < 0 || y < 0 || x + w > 1 || y + h > 1) {
    throw new ShapeArtInvalid('"textBox" pokes outside the 0..1 box the shape is drawn in.');
  }
  // A box can sit inside the silhouette and still be useless: 0.15 x 0.14 of a
  // 220px node is 33 x 31 px, which wraps a label one letter per line. Asked
  // for "a rectangle inside the shape" a model answers with a cautious one, so
  // the floor is what makes it look for the LARGEST rectangle instead.
  if (w < MIN_TEXTBOX_W || h < MIN_TEXTBOX_H) {
    throw new ShapeArtInvalid(
      `"textBox" is too small to hold a label (${w.toFixed(2)} x ${h.toFixed(2)}; the minimum is ${MIN_TEXTBOX_W} x ${MIN_TEXTBOX_H}). Find the LARGEST rectangle that fits inside the shape, not the first one that does.`,
    );
  }
  return { x, y, w, h };
}

/**
 * Whether the label's box is really inside the shape, sampled at its corners
 * and centre against the FIRST part — the silhouette.
 *
 * This is the rule an LLM breaks most often: it reasons about the extremes of
 * the outline and proposes a rectangle that fits the bounding box rather than
 * the drawing. Checking it needs `Path2D`, so the caller passes a probe; in a
 * DOM-less test the check is simply skipped rather than faked.
 */
export function textBoxFitsSilhouette(parts: ShapePart[], box: TextBox, probe: (d: string, x: number, y: number, rule: CanvasFillRule) => boolean): boolean {
  const first = parts[0];
  if (!first) return false;
  const rule = first.rule ?? "nonzero";
  const xs = [box.x, box.x + box.w / 2, box.x + box.w];
  const ys = [box.y, box.y + box.h / 2, box.y + box.h];
  const pts: Array<[number, number]> = [
    [xs[0], ys[0]], [xs[2], ys[0]], [xs[0], ys[2]], [xs[2], ys[2]], [xs[1], ys[1]],
  ];
  // Nudge the corners a hair inwards: a box that touches the outline exactly is
  // fine, and floating point on a curve should not decide a refusal.
  const eps = 0.004;
  return pts.every(([px, py]) => {
    const cx = Math.min(Math.max(px, box.x + eps), box.x + box.w - eps);
    const cy = Math.min(Math.max(py, box.y + eps), box.y + box.h - eps);
    return probe(first.d, cx, cy, rule);
  });
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
