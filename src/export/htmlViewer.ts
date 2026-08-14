/**
 * Self-contained HTML export — the map plus the renderer, in one file.
 *
 * For reading a whole map on screen, the best viewer is the canvas that
 * already draws it: 8,000 topics at 6-8ms a frame, with viewport culling and
 * bitmap caches. Every document format we measured was a worse version of that
 * — SVG stalls at 95,000 DOM nodes, PDF squeezes 470,000 units into a
 * 14,400-unit page, PNG puts 14px text at half a pixel. So this exports the
 * DRAWING CODE, not a drawing.
 *
 * What follows from that, and is the whole point: fidelity is inherited rather
 * than implemented. Relationships, boundaries, summaries, opacity, rotation,
 * shadow and borders are all present because this is the same renderer — none
 * of them had to be ported, and none can fall behind it.
 *
 * The trade is that the result is an application, not a document: it does not
 * print, and the browser cannot select or search its text. For "read my own
 * map on my own screen" neither costs anything.
 */
import viewerBundle from "./generated/viewer.bundle.js?raw";
import { nodeImageIds } from "../core/ops";
import type { Sheet } from "../core/types";
import type { ThemeName } from "../render/theme";
import { buildReport, publishReport, type ExportReport } from "./report";

export interface HtmlViewerOptions {
  title: string;
  theme: ThemeName;
  background: string;
  /** `data:` URI per asset, or null when unreadable. */
  imageDataUri?: (assetId: string) => Promise<string | null>;
}

/**
 * Gzip the document and carry it as base64.
 *
 * Applied to the WHOLE payload, images included, which is not what I expected
 * and the measurement corrected. JPEG bytes do not compress — but they are
 * carried as base64, which stores 6 bits per byte, and gzip recovers most of
 * that 33% overhead. Meanwhile the document itself, 8,000 nodes of repeated
 * keys and default values, compresses about ten to one. Measured on 3,001
 * nodes with 120 pictures: 4.8MB of payload down to 2.9MB.
 *
 * The result still ships only when it is genuinely smaller — the caller
 * compares — because that balance depends on the ratio of pictures to text and
 * a rule of thumb would eventually be wrong.
 *
 * Returns null where CompressionStream is missing, and the caller embeds plain
 * JSON: a smaller file nobody can open is not smaller.
 */
async function gzipBase64(text: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return null;
  }
}

export interface HtmlViewerResult {
  html: string;
  nodes: number;
  images: number;
  imagesMissing: number;
  bytes: number;
  imageBytes: number;
  report: ExportReport;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * `</script>` inside embedded JSON would close the tag early and the file would
 * load as broken HTML — the exact class of failure that produced a blank PDF
 * from a structurally perfect file. Escaping the sequence keeps the JSON valid
 * while making it inert to the HTML parser.
 */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

export async function sheetToHtmlViewer(sheet: Sheet, opts: HtmlViewerOptions): Promise<HtmlViewerResult> {
  const t0 = performance.now();

  const ids = new Set<string>();
  for (const n of Object.values(sheet.nodes)) for (const id of nodeImageIds(n)) ids.add(id);
  const images: Record<string, string> = {};
  let imageBytes = 0;
  let imagesMissing = 0;
  for (const id of ids) {
    const uri = opts.imageDataUri ? await opts.imageDataUri(id) : null;
    if (uri) {
      images[id] = uri;
      imageBytes += uri.length;
    } else {
      imagesMissing++;
    }
  }

  const doc = { title: opts.title, sheet, theme: opts.theme, images };
  const plain = jsonForScript(doc);
  const packed = await gzipBase64(JSON.stringify(doc));
  // The gzipped form only ships when it is actually smaller: base64 costs 33%,
  // so on a document that is mostly already-compressed image bytes it loses.
  const payload =
    packed !== null && packed.length + 40 < plain.length
      ? `{__gz:"${packed}"}`
      : plain;
  const compressed = payload !== plain;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:${esc(opts.background)}}
  #app{position:fixed;inset:0}
  .hud{position:fixed;left:12px;bottom:12px;font:12px/1.4 system-ui,sans-serif;
       color:#5b6472;background:rgba(255,255,255,.82);padding:5px 9px;border-radius:6px;
       pointer-events:none;user-select:none}
  .help{position:fixed;right:12px;bottom:12px;font:12px/1.4 system-ui,sans-serif;
        color:#5b6472;background:rgba(255,255,255,.82);padding:5px 9px;border-radius:6px;
        pointer-events:none;user-select:none}
</style></head>
<body><div id="app"><div class="help">drag to pan · wheel to zoom · F to fit</div></div>
<script>window.__RNODE_DOC=${payload}</script>
<script>${viewerBundle}</script>
</body></html>`;

  const report = buildReport({
    format: "svg", // the report's formats are the two document ones; this is neither
    sheet,
    ms: performance.now() - t0,
    bytes: html.length,
    emitted: {
      nodes: Object.keys(sheet.nodes).length,
      images: Object.keys(images).length,
      // Carried by the renderer itself rather than translated, so coverage is
      // total by construction.
      relationships: sheet.relationships.length,
      boundaries: sheet.boundaries.length,
      summaries: sheet.summaries.length,
    },
    honoured: [
      "fill", "stroke", "borderWidth", "borderStyle", "cornerRadius", "shape", "textColor",
      "fontSize", "fontWeight", "fontFamily", "italic", "underline", "strikethrough",
      "opacity", "shadow", "icon", "image", "imageWidth", "align", "width", "height", "rotation",
    ],
    units: {
      imageBytes,
      bundleBytes: viewerBundle.length,
      documentBytes: payload.length,
      compressed: compressed ? 1 : 0,
    },
    selfCheck:
      viewerBundle.length > 1000
        ? { ok: true, detail: `renderer bundle inlined (${Math.round(viewerBundle.length / 1024)}KB)` }
        : { ok: false, detail: "viewer bundle missing or empty — run `npm run build:viewer`" },
  });
  void publishReport(report);

  return { html, nodes: Object.keys(sheet.nodes).length, images: Object.keys(images).length, imagesMissing, bytes: html.length, imageBytes, report };
}
