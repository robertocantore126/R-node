/**
 * Topic measurement — the single source of truth for extents.
 *
 * Observable layout behavior (see docs/ARCHITECTURE.md, "Layout behavior"):
 * every topic has an extent computed from text width/height, padding, shape
 * and border; a two-line title makes the topic taller; that size change
 * ripples through the subtree and the whole branch.
 *
 * Titles are rich text: a sequence of TextRuns where each run may carry its
 * own bold/italic/color. Wrapping and extent computation walk the runs so a
 * bold run really is wider, and the box always contains the styled text.
 *
 * Layout and rendering AGREE on sizes — both use `measureTopic` with the
 * same `TextMeasurer`:
 *  - the renderer injects a canvas-backed measurer (real `measureText`);
 *  - pure layout code and tests default to a deterministic heuristic.
 */
import type { MindNode, Style, TextRun } from "../core/types";
import { nodeRuns } from "../core/text";

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
/**
 * Block gap shared by BOTH renderers (single source of truth): every block
 * boundary (paragraph end, list item end) advances by this fraction of the
 * line height. The Lexical overlay mirrors it via --rnode-block-gap
 * (calc(BLOCK_GAP_FACTOR * LINE_HEIGHT_FACTOR em)) so the editor and the
 * canvas keep the same vertical rhythm.
 */
export const BLOCK_GAP_FACTOR = 0.6;
export const MIN_TOPIC_W = 84;
export const MAX_TOPIC_W = 280;

/** One wrapped line of rich text: segments reference their source run. */
export interface TextRunLine {
  segments: { text: string; run: TextRun }[];
  width: number;
  /** Line height in px (tallest run on the line). */
  height?: number;
  /** Horizontal offset for continuation lines of a bullet item (hanging indent). */
  indent?: number;
  /** Extra vertical gap before this line (paragraph boundary). */
  gapBefore?: boolean;
}

/** Bullet marker + indent prefix for a list item at `depth` (1 = top level). */
export function listGlyph(depth: number): string {
  if (depth <= 1) return "•  ";
  if (depth === 2) return "  ◦  ";
  return "  ".repeat(depth - 1) + "•  ";
}

function runMetrics(run: TextRun, style: Style): TextMetricsInput {
  return {
    fontSize: run.fontSize ?? style.fontSize ?? 14,
    fontFamily: style.fontFamily,
    fontWeight: run.bold ? 700 : style.fontWeight,
    italic: (run.italic ?? false) || (style.italic ?? false),
  };
}

/**
 * Wrap rich text across runs at `maxW`, breaking only on whitespace.
 * A word may span runs (bold "he" + plain "llo" stays one token) so emphasis
 * never splits mid-word. Trailing whitespace is collapsed at line breaks.
 *
 * Block semantics:
 *  - a run with `paraGap` marks a paragraph boundary: its paragraph gets an
 *    extra vertical gap (gapBefore on the first line);
 *  - a run with `listIndent` starts a bullet item: the paragraph's first line
 *    carries the bullet glyph, continuation lines hang-indent under it;
 *  - each line's height is the tallest run on that line (per-run fontSize).
 */
export function wrapRunLines(runs: TextRun[], maxW: number, measurer: TextMeasurer, style: Style): TextRunLine[] {
  const widthOf = (text: string, run: TextRun): number => measurer.measure(text, runMetrics(run, style)).width;

  // 1) Split the run stream into paragraphs at literal \n (each paragraph is
  //    a segment list that may span multiple runs — emphasis survives a break).
  const paragraphs: { text: string; run: TextRun; paraGap: boolean }[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) paragraphs.push([]);
      if (parts[i].length > 0) {
        // only the first segment of the run carries the paragraph-gap flag
        paragraphs[paragraphs.length - 1].push({ text: parts[i], run, paraGap: i === 0 && !!run.paraGap });
      }
    }
  }

  const out: TextRunLine[] = [];
  let emittedParas = 0;
  for (const para of paragraphs) {
    // Bullet metadata for this paragraph (first listIndent run wins).
    let bulletRun: TextRun | null = null;
    for (const seg of para) if (seg.run.listIndent) { bulletRun = seg.run; break; }
    const glyph = bulletRun ? listGlyph(bulletRun.listIndent!) : null;
    const glyphW = glyph && bulletRun ? widthOf(glyph, bulletRun) : 0;
    // Block boundary → fixed gap. A paragraph flagged paraGap OR a list item
    // (bulletRun) starts a new block; the very first block of the topic has
    // no leading gap. The overlay applies the same rule with --rnode-block-gap.
    const gapBefore = (para.length > 0 && (para[0].paraGap || !!bulletRun)) && emittedParas > 0;

    // 2) Tokenize the paragraph into whitespace-separated fragments (whitespace
    //    kept). A word may span runs (bold "he" + plain "llo" stays one token)
    //    so emphasis never splits mid-word.
    const tokens: { text: string; run: TextRun }[] = [];
    for (const seg of para) {
      for (const part of seg.text.split(/(\s+)/)) {
        if (part.length > 0) tokens.push({ text: part, run: seg.run });
      }
    }

    const startOutLen = out.length;
    let line: { text: string; run: TextRun }[] = [];
    let lineWidth = 0;
    let firstLine = true; // the glyph lives on the first line only
    let lineMaxSize = 0;
    const push = (): void => {
      if (line.length === 0) return;
      const height = Math.max(1, lineMaxSize) * LINE_HEIGHT_FACTOR;
      const indent = glyph ? (firstLine ? 0 : glyphW) : 0;
      out.push({ segments: line, width: lineWidth, height, indent, gapBefore: gapBefore && firstLine });
      line = [];
      lineWidth = 0;
      lineMaxSize = 0;
      firstLine = false;
    };

    for (const tok of tokens) {
      const isSpace = /^\s+$/.test(tok.text);
      if (isSpace) {
        if (line.length > 0) {
          line.push(tok);
          lineWidth += widthOf(tok.text, tok.run);
        }
        continue; // leading/collapsed whitespace skipped
      }
      const w = widthOf(tok.text, tok.run);
      const budget = firstLine && glyph ? maxW - glyphW : maxW;
      if (line.length > 0 && lineWidth + w > budget) push();
      if (glyph && firstLine && line.length === 0) {
        // prepend the bullet marker to the first line
        line.push({ text: glyph, run: bulletRun! });
        lineWidth += glyphW;
        lineMaxSize = Math.max(lineMaxSize, bulletRun!.fontSize ?? style.fontSize ?? 14);
      }
      line.push(tok);
      lineWidth += w;
      lineMaxSize = Math.max(lineMaxSize, tok.run.fontSize ?? style.fontSize ?? 14);
    }
    push();
    if (out.length > startOutLen) emittedParas++;
  }
  if (out.length === 0) out.push({ segments: [], width: 0, height: (style.fontSize ?? 14) * LINE_HEIGHT_FACTOR });
  return out;
}

/**
 * String-based wrapping (legacy consumers). Runs collapse to plain text and
 * measure with the base style.
 */
export function wrapLines(text: string, maxW: number, measurer: TextMeasurer, style: Style): string[] {
  return wrapRunLines([{ text }], maxW, measurer, style).map((l) => l.segments.map((s) => s.text).join("").trimEnd());
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
  // An explicit width fixes the box and re-wraps the text at it (Xmind-style
  // resize); the height always follows the wrapped content.
  const maxW = style.width ? Math.max(MIN_TOPIC_W, style.width) : MAX_TOPIC_W;
  const textW = Math.max(24, maxW - pad * 2 - TEXT_INSET);
  const runs = nodeRuns(n.title, n.titleRuns);
  const lines = wrapRunLines(runs, textW, measurer, style);
  const maxLineW = lines.reduce((acc, l) => Math.max(acc, l.width), 0);

  let w = style.width ? Math.max(MIN_TOPIC_W, style.width) : Math.min(MAX_TOPIC_W, Math.max(MIN_TOPIC_W, Math.ceil(maxLineW) + pad * 2 + TEXT_INSET));
  let h = style.height ?? Math.max(28, lines.reduce((acc, l) => acc + (l.height ?? fontSize * LINE_HEIGHT_FACTOR) + (l.gapBefore ? (l.height ?? fontSize * LINE_HEIGHT_FACTOR) * BLOCK_GAP_FACTOR : 0), 0) + pad * 2 + 4);

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
