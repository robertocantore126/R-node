/**
 * PDF export — one tall strip of paper, cut into pages.
 *
 * THE RULE: the map is never split horizontally, only vertically. The whole
 * width lands on every sheet at ONE scale, and the sheets are contiguous bands
 * of the canvas stacked top to bottom, so stacking the printout reconstructs
 * the map exactly. This is what draw.io does, and it is the only arrangement in
 * which a reader keeps their bearings: a mind map is read along its branches,
 * and a branch that leaves the right-hand edge and resumes three sheets later
 * has been cut across the grain.
 *
 * Three properties follow, and each one was a bug in the version before this:
 *
 *   - ELEMENTS KEEP THEIR CANVAS POSITION. There is a single world-to-paper
 *     transform for the whole document; a page differs from its neighbour only
 *     by which horizontal band of the world it shows. Nothing is re-anchored,
 *     re-centred, or nudged per page. The previous version bucketed topics by
 *     which cell held their CENTRE and gave each page its own origin plus a
 *     bleed margin, which moved topics relative to each other across a cut.
 *
 *   - THE CUT IS SEAMLESS. A topic straddling a boundary is drawn on BOTH
 *     sheets, each showing its half, because membership is decided by whether a
 *     box INTERSECTS the band — not by where its centre falls. Assigning by
 *     centre drew it once and clipped the overhang away, leaving a gap on the
 *     neighbour.
 *
 *   - THE SCALE IS DERIVED FROM THE WIDTH, ONCE. It is the factor that makes
 *     the map's full width fit the usable page width, capped at true size so a
 *     narrow map is not blown up to fill the paper. So the PAGE SIZE is the
 *     readability control: a wider sheet means a bigger scale means larger
 *     text. A4 is genuinely too small for most maps — hence the default here,
 *     and the presets.
 *
 * Nothing stalls, at any map size, because each page carries its own content
 * stream and a viewer drawing page 7 never parses the other fifty-nine. That is
 * the problem the SVG export cannot solve at any file size — 95,000 DOM nodes
 * stall whether they weigh 110MB or 10MB. It is also why the drawing is NOT
 * authored once as a Form XObject placed per page under a clip, which is the
 * tempting trick: a clipped form still makes the viewer execute every operator
 * and discard most of them, so the whole cost would come back once per page.
 *
 * KNOWN GAPS, declared here and in the report rather than discovered later.
 * The font is Helvetica, one of the fourteen every viewer carries, so nothing
 * is embedded and non-Latin text degrades to "?". R-node measures with Segoe
 * UI, so line breaks are ours while the glyphs are the viewer's: invisible at
 * 0.048 scale, visible at 1:1, and the reason font embedding is the next piece
 * of work rather than a nicety. Run-level bold/italic is NOT approximated — a
 * per-line guess would render mixed lines wrong while looking complete, so the
 * report declares the gap instead. Shapes other than a rounded rectangle, code
 * topics, groups and summaries are likewise absent and likewise declared.
 */
// zlibSync, NOT deflateSync: /FlateDecode means zlib (RFC 1950), and fflate's
// deflateSync emits RAW deflate with no header. A viewer cannot decode that, so
// it renders nothing — a blank page from a file whose structure, xref and
// offsets are all perfectly valid. That is how a blank PDF once passed every
// check we had.
import { unzlibSync, zlibSync } from "fflate";
import { buildReport, publishReport, type ExportReport } from "./report";
import type { MindNode, Relationship, Sheet } from "../core/types";
import { nodeRuns } from "../core/text";
import {
  ARROW_HALF_ANGLE,
  ARROW_LEN,
  IMAGE_GAP,
  LINE_HEIGHT_FACTOR,
  TEXT_INSET,
  bezierEnterRect,
  bezierExitRect,
  bezierSlice,
  imageResolver,
  measureNode,
  positionedImageSlots,
  wrapRunLines,
  type Bezier3,
  type TextMeasurer,
} from "../layout/measure";

/**
 * ISO page sizes in points, landscape (wide side first).
 *
 * The page size is the readability control, because the scale is whatever makes
 * the map's width fit it. A4 is on the list for completeness; it is too narrow
 * for anything but a small map, which is why the default is A1 — a map 3,100
 * units wide still prints at true size on it, and copy shops plot A1.
 */
export const PAGE_SIZES = {
  A4: { w: 841.89, h: 595.28 },
  A3: { w: 1190.55, h: 841.89 },
  A2: { w: 1683.78, h: 1190.55 },
  A1: { w: 2383.94, h: 1683.78 },
  A0: { w: 3370.39, h: 2383.94 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

/** 1cm. */
const DEFAULT_MARGIN = 28.35;
/**
 * True size: world units are CSS pixels (96dpi), PDF units are points (72dpi),
 * so 0.75 pt/unit prints at the same physical size as the screen at 100%.
 *
 * This is a CEILING now, not the scale. The scale fits the map's width to the
 * page and is capped here, so a map narrower than the sheet is drawn at true
 * size with white space either side rather than blown up to fill it.
 */
export const PT_PER_UNIT = 0.75;

interface Placed {
  node: MindNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One emitted sheet: a horizontal band of the canvas, full width. */
interface Page {
  /** 0-based band, top to bottom. */
  band: number;
  /** 1-based, as printed. The index sheet, when present, is page 1. */
  number: number;
  /** World Y the band starts at; it runs to `top + height`. */
  top: number;
  height: number;
  /** Topics whose box INTERSECTS the band — a straddling topic is on both. */
  nodes: Placed[];
}

export interface PdfExportOptions {
  measurer: TextMeasurer;
  /**
   * Fill and text colour per node, resolved by the RENDERER — branch palettes
   * live there, and recomputing them here would be a second source of truth.
   */
  colorOf: (nodeId: string) => { fill: string; text: string } | null;
  /** Connector colour for a child node (its branch colour). */
  linkColorOf: (nodeId: string) => string;
  /** Colour for a relationship (its own, else the theme's accent). */
  relColorOf?: (relId: string) => string;
  /**
   * Raw JPEG bytes for an asset. JPEG only: those bytes embed as-is through
   * DCTDecode, while a PNG would need its IDAT unpacked and re-encoded. A PNG
   * asset is reported missing rather than drawn wrong.
   */
  jpegBytes?: (assetId: string) => Promise<{ bytes: Uint8Array; w: number; h: number } | null>;
  /** Paper, in points. A name from PAGE_SIZES or an explicit size. Default A1
   *  landscape — the page size IS the readability control, see PAGE_SIZES. */
  page?: PageSizeName | { w: number; h: number };
  margin?: number;
  /** Ceiling on the fitted scale. Default PT_PER_UNIT (true size). */
  maxPtPerUnit?: number;
  /** Prepend an index sheet. Default false: the sheets are one column read top
   *  to bottom, so their order needs no explaining. */
  index?: boolean;
  /** Page background. Pass null to leave the paper white. */
  background?: string | null;
}

export interface PdfExportResult {
  blob: Blob;
  nodes: number;
  images: number;
  /** Drawing operators across every page. */
  ops: number;
  bytes: number;
  /** Sheets in the file, index included. */
  pages: number;
  /** Sheets carrying map — `pages` minus the index. */
  mapPages: number;
  /** The fitted scale, in points per world unit. */
  scale: number;
  /** Topics drawn on two sheets because they straddle a cut. Not a fault: it
   *  is what makes the cut seamless. */
  split: number;
  pageW: number;
  pageH: number;
  ms: number;
  report: ExportReport;
}

const latin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** PDF string literal: only these three bytes are special. Anything outside
 *  WinAnsi becomes "?" — see the font gap in the header. */
const pdfStr = (s: string): string =>
  s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

function rgb(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return "0.5 0.5 0.5";
  let h = hex[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = (i: number): string => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3);
  return `${v(0)} ${v(2)} ${v(4)}`;
}

const f = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * Placement, mirroring the renderer's: the position is the node's own, the
 * extent comes from the shared measurer. Collapsed subtrees are omitted — the
 * export shows what the map shows.
 */
function placeAll(sheet: Sheet, measurer: TextMeasurer): Placed[] {
  const resolveImage = imageResolver(sheet);
  const out: Placed[] = [];
  const seen = new Set<string>();
  const queue = [sheet.rootNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = sheet.nodes[id];
    if (!node || seen.has(id)) continue;
    seen.add(id);
    const m = measureNode(node, measurer, resolveImage);
    out.push({ node, x: node.position.x, y: node.position.y, w: m.w, h: m.h });
    if (!node.collapsed) queue.push(...node.childrenIds);
  }
  for (const node of Object.values(sheet.nodes)) {
    if (seen.has(node.id) || node.parentId) continue;
    seen.add(node.id);
    const m = measureNode(node, measurer, resolveImage);
    out.push({ node, x: node.position.x, y: node.position.y, w: m.w, h: m.h });
  }
  return out;
}

/**
 * The connector curve, with the renderer's exact control points — a curve that
 * merely looks similar shows up as every line meeting its box at a slightly
 * wrong angle.
 */
function connectorCurve(parent: Placed, child: Placed, sheet: Sheet): Bezier3 {
  const st = sheet.structure;
  const childLeft = child.x + child.w / 2 < parent.x + parent.w / 2;
  let sx: number, sy: number, ex: number, ey: number;
  if (
    child.y > parent.y + parent.h - 1 &&
    st.structureType !== "mindmap" &&
    !(st.structureType === "logic" && st.orientation !== "vertical")
  ) {
    sx = parent.x + parent.w / 2;
    sy = parent.y + parent.h;
    ex = child.x + child.w / 2;
    ey = child.y;
  } else {
    sx = childLeft ? parent.x : parent.x + parent.w;
    sy = parent.y + parent.h / 2;
    ex = childLeft ? child.x + child.w : child.x;
    ey = child.y + child.h / 2;
  }
  const dx = Math.abs(ex - sx);
  return {
    p0: { x: sx, y: sy },
    p1: { x: sx + (childLeft ? -dx * 0.45 : dx * 0.45), y: sy },
    p2: { x: ex + (childLeft ? dx * 0.45 : -dx * 0.45), y: ey },
    p3: { x: ex, y: ey },
  };
}

/** The relationship curve, before it is trimmed at the two box borders. */
function relationshipCurve(a: Placed, b: Placed): Bezier3 {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  return {
    p0: { x: ax, y: ay },
    p1: { x: ax + (bx - ax) * 0.35, y: ay },
    p2: { x: bx - (bx - ax) * 0.35, y: by },
    p3: { x: bx, y: by },
  };
}

/** Per-page coordinate transform: world down-positive to PDF up-positive. */
interface Frame {
  X: (x: number) => number;
  Y: (y: number) => number;
  s: number;
}

export async function sheetToPdf(sheet: Sheet, opts: PdfExportOptions): Promise<PdfExportResult> {
  const t0 = performance.now();
  const paper = typeof opts.page === "string" ? PAGE_SIZES[opts.page] : opts.page ?? PAGE_SIZES.A1;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const withIndex = opts.index === true;
  const placed = placeAll(sheet, opts.measurer);
  const resolveImage = imageResolver(sheet);

  if (placed.length === 0) {
    const blob = new Blob([emptyPdf(paper)] as BlobPart[], { type: "application/pdf" });
    const report = buildReport({
      format: "pdf", sheet, ms: 0, bytes: blob.size,
      emitted: {}, honoured: [], units: {},
      selfCheck: { ok: true, detail: "empty map: one blank page" },
    });
    return {
      blob, nodes: 0, images: 0, ops: 0, bytes: blob.size, pages: 1, mapPages: 0,
      scale: 0, split: 0, pageW: paper.w, pageH: paper.h, ms: 0, report,
    };
  }

  // --- world bounds ---------------------------------------------------------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
  }
  const pad = 20;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const worldW = maxX - minX;
  const worldH = maxY - minY;

  // --- the scale, then the bands --------------------------------------------
  // ONE scale for the whole document, derived from the WIDTH: the map is never
  // cut vertically, so the page must hold all of it across. Capped at true size
  // so a narrow map keeps its printed dimensions instead of being blown up.
  const usableWpt = paper.w - margin * 2;
  const usableHpt = paper.h - margin * 2;
  const s = Math.min(opts.maxPtPerUnit ?? PT_PER_UNIT, usableWpt / worldW);

  // The band each sheet shows, in world units. Full width, always.
  const bandH = usableHpt / s;
  const bandCount = Math.max(1, Math.ceil(worldH / bandH));

  // A topic is on every band its box INTERSECTS, not the one holding its
  // centre. That is what makes the cut seamless: a topic across a boundary is
  // drawn on both sheets, each clipping it to its own half, and the two halves
  // meet exactly. Deciding by centre drew it once and clipped the overhang
  // away, which left a hole on the neighbouring sheet.
  const pages: Page[] = [];
  let split = 0;
  for (let band = 0; band < bandCount; band++) {
    const top = minY + band * bandH;
    const nodes = placed.filter((p) => p.y < top + bandH && p.y + p.h > top);
    pages.push({ band, top, height: bandH, number: pages.length + (withIndex ? 2 : 1), nodes });
  }
  for (const p of placed) {
    const first = Math.floor((p.y - minY) / bandH);
    const last = Math.floor((p.y + p.h - minY - 1e-9) / bandH);
    if (last > first) split++;
  }

  // The world-to-paper transform is GLOBAL in x: the same world x lands on the
  // same paper x on every sheet, which is what "elements keep their canvas
  // position" means. A map narrower than the sheet is centred, not stretched.
  const offX = margin + (usableWpt - worldW * s) / 2;

  // --- images ---------------------------------------------------------------
  // Declared once as XObjects and referenced by name from every page that
  // draws them: the bytes appear in the file exactly once however many topics
  // (or sheets) show the picture.
  const xobjects: { name: string; bytes: Uint8Array; w: number; h: number }[] = [];
  const xobjByAsset = new Map<string, string>();
  let imagesMissing = 0;
  if (opts.jpegBytes) {
    const ids = new Set<string>();
    for (const p of placed) {
      for (const it of positionedImageSlots(p, p.node, resolveImage).items) ids.add(it.id);
    }
    for (const id of ids) {
      const jpg = await opts.jpegBytes(id);
      if (!jpg) {
        imagesMissing++;
        continue;
      }
      const name = `Im${xobjects.length}`;
      xobjects.push({ name, bytes: jpg.bytes, w: jpg.w, h: jpg.h });
      xobjByAsset.set(id, name);
    }
  }

  const byId = new Map(placed.map((p) => [p.node.id, p]));
  let ops = 0;
  let images = 0;
  const fontSizes: number[] = [];

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  const drawBox = (cmds: string[], p: Placed, fill: string, fr: Frame): void => {
    const shape = p.node.style.shape ?? "rounded";
    if (shape === "none") return;
    cmds.push(`${rgb(fill)} rg`);
    const r = Math.min((p.node.style.cornerRadius ?? 10) * fr.s, (p.w * fr.s) / 2, (p.h * fr.s) / 2);
    const x0 = fr.X(p.x), y0 = fr.Y(p.y + p.h), w = p.w * fr.s, h = p.h * fr.s;
    if (r > 0.2) {
      // Four Bezier quarters. A sharp-cornered rectangle reads as a slab rather
      // than a topic, and the canvas rounds them.
      const k = r * 0.5523;
      cmds.push(
        `${f(x0 + r)} ${f(y0)} m`,
        `${f(x0 + w - r)} ${f(y0)} l ${f(x0 + w - r + k)} ${f(y0)} ${f(x0 + w)} ${f(y0 + r - k)} ${f(x0 + w)} ${f(y0 + r)} c`,
        `${f(x0 + w)} ${f(y0 + h - r)} l ${f(x0 + w)} ${f(y0 + h - r + k)} ${f(x0 + w - r + k)} ${f(y0 + h)} ${f(x0 + w - r)} ${f(y0 + h)} c`,
        `${f(x0 + r)} ${f(y0 + h)} l ${f(x0 + r - k)} ${f(y0 + h)} ${f(x0)} ${f(y0 + h - r + k)} ${f(x0)} ${f(y0 + h - r)} c`,
        `${f(x0)} ${f(y0 + r)} l ${f(x0)} ${f(y0 + r - k)} ${f(x0 + r - k)} ${f(y0)} ${f(x0 + r)} ${f(y0)} c f`,
      );
      ops += 6;
    } else {
      cmds.push(`${f(x0)} ${f(y0)} ${f(w)} ${f(h)} re f`);
      ops += 2;
    }
  };

  /**
   * The title, transcribed from the SVG exporter's placement — same maxW, same
   * gap-then-baseline order, same left-vs-centre rule, same middle column
   * between the top/bottom images and the side ones.
   *
   * Centring uses OUR measured `line.width` because PDF has no `text-anchor`:
   * a viewer cannot centre a string we hand it without us stating where it
   * starts. That bakes our metrics into the file, which is exactly the class of
   * error the SVG exporter avoids — and at 1:1 it is visible. It resolves when
   * the font is embedded and the widths become the same widths; until then it
   * is a declared gap, not a solved problem.
   */
  const drawTitle = (cmds: string[], p: Placed, color: string, fr: Frame): void => {
    const n = p.node;
    const size = n.style.fontSize ?? 14;
    const padNode = n.style.padding ?? 10;
    const pos = positionedImageSlots(p, n, resolveImage);
    const maxW = Math.max(20, p.w - padNode * 2 - TEXT_INSET - pos.sidePadW);
    const lines = wrapRunLines(nodeRuns(n.title, n.titleRuns), maxW, opts.measurer, n.style);
    if (lines.length === 0) return;

    let totalH = 0;
    for (const line of lines) totalH += (line.height ?? size * LINE_HEIGHT_FACTOR) + (line.gapPx ?? 0);
    const topBlock = (pos.slots.top?.h ?? 0) + (pos.slots.top ? IMAGE_GAP : 0);
    const botBlock = pos.slots.bottom ? IMAGE_GAP + pos.slots.bottom.h : 0;
    const midH = topBlock + totalH + botBlock;
    const startY = p.y + padNode + topBlock + Math.max(0, (p.h - padNode * 2 - midH) / 2);
    const startX = p.x + padNode + (pos.slots.left ? pos.slots.left.w + IMAGE_GAP : 0);

    cmds.push("BT", `${rgb(color)} rg`);
    ops += 2;
    let yCursor = startY;
    for (const line of lines) {
      const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
      yCursor += line.gapPx ?? 0;
      const baselineY = yCursor + (line.baseline ?? lh * 0.8);
      const indent = line.indent ?? 0;
      const isList = indent > 0 || !!line.bullet;
      const x = startX + (n.style.align === "left" || isList ? indent : (maxW - line.width) / 2);
      // Trailing whitespace is excluded from line.width (as CSS does when
      // centring), so emitting it would push a centred line off by that much.
      const str = line.segments.map((seg) => seg.text).join("").replace(/\s+$/, "");
      if (str) {
        const pt = Math.max(0.01, (line.segments[0]?.run.fontSize ?? size) * fr.s);
        fontSizes.push(pt);
        cmds.push(
          `/F1 ${f(pt)} Tf`,
          `1 0 0 1 ${f(fr.X(x))} ${f(fr.Y(baselineY))} Tm`,
          `(${pdfStr(str)}) Tj`,
        );
        ops += 3;
      }
      yCursor += lh;
    }
    cmds.push("ET");
    ops += 1;
  };

  const drawImages = (cmds: string[], p: Placed, fr: Frame): void => {
    for (const it of positionedImageSlots(p, p.node, resolveImage).items) {
      const name = xobjByAsset.get(it.id);
      if (!name) continue;
      // cm places the unit square: width 0 0 height x y_bottom.
      cmds.push(
        "q",
        `${f(it.size.w * fr.s)} 0 0 ${f(it.size.h * fr.s)} ${f(fr.X(it.x))} ${f(fr.Y(it.y + it.size.h))} cm`,
        `/${name} Do`,
        "Q",
      );
      ops += 4;
      images++;
    }
  };

  const curveCmd = (b: Bezier3, fr: Frame): string =>
    `${f(fr.X(b.p0.x))} ${f(fr.Y(b.p0.y))} m ${f(fr.X(b.p1.x))} ${f(fr.Y(b.p1.y))} ` +
    `${f(fr.X(b.p2.x))} ${f(fr.Y(b.p2.y))} ${f(fr.X(b.p3.x))} ${f(fr.Y(b.p3.y))} c S`;

  /** One arrowhead, tip at `to`, flaring back along the curve — the same
   *  geometry the canvas and the SVG paint (ARROW_LEN / ARROW_HALF_ANGLE). */
  const arrowHead = (
    cmds: string[],
    from: { x: number; y: number },
    to: { x: number; y: number },
    fr: Frame,
  ): void => {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const ax = to.x - ARROW_LEN * Math.cos(ang - ARROW_HALF_ANGLE);
    const ay = to.y - ARROW_LEN * Math.sin(ang - ARROW_HALF_ANGLE);
    const bx = to.x - ARROW_LEN * Math.cos(ang + ARROW_HALF_ANGLE);
    const by = to.y - ARROW_LEN * Math.sin(ang + ARROW_HALF_ANGLE);
    cmds.push(
      `${f(fr.X(to.x))} ${f(fr.Y(to.y))} m ${f(fr.X(ax))} ${f(fr.Y(ay))} l ${f(fr.X(bx))} ${f(fr.Y(by))} l f`,
    );
    ops += 1;
  };

  /**
   * Does a curve reach into this band?
   *
   * A cubic lies inside the convex hull of its control points, so the hull's
   * vertical extent is a conservative test — it can say yes to a curve that
   * only just misses, which costs four wasted operators and never drops a line
   * that should have been drawn. The earlier version tested the ENDPOINTS
   * instead, which silently lost every long connector passing straight through
   * a band on its way between two distant sheets.
   */
  const curveTouches = (b: Bezier3, top: number, height: number): boolean => {
    const lo = Math.min(b.p0.y, b.p1.y, b.p2.y, b.p3.y);
    const hi = Math.max(b.p0.y, b.p1.y, b.p2.y, b.p3.y);
    return lo < top + height && hi > top;
  };

  const drawRelationship = (
    cmds: string[],
    rel: Relationship,
    a: Placed,
    b: Placed,
    color: string,
    fr: Frame,
  ): Bezier3 | null => {
    const curve = relationshipCurve(a, b);
    const t0r = bezierExitRect(curve, a.x, a.y, a.w, a.h);
    const t1r = bezierEnterRect(curve, b.x, b.y, b.w, b.h);
    const drawn = t1r - t0r > 1e-6 ? bezierSlice(curve, t0r, t1r) : curve;
    cmds.push(
      `${rgb(color)} RG`,
      rel.lineStyle === "dashed" ? "[7 5] 0 d" : rel.lineStyle === "dotted" ? "[2 4] 0 d" : "[] 0 d",
      curveCmd(drawn, fr),
      "[] 0 d",
    );
    ops += 2;
    cmds.push(`${rgb(color)} rg`);
    arrowHead(cmds, drawn.p2, drawn.p3, fr);
    if (rel.bidirectional) arrowHead(cmds, drawn.p1, drawn.p0, fr);
    return drawn;
  };

  // -------------------------------------------------------------------------
  // One content stream per sheet
  // -------------------------------------------------------------------------

  const streams: Uint8Array[] = [];

  if (withIndex) {
    streams.push(zlibSync(latin1(buildIndexPage())));
  }

  for (const pg of pages) {
    // The x mapping does not mention the page: the same world x lands on the
    // same paper x on every sheet. Only y is banded.
    const fr: Frame = {
      s,
      X: (x) => offX + (x - minX) * s,
      Y: (y) => paper.h - margin - (y - pg.top) * s,
    };
    const cmds: string[] = [];
    if (opts.background) {
      cmds.push(`${rgb(opts.background)} rg`, `0 0 ${f(paper.w)} ${f(paper.h)} re f`);
      ops += 2;
    }
    // Clip to the usable area. This is what cuts a straddling topic cleanly in
    // two: the same box is drawn on both sheets and each keeps its own half.
    cmds.push("q", `${f(margin)} ${f(margin)} ${f(usableWpt)} ${f(usableHpt)} re W n`);

    // Connectors first, so every box paints over the line that reaches it.
    cmds.push(`${f(Math.max(0.05, 1.7 * s))} w`);
    for (const p of placed) {
      if (!p.node.parentId) continue;
      const parent = byId.get(p.node.parentId);
      if (!parent) continue;
      const curve = connectorCurve(parent, p, sheet);
      if (!curveTouches(curve, pg.top, pg.height)) continue;
      cmds.push(`${rgb(opts.linkColorOf(p.node.id))} RG`, curveCmd(curve, fr));
      ops += 2;
    }

    for (const rel of sheet.relationships) {
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (!a || !b) continue;
      if (!curveTouches(relationshipCurve(a, b), pg.top, pg.height)) continue;
      const color = opts.relColorOf ? opts.relColorOf(rel.id) : "#4f46e5";
      cmds.push(`${f(Math.max(0.05, 1.5 * s))} w`);
      drawRelationship(cmds, rel, a, b, color, fr);
      cmds.push(`${f(Math.max(0.05, 1.7 * s))} w`);
    }

    for (const p of pg.nodes) {
      const colors = opts.colorOf(p.node.id);
      drawBox(cmds, p, colors?.fill ?? "#ffffff", fr);
      drawImages(cmds, p, fr);
      drawTitle(cmds, p, colors?.text ?? "#111111", fr);
    }

    cmds.push("Q");
    // The sheet number, bottom-centre, outside the clip.
    cmds.push(
      "BT", "0.45 0.45 0.45 rg", `/F1 8 Tf`,
      `1 0 0 1 ${f(paper.w / 2 - 10)} ${f(margin / 2)} Tm`,
      `(${pg.number} / ${pages.length + (withIndex ? 1 : 0)}) Tj`, "ET",
    );
    ops += 3;
    streams.push(zlibSync(latin1(cmds.join("\n"))));
  }

  /**
   * The optional index sheet: the whole map shrunk to fit, with the band cuts
   * ruled across it and each band's page number in the margin.
   *
   * One filled rectangle per topic and NO text or pictures. That is what keeps
   * it cheap — the operator count that stalls a viewer is dominated by text
   * (three operators a line), so an index of an 8,000-topic map is 8,000
   * operators rather than 95,000. It is also the right drawing: at this size a
   * title would be a smudge, and what the reader needs is the shape of the map
   * and a number to turn to.
   */
  function buildIndexPage(): string {
    const fit = Math.min(usableWpt / worldW, usableHpt / worldH);
    const iOffX = margin + (usableWpt - worldW * fit) / 2;
    const iOffY = margin + (usableHpt - worldH * fit) / 2;
    const X = (x: number): number => iOffX + (x - minX) * fit;
    const Y = (y: number): number => paper.h - iOffY - (y - minY) * fit;
    const cmds: string[] = [];
    if (opts.background) cmds.push(`${rgb(opts.background)} rg`, `0 0 ${f(paper.w)} ${f(paper.h)} re f`);

    for (const p of placed) {
      const fill = opts.colorOf(p.node.id)?.fill ?? "#ffffff";
      cmds.push(
        `${rgb(fill)} rg`,
        `${f(X(p.x))} ${f(Y(p.y + p.h))} ${f(Math.max(0.4, p.w * fit))} ${f(Math.max(0.4, p.h * fit))} re f`,
      );
    }

    // Only horizontal rules: the map is never cut vertically.
    cmds.push("0.55 0.55 0.6 RG", "0.4 w", "[2 2] 0 d");
    for (let band = 1; band < pages.length; band++) {
      const wy = minY + band * bandH;
      cmds.push(`${f(X(minX))} ${f(Y(wy))} m ${f(X(maxX))} ${f(Y(wy))} l S`);
    }
    cmds.push("[] 0 d");

    cmds.push("BT", "0.25 0.25 0.3 rg", "/F1 9 Tf");
    for (const pg of pages) {
      cmds.push(`1 0 0 1 ${f(X(minX) - 18)} ${f(Y(pg.top + pg.height / 2))} Tm`, `(${pg.number}) Tj`);
    }
    cmds.push("ET");
    cmds.push(
      "BT", "0.35 0.35 0.4 rg", "/F1 10 Tf",
      `1 0 0 1 ${f(margin)} ${f(paper.h - margin + 4)} Tm`,
      `(${pdfStr(`${placed.length} topics on ${pages.length} sheets, read top to bottom`)}) Tj`,
      "ET",
    );
    return cmds.join("\n");
  }

  // -------------------------------------------------------------------------
  // Assemble
  // -------------------------------------------------------------------------

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const put = (u: Uint8Array): void => { chunks.push(u); pos += u.length; };
  const putStr = (str: string): void => put(latin1(str));
  const obj = (n: number, body: string, data?: Uint8Array): void => {
    offsets[n] = pos;
    putStr(`${n} 0 obj\n${body}\n`);
    if (data) { putStr("stream\n"); put(data); putStr("\nendstream\n"); }
    putStr("endobj\n");
  };

  const ID_CATALOG = 1, ID_PAGES = 2, ID_FONT = 3;
  let next = 4;
  const imgIds = xobjects.map(() => next++);
  const sheetIds = streams.map(() => ({ page: next++, content: next++ }));
  const objCount = next;

  const xobjDict = xobjects.map((x, i) => `/${x.name} ${imgIds[i]} 0 R`).join(" ");

  putStr("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  obj(ID_CATALOG, `<< /Type /Catalog /Pages ${ID_PAGES} 0 R >>`);
  obj(
    ID_PAGES,
    `<< /Type /Pages /Kids [${sheetIds.map((p) => `${p.page} 0 R`).join(" ")}] /Count ${sheetIds.length} >>`,
  );
  obj(ID_FONT, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  xobjects.forEach((x, i) => {
    obj(
      imgIds[i],
      `<< /Type /XObject /Subtype /Image /Width ${x.w} /Height ${x.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${x.bytes.length} >>`,
      x.bytes,
    );
  });
  streams.forEach((stream, i) => {
    obj(
      sheetIds[i].page,
      `<< /Type /Page /Parent ${ID_PAGES} 0 R /MediaBox [0 0 ${f(paper.w)} ${f(paper.h)}] ` +
        `/Resources << /Font << /F1 ${ID_FONT} 0 R >> /XObject << ${xobjDict} >> >> ` +
        `/Contents ${sheetIds[i].content} 0 R >>`,
    );
    obj(sheetIds[i].content, `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream);
  });

  const xrefAt = pos;
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
  for (let i = 1; i < objCount; i++) xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  putStr(xref);
  putStr(`trailer\n<< /Size ${objCount} /Root ${ID_CATALOG} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const blob = new Blob(chunks as BlobPart[], { type: "application/pdf" });

  // Read every stream back. The container passed every structural check while
  // its content stream was raw deflate instead of zlib, and the file rendered
  // blank: valid xref, correct offsets, right MediaBox, nothing visible. Only
  // decompressing what was just written catches that — and with pages there is
  // a second failure it catches, a sheet that decodes but draws nothing.
  let selfCheck: { ok: boolean; detail: string };
  try {
    let drawn = 0;
    let blank = 0;
    for (const stream of streams) {
      const back = new TextDecoder("latin1").decode(unzlibSync(stream));
      const here = (back.match(/(?:^| )(re f|c S|l S|Tj|Do|c f|l f)$/gm) ?? []).length;
      if (here === 0) blank++;
      drawn += here;
    }
    selfCheck =
      blank === 0 && drawn > 0
        ? { ok: true, detail: `${streams.length} sheets decompress; ${drawn.toLocaleString()} drawing operators` }
        : { ok: false, detail: `${blank} of ${streams.length} sheets decode but draw nothing` };
  } catch (e) {
    selfCheck = { ok: false, detail: `a content stream does not decompress: ${String(e)} — that sheet will be blank` };
  }

  const streamBytes = streams.reduce((sum, s2) => sum + s2.length, 0);
  const minFontPt = Math.min(...fontSizes, Infinity);
  const report = buildReport({
    format: "pdf",
    sheet,
    ms: performance.now() - t0,
    bytes: blob.size,
    emitted: {
      nodes: placed.length,
      images,
      relationships: sheet.relationships.filter((r) => byId.has(r.fromId) && byId.has(r.toId)).length,
      boundaries: 0,
      summaries: 0,
    },
    // Declared, not detected: an exporter cannot notice what it never thought
    // of, so it lists what it covers and the gap is computed against the
    // document. Everything absent here is a known omission — see the header.
    honoured: ["fill", "textColor", "fontSize", "cornerRadius", "image", "imageWidth", "align", "width", "height"],
    units: {
      operators: ops,
      streamBytes,
      imageBytes: xobjects.reduce((sum, x) => sum + x.bytes.length, 0),
      pages: streams.length,
      mapPages: pages.length,
      pageW: Math.round(paper.w),
      pageH: Math.round(paper.h),
      // The fitted scale, and how much of true size that is. A map wider than
      // the sheet buys its full width with everything getting smaller, and this
      // is the number that says by how much.
      ptPerUnit: Math.round(s * 1e4) / 1e4,
      percentOfTrueSize: Math.round((s / PT_PER_UNIT) * 100),
      splitAcrossSheets: split,
      imagesMissing,
      minFontPt: Math.round(minFontPt * 1000) / 1000,
    },
    // The scale is derived from the page width, so on a wide map this CAN fall
    // to something unreadable — the check is what tells the caller to reach for
    // a bigger sheet, and it is fed the real size with nothing optimistic in it.
    minEffectiveFontPt: Number.isFinite(minFontPt) ? minFontPt : undefined,
    selfCheck,
  });
  void publishReport(report);

  return {
    blob,
    nodes: placed.length,
    images,
    ops,
    bytes: blob.size,
    pages: streams.length,
    mapPages: pages.length,
    scale: s,
    split,
    pageW: paper.w,
    pageH: paper.h,
    ms: Math.round(performance.now() - t0),
    report,
  };
}

/** A single blank sheet, for a map with nothing on it. */
function emptyPdf(paper: { w: number; h: number }): Uint8Array {
  const body =
    "%PDF-1.7\n" +
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${paper.w} ${paper.h}] >>\nendobj\n` +
    "trailer\n<< /Size 4 /Root 1 0 R >>\n%%EOF\n";
  return latin1(body);
}
