/**
 * SVG export — the whole map as one vector document.
 *
 * Why vector, and why the whole thing. A 3,000-node map measures roughly
 * 4,400 × 250,000 world units: an aspect ratio of 1 to 57. Squeezing that into
 * a raster of any sane size puts 14px text at half a pixel, and a mind map is
 * not a picture anyway — it is a tree, read by navigating. SVG makes the
 * resolution question disappear: the file carries coordinates, the viewer
 * decides the zoom, and the text stays text (searchable, selectable, and a few
 * bytes instead of a few thousand pixels).
 *
 * This is a THIRD implementation of text layout after the canvas and the
 * editing overlay, which is exactly the risk the parity work was about. It is
 * mitigated by construction: the line boxes, baselines, bullets and paragraph
 * gaps all come from `wrapRunLines`, the same function the other two use. This
 * file only turns them into `<text>` elements — it decides nothing about where
 * a line breaks or how tall it is.
 *
 * Pure and framework-free, like the layout modules: sheet in, string out.
 * Everything environment-specific arrives through the options — measurement,
 * colours, image bytes — so it runs in Node under a heuristic measurer and in
 * the browser under the canvas one.
 */
import type { MindNode, Relationship, Sheet, TextRun } from "../core/types";
import { nodeRuns } from "../core/text";
import { positionedImageSlots } from "../layout/measure";
import { buildReport, publishReport, type ExportReport } from "./report";
import {
  ARROW_HALF_ANGLE,
  ARROW_LEN,
  FONT_STACK,
  GALLERY_CAPTION_LINE_H,
  GALLERY_CAPTION_SIZE,
  LINE_HEIGHT_FACTOR,
  TEXT_INSET,
  bezierEnterRect,
  bezierExitRect,
  bezierSlice,
  captionLines,
  imageResolver,
  measureNode,
  wrapRunLines,
  type Bezier3,
  type TextMeasurer,
} from "../layout/measure";

export interface SvgExportOptions {
  measurer: TextMeasurer;
  /**
   * Fill and text colour per node, resolved by the RENDERER. Branch palettes
   * live there; recomputing them here would be a second source of truth that
   * drifts the first time a theme changes.
   */
  colorOf: (nodeId: string) => { fill: string; text: string } | null;
  /** Connector colour for a child node (its branch colour). */
  linkColorOf: (nodeId: string) => string;
  /** Colour for a relationship (its own, else the theme's accent). */
  relColorOf?: (relId: string) => string;
  /** Page background. Pass null for a transparent document. */
  background: string | null;
  /**
   * `data:` URI for an image asset, or null when it cannot be read. Async
   * because the bytes live in the asset store; every image is fetched exactly
   * once even when several nodes share it.
   */
  imageDataUri?: (assetId: string) => Promise<string | null>;
  /** Margin around the drawing, in world units. */
  pad?: number;
}

interface Placed {
  node: MindNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Trim to 3 decimals and drop the trailing zeros — a 60% smaller file on big maps. */
const n3 = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
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

/** The node outline, in the same geometry the canvas paints. */
function shapeOf(p: Placed, fill: string): string {
  const { x, y, w, h } = p;
  const s = p.node.style;
  const shape = s.shape ?? "rounded";
  const f = ` fill="${esc(fill)}"`;
  switch (shape) {
    case "none":
      return "";
    case "circle":
      return `<ellipse cx="${n3(x + w / 2)}" cy="${n3(y + h / 2)}" rx="${n3(w / 2)}" ry="${n3(h / 2)}"${f}/>`;
    case "diamond":
      return `<polygon points="${n3(x + w / 2)},${n3(y)} ${n3(x + w)},${n3(y + h / 2)} ${n3(x + w / 2)},${n3(y + h)} ${n3(x)},${n3(y + h / 2)}"${f}/>`;
    case "hexagon": {
      const c = Math.min(w / 4, h / 2);
      return `<polygon points="${n3(x + c)},${n3(y)} ${n3(x + w - c)},${n3(y)} ${n3(x + w)},${n3(y + h / 2)} ${n3(x + w - c)},${n3(y + h)} ${n3(x + c)},${n3(y + h)} ${n3(x)},${n3(y + h / 2)}"${f}/>`;
    }
    case "rect":
      return `<rect x="${n3(x)}" y="${n3(y)}" width="${n3(w)}" height="${n3(h)}"${f}/>`;
    default: {
      const r = s.cornerRadius ?? 8;
      return `<rect x="${n3(x)}" y="${n3(y)}" width="${n3(w)}" height="${n3(h)}" rx="${n3(r)}"${f}/>`;
    }
  }
}

/**
 * The connector, with the renderer's exact control points — a curve that
 * merely looks similar would show up as every line meeting its box at a
 * slightly wrong angle.
 */
function connector(parent: Placed, child: Placed, sheet: Sheet, color: string): string {
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
  const cp1x = sx + (childLeft ? -dx * 0.45 : dx * 0.45);
  const cp2x = ex + (childLeft ? dx * 0.45 : -dx * 0.45);
  return `<path d="M${n3(sx)},${n3(sy)}C${n3(cp1x)},${n3(sy)} ${n3(cp2x)},${n3(ey)} ${n3(ex)},${n3(ey)}" fill="none" stroke="${esc(color)}" stroke-width="1.7"/>`;
}

/** One arrowhead, tip at (toX, toY), flaring back toward the curve — the
 *  same geometry the canvas paints (ARROW_LEN / ARROW_HALF_ANGLE are shared
 *  in measure.ts, I9). */
function arrowHead(fromX: number, fromY: number, toX: number, toY: number, color: string): string {
  const ang = Math.atan2(toY - fromY, toX - fromX);
  return (
    `<polygon points="${n3(toX)},${n3(toY)} ` +
    `${n3(toX - ARROW_LEN * Math.cos(ang - ARROW_HALF_ANGLE))},${n3(toY - ARROW_LEN * Math.sin(ang - ARROW_HALF_ANGLE))} ` +
    `${n3(toX - ARROW_LEN * Math.cos(ang + ARROW_HALF_ANGLE))},${n3(toY - ARROW_LEN * Math.sin(ang + ARROW_HALF_ANGLE))}" ` +
    `fill="${esc(color)}"/>`
  );
}

/**
 * A relationship, mirroring the renderer's drawRelationship: the same Bezier,
 * truncated at exactly the two box borders, with arrowheads whose tip sits on
 * the crossing and whose angle is the curve's real tangent there. A head that
 * merely points at the centre would disagree with the line the moment the
 * curve bends; and both exports must compute the same tip or they diverge.
 */
function relationship(rel: Relationship, byId: Map<string, Placed>, color: string): string {
  const a = byId.get(rel.fromId);
  const b = byId.get(rel.toId);
  if (!a || !b) return "";
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const curve: Bezier3 = {
    p0: { x: ax, y: ay },
    p1: { x: ax + (bx - ax) * 0.35, y: ay },
    p2: { x: bx - (bx - ax) * 0.35, y: by },
    p3: { x: bx, y: by },
  };
  const t0 = bezierExitRect(curve, a.x, a.y, a.w, a.h);
  const t1 = bezierEnterRect(curve, b.x, b.y, b.w, b.h);
  const drawn = t1 - t0 > 1e-6 ? bezierSlice(curve, t0, t1) : curve;
  const dash =
    rel.lineStyle === "dashed" ? ` stroke-dasharray="7 5"` : rel.lineStyle === "dotted" ? ` stroke-dasharray="2 4"` : "";
  const parts = [
    `<path d="M${n3(drawn.p0.x)},${n3(drawn.p0.y)}C${n3(drawn.p1.x)},${n3(drawn.p1.y)} ${n3(drawn.p2.x)},${n3(drawn.p2.y)} ${n3(drawn.p3.x)},${n3(drawn.p3.y)}" fill="none" stroke="${esc(color)}" stroke-width="1.5"${dash}/>`,
  ];
  parts.push(arrowHead(drawn.p2.x, drawn.p2.y, drawn.p3.x, drawn.p3.y, color));
  if (rel.bidirectional) {
    parts.push(arrowHead(drawn.p1.x, drawn.p1.y, drawn.p0.x, drawn.p0.y, color));
  }
  if (rel.label) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    // Width is estimated (the canvas measures it); close enough for a chip.
    const w = rel.label.length * 7 + 10;
    parts.push(`<rect x="${n3(mx - w / 2)}" y="${n3(my - 10)}" width="${n3(w)}" height="20" fill="#ffffff"/>`);
    parts.push(
      `<text x="${n3(mx)}" y="${n3(my + 0.5)}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="600" fill="${esc(color)}">${esc(rel.label)}</text>`
    );
  }
  return parts.join("");
}

/**
 * The title, as one `<text>` per segment placed on its own baseline.
 *
 * This loop is a transcription of the renderer's: same maxW, same gap-then-
 * baseline order, same left-vs-centre rule, same rule that a list item is
 * always left aligned. Deviating anywhere here reintroduces exactly the
 * divergence the parity harness was built to close.
 */
function title(
  p: Placed,
  color: string,
  pos: ReturnType<typeof positionedImageSlots>,
  measurer: TextMeasurer,
): string {
  const n = p.node;
  const size = n.style.fontSize ?? 14;
  const pad = n.style.padding ?? 10;
  // Same wrap width as the canvas drawText: side images shrink it.
  const maxW = Math.max(20, p.w - pad * 2 - TEXT_INSET - pos.sidePadW);
  const lines = wrapRunLines(nodeRuns(n.title, n.titleRuns), maxW, measurer, n.style);
  if (lines.length === 0) return "";

  let totalH = 0;
  for (const line of lines) totalH += (line.height ?? size * LINE_HEIGHT_FACTOR) + (line.gapPx ?? 0);

  // Same placement as the canvas drawText: the middle column, between the
  // top/bottom images and the side ones.
  //
  // Read from the INSETS, not by re-deriving the blocks from the slots. The
  // two agreed exactly while images were the only thing that reserved space,
  // which is why the duplicate survived; a gallery grid also reserves from the
  // bottom, and only the insets know that. The canvas drawText already reads
  // them for the same reason.
  const topBlock = pos.insets.top;
  const botBlock = pos.insets.bottom;
  const midH = topBlock + totalH + botBlock;
  const startY = p.y + pad + topBlock + Math.max(0, (p.h - pad * 2 - midH) / 2);
  const startX = p.x + pad + pos.insets.left;

  const baseWeight = n.style.fontWeight ?? 400;
  const nodeItalic = n.style.italic ?? false;
  const strike = n.style.strikethrough ?? false;
  const nodeUnderline = n.style.underline ?? false;

  const attrs = (run: TextRun): { size: number; weight: number; italic: boolean } => {
    const bold = (run.bold ?? false) || baseWeight >= 700;
    return {
      size: run.fontSize ?? size,
      weight: bold ? 700 : baseWeight,
      italic: (run.italic ?? false) || nodeItalic,
    };
  };
  /** The style attributes that decide whether two runs can share a tspan. */
  const styleKey = (run: TextRun): string => {
    const a = attrs(run);
    return `${a.size}|${a.weight}|${a.italic ? 1 : 0}|${run.color ?? color}|${(run.underline ?? false) || nodeUnderline ? 1 : 0}`;
  };
  const spanAttrs = (run: TextRun): string => {
    const a = attrs(run);
    const deco = [(run.underline ?? false) || nodeUnderline ? "underline" : "", strike ? "line-through" : ""]
      .filter(Boolean)
      .join(" ");
    return (
      ` font-size="${n3(a.size)}"` +
      (a.weight !== 400 ? ` font-weight="${a.weight}"` : "") +
      (a.italic ? ` font-style="italic"` : "") +
      ` fill="${esc(run.color ?? color)}"` +
      (deco ? ` text-decoration="${deco}"` : "")
    );
  };

  /**
   * One `<text>` per line, with a `<tspan>` per style change — NOT one element
   * per token with an x we computed.
   *
   * `wrapRunLines` returns a segment per token (spaces included), so the
   * per-token version had to place each word at a measured advance. That
   * bakes OUR font metrics into the file, and the file is rendered by someone
   * else's font engine: any disagreement shows up as widening gaps between
   * words, accumulating along the line. Letting the SVG renderer space a line
   * it is drawing anyway removes the whole class of error — our only claim is
   * where the line STARTS.
   *
   * xml:space="preserve" is required: the spaces are their own segments, and
   * SVG collapses whitespace without it.
   */
  const lineText = (segs: { text: string; run: TextRun }[], x: number, y: number): string => {
    if (segs.length === 0) return "";
    const parts: string[] = [];
    let i = 0;
    while (i < segs.length) {
      const key = styleKey(segs[i].run);
      let text = "";
      const run = segs[i].run;
      while (i < segs.length && styleKey(segs[i].run) === key) text += segs[i++].text;
      if (text) parts.push(`<tspan${spanAttrs(run)}>${esc(text)}</tspan>`);
    }
    return `<text x="${n3(x)}" y="${n3(y)}" xml:space="preserve">${parts.join("")}</text>`;
  };

  const out: string[] = [];
  let yCursor = startY;
  for (const line of lines) {
    const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
    yCursor += line.gapPx ?? 0;
    const baselineY = yCursor + (line.baseline ?? lh * 0.8);
    const indent = line.indent ?? 0;
    if (line.bullet) {
      out.push(lineText([{ text: line.bullet.char, run: line.bullet.run }], startX + line.bullet.x, baselineY));
    }
    const isList = indent > 0 || !!line.bullet;
    const x = startX + (n.style.align === "left" || isList ? indent : (maxW - line.width) / 2);
    // Trailing whitespace is excluded from line.width (as CSS does when
    // centering), so emitting it would push a centred line off by that much.
    const segs = [...line.segments];
    while (segs.length > 0 && segs[segs.length - 1].text.trim() === "") segs.pop();
    out.push(lineText(segs, x, baselineY));
    yCursor += lh;
  }
  return out.join("");
}

export interface SvgExportResult {
  svg: string;
  nodes: number;
  images: number;
  /** Images referenced but not readable — reported, never silently dropped. */
  imagesMissing: number;
  width: number;
  height: number;
  /** Self-audit: coverage, declared gaps, threshold warnings. */
  report: ExportReport;
  /** Total size, and how much of it is embedded image data. Reported because
   *  on a picture-heavy map the images ARE the file: an export measured at
   *  110MB turned out to be 103MB of base64. */
  bytes: number;
  imageBytes: number;
}

/**
 * Read the document back.
 *
 * A file that does not parse renders as nothing, and "nothing" is
 * indistinguishable from "empty map" until a person opens it — which is how a
 * blank PDF reached the user tonight while every structural check passed.
 * Also asserts the drawing is inside the viewBox: geometry outside it is
 * invisible without being malformed.
 */
function selfCheckSvg(svg: string, minX: number, minY: number, w: number, h: number): { ok: boolean; detail: string } {
  if (typeof DOMParser === "undefined") return { ok: true, detail: "not attempted (no DOMParser)" };
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const err = doc.querySelector("parsererror");
  if (err) return { ok: false, detail: `XML does not parse: ${err.textContent?.slice(0, 160) ?? "?"}` };
  let outside = 0;
  for (const r of Array.from(doc.querySelectorAll("rect, image"))) {
    const x = Number(r.getAttribute("x") ?? 0);
    const y = Number(r.getAttribute("y") ?? 0);
    if (x < minX - 1 || y < minY - 1 || x > minX + w + 1 || y > minY + h + 1) outside++;
  }
  return outside === 0
    ? { ok: true, detail: "parses; all geometry inside the viewBox" }
    : { ok: false, detail: `${outside} shapes outside the viewBox — invisible when opened` };
}

export async function sheetToSvg(sheet: Sheet, opts: SvgExportOptions): Promise<SvgExportResult> {
  const t0 = performance.now();
  const pad = opts.pad ?? 40;
  const placed = placeAll(sheet, opts.measurer);
  if (placed.length === 0) {
    const empty = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`;
    const report = buildReport({ format: "svg", sheet, ms: 0, bytes: empty.length, emitted: {}, honoured: [], units: {} });
    return { svg: empty, nodes: 0, images: 0, imagesMissing: 0, width: 1, height: 1, bytes: empty.length, imageBytes: 0, report };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placed) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + p.w > maxX) maxX = p.x + p.w;
    if (p.y + p.h > maxY) maxY = p.y + p.h;
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const width = maxX - minX;
  const height = maxY - minY;

  // Every distinct asset is fetched once, however many nodes point at it.
  const resolveImage = imageResolver(sheet);
  const uris = new Map<string, string | null>();
  let imageBytes = 0;
  if (opts.imageDataUri) {
    const ids = new Set<string>();
    for (const p of placed) {
      for (const it of positionedImageSlots(p, p.node, resolveImage).items) ids.add(it.id);
    }
    for (const id of ids) {
      const uri = await opts.imageDataUri(id);
      uris.set(id, uri);
      if (uri) imageBytes += uri.length;
    }
  }

  const byId = new Map(placed.map((p) => [p.node.id, p]));
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${n3(width)}" height="${n3(height)}" viewBox="${n3(minX)} ${n3(minY)} ${n3(width)} ${n3(height)}" ` +
      `font-family="${esc(FONT_STACK)}" text-rendering="optimizeLegibility">`
  );
  if (opts.background) {
    parts.push(`<rect x="${n3(minX)}" y="${n3(minY)}" width="${n3(width)}" height="${n3(height)}" fill="${esc(opts.background)}"/>`);
  }

  // Connectors first, then relationships, so every box paints over the line
  // that reaches it — the arrowheads sit at the borders and stay visible.
  parts.push("<g>");
  for (const p of placed) {
    if (!p.node.parentId) continue;
    const parent = byId.get(p.node.parentId);
    if (parent) parts.push(connector(parent, p, sheet, opts.linkColorOf(p.node.id)));
  }
  parts.push("</g>");

  let relationships = 0;
  if (sheet.relationships.length > 0) {
    parts.push("<g>");
    for (const rel of sheet.relationships) {
      const color = opts.relColorOf ? opts.relColorOf(rel.id) : "#4f46e5";
      const el = relationship(rel, byId, color);
      if (el) {
        parts.push(el);
        relationships++;
      }
    }
    parts.push("</g>");
  }

  let images = 0;
  let imagesMissing = 0;
  for (const p of placed) {
    const n = p.node;
    const colors = opts.colorOf(n.id);
    const fill = colors?.fill ?? "#ffffff";
    const text = colors?.text ?? "#1a1a1a";
    parts.push(`<g>`);
    const shape = shapeOf(p, fill);
    if (shape) parts.push(shape);

    const pos = positionedImageSlots(p, n, resolveImage);
    for (const it of pos.items) {
      const uri = uris.get(it.id) ?? null;
      if (uri) {
        parts.push(`<image x="${n3(it.x)}" y="${n3(it.y)}" width="${n3(it.size.w)}" height="${n3(it.size.h)}" href="${uri}" preserveAspectRatio="none"/>`);
        images++;
      } else {
        // The box still occupies its space: dropping it would reflow nothing
        // (the layout already accounted for it) but would leave a silent hole.
        parts.push(`<rect x="${n3(it.x)}" y="${n3(it.y)}" width="${n3(it.size.w)}" height="${n3(it.size.h)}" fill="none" stroke="${esc(text)}" stroke-opacity="0.25" stroke-dasharray="4 3"/>`);
        imagesMissing++;
      }
    }
    // Gallery cells (T25). "slice" is SVG's own cover: the picture scales to
    // fill the cell and the overflow is clipped to the <image> viewport, which
    // is exactly the centred square crop the canvas computes — expressed once,
    // by the renderer that has it built in, instead of arithmetic that could
    // drift from the canvas's.
    for (const c of pos.cells) {
      const uri = uris.get(c.id) ?? null;
      if (uri) {
        parts.push(
          `<image x="${n3(c.x)}" y="${n3(c.y)}" width="${n3(c.w)}" height="${n3(c.h)}" href="${uri}" preserveAspectRatio="xMidYMid slice"/>`
        );
        images++;
      } else {
        parts.push(
          `<rect x="${n3(c.x)}" y="${n3(c.y)}" width="${n3(c.w)}" height="${n3(c.h)}" fill="none" stroke="${esc(text)}" stroke-opacity="0.25" stroke-dasharray="4 3"/>`
        );
        imagesMissing++;
      }
      if (c.caption && c.captionH > 0) {
        // Centred under the cell, on the caption band's own baselines. The
        // wrap is NOT decided here: `captionLines` is the one function the
        // canvas, this export and the PDF all ask, so one document cannot
        // break a file name in three places. One <text> per line rather than
        // tspans — the lines are independent, centred, and a tspan dy would
        // re-derive the pitch the shared constant already owns.
        const lines = captionLines(c.caption, c.w, (s) =>
          opts.measurer.measure(s, { fontSize: GALLERY_CAPTION_SIZE, fontFamily: FONT_STACK }).width
        );
        for (let i = 0; i < lines.length; i++) {
          const y = c.captionY + GALLERY_CAPTION_SIZE + i * GALLERY_CAPTION_LINE_H;
          parts.push(
            `<text x="${n3(c.x + c.w / 2)}" y="${n3(y)}" font-family="${esc(FONT_STACK)}" font-size="${n3(GALLERY_CAPTION_SIZE)}" fill="${esc(text)}" fill-opacity="0.7" text-anchor="middle">${esc(lines[i])}</text>`
          );
        }
      }
    }
    parts.push(title(p, text, pos, opts.measurer));
    parts.push(`</g>`);
  }
  parts.push("</svg>");

  const svg = parts.join("");
  const elements = (svg.match(/<(text|tspan|path|rect|ellipse|polygon|image|g)[ />]/g) ?? []).length;
  const report = buildReport({
    format: "svg",
    sheet,
    ms: performance.now() - t0,
    bytes: svg.length,
    emitted: { nodes: placed.length, images, relationships, boundaries: 0, summaries: 0 },
    // Declared, not detected: an exporter cannot notice what it never thought
    // of, so it lists what it covers and the gap is computed against the
    // document. Everything absent here is a known omission.
    honoured: ["fill", "textColor", "fontSize", "fontWeight", "italic", "underline", "shape", "cornerRadius", "image", "imageWidth", "align", "width", "height"],
    units: { elements, imageBytes },
    // The document is parsed back: an SVG that does not parse renders as
    // nothing, which is exactly how the PDF failure stayed invisible.
    selfCheck: selfCheckSvg(svg, minX, minY, width, height),
  });
  void publishReport(report);
  return { svg, nodes: placed.length, images, imagesMissing, width, height, bytes: svg.length, imageBytes, report };
}
