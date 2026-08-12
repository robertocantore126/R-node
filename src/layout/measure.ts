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
import type { MindNode, Sheet, Style, TextRun } from "../core/types";
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

/**
 * Observable model:
 *   width(topic)  = width(text, wrapped) + paddingLeft + paddingRight + shapeAllowance
 *   height(topic) = height(lines)        + paddingTop  + paddingBottom  + shapeAllowance
 * Explicit style.width/height overrides win; an image (when resolvable) adds
 * its box above the text, separated by IMAGE_GAP.
 */
export function measureTopic(
  n: MindNode,
  measurer: TextMeasurer = HEURISTIC_MEASURER,
  resolveImage?: (id: string) => { w: number; h: number } | null,
): Extent {
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
  // the list indent is part of the line's extent, not free space
  const maxLineW = lines.reduce((acc, l) => Math.max(acc, (l.indent ?? 0) + l.width), 0);

  // Image above the text: width from style.imageWidth (or the original's,
  // capped at MAX_IMAGE_W), height keeps the aspect ratio. Unresolvable ids
  // (no card in sheet.attachments) measure as if the node had no image.
  let imgW = 0;
  let imgH = 0;
  if (style.image && resolveImage) {
    const att = resolveImage(style.image);
    if (att && att.w > 0) {
      imgW = style.imageWidth ?? Math.min(att.w, MAX_IMAGE_W);
      imgH = (imgW * att.h) / att.w;
    }
  }
  // An empty title still yields one strut line; "has text" means real content.
  const hasText = lines.some((l) => l.segments.length > 0);
  const textH = lines.reduce((acc, l) => acc + (l.height ?? fontSize * LINE_HEIGHT_FACTOR) + (l.gapPx ?? 0), 0);

  let w = style.width ? Math.max(MIN_TOPIC_W, style.width) : Math.min(MAX_TOPIC_W, Math.max(MIN_TOPIC_W, Math.ceil(maxLineW) + pad * 2 + TEXT_INSET));
  if (imgW > 0) w = Math.max(w, imgW + pad * 2);
  // With an image the box is imgH + (gap + text only if real text) + padding;
  // without one, the previous formula is untouched (the strut line included).
  let h = style.height ?? Math.max(28, imgH > 0 ? imgH + (hasText ? IMAGE_GAP + textH : 0) + pad * 2 + 4 : textH + pad * 2 + 4);

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
