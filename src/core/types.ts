/**
 * R-node — document schema (version 0.1).
 *
 * The schema is the single source of truth shared by every client (desktop,
 * web, mobile) and by the Rust document engine that will take over
 * persistence/layout on the desktop build. It is plain, serializable JSON.
 *
 * Design rules (from the product spec):
 *  - IDs everywhere, never array indices, for references.
 *  - Relationships are independent from parent/child hierarchy.
 *  - Versioned schema with migrations.
 */

export const SCHEMA_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export type NodeType =
  | "central" // root of a mind-map sheet (one per sheet)
  | "main" // direct child of central topic
  | "subtopic" // any regular descendant
  | "floating" // free, unparented topic
  | "summary" // groups a range of topics
  | "callout"; // annotation box linked to a topic

export type StructureType =
  | "mindmap" // classic radial mind map
  | "logic" // top-to-bottom / left-to-right reasoning chart
  | "tree" // hierarchical tree
  | "org" // org chart
  | "timeline" // chronological
  | "fishbone" // Ishikawa
  | "matrix" // rows x columns
  | "treetable" // hierarchical rows + columns
  | "freeform"; // grid/free canvas

export type Orientation = "horizontal" | "vertical";

export type ConnectorStyle = "curved" | "straight" | "elbow";

export type TaskStatus = "not-started" | "in-progress" | "blocked" | "completed" | "cancelled";

export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export type TopicShape =
  | "custom" // silhouette drawn from Style.shapeParts (T24)
  | "rounded"
  | "rect"
  | "capsule"
  | "circle"
  | "diamond"
  | "hexagon"
  | "cloud"
  | "underline"
  | "none";

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

/** Paint that either names a theme token or states a colour outright. */
export type ShapePaint = "accent" | "surface" | "text" | "muted" | (string & {});

/** One painted path of a custom shape (T24). See `Style.shapeParts`. */
export interface ShapePart {
  /** SVG path data in a 0..1 box, origin top-left. */
  d: string;
  fill?: ShapePaint;
  stroke?: ShapePaint;
  /** In the same 0..1 units as `d`, so it scales with the node. */
  strokeWidth?: number;
  /** "evenodd" is how a subpath cuts a hole. */
  rule?: "nonzero" | "evenodd";
}

/** Which of the four edges of a topic box an image is attached to. */
export type ImageSlot = "top" | "bottom" | "left" | "right";

/**
 * One cell of a gallery topic (T25): an attachment id plus the caption drawn
 * under it.
 *
 * The caption lives HERE and not on `AttachmentInfo` because that card is
 * per-ASSET and an asset is content-addressed: the same picture dropped into
 * two tiers is one card, so a caption stored there would rename both. The
 * caption is a property of this image IN THIS NODE, which is exactly what a
 * cell is.
 *
 * It is deliberately a plain string, not a `TextRun[]`. A rich caption would
 * need the Lexical overlay to edit it, and that overlay is a second renderer
 * over the same text — the §3 parity contract in full, for a label that is
 * one short line. Captions are edited in the Inspector and painted by the
 * canvas alone, so the parity contract never applies to them.
 */
export interface GalleryItem {
  /** SHA-256 of the asset — the same id `Style.image` and the slots use. */
  id: string;
  /** Single-line label under the cell. Newlines are not meaningful here. */
  caption?: string;
}

export interface Style {
  fill?: string;
  stroke?: string;
  borderWidth?: number;
  borderStyle?: "solid" | "dashed" | "dotted";
  cornerRadius?: number;
  shape?: TopicShape;
  textColor?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  opacity?: number;
  shadow?: boolean;
  icon?: string;
  /** Attachment id of the TOP image (kept as `image` for backwards
   *  compatibility with every saved document, op and export that predates
   *  the side slots). The other three slots live in imageBottom/Left/Right
   *  and all four share `imageWidth` as their display size. */
  image?: string;
  imageBottom?: string;
  imageLeft?: string;
  imageRight?: string;
  /** Display width of the image(s) in world units; height follows the aspect ratio. */
  imageWidth?: number;
  /**
   * Turns the topic into a GALLERY (T25): an ordered grid of captioned images
   * filling the body under the title — a tier-list row, a mood board, a cast
   * list. A presentation variant like `code` and `shapeParts`, deliberately
   * not a `NodeType`: that enum drives topology and layout, and a grid of
   * pictures inside one box changes neither.
   *
   * Why this is not "more image slots". `ImageSlot` names an EDGE of the box
   * and there are four of them by construction; the count is the point, and
   * every consumer — hit-test, drag & drop, the resize handle, the editing
   * overlay's insets — is written against those four names. A gallery has no
   * edge and no fixed count, so it is a different thing wearing the same
   * word. The two compose: a gallery topic may still carry side images.
   */
  gallery?: {
    /** Cells in paint order. An empty array is a gallery with no pictures yet. */
    items: GalleryItem[];
    /** Cell width in world units. Absent = GALLERY_CELL_W. */
    cellW?: number;
    /**
     * Cell width ÷ height. Absent = GALLERY_ASPECT (square).
     *
     * EVERY cell gets this shape, whatever the pictures are: each is cropped
     * to its centre to fill the box, never letterboxed and never stretched.
     * That is the whole reason the grid reads as a grid — a tier row of
     * portraits, screenshots and banners at their own aspect ratios is a
     * ragged pile, and lining them up is what makes it a tier list.
     */
    aspect?: number;
    /** Fixed column count. Absent or 0 = wrap to whatever the box allows. */
    cols?: number;
  };
  link?: string;
  /**
   * Marks the topic as a read-only code block (T22). The SOURCE lives in
   * `title`, newlines and all; the colours are NOT stored — they are derived
   * at paint time from the theme, so one document reads correctly in both
   * light and dark. A presentation variant, deliberately not a `NodeType`:
   * that enum drives topology and layout, and a code block changes neither.
   */
  code?: { lang: string };
  /**
   * Artwork for a `shape: "custom"` topic (T24), painted in order: silhouette
   * first, details on top. Every `d` is SVG path data in a NORMALISED 0..1 box,
   * scaled onto the node's rect at paint time, so one drawing works at any size.
   *
   * Colours ARE stored here, unlike anywhere else in this schema. T22 and T23
   * both strip colour because it had to contrast with something the theme owns
   * — text against a fill — so saving it fixed half of a pairing that later
   * changed. A shape's colours contrast with EACH OTHER, inside the shape: a
   * yellow moon is yellow on a light map and on a dark one. Here colour is
   * content. A part may still follow the palette by naming a token
   * (`accent` | `surface` | `text` | `muted`) instead of a hex.
   */
  shapeParts?: ShapePart[];
  padding?: number;
  align?: "left" | "center";
  width?: number;
  height?: number;
  rotation?: number;
  locked?: boolean;
  hidden?: boolean;
}

export const DEFAULT_STYLE: Style = {
  fill: undefined, // → theme branch palette
  stroke: "transparent",
  borderWidth: 0,
  borderStyle: "solid",
  cornerRadius: 10,
  shape: "rounded",
  textColor: undefined, // → theme
  fontSize: 14,
  fontWeight: 400,
  italic: false,
  underline: false,
  strikethrough: false,
  opacity: 1,
  shadow: false,
  icon: undefined,
  padding: 10,
  align: "center",
};

// ---------------------------------------------------------------------------
// Rich text (topic titles)
// ---------------------------------------------------------------------------

/**
 * A styled segment of a topic title. The title is rendered as a sequence of
 * runs: plain text plus per-run emphasis and color. A missing color inherits
 * the theme/branch text color of the node.
 *
 * Block-level semantics (so pasted content keeps its spatial structure,
 * Draw.io-style): a run may open a paragraph gap, carry its own font size
 * (headings), or start a bullet-list item at a given nesting depth.
 */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** CSS color; when absent the node/theme text color is used. */
  color?: string;
  /** Per-run font size in px (headings). Absent = node font size. */
  fontSize?: number;
  /** Extra vertical gap before this run's paragraph (past  a block boundary). */
  paraGap?: boolean;
  /** >0 → this run starts a bullet-list item at this depth (1 = top level). */
  listIndent?: number;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface TaskInfo {
  status: TaskStatus;
  priority: Priority;
  progress: number; // 0..100, 0 = not tracked
  assignee?: string;
  startDate?: string; // ISO date
  dueDate?: string;
  durationDays?: number;
  description?: string;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface Position {
  x: number;
  y: number;
  manual: boolean; // true = user-placed (layout engine must preserve)
  /** Locks a direct child of the central topic while its descendants reflow. */
  branchFree?: boolean;
  /** Legacy optional displacement retained for document compatibility. */
  offsetX?: number;
  offsetY?: number;
}

export interface MindNode {
  id: string;
  type: NodeType;
  parentId: string | null;
  childrenIds: string[];
  /** Plain-text title — always kept in sync with titleRuns (single run). */
  title: string;
  /**
   * Styled segments of the title. When absent the title is a single plain
   * run; every title mutation (styled or not) updates both fields so all
   * existing consumers (search, export, outliner, tests) keep working.
   */
  titleRuns?: TextRun[];
  position: Position;
  style: Style;
  collapsed: boolean;
  labels: string[];
  markers: string[];
  notes: string;
  task: TaskInfo | null;
  metadata: { createdAt: string; updatedAt: string };
}

// ---------------------------------------------------------------------------
// Relationships (independent from hierarchy)
// ---------------------------------------------------------------------------

export interface Relationship {
  id: string;
  fromId: string;
  toId: string;
  label?: string;
  color?: string;
  lineStyle?: "solid" | "dashed" | "dotted";
  /**
   * Line GEOMETRY, as opposed to `lineStyle`'s dash pattern. Absent means
   * "curved", so every document written before this field keeps the look it
   * has. Shape templates set it to "straight" (T23); the renderer honours it
   * from T24 on. The union is the one `StructureConfig` already uses — the
   * alternative was a second, parallel vocabulary for the same idea.
   */
  connector?: ConnectorStyle;
  bidirectional?: boolean;
}

// ---------------------------------------------------------------------------
// Groups & summaries (drawn over the map, derived from member geometry)
// ---------------------------------------------------------------------------

export interface Group {
  id: string;
  /** Topic ids enclosed by the dashed boundary (usually siblings). */
  memberIds: string[];
  label?: string;
}

export interface Summary {
  id: string;
  /** Topic ids spanned by the brace (usually a contiguous sibling range). */
  memberIds: string[];
  label?: string;
}

// ---------------------------------------------------------------------------
// Structure config
// ---------------------------------------------------------------------------

export interface StructureConfig {
  structureType: StructureType;
  orientation: Orientation;
  spacing: number; // gap between levels
  branchSpacing: number; // gap between siblings
  padding: number;
  compactMode: boolean;
  autoBalance: boolean;
  /** Keep main topics fixed; only their internal subtopics are auto-laid out. */
  freePositioningBranches: boolean;
  allowManualPositioning: boolean;
  connectorStyle: ConnectorStyle;
}

export const DEFAULT_STRUCTURE: StructureConfig = {
  structureType: "mindmap",
  orientation: "horizontal",
  spacing: 180,
  branchSpacing: 14,
  padding: 18,
  compactMode: false,
  autoBalance: true,
  freePositioningBranches: false,
  allowManualPositioning: true,
  connectorStyle: "curved",
};

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Metadata card for an image attached to the map, kept INSIDE the document.
 * The bytes never live here: they are stored in the AssetStore (IndexedDB),
 * addressed by content — `id` is the SHA-256 of the original file and the
 * key of the asset in the store. `Style.image` on a node references the same
 * id, so one asset can be shared by many nodes.
 */
export interface AttachmentInfo {
  id: string; // SHA-256 of the original bytes — the key in the AssetStore
  mime: string; // image/png | image/jpeg | image/gif | image/webp
  w: number; // intrinsic pixels of the ORIGINAL
  h: number;
  bytes: number; // weight of the original, shown to the user
  name?: string;
  alt?: string;
  /**
   * The original bytes are gone: the asset came from a compact .rnode.zip
   * import, which carries only display levels (AGENT_GUIDE I11). A complete
   * export of this document exports the resized level and must say so.
   */
  originalLost?: boolean;
}

// ---------------------------------------------------------------------------
// Sheet & Document
// ---------------------------------------------------------------------------

export interface Sheet {
  sheetId: string;
  title: string;
  structure: StructureConfig;
  rootNodeId: string;
  /** nodes keyed by id — the single source of truth for the tree */
  nodes: Record<string, MindNode>;
  relationships: Relationship[];
  boundaries: Group[];
  summaries: Summary[];
  callouts: unknown[];
  labels: string[];
  zones: unknown[];
  attachments: AttachmentInfo[];
  comments: unknown[];
  presentation: Record<string, unknown>;
}

export interface RnodeDocument {
  schemaVersion: string;
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  settings: {
    theme: "light" | "dark";
    showOutliner: boolean;
    showInspector: boolean;
  };
  themeId: string;
  sheets: Sheet[];
}
