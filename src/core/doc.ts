/**
 * DocumentModel — read-side helpers over the schema.
 *
 * This class is pure data logic: no rendering, no I/O. It is the seam where
 * the Rust document engine will later plug in (same schema, same invariants).
 */
import {
  DEFAULT_STRUCTURE,
  SCHEMA_VERSION,
  type MindNode,
  type NodeType,
  type RmindDocument,
  type Sheet,
  type Style,
  type TaskInfo,
} from "./types";

export function uid(prefix = "n"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class DocumentModel {
  readonly doc: RmindDocument;

  constructor(doc: RmindDocument) {
    this.doc = doc;
    if (doc.sheets.length === 0) throw new Error("document must contain at least one sheet");
  }

  // -- sheet --------------------------------------------------------------

  get sheet(): Sheet {
    return this.doc.sheets[0];
  }

  get rootNode(): MindNode {
    const n = this.sheet.nodes[this.sheet.rootNodeId];
    if (!n) throw new Error("sheet root node missing");
    return n;
  }

  node(id: string): MindNode | undefined {
    return this.sheet.nodes[id];
  }

  requireNode(id: string): MindNode {
    const n = this.node(id);
    if (!n) throw new Error(`missing node ${id}`);
    return n;
  }

  // -- tree walks ---------------------------------------------------------

  /** All node ids in the subtree rooted at id, including id (BFS). */
  subtreeIds(id: string): string[] {
    const out: string[] = [];
    const queue = [id];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      const n = this.node(cur);
      if (n) queue.push(...n.childrenIds);
    }
    return out;
  }

  /** Nodes that are actually visible (not hidden by a collapsed ancestor). */
  visibleIds(rootId: string): string[] {
    const out: string[] = [];
    const visit = (id: string): void => {
      out.push(id);
      const n = this.node(id);
      if (!n || n.collapsed) return;
      for (const c of n.childrenIds) visit(c);
    };
    visit(rootId);
    return out;
  }

  depth(id: string): number {
    let d = 0;
    let cur = this.node(id)?.parentId ?? null;
    while (cur) {
      d++;
      cur = this.node(cur)?.parentId ?? null;
    }
    return d;
  }

  /** 1-based index of `id` among its parent's children (-1 if root/absent). */
  siblingIndex(id: string): number {
    const n = this.node(id);
    if (!n?.parentId) return -1;
    const parent = this.node(n.parentId);
    if (!parent) return -1;
    return parent.childrenIds.indexOf(id);
  }

  /** Id of the first "main branch" ancestor (the child of the root), for coloring. */
  branchRootId(id: string): string {
    const rootId = this.sheet.rootNodeId;
    let cur: string | null = id;
    let prev: string | null = null;
    while (cur && cur !== rootId) {
      prev = cur;
      cur = this.node(cur)?.parentId ?? null;
    }
    return prev ?? id;
  }

  get visibleNodeCount(): number {
    return this.visibleIds(this.sheet.rootNodeId).length;
  }

  // -- factories ----------------------------------------------------------

  static blank(title = "Untitled map"): RmindDocument {
    const central: MindNode = DocumentModel.makeNode("central", null, "Central topic", {
      fontSize: 22,
      fontWeight: 700,
    });
    const sheetId = uid("s");
    const sheet: Sheet = {
      sheetId,
      title: "Map 1",
      structure: { ...DEFAULT_STRUCTURE },
      rootNodeId: central.id,
      nodes: { [central.id]: central },
      relationships: [],
      boundaries: [],
      summaries: [],
      callouts: [],
      labels: [],
      zones: [],
      attachments: [],
      comments: [],
      presentation: {},
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      documentId: uid("d"),
      title,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archived: false,
      pinned: false,
      settings: { theme: "light", showOutliner: false, showInspector: true },
      themeId: "r-mind-light",
      sheets: [sheet],
    };
  }

  /** Demo document so the first launch is not a blank canvas. */
  static sample(): RmindDocument {
    const doc = DocumentModel.blank("R-mind — Roadmap");
    doc.settings.theme = "light";
    const sheet = doc.sheets[0];
    const root = sheet.nodes[sheet.rootNodeId];
    root.title = "R-mind";

    const add = (parentId: string, title: string, type: NodeType = "main", task?: TaskInfo, style?: Style): MindNode => {
      const n = DocumentModel.makeNode(type, parentId, title, style);
      n.task = task ?? null;
      sheet.nodes[n.id] = n;
      sheet.nodes[parentId].childrenIds.push(n.id);
      return n;
    };

    const core = add(root.id, "Core editor", "main", undefined, { fill: "#ff646b" });
    add(core.id, "Document model + ops", "subtopic");
    add(core.id, "Undo / redo", "subtopic");
    add(core.id, "Canvas renderer", "subtopic", { status: "in-progress", priority: "high", progress: 60 });

    const structures = add(root.id, "Structures", "main", undefined, { fill: "#ff9a66" });
    add(structures.id, "Mind map", "subtopic", { status: "completed", priority: "high", progress: 100 });
    add(structures.id, "Logic chart", "subtopic");
    add(structures.id, "Tree / org chart", "subtopic");
    add(structures.id, "Timeline", "subtopic");

    const productivity = add(root.id, "Productivity", "main", undefined, { fill: "#4eb5e8" });
    add(productivity.id, "Outliner", "subtopic");
    add(productivity.id, "Tasks + Gantt", "subtopic");
    add(productivity.id, "Search", "subtopic");

    const collaboration = add(root.id, "Collaboration", "main", undefined, { fill: "#55c9bd" });
    add(collaboration.id, "CRDT sync", "subtopic");
    add(collaboration.id, "Presence", "subtopic");
    add(collaboration.id, "Permissions", "subtopic");

    const exportLayer = add(root.id, "Export", "main", undefined, { fill: "#a7d9bb" });
    add(exportLayer.id, "PNG / SVG / PDF", "subtopic");
    add(exportLayer.id, "Markdown / OPML", "subtopic");

    const ai = add(root.id, "AI (later)", "main", undefined, { fill: "#d979e5" });
    add(ai.id, "Map from prompt", "subtopic");
    add(ai.id, "Summarize branch", "subtopic");

    return doc;
  }

  static makeNode(type: NodeType, parentId: string | null, title: string, style?: Style): MindNode {
    const t = nowIso();
    const typeStyle: Style = type === "central"
      ? { fontSize: 22, fontWeight: 700, padding: 4, shape: "none" }
      : type === "main"
        ? { fontSize: 14, fontWeight: 600, padding: 9, cornerRadius: 8, shape: "rounded" }
        : type === "subtopic"
          ? { fontSize: 12, fontWeight: 400, padding: 7, cornerRadius: 8, shape: "rounded", align: "left" }
          : { fontSize: 14, fontWeight: 400, padding: 9, cornerRadius: 8, shape: "rounded" };
    return {
      id: uid("n"),
      type,
      parentId,
      childrenIds: [],
      title,
      position: { x: 0, y: 0, manual: false },
      style: { ...typeStyle, ...(style ?? {}) },
      collapsed: false,
      labels: [],
      markers: [],
      notes: "",
      task: null,
      metadata: { createdAt: t, updatedAt: t },
    };
  }
}
