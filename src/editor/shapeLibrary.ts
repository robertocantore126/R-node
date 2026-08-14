/**
 * R-node — the saved shape library (T23).
 *
 * A shape is not a special kind of node: it is a SUBGRAPH — N native topics
 * plus the relationships between them — stored in exactly the format
 * `copySelection` already writes to the clipboard. That is the whole design.
 * An opaque macro-node would be invisible to search, the outliner, every
 * export, `validateSheet` and undo; as native topics all of that works
 * already, and the shape stays editable after it lands.
 *
 * This module is the door. Everything a template carries is normalised and
 * checked HERE, once, because every rule below fails silently: a template that
 * smuggles a colour or a dangling parentId does not throw when it is saved — it
 * corrupts a map weeks later, far from the paste that caused it.
 *
 * Persistence copies `recentColors.ts`: one localStorage key, plain JSON, and a
 * read that throws returns an empty library rather than breaking the panel.
 */

import { DEFAULT_STRUCTURE, type MindNode, type Relationship, type Sheet, type Style, type TextRun, type TopicShape } from "../core/types";
import { nodeImageIds } from "../core/ops";
import { validateSheet } from "../core/validate";
import { runsToPlain } from "../core/text";

const KEY = "r-node.shape-library";
const MAX_NODES = 200;

export interface ShapeTemplate {
  id: string;
  name: string;
  createdAt: string;
  payload: { rootId: string; nodes: MindNode[]; relationships: Relationship[] };
}

/** Refusal with a reason a user can act on. Never thrown for I/O problems. */
export class ShapeRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapeRejected";
  }
}

// ---------------------------------------------------------------------------
// Normalisation — the four rules, each with the reason it exists
// ---------------------------------------------------------------------------

/** The built-in silhouettes. Anything else falls back to the default: a
 *  structure is made of base shapes, and a custom path belongs to a shape node
 *  (T24), which is a different object with a fixed size. */
const BASE_SHAPES = new Set<TopicShape>(["rounded", "rect", "capsule", "circle", "diamond", "hexagon", "cloud", "underline", "none"]);

/**
 * Colours out, form in.
 *
 * A stored colour eventually lands on a theme where it cannot be read, and it
 * stays there: the same conclusion T22 reached for code topics. Stripped, the
 * inserted topics inherit the host map's branch palette like any native one.
 */
function normaliseStyle(style: Style | undefined): Style {
  const s: Style = { ...(style ?? {}) };
  delete s.fill;
  delete s.stroke;
  delete s.textColor;
  // Image slots never reach here — a payload carrying one is refused — but the
  // display width would be meaningless without them anyway.
  delete s.image;
  delete s.imageBottom;
  delete s.imageLeft;
  delete s.imageRight;
  delete s.imageWidth;
  delete s.link;
  delete s.code;
  if (s.shape !== undefined && !BASE_SHAPES.has(s.shape)) delete s.shape;
  return s;
}

/** The one that is easy to miss: emphasis colour lives on the RUN, not on the
 *  node, so stripping only the Style would leave a red word red and defeat the
 *  rule entirely. The text itself is untouched, so I5 still holds. */
function normaliseRuns(runs: TextRun[] | undefined): TextRun[] | undefined {
  if (!runs) return undefined;
  return runs.map((r) => {
    const out: TextRun = { ...r };
    delete out.color;
    return out;
  });
}

function normaliseNode(n: MindNode, isRoot: boolean, known: Set<string>): MindNode {
  return {
    ...n,
    // The root of a copied subtree still points at its parent in the map it
    // came from — a node this payload does not contain. Structural, always.
    parentId: isRoot ? null : n.parentId,
    childrenIds: n.childrenIds.filter((id) => known.has(id)),
    titleRuns: normaliseRuns(n.titleRuns),
    // Geometry rigid: a triangle stays a triangle. The layout treats manual
    // nodes as fixed anchors and moves the OTHER branches around them.
    position: { ...n.position, manual: true },
    style: normaliseStyle(n.style),
    collapsed: false,
    // A map's state, not a shape's: due dates and one map's taxonomy have no
    // meaning in another document. `notes` stays, because it is content.
    task: null,
    labels: [],
    markers: [],
  };
}

function normaliseRelationship(r: Relationship, known: Set<string>): Relationship | null {
  if (!known.has(r.fromId) || !known.has(r.toId)) return null;
  const out: Relationship = { ...r, connector: "straight" };
  delete out.color;
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Build the sheet `validateSheet` expects, so the topology check is the one
 *  the app already trusts rather than a second, weaker copy. */
function asSheet(rootId: string, nodes: MindNode[], relationships: Relationship[]): Sheet {
  const byId: Record<string, MindNode> = {};
  for (const n of nodes) byId[n.id] = n;
  return {
    sheetId: "shape-check",
    title: "shape-check",
    structure: { ...DEFAULT_STRUCTURE },
    rootNodeId: rootId,
    nodes: byId,
    relationships,
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
  };
}

interface RawPayload {
  app?: unknown;
  payload?: { rootId?: unknown; nodes?: unknown; relationships?: unknown };
}

/**
 * Parse, normalise and check. Throws `ShapeRejected` with a reason meant to be
 * shown to the user — every message names what is wrong and, where it can, the
 * topic responsible.
 */
export function prepareShape(raw: string | object): ShapeTemplate["payload"] {
  let parsed: RawPayload;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as RawPayload;
    } catch {
      throw new ShapeRejected("That is not valid JSON.");
    }
  } else {
    parsed = raw as RawPayload;
  }

  if (!parsed || parsed.app !== "r-node" || !parsed.payload) {
    throw new ShapeRejected('Not an R-node payload: the object needs "app": "r-node" and a "payload".');
  }
  const { rootId, nodes, relationships } = parsed.payload;
  if (typeof rootId !== "string" || !Array.isArray(nodes) || nodes.length === 0) {
    throw new ShapeRejected('The payload needs a "rootId" and a non-empty "nodes" array.');
  }
  if (nodes.length > MAX_NODES) {
    throw new ShapeRejected(`Too large: ${nodes.length} topics, the limit is ${MAX_NODES}.`);
  }

  const list = nodes as MindNode[];
  const known = new Set(list.map((n) => n.id));
  if (!known.has(rootId)) {
    throw new ShapeRejected(`The root "${rootId}" is not among the topics.`);
  }

  // Images are refused rather than stripped: their bytes live in a per-document
  // AssetStore keyed by SHA-256, so a template would carry the reference
  // without the bytes and draw a hole in the map that receives it. Saying so
  // now beats discovering it at the drop.
  for (const n of list) {
    if (nodeImageIds(n).length > 0) {
      throw new ShapeRejected(`Topic "${n.title || n.id}" carries an image. A shape cannot: the picture's bytes belong to the document it came from.`);
    }
  }

  const normalised = list.map((n) => normaliseNode(n, n.id === rootId, known));
  const rels = Array.isArray(relationships)
    ? (relationships as Relationship[]).map((r) => normaliseRelationship(r, known)).filter((r): r is Relationship => r !== null)
    : [];

  // The topology check the app already trusts. It names the ids it blames, so
  // an LLM that wired a parentId wrongly gets told which one.
  try {
    validateSheet(asSheet(rootId, normalised, rels));
  } catch (e) {
    throw new ShapeRejected(`The structure is inconsistent — ${(e as Error).message}`);
  }

  // I5 is the document-wide invariant every consumer reads through. Stripping
  // run colours must not have touched the text; if it did, this template would
  // desynchronise search, export and the outliner in whatever map it lands in.
  for (const n of normalised) {
    if (n.titleRuns && runsToPlain(n.titleRuns) !== n.title) {
      throw new ShapeRejected(`Topic "${n.id}" has a title that disagrees with its styled runs.`);
    }
  }

  return { rootId, nodes: normalised, relationships: rels };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function slug(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base || "shape"}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Never throws: a corrupt or absent key reads as an empty library, because a
 *  panel that cannot render is worse than a panel with nothing in it. */
export function listShapes(): ShapeTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ShapeTemplate[]) : [];
  } catch {
    return [];
  }
}

function write(all: ShapeTemplate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota or private mode — the library is a convenience, never a blocker */
  }
}

/** Validates first, stores second. Throws `ShapeRejected` if the payload is
 *  not something this app can safely instantiate later. */
export function saveShape(name: string, raw: string | object): ShapeTemplate {
  const trimmed = name.trim();
  if (!trimmed) throw new ShapeRejected("Give the shape a name.");
  const payload = prepareShape(raw);
  const template: ShapeTemplate = {
    id: slug(trimmed),
    name: trimmed,
    createdAt: new Date().toISOString(),
    payload,
  };
  write([...listShapes(), template]);
  return template;
}

export function removeShape(id: string): void {
  write(listShapes().filter((t) => t.id !== id));
}
