/**
 * THROWAWAY PROBE — delete once it has answered its question.
 *
 * The question: an SVG of the whole map is slow to pan and zoom, and dropping
 * the file from 110MB to 10MB changed nothing, so the cost is the ~95,000 DOM
 * nodes and not the bytes. A PDF viewer does not build a DOM: it reads a
 * compressed stream of drawing commands and hands them to native routines. Is
 * that actually fast at this size, or does it stall like the DOM does?
 *
 * This answers ONLY that. It is deliberately wrong in ways that do not change
 * the operation count:
 *   - Helvetica, one of the 14 fonts every viewer has, so nothing is embedded.
 *     R-node measures with Segoe UI, so line breaks here will not match the
 *     canvas exactly. Irrelevant to "how many commands and how fast".
 *   - No relationships, groups, summaries or style properties, same as the SVG.
 *
 * If the PDF scrolls, the real exporter is worth building and the font question
 * has to be settled properly. If it stalls too, we learned that in an hour
 * instead of a week, and the answer is a tile pyramid.
 */
// zlibSync, NOT deflateSync: /FlateDecode means zlib (RFC 1950), and fflate's
// deflateSync emits RAW deflate with no header. A viewer cannot decode that, so
// it renders nothing — a completely blank page from a file whose structure,
// xref and offsets are all perfectly valid.
import { zlibSync } from "fflate";
import type { MindNode, Sheet } from "../core/types";
import { nodeRuns } from "../core/text";
import {
  IMAGE_GAP,
  LINE_HEIGHT_FACTOR,
  MAX_IMAGE_W,
  TEXT_INSET,
  imageResolver,
  measureNode,
  wrapRunLines,
  type TextMeasurer,
} from "../layout/measure";

/** Acrobat and Chrome stop being reliable past 14,400 units on a side. */
const MAX_PAGE_UNITS = 14_400;

interface Placed { node: MindNode; x: number; y: number; w: number; h: number }

const latin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** PDF string literal: only these three bytes are special. */
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

function placeAll(sheet: Sheet, measurer: TextMeasurer): Placed[] {
  const resolveImage = imageResolver(sheet);
  const out: Placed[] = [];
  const seen = new Set<string>();
  const queue = [sheet.rootNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const n = sheet.nodes[id];
    if (!n || seen.has(id)) continue;
    seen.add(id);
    const m = measureNode(n, measurer, resolveImage);
    out.push({ node: n, x: n.position.x, y: n.position.y, w: m.w, h: m.h });
    if (!n.collapsed) queue.push(...n.childrenIds);
  }
  return out;
}

export interface PdfProbeOptions {
  measurer: TextMeasurer;
  colorOf: (id: string) => { fill: string; text: string } | null;
  linkColorOf: (id: string) => string;
  /** Raw JPEG bytes for an asset. Only JPEG: it embeds as-is via DCTDecode,
   *  while PNG would need its IDAT unpacked — not worth it for a probe. */
  jpegBytes?: (assetId: string) => Promise<{ bytes: Uint8Array; w: number; h: number } | null>;
}

export interface PdfProbeResult {
  blob: Blob;
  nodes: number;
  images: number;
  /** Drawing operators in the content stream: the number under test. */
  ops: number;
  bytes: number;
  streamBytes: number;
  pageW: number;
  pageH: number;
  scale: number;
  ms: number;
}

export async function sheetToPdf(sheet: Sheet, opts: PdfProbeOptions): Promise<PdfProbeResult> {
  const t0 = performance.now();
  const placed = placeAll(sheet, opts.measurer);
  const resolveImage = imageResolver(sheet);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
  }
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const scale = Math.min(1, MAX_PAGE_UNITS / Math.max(worldW, worldH));
  const pageW = worldW * scale;
  const pageH = worldH * scale;

  // World Y grows down, PDF Y grows up. Flipping per coordinate rather than
  // with a global matrix keeps the text upright.
  const X = (x: number): number => (x - minX) * scale;
  const Y = (y: number): number => pageH - (y - minY) * scale;
  const f = (v: number): string => (Math.round(v * 100) / 100).toString();

  const cmds: string[] = [];
  let ops = 0;

  // --- connectors -----------------------------------------------------------
  const byId = new Map(placed.map((p) => [p.node.id, p]));
  cmds.push("1.7 w");
  for (const p of placed) {
    if (!p.node.parentId) continue;
    const parent = byId.get(p.node.parentId);
    if (!parent) continue;
    const childLeft = p.x + p.w / 2 < parent.x + parent.w / 2;
    const sx = childLeft ? parent.x : parent.x + parent.w;
    const sy = parent.y + parent.h / 2;
    const ex = childLeft ? p.x + p.w : p.x;
    const ey = p.y + p.h / 2;
    const dx = Math.abs(ex - sx);
    const c1 = sx + (childLeft ? -dx * 0.45 : dx * 0.45);
    const c2 = ex + (childLeft ? dx * 0.45 : -dx * 0.45);
    cmds.push(
      `${rgb(opts.linkColorOf(p.node.id))} RG`,
      `${f(X(sx))} ${f(Y(sy))} m ${f(X(c1))} ${f(Y(sy))} ${f(X(c2))} ${f(Y(ey))} ${f(X(ex))} ${f(Y(ey))} c S`
    );
    ops += 2;
  }

  // --- images ---------------------------------------------------------------
  const xobjects: { name: string; bytes: Uint8Array; w: number; h: number }[] = [];
  const xobjByAsset = new Map<string, string>();
  if (opts.jpegBytes) {
    const ids = new Set<string>();
    for (const p of placed) if (p.node.style.image) ids.add(p.node.style.image);
    for (const id of ids) {
      const jpg = await opts.jpegBytes(id);
      if (!jpg) continue;
      const name = `Im${xobjects.length}`;
      xobjects.push({ name, bytes: jpg.bytes, w: jpg.w, h: jpg.h });
      xobjByAsset.set(id, name);
    }
  }

  // --- boxes, pictures and text --------------------------------------------
  let images = 0;
  for (const p of placed) {
    const n = p.node;
    const colors = opts.colorOf(n.id);
    const fill = colors?.fill ?? "#ffffff";
    const text = colors?.text ?? "#111111";

    if ((n.style.shape ?? "rounded") !== "none") {
      cmds.push(`${rgb(fill)} rg`, `${f(X(p.x))} ${f(Y(p.y + p.h))} ${f(p.w * scale)} ${f(p.h * scale)} re f`);
      ops += 2;
    }

    let imgH = 0;
    const assetId = n.style.image;
    if (assetId) {
      const att = resolveImage(assetId);
      const name = xobjByAsset.get(assetId);
      if (att && att.w > 0) {
        const imgW = n.style.imageWidth ?? Math.min(att.w, MAX_IMAGE_W);
        imgH = (imgW * att.h) / att.w;
        if (name) {
          const ix = p.x + (p.w - imgW) / 2;
          const iy = p.y + (n.style.padding ?? 10);
          // cm places the unit square: width 0 0 height x y_bottom
          cmds.push(
            "q",
            `${f(imgW * scale)} 0 0 ${f(imgH * scale)} ${f(X(ix))} ${f(Y(iy + imgH))} cm`,
            `/${name} Do`,
            "Q"
          );
          ops += 4;
          images++;
        }
      }
    }

    // Text, transcribed from the renderer's loop (same maxW, same baselines).
    const size = n.style.fontSize ?? 14;
    const padNode = n.style.padding ?? 10;
    const maxW = Math.max(20, p.w - padNode * 2 - TEXT_INSET);
    const lines = wrapRunLines(nodeRuns(n.title, n.titleRuns), maxW, opts.measurer, n.style);
    if (lines.length === 0) continue;
    let totalH = 0;
    for (const line of lines) totalH += (line.height ?? size * LINE_HEIGHT_FACTOR) + (line.gapPx ?? 0);
    const startY =
      imgH > 0
        ? p.y + padNode + imgH + IMAGE_GAP + Math.max(0, (p.h - padNode * 2 - imgH - IMAGE_GAP - totalH) / 2)
        : p.y + p.h / 2 - totalH / 2;
    const startX = p.x + padNode;

    cmds.push("BT", `${rgb(text)} rg`);
    ops += 2;
    let yCursor = startY;
    for (const line of lines) {
      const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
      yCursor += line.gapPx ?? 0;
      const baselineY = yCursor + (line.baseline ?? lh * 0.8);
      const indent = line.indent ?? 0;
      const isList = indent > 0 || !!line.bullet;
      const x = startX + (n.style.align === "left" || isList ? indent : (maxW - line.width) / 2);
      const runSize = (line.segments[0]?.run.fontSize ?? size) * scale;
      const str = line.segments.map((s) => s.text).join("").replace(/\s+$/, "");
      if (str) {
        cmds.push(
          `/F1 ${f(Math.max(0.01, runSize))} Tf`,
          `1 0 0 1 ${f(X(x))} ${f(Y(baselineY))} Tm`,
          `(${pdfStr(str)}) Tj`
        );
        ops += 3;
      }
      yCursor += lh;
    }
    cmds.push("ET");
    ops += 1;
  }

  // --- assemble -------------------------------------------------------------
  const stream = zlibSync(latin1(cmds.join("\n")));
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const put = (u: Uint8Array): void => { chunks.push(u); pos += u.length; };
  const putStr = (s: string): void => put(latin1(s));
  const obj = (n: number, body: string, data?: Uint8Array): void => {
    offsets[n] = pos;
    putStr(`${n} 0 obj\n${body}\n`);
    if (data) { putStr("stream\n"); put(data); putStr("\nendstream\n"); }
    putStr("endobj\n");
  };

  const firstImgObj = 6;
  const xobjDict = xobjects.map((x, i) => `/${x.name} ${firstImgObj + i} 0 R`).join(" ");

  putStr("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pageW)} ${f(pageH)}] ` +
      `/Resources << /Font << /F1 5 0 R >> /XObject << ${xobjDict} >> >> /Contents 4 0 R >>`
  );
  obj(4, `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream);
  obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  xobjects.forEach((x, i) => {
    obj(
      firstImgObj + i,
      `<< /Type /XObject /Subtype /Image /Width ${x.w} /Height ${x.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${x.bytes.length} >>`,
      x.bytes
    );
  });

  const count = firstImgObj + xobjects.length;
  const xrefAt = pos;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  putStr(xref);
  putStr(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const blob = new Blob(chunks as BlobPart[], { type: "application/pdf" });
  return {
    blob, nodes: placed.length, images, ops,
    bytes: blob.size, streamBytes: stream.length,
    pageW, pageH, scale, ms: Math.round(performance.now() - t0),
  };
}
