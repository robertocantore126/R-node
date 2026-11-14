/**
 * draw.io (mxGraph) XML → a neutral list of boxes and arrows.
 *
 * The point is the AI workflow: every assistant already writes draw.io XML
 * well, so R-node accepts that instead of teaching a format of its own. It is
 * also what draw.io itself puts on the clipboard, plain or compressed.
 *
 * This module only READS the XML. Mapping onto topics and relationships, and
 * where they land in the canvas, is the store's job (importDrawio). Anything
 * the reader does not recognise still produces a box: the label is the
 * content, the outline is a guess, and nothing the user pasted is dropped.
 */
import type { ArrowHead, ConnectorStyle, RelAnchor, TopicShape } from "./types";
import { withAlpha } from "./paint";

export interface DrawioVertex {
  id: string;
  label: string;
  /** Absolute, in draw.io units (pixels at 100%), parents already added. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The draw.io shape name as written ("ellipse", "cylinder3", "swimlane"...). */
  kind: string;
  shape: TopicShape;
  /** Text only: no box at all. */
  text: boolean;
  /** Holds other vertices (swimlane, container=1, or the parent of one). */
  container: boolean;
  /** The id of the nearest container vertex holding this one, if any. */
  parent?: string;
  /** A swimlane's title band colour (its fillColor; the body is swimlaneFillColor). */
  headerFill?: string;
  /** A box drawn behind others as their frame: visual only, it holds nothing. */
  frame?: boolean;
  /** draw.io's verticalAlign=top/bottom: the label sits at that edge of the box. */
  titleAt?: "top" | "bottom";
  fill?: string;
  stroke?: string;
  textColor?: string;
  strokeWidth?: number;
  dashed?: boolean;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  opacity?: number;
  align?: "left" | "center";
}

export interface DrawioEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  color?: string;
  width?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  connector: ConnectorStyle;
  endArrow: ArrowHead;
  startArrow: ArrowHead;
  fromAnchor?: RelAnchor;
  toAnchor?: RelAnchor;
}

export interface DrawioDiagram {
  vertices: DrawioVertex[];
  edges: DrawioEdge[];
  /** Edges with a loose end (draw.io allows them; an R-node arrow needs two topics). */
  skippedEdges: number;
  /** The text was cut off; this is what arrived up to the last complete cell. */
  truncated?: boolean;
}

/** Cheap test, before any parsing: does this text carry a draw.io diagram? */
export function looksLikeDrawio(text: string): boolean {
  return /<mxGraphModel[\s>]|<mxfile[\s>]/.test(text);
}

/**
 * Cut the diagram out of what an assistant answered: it may sit in a ```xml
 * fence, after a sentence of prose, or with an <?xml?> header.
 */
export function extractDrawioXml(text: string): string | null {
  return extractDrawio(text)?.xml ?? null;
}

/**
 * As extractDrawioXml, and a diagram that was CUT OFF (an AI answer that hit
 * its length limit, a copy that missed the last lines) is closed after its
 * last complete cell, so everything that did arrive is still imported.
 */
export function extractDrawio(text: string): { xml: string; truncated: boolean } | null {
  const open = /<mxfile[\s>]|<mxGraphModel[\s>]/.exec(text);
  if (!open) return null;
  const tag = open[0].startsWith("<mxfile") ? "mxfile" : "mxGraphModel";
  const close = text.lastIndexOf(`</${tag}>`);
  if (close >= open.index) return { xml: text.slice(open.index, close + tag.length + 3), truncated: false };
  // Unclosed. Only a plain model can be mended (a compressed page cut short is lost).
  const model = /<mxGraphModel[\s>]/.exec(text.slice(open.index));
  if (!model) return null;
  const start = open.index + model.index;
  const body = text.slice(start);
  let end = -1;
  for (const m of body.matchAll(/<\/mxCell>|<\/UserObject>|<\/object>|<mxCell\b[^<>]*\/>/g)) end = m.index! + m[0].length;
  if (end < 0) return null;
  return { xml: body.slice(0, end) + (body.includes("<root") ? "</root>" : "") + "</mxGraphModel>", truncated: true };
}

/** draw.io's compressed page: base64 → raw deflate → URI-encoded XML. */
async function inflatePage(data: string): Promise<string> {
  const bin = atob(data.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const source = new ReadableStream<BufferSource>({ start(c) { c.enqueue(bytes); c.close(); } });
  const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const decoder = new TextDecoder();
  let xml = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    xml += decoder.decode(value, { stream: true });
  }
  xml += decoder.decode();
  return decodeURIComponent(xml);
}

/** "ellipse;whiteSpace=wrap;fillColor=#fff" → { ellipse: "", whiteSpace: "wrap", ... }. */
export function parseStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq < 0) out[p] = "";
    else out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

/** The bare first token of a style ("ellipse", "text", "swimlane"), if any. */
function styleName(style: string): string {
  const first = style.split(";")[0]?.trim() ?? "";
  return first && !first.includes("=") ? first : "";
}

/** "none" means none; "default" and absent mean "let the theme decide". */
function color(v: string | undefined): string | undefined {
  if (v === undefined || v === "" || v === "default" || v === "inherit") return undefined;
  if (v === "none") return "transparent";
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v.toLowerCase() : /^[a-z]+$/i.test(v) ? v.toLowerCase() : undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A label written as HTML (html=1) becomes plain lines. */
export function labelText(value: string, html: boolean): string {
  if (!value) return "";
  let s = value;
  if (html || /<[a-z][\s\S]*>/i.test(s)) {
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "");
    // Entities left after stripping (&nbsp;, &amp;...).
    if (typeof DOMParser !== "undefined") {
      s = new DOMParser().parseFromString(`<!doctype html><body>${s.replace(/</g, "&lt;")}`, "text/html").body.textContent ?? s;
    }
  }
  return s.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Which R-node outline a draw.io shape gets. Shapes R-node does not draw yet
 * fall back to the closest box, so the content is always there.
 */
export function shapeFor(kind: string, s: Record<string, string>): TopicShape {
  // The flowchart stencils ("mxgraph.flowchart.decision") name the same ideas.
  const name = kind.replace(/^mxgraph\.(flowchart|basic)\./, "");
  switch (name) {
    case "ellipse":
    case "doubleEllipse":
    case "start_1":
    case "start_2":
    case "on-page_reference":
    case "or":
    case "summing_function":
      return "ellipse";
    case "rhombus":
    case "decision":
      return "diamond";
    case "hexagon":
    case "preparation":
      return "hexagon";
    case "cloud":
      return "cloud";
    case "cylinder":
    case "cylinder2":
    case "cylinder3":
    case "datastore":
    case "database":
    case "stored_data":
    case "direct_data":
      return "cylinder";
    case "document":
    case "multi-Document":
    case "tape":
      return "document";
    case "parallelogram":
    case "data":
    case "manual_input":
      return "parallelogram";
    case "triangle":
    case "extract_or_measurement":
    case "merge_or_storage":
      return "triangle";
    case "process":
    case "predefined_process":
      return "process";
    case "note":
    case "card":
    case "card2":
      return "note";
    case "terminator":
    case "delay":
    case "display":
      return "capsule";
    case "text":
      return "none";
    default:
      return s.rounded === "1" ? (Number(s.arcSize) >= 50 ? "capsule" : "rounded") : "rect";
  }
}

function arrowHead(v: string | undefined, fill: string | undefined, fallback: ArrowHead): ArrowHead {
  if (v === undefined) return fallback;
  switch (v) {
    case "none":
      return "none";
    case "open":
    case "openThin":
    case "openAsync":
      return "open";
    case "diamond":
    case "diamondThin":
    case "ERmandOne":
      return "diamond";
    case "oval":
    case "circle":
    case "circlePlus":
      return "circle";
    default:
      // classic, block, blockThin, async...: a closed head, unless draw.io
      // says it is drawn hollow.
      return fill === "0" ? "open" : "triangle";
  }
}

function anchor(x: string | undefined, y: string | undefined): RelAnchor | undefined {
  const ax = num(x), ay = num(y);
  return ax === undefined || ay === undefined ? undefined : { x: Math.min(1, Math.max(0, ax)), y: Math.min(1, Math.max(0, ay)) };
}

/** The <mxGraphModel> of the first page, whatever the wrapping. */
async function graphModel(xml: string): Promise<Element | null> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const model = doc.getElementsByTagName("mxGraphModel")[0];
  if (model) return model;
  const page = doc.getElementsByTagName("diagram")[0];
  const data = page?.textContent?.trim();
  if (!data) return null;
  try {
    return graphModel(await inflatePage(data));
  } catch {
    return null;
  }
}

/** Parse a pasted diagram; null when the text holds none or it is broken. */
export async function parseDrawio(text: string): Promise<DrawioDiagram | null> {
  const found = extractDrawio(text);
  if (!found || typeof DOMParser === "undefined") return null;
  const model = await graphModel(found.xml);
  if (!model) return null;

  interface Cell { id: string; parent: string; el: Element; style: Record<string, string>; name: string; vertex: boolean; edge: boolean }
  const cells = new Map<string, Cell>();
  const order: Cell[] = [];
  // UserObject / object wrappers carry the label as an attribute and the
  // mxCell inside them; the wrapper's id is the cell's id.
  const read = (el: Element, wrapper?: Element): void => {
    const id = wrapper?.getAttribute("id") ?? el.getAttribute("id");
    if (!id) return;
    const styleText = el.getAttribute("style") ?? "";
    const cell: Cell = {
      id,
      parent: el.getAttribute("parent") ?? "",
      el: wrapper ?? el,
      style: parseStyle(styleText),
      name: styleName(styleText),
      vertex: el.getAttribute("vertex") === "1",
      edge: el.getAttribute("edge") === "1",
    };
    cells.set(id, cell);
    order.push(cell);
  };
  const root = model.getElementsByTagName("root")[0];
  if (!root) return null;
  for (const child of Array.from(root.children)) {
    if (child.tagName === "mxCell") read(child);
    else {
      const inner = child.getElementsByTagName("mxCell")[0];
      if (inner) read(inner, child);
    }
  }

  const geometry = (c: Cell): { x: number; y: number; w: number; h: number; relative: boolean } => {
    const g = (c.el.tagName === "mxCell" ? c.el : c.el.getElementsByTagName("mxCell")[0])?.getElementsByTagName("mxGeometry")[0];
    return {
      x: num(g?.getAttribute("x") ?? undefined) ?? 0,
      y: num(g?.getAttribute("y") ?? undefined) ?? 0,
      w: num(g?.getAttribute("width") ?? undefined) ?? 0,
      h: num(g?.getAttribute("height") ?? undefined) ?? 0,
      relative: g?.getAttribute("relative") === "1",
    };
  };
  const value = (c: Cell): string => labelText(c.el.getAttribute("value") ?? c.el.getAttribute("label") ?? "", c.style.html === "1");

  // Absolute origin of a vertex: draw.io stores children relative to their
  // parent vertex (groups, swimlanes, containers); layers sit at 0,0.
  const origin = new Map<string, { x: number; y: number }>();
  const absolute = (id: string, seen = new Set<string>()): { x: number; y: number } => {
    const known = origin.get(id);
    if (known) return known;
    const c = cells.get(id);
    if (!c || !c.vertex || seen.has(id)) return { x: 0, y: 0 };
    seen.add(id);
    const g = geometry(c);
    const p = absolute(c.parent, seen);
    const out = { x: p.x + g.x, y: p.y + g.y };
    origin.set(id, out);
    return out;
  };

  const parentsOfVertices = new Set(order.filter((c) => c.vertex && cells.get(c.parent)?.vertex).map((c) => c.parent));
  const edgeLabels = new Map<string, string[]>();
  const vertices: DrawioVertex[] = [];
  for (const c of order) {
    if (!c.vertex) continue;
    const g = geometry(c);
    const owner = cells.get(c.parent);
    // A label riding on an edge: it belongs to that arrow, not to the canvas.
    if (owner?.edge || g.relative) {
      const text = value(c);
      if (owner?.edge && text) edgeLabels.set(owner.id, [...(edgeLabels.get(owner.id) ?? []), text]);
      continue;
    }
    const s = c.style;
    const kind = s.shape ?? c.name ?? "";
    // An invisible group only positions its children.
    if (c.name === "group" || (kind === "" && s.group === "1")) continue;
    const pos = absolute(c.id);
    const text = c.name === "text" || s.text === "1" || (s.strokeColor === "none" && (s.fillColor === "none" || s.fillColor === undefined) && c.name !== "swimlane");
    const fontStyle = num(s.fontStyle) ?? 0;
    const swimlane = kind === "swimlane" || c.name === "swimlane";
    const container = swimlane || s.container === "1" || parentsOfVertices.has(c.id);
    // A swimlane's fillColor paints its header; its body is swimlaneFillColor (none by default).
    const fill = swimlane ? color(s.swimlaneFillColor) ?? "transparent" : color(s.fillColor);
    const fillOpacity = num(s.fillOpacity);
    vertices.push({
      id: c.id,
      label: value(c),
      x: pos.x,
      y: pos.y,
      w: Math.max(10, g.w),
      h: Math.max(10, g.h),
      kind: swimlane ? "swimlane" : kind,
      shape: text ? "none" : container ? (s.rounded === "1" ? "rounded" : "rect") : shapeFor(kind, s),
      text: text && !container,
      container,
      headerFill: swimlane ? color(s.fillColor) ?? "transparent" : undefined,
      fill: fill && fill !== "transparent" && fillOpacity !== undefined && fillOpacity < 100 ? withAlpha(fill, fillOpacity / 100) : fill,
      stroke: color(s.strokeColor),
      textColor: color(s.fontColor),
      strokeWidth: num(s.strokeWidth),
      dashed: s.dashed === "1",
      fontSize: num(s.fontSize),
      bold: (fontStyle & 1) !== 0 || undefined,
      italic: (fontStyle & 2) !== 0 || undefined,
      underline: (fontStyle & 4) !== 0 || undefined,
      opacity: num(s.opacity) !== undefined ? num(s.opacity)! / 100 : undefined,
      align: s.align === "left" ? "left" : undefined,
      titleAt: !container && (s.verticalAlign === "top" || s.verticalAlign === "bottom") ? s.verticalAlign : undefined,
    });
  }

  const ids = new Set(vertices.map((v) => v.id));
  // Which kept container holds each box: the nearest one up the parent chain
  // (an invisible group in between only positions, it does not hold).
  const containers = new Set(vertices.filter((v) => v.container).map((v) => v.id));
  for (const v of vertices) {
    let p = cells.get(v.id)?.parent;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      if (containers.has(p)) { v.parent = p; break; }
      const pc = cells.get(p);
      if (!pc?.vertex) break;
      p = pc.parent;
    }
  }
  // Frames drawn as plain boxes BEHIND others (an "AWS Cloud" or "VPC"
  // rectangle, its services laid on top at the same level): a rectangle that
  // wholly encloses another box of its own level is a FRAME. It stays a
  // visual box — it holds nothing and captures nothing — with its title
  // painted at the top, where draw.io drew it.
  const tol = 1;
  const encloses = (a: DrawioVertex, b: DrawioVertex): boolean =>
    b.x >= a.x - tol && b.y >= a.y - tol && b.x + b.w <= a.x + a.w + tol && b.y + b.h <= a.y + a.h + tol && a.w * a.h > b.w * b.h;
  for (const f of vertices) {
    if (f.text || f.container || (f.shape !== "rect" && f.shape !== "rounded")) continue;
    if (vertices.some((v) => v !== f && v.parent === f.parent && encloses(f, v))) {
      f.frame = true;
      f.titleAt = f.titleAt === "bottom" ? "bottom" : "top";
    }
  }
  // Holders before what they hold, whatever order the file listed them in.
  const depth = (v: DrawioVertex): number => { let d = 0, p = v.parent; while (p && d < 64) { d++; p = vertices.find((o) => o.id === p)?.parent; } return d; };
  // Frames go under what they frame: first, the largest first.
  const layer = (v: DrawioVertex): number => (v.frame ? -v.w * v.h : 0);
  vertices.sort((a, b) => depth(a) - depth(b) || layer(a) - layer(b));
  const edges: DrawioEdge[] = [];
  let skippedEdges = 0;
  for (const c of order) {
    if (!c.edge) continue;
    const el = c.el.tagName === "mxCell" ? c.el : c.el.getElementsByTagName("mxCell")[0];
    const source = el?.getAttribute("source") ?? "", target = el?.getAttribute("target") ?? "";
    if (!ids.has(source) || !ids.has(target) || source === target) {
      skippedEdges++;
      continue;
    }
    const s = c.style;
    const dash = s.dashPattern ?? "";
    const label = [value(c), ...(edgeLabels.get(c.id) ?? [])].filter(Boolean).join("\n");
    edges.push({
      id: c.id,
      source,
      target,
      label,
      color: color(s.strokeColor),
      width: num(s.strokeWidth),
      // Explicit "solid": an R-node arrow with no lineStyle is drawn dashed.
      lineStyle: s.dashed === "1" ? (/^1\s+[1-4]$/.test(dash.trim()) ? "dotted" : "dashed") : "solid",
      connector: s.curved === "1" ? "curved" : /orthogonal|elbow|entityRelation/i.test(s.edgeStyle ?? "") ? "elbow" : "straight",
      endArrow: arrowHead(s.endArrow, s.endFill, "triangle"),
      startArrow: arrowHead(s.startArrow, s.startFill, "none"),
      fromAnchor: anchor(s.exitX, s.exitY),
      toAnchor: anchor(s.entryX, s.entryY),
    });
  }
  return { vertices, edges, skippedEdges, ...(found.truncated ? { truncated: true } : {}) };
}
