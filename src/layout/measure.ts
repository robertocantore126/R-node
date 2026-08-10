/**
 * Topic measurement — the single source of truth for extents.
 *
 * Observable layout behavior (see docs/ARCHITECTURE.md, "Layout behavior"):
 * every topic has an extent computed from text width/height, padding, shape
 * and border; a two-line title makes the topic taller; that size change
 * ripples through the subtree and the whole branch.
 *
 * To make that real, layout and rendering must AGREE on sizes. Both use the
 * same `measureTopic` with the same `TextMeasurer`:
 *  - the renderer injects a canvas-backed measurer (real `measureText`);
 *  - pure layout code and tests default to a deterministic heuristic.
 */
import type { MindNode, Style } from "../core/types";

// ---------------------------------------------------------------------------
// Text measurer
// ---------------------------------------------------------------------------

export interface TextMetricsInput {
  fontSize: number;
  fontFamily?: string;
  fontWeight?: number;
  italic?: boolean;
}

export interface TextMeasurer {
  measure(text: string, style: TextMetricsInput): { width: number };
}

/** Deterministic fallback (no DOM): ~0.55 × fontSize per char. */
export const HEURISTIC_MEASURER: TextMeasurer = {
  measure: (t, s) => ({ width: t.length * (s.fontSize * 0.55) }),
};

let sharedCanvasMeasurer: TextMeasurer | null = null;

/** Canvas-backed measurer (real text metrics). Falls back to heuristic in Node. */
export function createCanvasTextMeasurer(): TextMeasurer {
  if (typeof document === "undefined") return HEURISTIC_MEASURER;
  if (sharedCanvasMeasurer) return sharedCanvasMeasurer;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return HEURISTIC_MEASURER;
  const cache = new Map<string, number>();
  sharedCanvasMeasurer = {
    measure(text, s) {
      const key = `${s.fontWeight ?? 400}|${s.italic ? 1 : 0}|${s.fontSize}|${s.fontFamily ?? "system-ui"}|${text}`;
      const hit = cache.get(key);
      if (hit !== undefined) return { width: hit };
      ctx.font = `${s.italic ? "italic " : ""}${s.fontWeight ?? 400} ${s.fontSize}px ${s.fontFamily ?? "system-ui, -apple-system, sans-serif"}`;
      const width = ctx.measureText(text).width;
      if (cache.size > 20_000) cache.clear();
      cache.set(key, width);
      return { width };
    },
  };
  return sharedCanvasMeasurer;
}

// ---------------------------------------------------------------------------
// Wrapping (shared by layout and renderer so line counts always agree)
// ---------------------------------------------------------------------------

export const TEXT_INSET = 6; // horizontal inset inside the topic box (both sides)
export const LINE_HEIGHT_FACTOR = 1.25;
export const MIN_TOPIC_W = 84;
export const MAX_TOPIC_W = 280;

export function wrapLines(text: string, maxW: number, measurer: TextMeasurer, style: Style): string[] {
  const fontSize = style.fontSize ?? 14;
  const m = (t: string): number => measurer.measure(t, { fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, italic: style.italic }).width;
  const rawLines = text.split("\n");
  const out: string[] = [];
  for (const raw of rawLines) {
    if (m(raw) <= maxW || maxW <= 20) {
      out.push(raw);
      continue;
    }
    const words = raw.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (m(candidate) <= maxW || !line) line = candidate;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

// ---------------------------------------------------------------------------
// Extent
// ---------------------------------------------------------------------------

export interface Extent {
  w: number;
  h: number;
}

/**
 * Observable model:
 *   width(topic)  = width(text, wrapped) + paddingLeft + paddingRight + shapeAllowance
 *   height(topic) = height(lines)        + paddingTop  + paddingBottom  + shapeAllowance
 * Explicit style.width/height overrides win; images/notes are added in Phase 2+.
 */
export function measureTopic(n: MindNode, measurer: TextMeasurer = HEURISTIC_MEASURER): Extent {
  const style = n.style;
  if (style.width && style.height) return { w: style.width, h: style.height };

  const fontSize = style.fontSize ?? 14;
  const pad = style.padding ?? 10;
  const maxW = style.width ?? MAX_TOPIC_W;
  const textW = Math.max(24, maxW - pad * 2 - TEXT_INSET);
  const lines = wrapLines(n.title, textW, measurer, style);
  const m = (t: string): number => measurer.measure(t, { fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, italic: style.italic }).width;
  const maxLineW = lines.reduce((acc, l) => Math.max(acc, m(l)), 0);

  let w = style.width ?? Math.min(MAX_TOPIC_W, Math.max(MIN_TOPIC_W, Math.ceil(maxLineW) + pad * 2 + TEXT_INSET));
  let h = style.height ?? Math.max(28, lines.length * fontSize * LINE_HEIGHT_FACTOR + pad * 2 + 4);

  const shape = style.shape ?? "rounded";
  if (shape === "circle") {
    const d = Math.max(w, h);
    return { w: d, h: d };
  }
  if (shape === "diamond") {
    w += fontSize;
    h += fontSize;
  } else if (shape === "hexagon") {
    w += 14;
    h += 10;
  }
  return { w, h };
}

export function measureNode(n: MindNode, measurer?: TextMeasurer): Extent {
  return measureTopic(n, measurer);
}
