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
import type { ImageSlot, MindNode, Sheet, Style, TextRun } from "../core/types";
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
  /**
   * Font ascent/descent around the baseline, in px. Needed to build line boxes
   * the way CSS does (see `wrapRunLines`); when absent the caller falls back to
   * a 0.8/0.2 split, which reproduces the old fontSize × LINE_HEIGHT_FACTOR
   * behavior exactly.
   */
  metrics?(style: TextMetricsInput): { ascent: number; descent: number };
}

/** Deterministic fallback (no DOM): ~0.55 × fontSize per char. */
export const HEURISTIC_MEASURER: TextMeasurer = {
  measure: (t, s) => ({ width: t.length * (s.fontSize * 0.55) }),
  metrics: (s) => ({ ascent: s.fontSize * 0.8, descent: s.fontSize * 0.2 }),
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
  const metricsCache = new Map<string, { ascent: number; descent: number }>();
  const fontOf = (s: TextMetricsInput): string =>
    `${s.italic ? "italic " : ""}${s.fontWeight ?? 400} ${s.fontSize}px ${s.fontFamily ?? FONT_STACK}`;
  sharedCanvasMeasurer = {
    measure(text, s) {
      const key = `${s.fontWeight ?? 400}|${s.italic ? 1 : 0}|${s.fontSize}|${s.fontFamily ?? "system-ui"}|${text}`;
      const hit = cache.get(key);
      if (hit !== undefined) return { width: hit };
      ctx.font = fontOf(s);
      const width = ctx.measureText(text).width;
      if (cache.size > 20_000) cache.clear();
      cache.set(key, width);
      return { width };
    },
    metrics(s) {
      const font = fontOf(s);
      const hit = metricsCache.get(font);
      if (hit) return hit;
      ctx.font = font;
      const m = ctx.measureText("M");
      const ascent = m.fontBoundingBoxAscent > 0 ? m.fontBoundingBoxAscent : s.fontSize * 0.8;
      const descent = m.fontBoundingBoxDescent > 0 ? m.fontBoundingBoxDescent : s.fontSize * 0.2;
      const out = { ascent, descent };
      metricsCache.set(font, out);
      return out;
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
 * The one font stack for topic text. Must stay identical to `--font` in
 * styles.css: the canvas measured/drew with "system-ui, -apple-system,
 * sans-serif" while the overlay inherited `--font`, so on any machine where
 * those resolve differently the editor and the node used different faces —
 * different metrics, different wrap, for no visible reason.
 */
export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/**
 * Monospace stack for code topics (T22). A code topic is never edited, so
 * there is no CSS counterpart to keep in sync — the measure and the renderer
 * are the only two readers, and both take it from here (I9).
 */
export const CODE_FONT_STACK = 'ui-monospace, "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace';
/** Height of the window-chrome strip on top of a code topic (T22). Shared with
 *  the renderer (I9): the measure must reserve exactly what the painter draws. */
export const CODE_TITLEBAR_H = 22;
/** Ceiling for a code topic's width (T22). Code never re-wraps, so one long
 *  line must not be able to mint a 20,000px box; the cap is far above any
 *  real line, unlike MAX_TOPIC_W which a code block is allowed to exceed. */
export const MAX_CODE_W = 720;
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
/** Default display width of a node image in world units (Xmind-style cap). */
export const MAX_IMAGE_W = 240;
/** Vertical gap between a node's image and its text, in world units. */
export const IMAGE_GAP = 6;

/**
 * Gallery topics (T25). Shared by the measure, the canvas renderer, the SVG
 * and the PDF export (I9) — four readers, so a hand-copied number here is the
 * classic way an exported tier list stops matching the one on screen.
 */
/**
 * Cell width when `Style.gallery.cellW` says nothing — a small PREVIEW, not a
 * thumbnail: a face has to be recognisable at a normal zoom or the grid is a
 * row of coloured squares.
 */
export const GALLERY_CELL_W = 96;
/** Cell width ÷ height when `Style.gallery.aspect` says nothing: square. */
export const GALLERY_ASPECT = 1;
/** Gap between cells, horizontally and vertically. */
export const GALLERY_GAP = 4;
/** Font size of a cell caption. Fixed: a caption is chrome, not node text. */
export const GALLERY_CAPTION_SIZE = 9;
/** Gap between the bottom of a cell's picture and its caption's line box. */
export const GALLERY_CAPTION_GAP = 2;
/** Ceiling for a gallery's width, mirroring MAX_CODE_W's reason: a 40-image
 *  row must wrap rather than mint a box wider than any screen. */
export const MAX_GALLERY_W = 720;

/**
 * Tier lists (T26). Same four readers as the gallery constants above (I9), and
 * the cards are laid out by the same helper — a tier row IS a wrapping grid of
 * cells, so `gridCells` serves both and neither owns a second copy.
 */
/** Card width when `Style.tierList.cellW` says nothing. */
export const TIER_CELL_W = 72;
/** Cards per row before wrapping, when `cols` says nothing. */
export const TIER_COLS = 8;
/** Width of the coloured rank column, when `labelW` says nothing. */
export const TIER_LABEL_W = 72;
/** Font size of a rank label. Scales with nothing: the column is fixed. */
export const TIER_LABEL_SIZE = 15;
/** Hairline between rows, and around the whole chart. */
export const TIER_BORDER = 1;
/** Padding inside a row band, above and below the cards. */
export const TIER_ROW_PAD = 3;
/** Gap between the ranked rows and the pool below them. */
export const TIER_POOL_GAP = 10;
/** Font size of a text card's own text. */
export const TIER_TEXT_SIZE = 11;

/**
 * The default ladder for a new tier list — the one every reader already knows.
 * Colours are content (see `TierRow.color`), so they are stated, not themed.
 */
export const TIER_DEFAULT_ROWS: { label: string; color: string }[] = [
  { label: "S", color: "#ff7f7f" },
  { label: "A", color: "#ffbf7f" },
  { label: "B", color: "#ffdf7f" },
  { label: "C", color: "#ffff7f" },
  { label: "D", color: "#bfff7f" },
];

/**
 * Width of the bullet column, in em of the list item's font size. Shared with
 * the overlay as `--rnode-bullet-w`: the canvas indents the text by exactly
 * this and the CSS hangs the item by exactly this, so a wrapped list item
 * lines up identically on both sides.
 *
 * Measuring the glyph string ("•  ") instead — what this used to do — could
 * never match the browser, because with `list-style` the marker width is
 * UA-defined and no CSS length can be derived from it.
 */
export const BULLET_WIDTH_EM = 1.2;

/** Arrowhead length for relationships, in world units at scale 1 (I9: the
 *  canvas and the SVG export must draw the same head or the two diverge). */
export const ARROW_LEN = 9;
/** Half the arrowhead's spread, in radians. */
export const ARROW_HALF_ANGLE = 0.42;

/** A cubic Bézier, in world units. */
export interface Bezier3 {
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  p3: { x: number; y: number };
}

/** Point on a cubic Bézier at parameter t (0..1). */
export function bezierPoint(b: Bezier3, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const bb = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * b.p0.x + bb * b.p1.x + c * b.p2.x + d * b.p3.x,
    y: a * b.p0.y + bb * b.p1.y + c * b.p2.y + d * b.p3.y,
  };
}

/**
 * The sub-curve of [t0, t1] as its own cubic Bézier (de Casteljau). Used to
 * truncate a relationship curve exactly at the node borders, so the drawn
 * line meets the arrowhead instead of running under it toward the centre.
 * The tangents of the slice at its ends are the exact tangents of the
 * original curve at t0 and t1.
 */
export function bezierSlice(b: Bezier3, t0: number, t1: number): Bezier3 {
  const lerp = (a: { x: number; y: number }, c: { x: number; y: number }, t: number) => ({
    x: a.x + (c.x - a.x) * t,
    y: a.y + (c.y - a.y) * t,
  });
  // Subdivide at t0, keep the right part [t0, 1].
  const q1 = lerp(b.p0, b.p1, t0);
  const q2 = lerp(b.p1, b.p2, t0);
  const q3 = lerp(b.p2, b.p3, t0);
  const q4 = lerp(q1, q2, t0);
  const q5 = lerp(q2, q3, t0);
  const right: Bezier3 = { p0: lerp(q4, q5, t0), p1: q5, p2: q3, p3: b.p3 };
  // Subdivide the right part at u = (t1 - t0) / (1 - t0). The left part of
  // that subdivision is the slice: [R0, e1, f1, g] — using the second-level
  // point f2 (r5) as p2 was the classic mistake and bent the slice's end
  // tangent in the wrong direction.
  const u = (t1 - t0) / (1 - t0);
  const r1 = lerp(right.p0, right.p1, u); // e1
  const r2 = lerp(right.p1, right.p2, u); // e2
  const r3 = lerp(right.p2, right.p3, u); // e3
  const r4 = lerp(r1, r2, u); // f1
  const r6 = lerp(r4, lerp(r2, r3, u), u); // g = P(t1)
  return { p0: right.p0, p1: r1, p2: r4, p3: r6 };
}

/**
 * The parameter t where the curve crosses an axis-aligned rectangle. The
 * relationship curve is monotonic in both axes (control points stay within
 * the endpoints' span), so there is exactly one crossing. `enter` finds the
 * FIRST point inside the rect (the curve ends at the target centre, which is
 * inside); `exit` finds the FIRST point outside (the curve starts at the
 * source centre, which is inside). Degenerate overlaps (two boxes that
 * already touch) clamp to 0 / 1.
 */
function rectCrossing(b: Bezier3, x: number, y: number, w: number, h: number, exit: boolean): number {
  const inside = (t: number): boolean => {
    const p = bezierPoint(b, t);
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
  };
  const lo0 = inside(0);
  const hi1 = inside(1);
  // The search assumes the polarity flips once; if it already did not, the
  // crossing is at the degenerate end.
  if (lo0 === hi1) return exit ? 1 : 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // Same polarity as the start: the boundary is ahead; flipped: behind.
    if (inside(mid) === lo0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** First t where the curve (starting outside, ending inside) enters the rect. */
export function bezierEnterRect(b: Bezier3, x: number, y: number, w: number, h: number): number {
  return rectCrossing(b, x, y, w, h, false);
}

/**
 * Where the segment from one box's centre to another's crosses the FIRST box's
 * border (T24's straight relationships).
 *
 * Lives here beside the bezier trimmers for the reason §2/I9 gives: the
 * renderer and the SVG export both truncate a link at the node border, and two
 * copies of that arithmetic drift — visibly, at the arrowheads. Returns the
 * point on the border; the caller decides which end it is trimming by passing
 * the boxes in the right order.
 */
export function segmentExitRect(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const dx = to.x + to.w / 2 - cx;
  const dy = to.y + to.h / 2 - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // Scale the direction until it touches the nearer of the two half-extents:
  // the border hit is whichever axis runs out first.
  const halfW = from.w / 2;
  const halfH = from.h / 2;
  const tx = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const ty = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** First t where the curve (starting inside, ending outside) leaves the rect. */
export function bezierExitRect(b: Bezier3, x: number, y: number, w: number, h: number): number {
  return rectCrossing(b, x, y, w, h, true);
}

const BULLET_CHARS = ["•", "◦", "▪"];

/** Bullet marker for a list item at `depth` (1 = top level). */
export function bulletChar(depth: number): string {
  return BULLET_CHARS[Math.min(BULLET_CHARS.length - 1, Math.max(0, depth - 1))];
}

/** One wrapped line of rich text: segments reference their source run. */
export interface TextRunLine {
  segments: { text: string; run: TextRun }[];
  /** Visible width — trailing whitespace excluded, as CSS does when centering. */
  width: number;
  /** Line height in px — the CSS line box over every inline box on the line. */
  height?: number;
  /** Distance from the line's top to its baseline (CSS half-leading applied). */
  baseline?: number;
  /** x where the TEXT starts (list items: depth × bullet width, every line). */
  indent?: number;
  /** Extra vertical gap before this line (paragraph boundary). */
  gapBefore?: boolean;
  /**
   * The gap in px. Derived from the block's STRUT, never from this line's
   * height: the overlay applies `margin-top: calc(0.6 * 1.25em)` on the block
   * element, whose em is the topic's font size — a heading's size lives on an
   * inner span and does not enlarge its own block gap. Sizing the gap from the
   * line height made a heading after a paragraph sit 9px too low.
   */
  gapPx?: number;
  /** First line of a list item: which marker to draw and where. */
  bullet?: { char: string; x: number; run: TextRun };
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
  /**
   * The CSS strut: every line box is at least as tall as the block's own font
   * size, even when every inline box on it is smaller. Without this a run of
   * 10px text inside a 14px topic produced a 12.5px line on the canvas and a
   * 17.5px line in the editor.
   */
  const strut = style.fontSize ?? 14;
  /** `margin-top: calc(BLOCK_GAP_FACTOR * LINE_HEIGHT_FACTOR em)` on the block. */
  const blockGapPx = strut * LINE_HEIGHT_FACTOR * BLOCK_GAP_FACTOR;

  /**
   * One inline box's extent above and below the baseline, CSS-style: the
   * leading (line-height − content height) is split in half around the font's
   * content area. A line box is then max(above) + max(below) over EVERY inline
   * box on the line, the strut included — not `tallest font-size × 1.25`,
   * which put a 26px heading 1px off from the browser on every line.
   */
  const boxOf = (m: TextMetricsInput): { above: number; below: number } => {
    const met = measurer.metrics ? measurer.metrics(m) : { ascent: m.fontSize * 0.8, descent: m.fontSize * 0.2 };
    const half = (m.fontSize * LINE_HEIGHT_FACTOR - (met.ascent + met.descent)) / 2;
    return { above: met.ascent + half, below: met.descent + half };
  };
  const strutBox = boxOf({ fontSize: strut, fontFamily: style.fontFamily, fontWeight: style.fontWeight, italic: style.italic });

  // 1) Split the run stream into paragraphs (each paragraph is a segment list
  //    that may span multiple runs — emphasis survives a break). A paragraph
  //    ends at a literal \n, and ALSO at a run that opens a new block.
  interface Seg {
    text: string;
    run: TextRun;
    paraGap: boolean;
  }
  const paragraphs: Seg[][] = [[]];
  const openParagraph = (): void => {
    if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
  };
  for (const run of runs) {
    const parts = run.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) paragraphs.push([]);
      // A paraGap/listIndent run starts a new block even WITHOUT a newline:
      // editorStateToRuns marks a root-child boundary with paraGap alone, so
      // without this two typed paragraphs ran together on one canvas line
      // while the editor showed them as two separate <p>.
      else if (run.paraGap || run.listIndent !== undefined) openParagraph();
      if (parts[i].length > 0) {
        // only the first segment of the run carries the paragraph-gap flag
        paragraphs[paragraphs.length - 1].push({ text: parts[i], run, paraGap: i === 0 && !!run.paraGap });
      }
    }
  }

  /** Longest prefix of `text` that fits `budget` (at least one character). */
  const fitPrefix = (text: string, run: TextRun, budget: number): number => {
    let lo = 1;
    let hi = text.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (widthOf(text.slice(0, mid), run) <= budget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };

  const out: TextRunLine[] = [];
  let emittedBlocks = 0;
  // Blank paragraphs are only real blank lines when content follows them; the
  // trailing ones are just the newlines that close the last block. Tolerating
  // any number of them keeps documents written by older builds (which could
  // accumulate "\n\n") rendering the same as the editor shows them.
  let lastContentIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) if (paragraphs[i].length > 0) lastContentIdx = i;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    // Bullet metadata for this paragraph (first listIndent run wins).
    let bulletRun: TextRun | null = null;
    for (const seg of para) if (seg.run.listIndent) { bulletRun = seg.run; break; }
    const depth = bulletRun?.listIndent ?? 0;
    // Text column of a list item: depth × bullet width on EVERY line (the
    // marker sits in the column to its left). Mirrors the CSS padding-left +
    // negative text-indent on .topic-rich-editable li.
    const bulletW = BULLET_WIDTH_EM * (bulletRun?.fontSize ?? strut);
    const textIndent = depth * bulletW;
    const budget = Math.max(1, maxW - textIndent);
    // Block boundary → fixed gap. A paragraph flagged paraGap OR a list item
    // (bulletRun) starts a new block; the very first block of the topic has
    // no leading gap. The overlay applies the same rule with --rnode-block-gap.
    const gapBefore = (para.length === 0 ? false : para[0].paraGap || !!bulletRun) && emittedBlocks > 0;

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
    let lineWidth = 0; // includes trailing whitespace
    let visibleWidth = 0; // excludes it — this is what CSS centers
    let firstLine = true; // the marker lives on the first line only
    let lineAbove = strutBox.above;
    let lineBelow = strutBox.below;
    const grow = (run: TextRun): void => {
      const bx = boxOf(runMetrics(run, style));
      lineAbove = Math.max(lineAbove, bx.above);
      lineBelow = Math.max(lineBelow, bx.below);
    };
    const push = (): void => {
      if (line.length === 0) return;
      // Trailing whitespace hangs past the line end in CSS: it must not count
      // towards the width, or every centered wrapped line sits half a space
      // off and the measured box is a couple of px too wide.
      while (line.length > 0 && /^\s+$/.test(line[line.length - 1].text)) line.pop();
      out.push({
        segments: line,
        width: visibleWidth,
        height: lineAbove + lineBelow,
        baseline: lineAbove,
        indent: textIndent,
        gapBefore: gapBefore && firstLine,
        gapPx: gapBefore && firstLine ? blockGapPx : undefined,
        bullet: bulletRun && firstLine ? { char: bulletChar(depth), x: Math.max(0, textIndent - bulletW), run: bulletRun } : undefined,
      });
      line = [];
      lineWidth = 0;
      visibleWidth = 0;
      lineAbove = strutBox.above;
      lineBelow = strutBox.below;
      firstLine = false;
    };

    for (const tok of tokens) {
      if (/^\s+$/.test(tok.text)) {
        if (line.length > 0) {
          line.push(tok);
          lineWidth += widthOf(tok.text, tok.run);
        }
        continue; // leading/collapsed whitespace skipped
      }
      let rest = tok.text;
      // A token longer than the whole column must break mid-word, exactly as
      // `overflow-wrap: break-word` does in the overlay. Without this the
      // canvas drew past its bitmap (clipping the tail) while the editor let
      // it overflow the box.
      for (;;) {
        const w = widthOf(rest, tok.run);
        if (lineWidth + w <= budget || (line.length === 0 && w <= budget)) {
          line.push({ text: rest, run: tok.run });
          lineWidth += w;
          visibleWidth = lineWidth;
          grow(tok.run);
          break;
        }
        if (line.length > 0) {
          push();
          continue; // retry the whole token on a fresh line
        }
        const k = fitPrefix(rest, tok.run, budget);
        if (k >= rest.length) {
          line.push({ text: rest, run: tok.run });
          lineWidth += w;
          visibleWidth = lineWidth;
          grow(tok.run);
          break;
        }
        const head = rest.slice(0, k);
        line.push({ text: head, run: tok.run });
        lineWidth += widthOf(head, tok.run);
        visibleWidth = lineWidth;
        grow(tok.run);
        push();
        rest = rest.slice(k);
      }
    }
    push();
    if (out.length > startOutLen) {
      emittedBlocks++;
    } else if (pi < lastContentIdx) {
      // An empty paragraph is a real, visible blank line in the editor (the
      // canvas used to swallow it). A trailing empty paragraph is just the
      // newline that closes the last block, so it is not emitted.
      out.push({ segments: [], width: 0, height: strutBox.above + strutBox.below, baseline: strutBox.above, indent: textIndent, gapBefore, gapPx: gapBefore ? blockGapPx : undefined });
      emittedBlocks++;
    }
  }
  if (out.length === 0) out.push({ segments: [], width: 0, height: strutBox.above + strutBox.below, baseline: strutBox.above });
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
 * Resolve an attachment id to the ORIGINAL image's pixel size. Built from the
 * sheet's metadata cards in one place (invariant I9): every caller that
 * measures a node — layout, renderer, overlay — uses the same resolver, so
 * the three never disagree on a node's extent.
 */
export function imageResolver(sheet: Sheet): (id: string) => { w: number; h: number } | null {
  const byId = new Map<string, { w: number; h: number }>();
  for (const att of sheet.attachments) byId.set(att.id, { w: att.w, h: att.h });
  return (id: string) => byId.get(id) ?? null;
}

export interface SlotSize {
  w: number;
  h: number;
}

export type SlotSizes = {
  top: SlotSize | null;
  bottom: SlotSize | null;
  left: SlotSize | null;
  right: SlotSize | null;
};

/**
 * Per-slot image display sizes (I9). imgW comes from the shared
 * style.imageWidth, or the original's width capped at MAX_IMAGE_W; imgH
 * keeps the aspect ratio. The renderer, the editing overlay and the SVG
 * export all call this, so they cannot disagree with the layout on where
 * an image sits inside a box.
 */
export function slotSizes(
  n: MindNode,
  resolveImage?: ((id: string) => { w: number; h: number } | null) | null,
): SlotSizes {
  const size = (id: string | undefined): SlotSize | null => {
    if (!id || !resolveImage) return null;
    const att = resolveImage(id);
    if (!att || att.w <= 0) return null;
    const w = n.style.imageWidth ?? Math.min(att.w, MAX_IMAGE_W);
    return { w, h: (w * att.h) / att.w };
  };
  return {
    top: size(n.style.image),
    bottom: size(n.style.imageBottom),
    left: size(n.style.imageLeft),
    right: size(n.style.imageRight),
  };
}

export interface PositionedSlot {
  slot: ImageSlot;
  /** The attachment id sitting in this slot (for decoding the bitmap). */
  id: string;
  size: SlotSize;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Gallery topics (T25)
// ---------------------------------------------------------------------------

/** The grid's shape, derived from the node alone — see `galleryExtent`. */
export interface GalleryExtent {
  /** Extent of the whole grid, captions included. */
  w: number;
  h: number;
  /** Width of one picture. */
  cellW: number;
  /** Height of one picture — `cellW / aspect`, the same for every cell. */
  cellPicH: number;
  /** Picture plus caption band: the pitch of a row, gap excluded. */
  cellH: number;
  cols: number;
  rows: number;
  /** Band reserved under every picture for its caption; 0 when none has one. */
  captionH: number;
  count: number;
}

/** One placed cell: where its picture goes and which part of it is shown. */
export interface GalleryCell {
  id: string;
  /** Trimmed caption; "" when this cell has none. */
  caption: string;
  /** The picture's rect — square, `cellW` on a side. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The centred part of the source that fills the cell ("cover"), in
   * NORMALISED 0..1 units of the original. Normalised rather than in pixels
   * because the canvas never holds the original: it holds a bitmap decoded at
   * whatever bucket the zoom asked for, and a fraction multiplies onto that
   * bitmap's own dimensions with nothing to look up. Null when the asset card
   * is missing — the signal to draw the dashed placeholder instead.
   */
  crop: { sx: number; sy: number; sw: number; sh: number } | null;
  /** Baseline-independent rect of the caption band under the picture. */
  captionY: number;
  captionH: number;
}

/**
 * Lay `count` cells into a wrapping grid of `cols` columns, in reading order.
 *
 * The one implementation of "cards in a grid", shared by the gallery and by
 * every row of a tier list. Both had the same three-line arithmetic and both
 * would have drifted the first time the gap changed.
 */
export function gridCells(
  count: number,
  cols: number,
  cellW: number,
  cellH: number,
  gap: number,
  originX: number,
  originY: number,
): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const perRow = Math.max(1, cols);
  for (let i = 0; i < count; i++) {
    out.push({
      x: originX + (i % perRow) * (cellW + gap),
      y: originY + Math.floor(i / perRow) * (cellH + gap),
      w: cellW,
      h: cellH,
    });
  }
  return out;
}

/**
 * Clip a caption to `maxW`, ending it with an ellipsis when it does not fit.
 *
 * Shared by the canvas, the SVG export and the PDF export (I9). The obvious
 * alternative in SVG — `textLength` with `lengthAdjust` — is not the same
 * picture: it squeezes a long caption into the cell instead of cutting it, and
 * it stretches a SHORT one out to the full width, so the three painters would
 * show three different labels for one document.
 *
 * Binary search over the prefix, not a character walk: a 60-character caption
 * measured one prefix at a time is 60 measurements per cell per frame, and a
 * tier list is forty cells.
 */
export function ellipsizeToWidth(text: string, maxW: number, measure: (s: string) => number): string {
  if (text === "" || measure(text) <= maxW) return text;
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + ell) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ell : ell;
}

/**
 * The centred part of a source that fills a box of ratio `targetAspect`
 * (width ÷ height), in normalised 0..1 units — "cover", the rule that lets a
 * grid of mismatched pictures line up.
 *
 * The alternative, letterboxing each picture inside its cell, keeps every
 * pixel but gives every cell a different amount of empty space around it, so
 * the row stops reading as a row. Cropping loses the edges of the frame and
 * keeps the alignment, which is the trade a tier list wants.
 *
 * Null when the size is unknown — the caller draws a placeholder rather than
 * guessing a crop.
 */
export function coverCrop(
  nat: { w: number; h: number } | null,
  targetAspect: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!nat || nat.w <= 0 || nat.h <= 0 || !(targetAspect > 0)) return null;
  const sourceAspect = nat.w / nat.h;
  // Wider than the cell → the full height is used and the sides are trimmed.
  // Taller → the full width is used and the top and bottom are trimmed.
  const sw = sourceAspect > targetAspect ? targetAspect / sourceAspect : 1;
  const sh = sourceAspect > targetAspect ? 1 : sourceAspect / targetAspect;
  return { sx: (1 - sw) / 2, sy: (1 - sh) / 2, sw, sh };
}

/**
 * Where a cell dropped at (wx, wy) should be inserted among `cells` — an index
 * in 0..cells.length, counting the slots BETWEEN pictures rather than the
 * pictures themselves.
 *
 * Nearest cell centre, then before or after it depending on which side of that
 * centre the pointer is. Vertical distance is weighted into the choice so a
 * multi-row grid picks the row first: a pointer in row two must not insert
 * into row one merely because a row-one cell is horizontally closer.
 *
 * Pure and framework-free, like `nearestImageSide`, and for the same reason —
 * it is a rule the user drives by hand and it is not obvious from watching it
 * once.
 */
export function galleryInsertIndex(
  cells: { x: number; y: number; w: number; h: number }[],
  wx: number,
  wy: number,
): number {
  if (cells.length === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    // Rows dominate: a full row apart must outweigh any horizontal offset
    // inside a row, or a grid inserts into the wrong line.
    const d = Math.abs(wy - cy) * 4 + Math.abs(wx - cx);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const c = cells[best];
  return wx > c.x + c.w / 2 ? best + 1 : best;
}

/**
 * The grid a gallery topic wants, or null when the node is not one.
 *
 * Derived from the NODE ALONE — never from the placed box. That is the whole
 * discipline here: the column count decides the width, so reading the width
 * back to decide the columns is a loop, and resolving that loop differently in
 * the measure and in the painter is how the canvas and the export end up
 * disagreeing about how many pictures fit on a row. An explicit
 * `Style.width` wraps the grid into that width; otherwise the grid wraps at
 * MAX_GALLERY_W and the box grows to fit it.
 *
 * Captions reserve their band on EVERY cell as soon as ONE cell has a caption.
 * Per-cell reservation staggers the rows, and a grid whose rows do not line up
 * stops reading as a grid.
 */
export function galleryExtent(
  n: MindNode,
  resolveImage?: ((id: string) => { w: number; h: number } | null) | null,
): GalleryExtent | null {
  const g = n.style.gallery;
  if (!g || g.items.length === 0) return null;
  const count = g.items.length;
  const cellW = Math.max(16, g.cellW ?? GALLERY_CELL_W);
  const aspect = g.aspect && g.aspect > 0 ? g.aspect : GALLERY_ASPECT;
  const cellPicH = Math.max(8, Math.round(cellW / aspect));
  const captionH = g.items.some((it) => (it.caption ?? "").trim() !== "")
    ? GALLERY_CAPTION_GAP + Math.round(GALLERY_CAPTION_SIZE * LINE_HEIGHT_FACTOR)
    : 0;
  const cellH = cellPicH + captionH;

  let cols: number;
  if (g.cols && g.cols > 0) {
    cols = Math.min(count, Math.floor(g.cols));
  } else {
    const pad = n.style.padding ?? 10;
    // Side images eat the row before the grid does, so they belong in the fit.
    const side = slotSizes(n, resolveImage);
    const sidePadW = (side.left ? side.left.w + IMAGE_GAP : 0) + (side.right ? side.right.w + IMAGE_GAP : 0);
    const availW = (n.style.width ? Math.max(MIN_TOPIC_W, n.style.width) - pad * 2 - TEXT_INSET : MAX_GALLERY_W) - sidePadW;
    const fit = Math.floor((availW + GALLERY_GAP) / (cellW + GALLERY_GAP));
    cols = Math.min(count, Math.max(1, fit));
  }
  const rows = Math.ceil(count / cols);
  return {
    w: cols * cellW + (cols - 1) * GALLERY_GAP,
    h: rows * cellH + (rows - 1) * GALLERY_GAP,
    cellW,
    cellPicH,
    cellH,
    cols,
    rows,
    captionH,
    count,
  };
}

export interface TextInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far the text column sits from each edge of the box, padding excluded:
 * an occupied slot reserves its own size PLUS one IMAGE_GAP, an empty slot
 * reserves nothing at all (I9).
 *
 * The distinction is the whole point. Adding the gap unconditionally costs
 * IMAGE_GAP on every side that holds no image — invisible on the canvas, which
 * never reads these numbers, but it narrows the editing overlay's text column
 * and re-wraps the text the instant a topic with an image is double-clicked.
 *
 * `belowH` is whatever stacks BELOW the text inside the box — a gallery grid
 * (T25) or a tier-list chart (T26) — and it reserves from the bottom on
 * exactly the same terms as a bottom image. Folding it in here rather than at
 * each call site is what makes the four readers — the measure, the canvas, the
 * SVG and the PDF — place the title of such a topic identically without any of
 * them knowing what a gallery or a tier list is.
 *
 * Consumed by measureTopic, positionedImageSlots, the RichEditor overlay and
 * the parity harness: all four have to agree on where the text may go.
 */
export function textInsets(slots: SlotSizes, belowH = 0): TextInsets {
  const reserve = (v: number | undefined): number => (v && v > 0 ? v + IMAGE_GAP : 0);
  return {
    top: reserve(slots.top?.h),
    bottom: reserve(slots.bottom?.h) + reserve(belowH),
    left: reserve(slots.left?.w),
    right: reserve(slots.right?.w),
  };
}

/**
 * The four image slots pinned to a box (I9): the side images sit just
 * inside the padding, the top/bottom images are centred in the middle
 * column that remains between them. Single source of truth for the layout
 * measure, the canvas renderer, the editing overlay and the SVG export.
 */
export function positionedImageSlots(
  box: { x: number; y: number; w: number; h: number },
  n: MindNode,
  resolveImage?: ((id: string) => { w: number; h: number } | null) | null,
): {
  slots: SlotSizes;
  insets: TextInsets;
  sidePadW: number;
  midL: number;
  midW: number;
  items: PositionedSlot[];
  gallery: GalleryExtent | null;
  cells: GalleryCell[];
} {
  const slots = slotSizes(n, resolveImage);
  const gallery = galleryExtent(n, resolveImage);
  const tier = tierListLayout(n, resolveImage);
  const insets = textInsets(slots, (gallery?.h ?? 0) + (tier?.h ?? 0));
  const sidePadW = insets.left + insets.right;
  const pad = n.style.padding ?? 10;
  const midL = box.x + pad + insets.left;
  const midR = box.x + box.w - pad - insets.right;
  const midW = Math.max(0, midR - midL);
  const items: PositionedSlot[] = [];
  if (slots.top) items.push({ slot: "top", id: n.style.image!, size: slots.top, x: midL + (midW - slots.top.w) / 2, y: box.y + pad });
  if (slots.bottom)
    items.push({ slot: "bottom", id: n.style.imageBottom!, size: slots.bottom, x: midL + (midW - slots.bottom.w) / 2, y: box.y + box.h - pad - slots.bottom.h });
  if (slots.left) items.push({ slot: "left", id: n.style.imageLeft!, size: slots.left, x: box.x + pad, y: box.y + (box.h - slots.left.h) / 2 });
  if (slots.right) items.push({ slot: "right", id: n.style.imageRight!, size: slots.right, x: box.x + box.w - pad - slots.right.w, y: box.y + (box.h - slots.right.h) / 2 });

  // The grid sits at the FOOT of the middle column, just above a bottom image
  // if there is one — the same block the insets reserved for it, read back.
  // `midW` already excludes the grid's own reservation (it is vertical), so
  // the grid centres in the column the side images leave behind.
  const cells: GalleryCell[] = [];
  if (gallery) {
    const belowGrid = slots.bottom ? slots.bottom.h + IMAGE_GAP : 0;
    const gridTop = box.y + box.h - pad - belowGrid - gallery.h;
    const gridLeft = midL + (midW - gallery.w) / 2;
    const g = n.style.gallery!;
    for (let i = 0; i < g.items.length; i++) {
      const item = g.items[i];
      const col = i % gallery.cols;
      const row = Math.floor(i / gallery.cols);
      const x = gridLeft + col * (gallery.cellW + GALLERY_GAP);
      const y = gridTop + row * (gallery.cellH + GALLERY_GAP);
      const nat = resolveImage?.(item.id) ?? null;
      cells.push({
        id: item.id,
        caption: (item.caption ?? "").trim(),
        x,
        y,
        w: gallery.cellW,
        h: gallery.cellPicH,
        crop: coverCrop(nat, gallery.cellW / gallery.cellPicH),
        captionY: y + gallery.cellPicH + GALLERY_CAPTION_GAP,
        captionH: gallery.captionH > 0 ? gallery.captionH - GALLERY_CAPTION_GAP : 0,
      });
    }
  }
  return { slots, insets, sidePadW, midL, midW, items, gallery, cells };
}

// ---------------------------------------------------------------------------
// Tier lists (T26)
// ---------------------------------------------------------------------------

/** One placed card. `rowIndex` is -1 for the pool, which is how every caller
 *  names the two places a card can be without a second type. */
export interface TierCell {
  rowIndex: number;
  index: number;
  /** Asset id when the card is a picture; absent for a text-only card. */
  id?: string;
  /** Caption under the picture, or the card's whole content when there is none. */
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cover crop of the picture, normalised — null for a text card. */
  crop: { sx: number; sy: number; sw: number; sh: number } | null;
}

export interface TierRowLayout {
  index: number;
  label: string;
  color: string;
  /** The whole band, label column included. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The coloured rank column at its left. */
  labelW: number;
  cells: TierCell[];
}

export interface TierListLayout {
  /** Extent of the whole chart, pool included. */
  w: number;
  h: number;
  cellW: number;
  cellH: number;
  cols: number;
  labelW: number;
  rows: TierRowLayout[];
  /** The unranked pool, drawn under the rows. Its cells carry rowIndex -1. */
  pool: { x: number; y: number; w: number; h: number; cols: number; cells: TierCell[] };
}

/**
 * The chart a tier-list topic wants, or null when the node is not one.
 *
 * Sized from the NODE ALONE, never from the placed box — the same rule
 * `galleryExtent` documents, and for the same reason: the column count decides
 * the width, so reading the width back to decide the columns is a loop, and
 * resolving it differently in the measure and in the painter is how the canvas
 * and the export come to disagree.
 *
 * Every row is the same width whatever it holds, because that is what makes
 * the rows comparable — the thing a tier list is for. A row with more cards
 * than `cols` grows TALLER, it never grows wider.
 */
export function tierListLayout(
  n: MindNode,
  resolveImage?: ((id: string) => { w: number; h: number } | null) | null,
): TierListLayout | null {
  const t = n.style.tierList;
  if (!t) return null;
  const cellW = Math.max(16, t.cellW ?? TIER_CELL_W);
  const aspect = t.aspect && t.aspect > 0 ? t.aspect : GALLERY_ASPECT;
  const cellH = Math.max(8, Math.round(cellW / aspect));
  const cols = Math.max(1, Math.floor(t.cols ?? TIER_COLS));
  const labelW = Math.max(24, t.labelW ?? TIER_LABEL_W);

  const itemsW = cols * cellW + (cols - 1) * GALLERY_GAP;
  const totalW = labelW + TIER_BORDER + itemsW + TIER_ROW_PAD * 2;

  const cellOf = (item: { id?: string; text?: string }, rowIndex: number, index: number, r: { x: number; y: number; w: number; h: number }): TierCell => ({
    rowIndex,
    index,
    id: item.id,
    text: (item.text ?? "").trim(),
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    crop: item.id ? coverCrop(resolveImage?.(item.id) ?? null, cellW / cellH) : null,
  });

  const rows: TierRowLayout[] = [];
  let y = 0;
  for (let ri = 0; ri < t.rows.length; ri++) {
    const row = t.rows[ri];
    // An empty row still stands one card tall: a tier you have not filled yet
    // has to remain a visible drop target, which is most of what it is for.
    const lines = Math.max(1, Math.ceil(row.items.length / cols));
    const h = lines * cellH + (lines - 1) * GALLERY_GAP + TIER_ROW_PAD * 2;
    const rects = gridCells(row.items.length, cols, cellW, cellH, GALLERY_GAP, labelW + TIER_BORDER + TIER_ROW_PAD, y + TIER_ROW_PAD);
    rows.push({
      index: ri,
      label: row.label,
      color: row.color,
      x: 0,
      y,
      w: totalW,
      h,
      labelW,
      cells: row.items.map((it, i) => cellOf(it, ri, i, rects[i])),
    });
    y += h + TIER_BORDER;
  }

  // The pool spans the full width — it has no rank column to give up, and a
  // staging area that wrapped at the rows' column count would waste the strip
  // the label column occupies.
  const poolCols = Math.max(1, Math.floor((totalW - TIER_ROW_PAD * 2 + GALLERY_GAP) / (cellW + GALLERY_GAP)));
  const poolLines = Math.max(1, Math.ceil(t.pool.length / poolCols));
  const poolH = poolLines * cellH + (poolLines - 1) * GALLERY_GAP + TIER_ROW_PAD * 2;
  const poolY = y + (t.rows.length > 0 ? TIER_POOL_GAP - TIER_BORDER : 0);
  const poolRects = gridCells(t.pool.length, poolCols, cellW, cellH, GALLERY_GAP, TIER_ROW_PAD, poolY + TIER_ROW_PAD);

  return {
    w: totalW,
    h: poolY + poolH,
    cellW,
    cellH,
    cols,
    labelW,
    rows,
    pool: {
      x: 0,
      y: poolY,
      w: totalW,
      h: poolH,
      cols: poolCols,
      cells: t.pool.map((it, i) => cellOf(it, -1, i, poolRects[i])),
    },
  };
}

/**
 * The chart placed into a box: the same layout, offset to where the topic
 * actually sits, and centred in the middle column like the gallery grid.
 * Single source of truth for the renderer, the hit tests and the exports.
 */
export function positionedTierList(
  box: { x: number; y: number; w: number; h: number },
  n: MindNode,
  resolveImage?: ((id: string) => { w: number; h: number } | null) | null,
): TierListLayout | null {
  const l = tierListLayout(n, resolveImage);
  if (!l) return null;
  const pad = n.style.padding ?? 10;
  const dx = box.x + pad + Math.max(0, (box.w - pad * 2 - l.w) / 2);
  const dy = box.y + box.h - pad - l.h;
  const moveCell = (c: TierCell): TierCell => ({ ...c, x: c.x + dx, y: c.y + dy });
  return {
    ...l,
    rows: l.rows.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy, cells: r.cells.map(moveCell) })),
    pool: { ...l.pool, x: l.pool.x + dx, y: l.pool.y + dy, cells: l.pool.cells.map(moveCell) },
  };
}

/**
 * Observable model:
 *   width(topic)  = width(text, wrapped) + paddingLeft + paddingRight + shapeAllowance
 *   height(topic) = height(lines)        + paddingTop  + paddingBottom  + shapeAllowance
 * Explicit style.width/height overrides win; an image (when resolvable) adds
 * its box above the text, separated by IMAGE_GAP.
 */
/**
 * Everything `measureTopicUncached` actually reads, as a string.
 *
 * Derived from the function body, NOT from the Style type: a field missing
 * here means the layout silently reuses a stale size, which shows up as
 * overlapping or clipped topics far from the cause. Colour, underline,
 * strikethrough and alignment are deliberately absent — they change how the
 * text looks, not how much room it needs, and including them would throw the
 * entry away for nothing.
 */
function extentKey(n: MindNode, slots: SlotSizes): string {
  const s = n.style;
  let runs = "";
  for (const r of nodeRuns(n.title, n.titleRuns)) {
    runs += `${r.text}${r.bold ? 1 : 0}${r.italic ? 1 : 0}${r.fontSize ?? ""}${r.listIndent ?? ""}${r.paraGap ? 1 : 0}`;
  }
  // The images contribute only through their RESOLVED sizes: swapping in
  // another picture with the same dimensions leaves the box identical. All
  // four slots take part — a node with a left image measures differently
  // from one whose image moved to the top.
  const sz = (p: SlotSize | null): string => (p ? `${p.w}x${p.h}` : "");
  // The code flag must be in the key: without it a topic promoted to a code
  // block keeps the extent it had as a normal topic (measured with wrap and
  // clamped to MAX_TOPIC_W) until some unrelated edit happens to bust it.
  // The gallery contributes its GRID, not its pictures: the cell size, the
  // column count and whether any caption reserves the band are the only three
  // things that move the box. Swapping which picture is in a cell — or
  // retyping a caption that stays a caption — legitimately leaves the extent
  // alone, so those must not appear here or every keystroke in the Inspector
  // would mint a cache entry and re-measure the whole sheet.
  const g = s.gallery;
  const gal = g
    ? `${g.items.length}:${g.cellW ?? ""}:${g.cols ?? ""}:${g.items.some((it) => (it.caption ?? "").trim() !== "") ? 1 : 0}`
    : "";
  // A tier list contributes its SHAPE: how many cards sit in each row (which
  // decides how many lines that row wraps to), the pool's count, and the four
  // size knobs. Which picture is on a card, and what its text says, move
  // nothing — and including them would mint a cache entry per keystroke.
  const t = s.tierList;
  const tier = t
    ? `${t.rows.map((r) => r.items.length).join(",")}|${t.pool.length}|${t.cellW ?? ""}:${t.aspect ?? ""}:${t.cols ?? ""}:${t.labelW ?? ""}`
    : "";
  return `${runs}|${s.code ? "code:" + s.code.lang : ""}|${s.width ?? ""}|${s.height ?? ""}|${s.fontSize ?? ""}|${s.fontFamily ?? ""}|${s.fontWeight ?? ""}|${s.italic ? 1 : 0}|${s.padding ?? ""}|${s.shape ?? ""}|${s.imageWidth ?? ""}|${sz(slots.top)}|${sz(slots.bottom)}|${sz(slots.left)}|${sz(slots.right)}|${gal}|${tier}`;
}

/**
 * Measured extents, per measurer (the heuristic and the canvas one disagree by
 * design, so they must not share entries).
 *
 * Why this exists: `layoutSheet` measures EVERY node on every run, and a run
 * was timed at 86–109 ms on a 3001-node map — six frames of frozen UI after
 * each edit. Between two runs a single node changes, so ~3000 of those
 * measurements re-derive an answer that has not moved.
 *
 * Capped by ENTRY COUNT on purpose. That knob was wrong for the bitmap caches,
 * where entries differ in size by orders of magnitude; here every entry is two
 * numbers, so counting them is counting bytes.
 */
const extentCaches = new WeakMap<TextMeasurer, Map<string, Extent>>();
const EXTENT_CACHE_MAX = 20_000;

export function measureTopic(
  n: MindNode,
  measurer: TextMeasurer = HEURISTIC_MEASURER,
  resolveImage?: (id: string) => { w: number; h: number } | null,
): Extent {
  const slots = slotSizes(n, resolveImage);
  const key = extentKey(n, slots);
  let cache = extentCaches.get(measurer);
  if (!cache) {
    cache = new Map();
    extentCaches.set(measurer, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const out = measureTopicUncached(n, measurer, resolveImage, slots);
  if (cache.size >= EXTENT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, out);
  return out;
}

function measureTopicUncached(
  n: MindNode,
  measurer: TextMeasurer = HEURISTIC_MEASURER,
  resolveImage?: (id: string) => { w: number; h: number } | null,
  slots: SlotSizes = slotSizes(n, resolveImage),
): Extent {
  const style = n.style;
  if (style.width && style.height) return { w: style.width, h: style.height };

  // A code topic measures on its own path (T22): it does NOT wrap and DOES
  // keep its leading whitespace — both properties are exactly what the shared
  // wrapRunLines must not do for normal topics, so this lives beside that path
  // instead of inside it. One source line is one box line, never re-flowed; a
  // trailing newline closes the last line instead of opening an empty one (the
  // same rule §3 rule 8 applies to normal blocks).
  if (style.code) {
    const fontSize = style.fontSize ?? 14;
    const pad = style.padding ?? 10;
    const lineCount = n.title === "" ? 1 : n.title.split("\n").length - (n.title.endsWith("\n") ? 1 : 0);
    const lineH = fontSize * LINE_HEIGHT_FACTOR;
    let widest = 0;
    for (const line of n.title.split("\n")) {
      // Leading spaces count toward the line: they are the indentation.
      widest = Math.max(widest, measurer.measure(line, { fontSize, fontFamily: CODE_FONT_STACK }).width);
    }
    const w = style.width
      ? Math.max(MIN_TOPIC_W, style.width)
      : Math.min(MAX_CODE_W, Math.max(MIN_TOPIC_W, Math.ceil(widest) + pad * 2 + TEXT_INSET));
    const h = style.height ?? Math.max(28, lineCount * lineH + pad * 2 + 4 + CODE_TITLEBAR_H);
    return { w, h };
  }

  const fontSize = style.fontSize ?? 14;
  const pad = style.padding ?? 10;
  const topH = slots.top?.h ?? 0;
  const botH = slots.bottom?.h ?? 0;
  const leftH = slots.left?.h ?? 0;
  const rightH = slots.right?.h ?? 0;
  // Side images eat into the width available to the text; the gap counts
  // only when an image is actually present on that side.
  const insets = textInsets(slots);
  const sidePadW = insets.left + insets.right;
  // An explicit width fixes the box and re-wraps the text at it (Xmind-style
  // resize); the height always follows the wrapped content.
  const maxW = style.width ? Math.max(MIN_TOPIC_W, style.width) : MAX_TOPIC_W;
  const textW = Math.max(24, maxW - pad * 2 - TEXT_INSET - sidePadW);
  const runs = nodeRuns(n.title, n.titleRuns);
  const lines = wrapRunLines(runs, textW, measurer, style);
  // the list indent is part of the line's extent, not free space
  const maxLineW = lines.reduce((acc, l) => Math.max(acc, (l.indent ?? 0) + l.width), 0);

  // An empty title still yields one strut line; "has text" means real content.
  const hasText = lines.some((l) => l.segments.length > 0);
  const textH = lines.reduce((acc, l) => acc + (l.height ?? fontSize * LINE_HEIGHT_FACTOR) + (l.gapPx ?? 0), 0);

  // Middle column: top image, text, gallery grid, bottom image. A gap
  // separates each present block from the next but never appears when nothing
  // is on that side — text-only nodes keep their exact old height.
  const gallery = galleryExtent(n, resolveImage);
  const tier = tierListLayout(n, resolveImage);
  // A gallery and a tier list are alternative bodies, but summing rather than
  // choosing keeps the box correct for a node that somehow carries both
  // instead of silently dropping one of them off the bottom.
  const galH = (gallery?.h ?? 0) + (tier?.h ?? 0);
  let midH = topH + botH + galH;
  if (topH > 0 && (hasText || galH > 0 || botH > 0)) midH += IMAGE_GAP; // top image → next block
  if (hasText && (galH > 0 || botH > 0)) midH += IMAGE_GAP; // text → grid or bottom image
  if (galH > 0 && botH > 0) midH += IMAGE_GAP; // grid → bottom image
  if (hasText) midH += textH;
  // Side images sit beside the middle column; the box fits the taller one.
  const sideH = Math.max(leftH, rightH);
  const contentH = Math.max(midH, sideH);

  // The width clamp caps the TEXT column only — side images legitimately
  // push the box wider than MAX_TOPIC_W, exactly like the top image already
  // could. With no side images sidePadW is 0 and this is the old formula.
  let w = style.width
    ? Math.max(MIN_TOPIC_W, style.width)
    : Math.min(MAX_TOPIC_W, Math.max(MIN_TOPIC_W, Math.ceil(maxLineW) + pad * 2 + TEXT_INSET)) + sidePadW;
  // The middle column must fit the top/bottom images and the gallery grid
  // (the side columns are already part of sidePadW). The grid's own width is
  // already capped — by MAX_GALLERY_W, or by an explicit style.width it was
  // told to wrap into — so this widens the box without unbounding it.
  const maxTopBotW = Math.max(slots.top?.w ?? 0, slots.bottom?.w ?? 0, gallery?.w ?? 0, tier?.w ?? 0);
  if (maxTopBotW > 0) w = Math.max(w, maxTopBotW + pad * 2 + sidePadW);
  // ... and it can never collapse below the minimum text width.
  w = Math.max(w, sidePadW + (24 + TEXT_INSET) + pad * 2);
  // With an image the box is content + padding; without one, the previous
  // formula is untouched (the strut line included).
  let h = style.height ?? Math.max(28, contentH > 0 ? contentH + pad * 2 + 4 : textH + pad * 2 + 4);

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

export function measureNode(n: MindNode, measurer?: TextMeasurer, resolveImage?: (id: string) => { w: number; h: number } | null): Extent {
  return measureTopic(n, measurer, resolveImage);
}
