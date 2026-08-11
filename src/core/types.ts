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
  image?: string; // attachment id
  link?: string;
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
  attachments: unknown[];
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
