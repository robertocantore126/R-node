/**
 * EditorStore — the editor interaction layer.
 *
 * Owns all editor state (documents, selection, camera, editing, drop target,
 * UI flags) and exposes commands. Every mutation that touches the document
 * goes through the operation system + history, so undo/redo and (later) the
 * collaboration layer get a single consistent stream of ops.
 *
 * The store is framework-free: React subscribes via useSyncExternalStore.
 */
import { DocumentModel, nowIso, uid } from "../core/doc";
import { History } from "../core/history";
import { applyWithInverse, makeOp, type Op } from "../core/ops";
import { trace } from "../dev/trace";
import { SCHEMA_VERSION, type Group, type MindNode, type NodeType, type Position, type Relationship, type RnodeDocument, type Sheet, type Style, type Summary, type TaskInfo, type TextRun } from "../core/types";
import { isEmptyRuns, nodeRuns, normalizeRuns, plainToRuns, runsEqual, runsToPlain, trimRuns } from "../core/text";
import { applyLayout, layoutSheet } from "../layout/mindmap";
import { createCanvasTextMeasurer, measureNode, MIN_TOPIC_W, type TextMeasurer } from "../layout/measure";
import { centerOn, fitBounds, panBy, zoomAt, type Camera } from "../render/viewport";
import { THEMES } from "../render/theme";
import type { DropIndicator } from "../render/renderer";
import { LocalStorageAdapter, type StorageAdapter } from "../persist/storage";

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: { description?: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
}

/**
 * Validate/sanitize titleRuns coming from an imported document: only plain
 * text with bold/italic/underline/color survives; anything else is dropped.
 * Falls back to a single plain run of `title` when no valid runs are present.
 */
function sanitizeTitleRuns(raw: unknown): TextRun[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const runs: TextRun[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const text = typeof (r as { text?: unknown }).text === "string" ? (r as { text: string }).text : "";
    if (text.length === 0) continue;
    const run: TextRun = { text };
    if ((r as { bold?: unknown }).bold === true) run.bold = true;
    if ((r as { italic?: unknown }).italic === true) run.italic = true;
    if ((r as { underline?: unknown }).underline === true) run.underline = true;
    const color = (r as { color?: unknown }).color;
    if (typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color)) run.color = color;
    runs.push(run);
  }
  if (runs.length === 0) return undefined;
  return normalizeRuns(runs);
}

export type NavDir = "up" | "down" | "left" | "right";

export interface EditorState {
  docs: RnodeDocument[];
  activeDocId: string;
  selection: string[];
  camera: Camera;
  editingId: string | null;
  drop: DropIndicator | null;
  hoverId: string | null;
  showPalette: boolean;
  showOutliner: boolean;
  showInspector: boolean;
  search: string;
  searchResults: string[];
  searchIndex: number;
  /** Initial content for the inline editor: set by type-to-edit / paste-to-edit. */
  pendingInsert: string | null;
  sync: "saved" | "dirty";
  message: string | null;
  canUndo: boolean;
  canRedo: boolean;
  docTitle: string;
  theme: "light";
  structureType: string;
  mode: "select" | "pan";
  zen: boolean;
  relFrom: string | null;
  /** Selected overlay object: a relationship, group or summary (not a node). */
  relSel: string | null;
  groupSel: string | null;
  summarySel: string | null;
}

export class EditorStore {
  private state: EditorState;
  private snap: EditorState;
  private listeners = new Set<() => void>();
  private model: DocumentModel;
  private history = new History();
  private adapter: StorageAdapter;
  /**
   * File System Access handles (per document) so later saves silently
   * OVERWRITE the .rnode.json the user picked instead of re-downloading.
   * Handles are persisted in IndexedDB to survive reloads.
   */
  private fileHandles = new Map<string, FileSystemFileHandle>();
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Live rich-text draft of the inline editor (TextRun[]), kept in sync by
   * the Lexical overlay on every change. The canvas pointer handler runs
   * BEFORE the editor blur, so selection changes commit the draft instead of
   * losing it. While editing, the node's title/titleRuns mirror this draft so
   * the layout engine measures the topic at its live size (30ms debounce).
   */
  private editingDraftRuns: TextRun[] | null = null;
  /**
   * The node's committed title/titleRuns when editing started — used as the
   * `prev` of the final setTitle op (undo restores exactly this) and to
   * restore the node when the edit is cancelled (Escape).
   */
  private editOriginal: { title: string; titleRuns?: TextRun[] } | null = null;
  /**
   * Canvas resize drag (Xmind-style handles on the selected node's edges).
   * setResizeDraft mutates the node's width (and, for a left-edge drag, its
   * position.x with a transient manual flag) ephemerally — no op, no history
   * — so the layout re-wraps the text live during the drag. commitResize
   * emits ONE batch op (setStyle + optional setPosition), so undo restores
   * the exact pre-drag state.
   */
  private resizeState: { nodeId: string; original: Style; origPos: Position } | null = null;
  /** Canvas-backed measurer: layout and renderer agree on every topic size. */
  private measurer: TextMeasurer = createCanvasTextMeasurer();

  constructor(adapter: StorageAdapter = new LocalStorageAdapter()) {
    this.adapter = adapter;
    this.model = new DocumentModel(DocumentModel.sample());
    this.state = this.makeState();
    this.snap = this.state;
    this.normalizeBranchColors(this.model.sheet);
  }

  // -------------------------------------------------------------------------
  // React binding
  // -------------------------------------------------------------------------

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): EditorState => this.snap;

  get doc(): DocumentModel {
    return this.model;
  }

  get sheet(): Sheet {
    return this.model.sheet;
  }

  private makeState(): EditorState {
    const d = this.model.doc;
    return {
      docs: [d],
      activeDocId: d.documentId,
      selection: [],
      camera: { x: 0, y: 0, scale: 1 },
      editingId: null,
      drop: null,
      hoverId: null,
      showPalette: false,
      showOutliner: false,
      showInspector: true,
      search: "",
      searchResults: [],
      searchIndex: 0,
      pendingInsert: null,
      sync: "saved",
      message: null,
      canUndo: false,
      canRedo: false,
      docTitle: d.title,
      theme: "light",
      structureType: d.sheets[0].structure.structureType,
      mode: "select",
      zen: false,
      relFrom: null,
      relSel: null,
      groupSel: null,
      summarySel: null,
    };
  }

  private notify(): void {
    const d = this.model.doc;
    this.state = {
      ...this.state,
      docs: this.state.docs,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      docTitle: d.title,
      theme: "light",
      structureType: d.sheets[0].structure.structureType,
    };
    this.snap = { ...this.state, selection: [...this.state.selection], searchResults: [...this.state.searchResults] };
    for (const l of this.listeners) l();
  }

  toast(msg: string): void {
    this.state.message = msg;
    this.notify();
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => {
      this.state.message = null;
      this.notify();
    }, 2200);
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const docs = await this.adapter.load();
    if (docs.length > 0) {
      this.model = new DocumentModel(docs[0]);
    } else {
      // First run: start from the sample map. Nothing is persisted until the
      // user presses Save / Ctrl+S — the sample acts as an in-memory draft.
      this.model = new DocumentModel(DocumentModel.sample());
    }
    this.normalizeBranchColors(this.model.sheet);
    this.state = this.makeState();
    if (docs.length > 0) this.state.docs = docs;
    if (docs.length === 0) this.state.sync = "dirty";
    // Loading a document must respect positions explicitly placed by the
    // user. Forced layout is reserved for the explicit "Auto layout" command.
    this.scheduleLayout(false);
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Op execution
  // -------------------------------------------------------------------------

  /** Apply ops, record them in history, mark dirty, schedule layout. */
  execOps(ops: Op[], opts?: { skipHistory?: boolean }): void {
    if (ops.length === 0) return;
    const t = typeof performance !== "undefined" ? performance.now() : 0;
    const inverses: Op[][] = [];
    for (const op of ops) inverses.push(applyWithInverse(this.sheet, op));
    if (!opts?.skipHistory) this.history.push(ops, inverses);
    trace.op(ops.map((o) => o.type).join(","), ops.length, (typeof performance !== "undefined" ? performance.now() : 0) - t);
    this.touch();
  }

  undo(): void {
    const ops = this.history.undo();
    if (!ops) return;
    for (const op of ops) applyWithInverse(this.sheet, op);
    this.clearSelection();
    this.touch();
  }

  redo(): void {
    const ops = this.history.redo();
    if (!ops) return;
    for (const op of ops) applyWithInverse(this.sheet, op);
    this.clearSelection();
    this.touch();
  }

  private touch(): void {
    this.model.doc.updatedAt = nowIso();
    this.scheduleLayout(false);
    this.state.sync = "dirty";
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Layout (derived data — never in history)
  // -------------------------------------------------------------------------

  private scheduleLayout(force: boolean, clearManual = false): void {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      const t = typeof performance !== "undefined" ? performance.now() : 0;
      applyLayout(this.sheet, force, this.measurer, clearManual);
      trace.layout(Object.keys(this.sheet.nodes).length, (typeof performance !== "undefined" ? performance.now() : 0) - t);
      this.notify();
    }, 30);
  }

  // -------------------------------------------------------------------------
  // Save / Load (manual — the user decides when to persist)
  // -------------------------------------------------------------------------

  /**
   * Save the workspace: persist all docs to the storage adapter AND write the
   * portable .rnode.json. The first save lets the user pick the file location
   * (File System Access API); every later save silently OVERWRITES that same
   * file, so the file on disk is always the current version. Falls back to a
   * plain download (current content) where the API is unavailable.
   */
  async saveNow(): Promise<void> {
    // A Ctrl+S pressed while the inline editor is open must save the text the
    // user is typing: commit the draft without closing the editor, so they
    // can keep going. The later blur/Enter commit finds the title up to date.
    this.commitDraftKeepEditing();
    try {
      await this.adapter.save(this.state.docs);
      const json = JSON.stringify(this.model.doc, null, 2);
      const fileWritten = await this.writePortableFile(json);
      this.state.sync = "saved";
      this.toast(fileWritten ? "Saved" : "Saved locally (no file chosen)");
    } catch {
      this.state.sync = "dirty";
      this.toast("Save failed — check storage");
    }
  }

  /**
   * Write the portable .rnode.json. Returns true when a file was written or
   * downloaded; false when the user cancelled the file picker (the document
   * is still persisted to app storage).
   */
  private async writePortableFile(json: string): Promise<boolean> {
    const docId = this.model.doc.documentId;
    const key = `r-node.file-handle.${docId}`;

    // 1) Reuse the stored handle → silent overwrite, no dialog, no download.
    let handle = this.fileHandles.get(docId) ?? null;
    if (!handle) {
      handle = await this.loadFileHandle(key);
      if (handle) this.fileHandles.set(docId, handle);
    }
    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        return true;
      } catch {
        // Handle stale (file moved/deleted) → drop it and ask again.
        this.fileHandles.delete(docId);
        await this.clearFileHandle(key);
      }
    }

    // 2) No handle but the API exists → let the user pick where to save.
    if (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function") {
      try {
        const picked = await window.showSaveFilePicker({
          suggestedName: this.docFileName(),
          types: [{ description: "R-node document", accept: { "application/json": [".rnode.json", ".json"] } }],
        });
        const writable = await picked.createWritable();
        await writable.write(json);
        await writable.close();
        this.fileHandles.set(docId, picked);
        await this.storeFileHandle(key, picked);
        return true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return false;
        // picker failed (permission/unsupported) → fall back to download
      }
    }

    // 3) Fallback: download the file with the CURRENT content.
    const blob = new Blob([json], { type: "application/json" });
    this.download(blob, this.docFileName());
    return true;
  }

  private async storeFileHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    try {
      const db = await this.openIdb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("file-handles", "readwrite");
        tx.objectStore("file-handles").put(handle, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* handle persistence is best-effort */
    }
  }

  private async loadFileHandle(key: string): Promise<FileSystemFileHandle | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await this.openIdb();
      return await new Promise<FileSystemFileHandle | null>((resolve, reject) => {
        const tx = db.transaction("file-handles", "readonly");
        const req = tx.objectStore("file-handles").get(key);
        req.onsuccess = () => resolve((req.result as FileSystemFileHandle | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  private async clearFileHandle(key: string): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    try {
      const db = await this.openIdb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("file-handles", "readwrite");
        tx.objectStore("file-handles").delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* best-effort */
    }
  }

  private openIdb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("r-node", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("file-handles")) db.createObjectStore("file-handles");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Open a .rnode.json file from disk (file picker). Legacy .rmind.json files are still accepted. */
  async loadFile(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rnode.json,.rmind.json,application/json,.json";
    const file: File | null = await new Promise((resolve) => {
      input.onchange = (): void => resolve(input.files?.[0] ?? null);
      input.click();
    });
    if (!file) return;
    try {
      const text = await file.text();
      const id = this.importDocumentFromJson(text);
      if (id) this.toast(`Opened ${file.name}`);
      else this.toast("Not a valid R-node file");
    } catch {
      this.toast("Could not read the file");
    }
  }

  /**
   * Parse, validate and open a .rnode.json document. Returns the imported
   * document id, or null if the text is not a valid R-node document.
   */
  importDocumentFromJson(text: string): string | null {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    const doc = this.validateImportedDoc(raw);
    if (!doc) return null;
    const existing = this.state.docs.findIndex((d) => d.documentId === doc.documentId);
    if (existing >= 0) this.state.docs[existing] = doc;
    else this.state.docs = [...this.state.docs, doc];
    this.switchToDoc(doc.documentId);
    this.state.sync = "dirty"; // loaded from disk — not yet in app storage
    this.normalizeBranchColors(this.sheet);
    this.notify();
    return doc.documentId;
  }

  /** Structural validation + sanitization of an imported document. */
  private validateImportedDoc(raw: unknown): RnodeDocument | null {
    if (!raw || typeof raw !== "object") return null;
    const d = raw as Partial<RnodeDocument>;
    if (typeof d.documentId !== "string" || d.documentId.length === 0) return null;
    if (!Array.isArray(d.sheets) || d.sheets.length === 0) return null;
    const s = d.sheets[0] as Partial<Sheet> | undefined;
    if (!s || typeof s.rootNodeId !== "string" || !s.nodes || typeof s.nodes !== "object") return null;
    const rawNodes = s.nodes as Record<string, unknown>;
    const root = rawNodes[s.rootNodeId];
    if (!root || typeof root !== "object") return null;

    const nodes: Record<string, MindNode> = {};
    for (const [id, n] of Object.entries(rawNodes)) {
      if (!n || typeof n !== "object") continue;
      const node = n as Partial<MindNode>;
      const position = (typeof node.position === "object" && node.position ? node.position : {}) as Partial<Position>;
      nodes[id] = {
        id,
        type: typeof node.type === "string" ? node.type : "subtopic",
        parentId: typeof node.parentId === "string" || node.parentId === null ? node.parentId : null,
        childrenIds: Array.isArray(node.childrenIds) ? node.childrenIds.filter((c): c is string => typeof c === "string") : [],
        title: typeof node.title === "string" ? node.title : "",
        titleRuns: sanitizeTitleRuns(node.titleRuns),
        position: {
          x: typeof position.x === "number" ? position.x : 0,
          y: typeof position.y === "number" ? position.y : 0,
          manual: !!position.manual,
        },
        style: (typeof node.style === "object" && node.style ? node.style : {}) as Style,
        collapsed: !!node.collapsed,
        labels: Array.isArray(node.labels) ? node.labels.filter((l): l is string => typeof l === "string") : [],
        markers: Array.isArray(node.markers) ? node.markers.filter((m): m is string => typeof m === "string") : [],
        notes: typeof node.notes === "string" ? node.notes : "",
        task: typeof node.task === "object" && node.task ? (node.task as TaskInfo) : null,
        metadata: {
          createdAt: typeof node.metadata?.createdAt === "string" ? node.metadata.createdAt : nowIso(),
          updatedAt: typeof node.metadata?.updatedAt === "string" ? node.metadata.updatedAt : nowIso(),
        },
      };
    }

    const sheet: Sheet = {
      sheetId: typeof s.sheetId === "string" ? s.sheetId : uid("s"),
      title: typeof s.title === "string" ? s.title : "Map 1",
      structure: {
        structureType: s.structure?.structureType ?? "mindmap",
        orientation: s.structure?.orientation ?? "horizontal",
        spacing: typeof s.structure?.spacing === "number" ? s.structure.spacing : 180,
        branchSpacing: typeof s.structure?.branchSpacing === "number" ? s.structure.branchSpacing : 14,
        padding: typeof s.structure?.padding === "number" ? s.structure.padding : 18,
        compactMode: !!s.structure?.compactMode,
        autoBalance: s.structure?.autoBalance ?? true,
        freePositioningBranches: !!s.structure?.freePositioningBranches,
        allowManualPositioning: s.structure?.allowManualPositioning ?? true,
        connectorStyle: s.structure?.connectorStyle ?? "curved",
      },
      rootNodeId: s.rootNodeId,
      nodes,
      relationships: Array.isArray(s.relationships) ? s.relationships : [],
      boundaries: Array.isArray(s.boundaries) ? s.boundaries : [],
      summaries: Array.isArray(s.summaries) ? s.summaries : [],
      callouts: Array.isArray(s.callouts) ? s.callouts : [],
      labels: Array.isArray(s.labels) ? s.labels : [],
      zones: Array.isArray(s.zones) ? s.zones : [],
      attachments: Array.isArray(s.attachments) ? s.attachments : [],
      comments: Array.isArray(s.comments) ? s.comments : [],
      presentation: typeof s.presentation === "object" && s.presentation ? s.presentation : {},
    };

    return {
      schemaVersion: typeof d.schemaVersion === "string" ? d.schemaVersion : SCHEMA_VERSION,
      documentId: d.documentId,
      title: typeof d.title === "string" ? d.title : "Imported map",
      createdAt: typeof d.createdAt === "string" ? d.createdAt : nowIso(),
      updatedAt: nowIso(),
      archived: !!d.archived,
      pinned: !!d.pinned,
      settings: {
        theme: "light",
        showOutliner: !!d.settings?.showOutliner,
        showInspector: d.settings?.showInspector ?? true,
      },
      themeId: typeof d.themeId === "string" ? d.themeId : "r-node-light",
      sheets: [sheet],
    };
  }

  private docFileName(): string {
    return `${this.model.doc.title.replace(/[^\w-]+/g, "_")}.rnode.json`;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  select(id: string, opts?: { additive?: boolean; center?: boolean }): void {
    // The canvas pointer handler runs before the textarea blur fires. Commit
    // the in-progress edit here so clicking away never loses typed text.
    this.commitDraftOnLeave();
    const additive = opts?.additive ?? false;
    let sel: string[];
    if (additive) {
      sel = this.state.selection.includes(id) ? this.state.selection.filter((s) => s !== id) : [...this.state.selection, id];
    } else {
      sel = [id];
    }
    this.state.selection = sel;
    this.state.editingId = null;
    this.state.pendingInsert = null;
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.summarySel = null;
    if (opts?.center) this.centerOnNode(id);
    this.notify();
  }

  selectMany(ids: string[], opts?: { additive?: boolean }): void {
    this.commitDraftOnLeave();
    if (opts?.additive) {
      const set = new Set(this.state.selection);
      for (const id of ids) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      this.state.selection = [...set];
    } else {
      this.state.selection = [...ids];
    }
    this.state.editingId = null;
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.summarySel = null;
    this.notify();
  }

  clearSelection(): void {
    this.commitDraftOnLeave();
    if (this.state.selection.length === 0 && !this.state.relSel && !this.state.groupSel && !this.state.summarySel) return;
    this.state.selection = [];
    this.state.editingId = null;
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.summarySel = null;
    this.notify();
  }

  get selectionNode(): MindNode | null {
    const id = this.state.selection[this.state.selection.length - 1];
    return id ? this.model.node(id) ?? null : null;
  }

  // -------------------------------------------------------------------------
  // Text editing
  // -------------------------------------------------------------------------

  startEdit(id: string): void {
    trace.edit("start", id);
    this.commitDraftOnLeave();
    const node = this.model.node(id);
    if (!node) return;
    this.state.selection = [id];
    this.state.editingId = id;
    this.state.pendingInsert = null;
    this.editOriginal = { title: node.title, titleRuns: node.titleRuns };
    // Seed the draft with the current title so layout keeps measuring the
    // node at its current size until the editor reports its first change.
    this.applyDraftRuns(id, nodeRuns(node.title, node.titleRuns), false);
    this.notify();
  }

  /**
   * XMind-style type/paste-to-edit: a printable character (or pasted text)
   * with a topic selected starts editing it with that content. The editor
   * consumes the pending insert on mount, replacing the previous title.
   */
  typeToEdit(text: string): void {
    this.commitDraftOnLeave();
    const node = this.selectionNode;
    if (!node) return;
    this.state.selection = [node.id];
    this.state.editingId = node.id;
    this.state.pendingInsert = text;
    this.editOriginal = { title: node.title, titleRuns: node.titleRuns };
    this.applyDraftRuns(node.id, nodeRuns(node.title, node.titleRuns), false);
    this.notify();
  }

  /** The Lexical overlay calls this on mount to pick up the pending type/paste text. */
  consumePendingInsert(): string | null {
    const v = this.state.pendingInsert;
    this.state.pendingInsert = null;
    return v;
  }

  /**
   * Buffer an extra character while the type-to-edit editor is still
   * mounting (pendingInsert not yet consumed). Without this, fast typists
   * lose the keystrokes between typeToEdit() and the editor appearing:
   * the shortcut handler sees editingId set and drops them.
   */
  appendPendingInsert(ch: string): boolean {
    if (this.state.pendingInsert === null) return false;
    this.state.pendingInsert += ch;
    this.notify();
    return true;
  }

  /** Plain-text shim (Inspector/Outliner/tests): a single unstyled run. */
  setEditingDraft(text: string | null): void {
    if (text === null) {
      this.editingDraftRuns = null;
      return;
    }
    this.setEditingDraftRuns(plainToRuns(text));
  }

  /**
   * The Lexical overlay reports its live content as TextRuns on every
   * change. The draft is applied to the node ephemerally (no op, no history)
   * so the debounced layout and the canvas repaint track the text live.
   */
  setEditingDraftRuns(runs: TextRun[]): void {
    const id = this.state.editingId;
    if (!id) return;
    this.applyDraftRuns(id, runs, true);
  }

  /** Apply the draft runs to the node (ephemeral) and schedule live layout. */
  private applyDraftRuns(id: string, runs: TextRun[], notify: boolean): void {
    const node = this.model.node(id);
    if (!node) return;
    const clean = normalizeRuns(runs);
    this.editingDraftRuns = clean;
    if (clean.length > 0) {
      node.title = runsToPlain(clean);
      node.titleRuns = clean;
    } else {
      node.title = "";
      node.titleRuns = [];
    }
    if (notify) {
      this.scheduleLayout(false);
      this.notify();
    }
  }

  private restoreOriginal(node: MindNode, original: { title: string; titleRuns?: TextRun[] } | null): void {
    if (!original) return;
    node.title = original.title;
    if (original.titleRuns) node.titleRuns = original.titleRuns.map((r) => ({ ...r }));
    else delete node.titleRuns;
  }

  /**
   * Commit the in-progress edit as a real setTitle op. Selection changes
   * commit the draft too, so clicking away (pointerdown runs before blur)
   * never loses typed text. Undo restores the pre-edit title exactly.
   */
  commitEdit(): void {
    trace.edit("commit", this.state.editingId ?? undefined);
    const id = this.state.editingId;
    const runs = this.editingDraftRuns;
    const original = this.editOriginal;
    this.state.editingId = null;
    this.editingDraftRuns = null;
    this.editOriginal = null;
    this.state.pendingInsert = null;
    if (!id || runs === null || !original) return;
    const node = this.model.node(id);
    if (!node) return;
    const clean = trimRuns(runs);
    if (isEmptyRuns(clean)) {
      // empty new topic -> delete it; a topic with children keeps its title
      if (node.childrenIds.length === 0) this.deleteNodes([id]);
      else {
        this.restoreOriginal(node, original);
        this.notify();
      }
      return;
    }
    const plain = runsToPlain(clean);
    if (plain !== original.title || !runsEqual(clean, original.titleRuns)) {
      this.execOps([
        makeOp<Op & { type: "setTitle" }>("setTitle", {
          id,
          title: plain,
          prev: original.title,
          titleRuns: clean,
          prevRuns: original.titleRuns,
        }),
      ]);
    } else {
      // unchanged -> drop the ephemeral patch, nothing to record
      this.restoreOriginal(node, original);
      this.notify();
    }
  }

  /**
   * Apply the in-progress edit (setTitle) WITHOUT closing the editor. Ctrl+S
   * while typing therefore saves the current text and keeps editing.
   */
  private commitDraftKeepEditing(): void {
    const id = this.state.editingId;
    const runs = this.editingDraftRuns;
    const original = this.editOriginal;
    if (!id || runs === null || !original) return;
    const node = this.model.node(id);
    if (!node) return;
    const clean = trimRuns(runs);
    if (isEmptyRuns(clean)) return;
    const plain = runsToPlain(clean);
    if (plain === original.title && runsEqual(clean, original.titleRuns)) return;
    this.execOps([
      makeOp<Op & { type: "setTitle" }>("setTitle", {
        id,
        title: plain,
        prev: original.title,
        titleRuns: clean,
        prevRuns: original.titleRuns,
      }),
    ]);
    // The committed state is now the baseline for any further Ctrl+S.
    this.editOriginal = { title: plain, titleRuns: clean };
  }

  /** Commit the draft when the selection/editing context is about to change. */
  private commitDraftOnLeave(): void {
    if (this.state.editingId !== null) this.commitEdit();
    else {
      this.editingDraftRuns = null;
      this.editOriginal = null;
      this.state.pendingInsert = null;
    }
  }

  cancelEdit(): void {
    trace.edit("cancel", this.state.editingId ?? undefined);
    const id = this.state.editingId;
    const original = this.editOriginal;
    this.state.editingId = null;
    this.editingDraftRuns = null;
    this.editOriginal = null;
    this.state.pendingInsert = null;
    if (id) {
      const node = this.model.node(id);
      if (!node) return;
      this.restoreOriginal(node, original);
      if (node.title === "" && node.childrenIds.length === 0) this.deleteNodes([id]);
      else this.notify();
    }
  }

  // -------------------------------------------------------------------------
  // Structure commands (Enter / Tab / Shift+Tab ...)
  // -------------------------------------------------------------------------

  private defaultTopicTitle(type: NodeType, parentId: string | null): string {
    if (type === "central") return "Central Topic";
    if (type === "floating") return "New Idea";
    const label = type === "main" ? "Main Topic" : "Subtopic";
    const parent = parentId ? this.model.node(parentId) : undefined;
    const siblingCount = parent?.childrenIds.reduce((count, id) => {
      return count + (this.model.node(id)?.type === type ? 1 : 0);
    }, 0) ?? Object.values(this.sheet.nodes).filter((n) => n.type === type).length;
    return `${label} ${siblingCount + 1}`;
  }

  private normalizeBranchColors(sheet: Sheet): void {
    const root = sheet.nodes[sheet.rootNodeId];
    if (!root) return;
    for (const [index, childId] of root.childrenIds.entries()) {
      const child = sheet.nodes[childId];
      if (!child) continue;
      if (!child.style.fill) child.style.fill = this.defaultBranchFill(index);
      const softFill = this.defaultBranchSoftFill(childId);
      const stack = [childId];
      while (stack.length > 0) {
        const currentId = stack.pop()!;
        const current = sheet.nodes[currentId];
        if (!current) continue;
        if (currentId !== childId && !current.style.fill) current.style.fill = softFill;
        stack.push(...current.childrenIds);
      }
    }
  }

  private defaultBranchFill(index: number): string {
    return THEMES.light.branch[index % THEMES.light.branch.length];
  }

  private createNodePosition(parent: MindNode): { x: number; y: number; manual: boolean } {
    const base = parent.position;
    const st = this.sheet.structure;
    const pSize = measureNode(parent, this.measurer);
    const estimatedW = 140;
    const offsetX = parent.type === "central" ? pSize.w / 2 + st.spacing + estimatedW / 2 + 20 : pSize.w / 2 + st.spacing + estimatedW / 2 + 10;
    const offsetY = parent.type === "central" ? parent.childrenIds.length * (pSize.h + st.branchSpacing) - (parent.childrenIds.length > 0 ? pSize.h / 2 : 0) : parent.childrenIds.length * (pSize.h + st.branchSpacing);
    return { x: base.x + offsetX, y: base.y + offsetY, manual: false };
  }

  private branchRootId(parentId: string | null): string | null {
    if (!parentId) return null;
    let cur: string | null = parentId;
    let prev: string | null = parentId;
    while (cur && cur !== this.sheet.rootNodeId) {
      prev = cur;
      cur = this.sheet.nodes[cur]?.parentId ?? null;
    }
    return prev;
  }

  private defaultBranchSoftFill(rootId: string | null): string | undefined {
    if (!rootId) return undefined;
    const root = this.sheet.nodes[this.sheet.rootNodeId];
    if (!root) return undefined;
    const index = root.childrenIds.indexOf(rootId);
    return THEMES.light.branchSoft[(index >= 0 ? index : 0) % THEMES.light.branchSoft.length];
  }

  private createNodeStyle(type: NodeType, parentId: string | null, index: number): Style | undefined {
    if (type === "main" && parentId === this.sheet.rootNodeId) {
      return { fill: this.defaultBranchFill(index) };
    }
    if (type === "subtopic") {
      const branchRootId = this.branchRootId(parentId);
      return { fill: this.defaultBranchSoftFill(branchRootId) };
    }
    return undefined;
  }

  createSibling(): void {
    const node = this.selectionNode;
    if (!node) return;
    if (node.type === "central") return this.createChild();
    if (!node.parentId) {
      this.toast("Floating topics have no siblings");
      return;
    }
    const parent = this.model.requireNode(node.parentId);
    const index = parent.childrenIds.indexOf(node.id) + 1;
    const type: NodeType = parent.type === "central" ? "main" : "subtopic";
    const id = uid("n");
    const position = this.createNodePosition(type === "main" ? parent : node);
    const style = this.createNodeStyle(type, parent.id, index);
    this.execOps([makeOp<Op & { type: "createNode" }>("createNode", { id, nodeType: type, parentId: parent.id, index, title: this.defaultTopicTitle(type, parent.id), position, style })]);
    this.startEdit(id);
  }

  createChild(): void {
    const node = this.selectionNode ?? this.model.rootNode;
    const type: NodeType = node.type === "central" ? "main" : "subtopic";
    const id = uid("n");
    const position = this.createNodePosition(node);
    const style = this.createNodeStyle(type, node.id, node.childrenIds.length);
    this.execOps([makeOp<Op & { type: "createNode" }>("createNode", { id, nodeType: type, parentId: node.id, index: node.childrenIds.length, title: this.defaultTopicTitle(type, node.id), position, style })]);
    // Tab spawns the child without entering edit mode: the selection stays on
    // the source node, so repeated Tab keeps adding siblings under the same
    // parent instead of nesting (or stealing the selection).
    this.notify();
  }

  createParent(): void {
    const node = this.selectionNode;
    if (!node || !node.parentId) return;
    const parent = this.model.requireNode(node.parentId);
    const type: NodeType = parent.type === "central" ? "main" : "subtopic";
    const newId = uid("n");
    const idx = parent.childrenIds.indexOf(node.id);
    const style = this.createNodeStyle(type, parent.id, idx);
    const ops: Op[] = [
      makeOp<Op & { type: "createNode" }>("createNode", { id: newId, nodeType: type, parentId: parent.id, index: idx, title: this.defaultTopicTitle(type, parent.id), style }),
      makeOp<Op & { type: "moveNode" }>("moveNode", {
        id: node.id,
        fromParentId: parent.id,
        fromIndex: idx + 1,
        toParentId: newId,
        toIndex: 0,
      }),
    ];
    if (node.position.manual) {
      ops.push(makeOp<Op & { type: "setPosition" }>("setPosition", {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        manual: false,
        prev: { ...node.position },
      }));
    }
    this.execOps(ops);
    this.select(newId);
  }

  createFloatingAt(x: number, y: number): void {
    const id = uid("n");
    this.execOps([
      makeOp<Op & { type: "createNode" }>("createNode", {
        id,
        nodeType: "floating",
        parentId: null,
        index: 0,
        title: this.defaultTopicTitle("floating", null),
        position: { x, y, manual: true },
      }),
    ]);
    this.startEdit(id);
  }

  promote(): void {
    const node = this.selectionNode;
    if (!node || !node.parentId) return;
    const parent = this.model.requireNode(node.parentId);
    if (!parent.parentId) {
      this.toast("Already at top level");
      return;
    }
    const grand = this.model.requireNode(parent.parentId);
    const fromIndex = parent.childrenIds.indexOf(node.id);
    const toIndex = grand.childrenIds.indexOf(parent.id) + 1;
    const ops: Op[] = [makeOp<Op & { type: "moveNode" }>("moveNode", { id: node.id, fromParentId: parent.id, fromIndex, toParentId: grand.id, toIndex })];
    if (node.position.manual) {
      ops.push(makeOp<Op & { type: "setPosition" }>("setPosition", {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        manual: false,
        prev: { ...node.position },
      }));
    }
    this.execOps(ops);
  }

  demote(): void {
    const node = this.selectionNode;
    if (!node || !node.parentId) return;
    const parent = this.model.requireNode(node.parentId);
    const idx = parent.childrenIds.indexOf(node.id);
    if (idx <= 0) return;
    const prev = this.model.requireNode(parent.childrenIds[idx - 1]);
    const ops: Op[] = [makeOp<Op & { type: "moveNode" }>("moveNode", { id: node.id, fromParentId: parent.id, fromIndex: idx, toParentId: prev.id, toIndex: prev.childrenIds.length })];
    if (node.position.manual) {
      ops.push(makeOp<Op & { type: "setPosition" }>("setPosition", {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        manual: false,
        prev: { ...node.position },
      }));
    }
    this.execOps(ops);
  }

  toggleCollapsed(id: string): void {
    const node = this.model.node(id);
    if (!node) return;
    this.execOps([makeOp<Op & { type: "setCollapsed" }>("setCollapsed", { id, collapsed: !node.collapsed, prev: node.collapsed })]);
  }

  expandAll(id: string): void {
    const ops: Op[] = [];
    for (const sid of this.model.subtreeIds(id)) {
      const n = this.model.node(sid);
      if (n?.collapsed) ops.push(makeOp<Op & { type: "setCollapsed" }>("setCollapsed", { id: sid, collapsed: false, prev: true }));
    }
    if (ops.length) this.execOps(ops);
  }

  deleteSelection(): void {
    this.deleteNodes([...this.state.selection]);
  }

  /** Delete nodes (and descendants); central topic is protected. */
  deleteNodes(ids: string[]): void {
    const pruned = ids.filter((id) => id !== this.sheet.rootNodeId);
    const toDelete: string[] = [];
    for (const id of pruned) {
      if (toDelete.some((d) => this.isDescendant(d, id))) continue;
      toDelete.push(id);
    }
    const ops: Op[] = [];
    for (const id of toDelete) {
      const node = this.model.node(id);
      if (!node) continue;
      const subtree = this.model.subtreeIds(id).map((sid) => this.model.node(sid)!).filter(Boolean);
      const subtreeSet = new Set(subtree.map((s) => s.id));
      const removedRelationships = this.sheet.relationships.filter((r) => subtreeSet.has(r.fromId) || subtreeSet.has(r.toId));
      const parentId = node.parentId;
      const index = parentId ? this.model.requireNode(parentId).childrenIds.indexOf(id) : 0;
      ops.push(makeOp<Op & { type: "deleteNode" }>("deleteNode", { id, parentId, index, subtree, removedRelationships }));
    }
    // Drop groups/summaries whose members are all gone (their boxes/braces
    // would dangle otherwise). Undo of the batch restores them.
    const deletedSet = new Set<string>();
    for (const id of toDelete) for (const sid of this.model.subtreeIds(id)) deletedSet.add(sid);
    for (const g of this.sheet.boundaries) {
      if (g.memberIds.length > 0 && g.memberIds.every((m) => deletedSet.has(m))) {
        ops.push(makeOp<Op & { type: "deleteGroup" }>("deleteGroup", { id: g.id, group: g }));
      }
    }
    for (const s of this.sheet.summaries) {
      if (s.memberIds.length > 0 && s.memberIds.every((m) => deletedSet.has(m))) {
        ops.push(makeOp<Op & { type: "deleteSummary" }>("deleteSummary", { id: s.id, summary: s }));
      }
    }
    if (ops.length) {
      this.execOps(ops);
      this.state.selection = [];
      this.state.relSel = null;
      this.state.groupSel = null;
      this.state.summarySel = null;
      this.notify();
    }
  }

  private isDescendant(ancestorId: string, id: string): boolean {
    let cur = this.model.node(id)?.parentId ?? null;
    while (cur) {
      if (cur === ancestorId) return true;
      cur = this.model.node(cur)?.parentId ?? null;
    }
    return false;
  }

  /** Descendant ids whose position is manually pinned (must follow their parent). */
  private collectManualDescendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...(this.model.node(id)?.childrenIds ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const n = this.model.node(cur);
      if (!n) continue;
      if (n.position.manual) out.push(cur);
      stack.push(...n.childrenIds);
    }
    return out;
  }

  sortSiblings(parentId: string, compare: (a: MindNode, b: MindNode) => number): void {
    const parent = this.model.node(parentId);
    if (!parent || parent.childrenIds.length < 2) return;
    const prevOrder = [...parent.childrenIds];
    const order = [...prevOrder].sort((a, b) => compare(this.model.node(a)!, this.model.node(b)!));
    if (order.every((v, i) => v === prevOrder[i])) return;
    this.execOps([makeOp<Op & { type: "sortSiblings" }>("sortSiblings", { parentId, order, prevOrder })]);
  }

  // -------------------------------------------------------------------------
  // Drag & drop
  // -------------------------------------------------------------------------

  setDrop(drop: DropIndicator | null): void {
    this.state.drop = drop;
    this.notify();
  }

  setHover(id: string | null): void {
    if (this.state.hoverId === id) return;
    this.state.hoverId = id;
    this.notify();
  }

  /** Reparenting hands the topic back to the automatic layout engine. */
  private releaseManualPosition(node: MindNode): Op | null {
    if (!node.position.manual) return null;
    return makeOp<Op & { type: "setPosition" }>("setPosition", {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      manual: false,
      prev: { ...node.position },
    });
  }

  /** Resolve a drop of `draggedId` over `targetId`/empty space. */
  dropAt(draggedId: string, targetId: string | null, mode: "child" | "before" | "after" | "floating", worldX: number, worldY: number): void {
    const node = this.model.node(draggedId);
    if (!node || draggedId === targetId) {
      this.setDrop(null);
      return;
    }
    if (targetId) {
      const target = this.model.node(targetId);
      if (!target || this.isDescendant(draggedId, targetId)) {
        this.setDrop(null);
        return;
      }
      if (mode === "child") {
        const ops: Op[] = [makeOp<Op & { type: "moveNode" }>("moveNode", {
          id: draggedId,
          fromParentId: node.parentId,
          fromIndex: node.parentId ? this.model.requireNode(node.parentId).childrenIds.indexOf(draggedId) : 0,
          toParentId: targetId,
          toIndex: target.childrenIds.length,
        })];
        const release = this.releaseManualPosition(node);
        if (release) ops.push(release);
        this.execOps(ops);
      } else if (mode === "before" || mode === "after") {
        if (!target.parentId) {
          this.setDrop(null);
          return;
        }
        const targetParent = this.model.requireNode(target.parentId);
        const targetIdx = targetParent.childrenIds.indexOf(targetId);
        const desired = mode === "after" ? targetIdx + 1 : targetIdx;
        // final index after removing the dragged node (if same parent)
        let finalIdx = desired;
        if (node.parentId === target.parentId) {
          const curIdx = targetParent.childrenIds.indexOf(draggedId);
          if (curIdx >= 0 && curIdx < desired) finalIdx = desired - 1;
        }
        const ops: Op[] = [makeOp<Op & { type: "moveNode" }>("moveNode", {
          id: draggedId,
          fromParentId: node.parentId,
          fromIndex: node.parentId ? this.model.requireNode(node.parentId).childrenIds.indexOf(draggedId) : 0,
          toParentId: target.parentId,
          toIndex: finalIdx,
        })];
        const release = node.parentId !== target.parentId ? this.releaseManualPosition(node) : null;
        if (release) ops.push(release);
        this.execOps(ops);
      }
    } else if (mode === "floating") {
      // allow floating drops generally; respect sheet setting if manual positioning disabled
      if (!this.sheet.structure.allowManualPositioning) {
        this.setDrop(null);
        return;
      }
      // Only main topics (direct children of root) and floating topics (no
      // parent) may be pinned to an absolute position. Deeper hierarchical
      // nodes stay in the auto layout and follow their parent — dropping one
      // on empty canvas does nothing.
      const isRootChild = node.parentId === this.sheet.rootNodeId;
      const isFloatingTopic = !node.parentId;
      if (!isRootChild && !isFloatingTopic) {
        this.setDrop(null);
        return;
      }
      // If dragging a direct child of root, allow swapping sides by reordering
      if (isRootChild) {
        const parent = this.model.requireNode(this.sheet.rootNodeId);
        const layout = layoutSheet(this.sheet, false, this.measurer);
        const rootCx = layout.positions.get(this.sheet.rootNodeId)?.x ?? parent.position.x;
        let desiredIndex = worldX < (rootCx + measureNode(parent, this.measurer).w / 2) ? parent.childrenIds.length : 0;
        // adjust for current index
        const curIdx = parent.childrenIds.indexOf(draggedId);
        if (curIdx >= 0 && curIdx < desiredIndex) desiredIndex = desiredIndex - 1;
        const ops: Op[] = [
          makeOp<Op & { type: "moveNode" }>("moveNode", {
            id: draggedId,
            fromParentId: node.parentId,
            fromIndex: curIdx >= 0 ? curIdx : 0,
            toParentId: parent.id,
            toIndex: desiredIndex,
          }),
          makeOp<Op & { type: "setPosition" }>("setPosition", {
            id: draggedId,
            x: worldX,
            y: worldY,
            manual: true,
            prev: node.position,
          }),
        ];
        // Children must follow the main keeping their relative layout: drop any
        // leftover manual pin on descendants so the whole subtree re-flows
        // around the main's new position.
        for (const descId of this.collectManualDescendants(draggedId)) {
          const d = this.model.node(descId);
          if (!d) continue;
          ops.push(makeOp<Op & { type: "setPosition" }>("setPosition", {
            id: descId,
            x: d.position.x,
            y: d.position.y,
            manual: false,
            prev: { ...d.position },
          }));
        }
        this.execOps(ops);
      } else {
        this.execOps([
          makeOp<Op & { type: "setPosition" }>("setPosition", {
            id: draggedId,
            x: worldX,
            y: worldY,
            manual: true,
            prev: node.position,
          }),
        ]);
      }
    }
    this.setDrop(null);
    this.select(draggedId);
  }

  // -------------------------------------------------------------------------
  // Style / tasks
  // -------------------------------------------------------------------------

  setNodeStyle(id: string, patch: Partial<Style>): void {
    const node = this.model.node(id);
    if (!node) return;
    this.execOps([makeOp<Op & { type: "setStyle" }>("setStyle", { id, style: { ...node.style, ...patch }, prev: node.style })]);
  }

  // -------------------------------------------------------------------------
  // Canvas resize drag (Xmind-style handle) — ephemeral draft, single commit
  // -------------------------------------------------------------------------

  /** A resize drag started on this node: capture the pre-drag style + position. */
  beginResize(nodeId: string): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    this.resizeState = { nodeId, original: { ...node.style }, origPos: { ...node.position } };
  }

  /**
   * Live width during the drag: ephemeral mutation, no op, no history.
   * For a left-edge drag the right edge is the anchor: position.x follows
   * the cursor with a TRANSIENT manual flag — applyLayout skips manual
   * nodes and would otherwise snap the position back every 30ms. The flag
   * is restored to its original value by commitResize.
   */
  setResizeDraft(nodeId: string, width: number, opts?: { anchorRight?: boolean; x?: number }): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    const w = Math.round(Math.min(640, Math.max(MIN_TOPIC_W, width)));
    node.style = { ...node.style, width: w };
    if (opts?.anchorRight && typeof opts.x === "number") {
      node.position = { ...node.position, x: opts.x, manual: true };
    }
    this.scheduleLayout(false);
    this.notify();
  }

  /** End of the drag: one batch op (setStyle + optional setPosition); undo restores it all. */
  commitResize(): void {
    const r = this.resizeState;
    this.resizeState = null;
    if (!r) return;
    const node = this.model.node(r.nodeId);
    if (!node) return;
    const w = node.style.width;
    const xChanged = node.position.x !== r.origPos.x;
    // A left-edge drag moves position.x. It persists only for floating or
    // already-manual nodes; auto-layout nodes return to the layout's slot
    // (the width is what survives there — the next applyLayout re-pins x).
    const keepX = xChanged && (node.type === "floating" || r.origPos.manual);
    const ops: Op[] = [];
    if (w !== undefined && w !== r.original.width) {
      ops.push(
        makeOp<Op & { type: "setStyle" }>("setStyle", {
          id: r.nodeId,
          style: { ...node.style, width: w },
          prev: r.original,
        })
      );
    }
    if (keepX) {
      ops.push(
        makeOp<Op & { type: "setPosition" }>("setPosition", {
          id: r.nodeId,
          x: node.position.x,
          y: node.position.y,
          manual: true,
          prev: r.origPos,
        })
      );
    } else if (xChanged) {
      node.position = { ...r.origPos };
    }
    if (ops.length > 0) {
      this.execOps(ops);
    } else {
      // click without a real change — restore the pre-drag state, no op
      node.style = r.original;
      node.position = { ...r.origPos };
      this.scheduleLayout(false);
      this.notify();
    }
  }

  setBranchFreePosition(id: string, enabled: boolean): void {
    const node = this.model.node(id);
    if (!node || node.type !== "main") return;
    this.execOps([
      makeOp<Op & { type: "setPosition" }>("setPosition", {
        id,
        x: node.position.x,
        y: node.position.y,
        manual: enabled,
        prev: { ...node.position },
      }),
    ]);
  }

  setTask(id: string, patch: Partial<TaskInfo>): void {
    const node = this.model.node(id);
    if (!node) return;
    const current = node.task ?? { status: "not-started", priority: "none", progress: 0 };
    this.execOps([makeOp<Op & { type: "setTask" }>("setTask", { id, task: { ...current, ...patch }, prev: node.task })]);
  }

  toggleTaskComplete(id: string): void {
    const node = this.model.node(id);
    if (!node) return;
    const current = node.task ?? { status: "not-started", priority: "none", progress: 0 };
    const next: TaskInfo = { ...current, status: current.status === "completed" ? "not-started" : "completed", progress: current.status === "completed" ? 0 : 100 };
    this.execOps([makeOp<Op & { type: "setTask" }>("setTask", { id, task: next, prev: node.task })]);
  }

  duplicateTopic(): void {
    const node = this.selectionNode;
    if (!node || !node.parentId) return;
    if (node.id === this.sheet.rootNodeId) {
      this.toast("Cannot duplicate the central topic");
      return;
    }
    const parent = this.model.requireNode(node.parentId);
    const index = parent.childrenIds.indexOf(node.id) + 1;
    const source = this.model.subtreeIds(node.id).map((id) => this.model.node(id)!).filter(Boolean);
    const ops = this.remapOps(source, parent.id, index, node.type);
    if (ops.length) this.execOps(ops);
  }

  /** Indented text outline (XMind-style) of the pruned selection: each selected
   *  topic is a root line, descendants follow indented, in tree order. */
  private outlineText(pruned: string[]): string {
    const lines: string[] = [];
    const emit = (id: string, depth: number): void => {
      const n = this.model.node(id);
      if (!n) return;
      lines.push("  ".repeat(depth) + runsToPlain(nodeRuns(n.title, n.titleRuns)));
      for (const cid of n.childrenIds) emit(cid, depth + 1);
    };
    const walk = (id: string): void => {
      if (pruned.includes(id)) emit(id, 0);
      const n = this.model.node(id);
      if (!n) return;
      for (const cid of n.childrenIds) walk(cid);
    };
    walk(this.sheet.rootNodeId);
    return lines.join("\n");
  }

  async copySelection(): Promise<void> {
    const ids = this.state.selection;
    const pruned = ids.filter((id) => !ids.some((other) => other !== id && this.isDescendant(other, id)));
    const rootId = pruned[0];
    if (!rootId) return;
    const subtreeIds = this.model.subtreeIds(rootId);
    const nodes = subtreeIds.map((id) => this.model.node(id)!).filter(Boolean);
    const rels = this.sheet.relationships.filter((r) => subtreeIds.includes(r.fromId) && subtreeIds.includes(r.toId));
    const payload = JSON.stringify({ app: "r-node", payload: { rootId, nodes, relationships: rels } });
    const text = this.outlineText(pruned);
    try {
      // Two formats on the clipboard at once: the full map as the custom
      // `text/rnode` MIME (internal paste keeps every run/style), and the
      // plain-text outline as `text/plain` so pasting OUTSIDE R-node (chat,
      // Word, notes) yields readable text instead of raw JSON.
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/rnode": new Blob([payload], { type: "text/rnode" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    } catch {
      // ClipboardItem with custom types unsupported (older engines / blocked) —
      // fall back to plain text only.
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* clipboard may be blocked; copying still succeeded in-memory */
      }
    }
    this.toast(`Copied ${nodes.length} topic${nodes.length > 1 ? "s" : ""}`);
  }

  /** Copy the selected branches to the clipboard as an indented text outline
   *  (XMind-style): each selected topic becomes a root line, its descendants
   *  follow indented, in tree order. */
  async copySelectionOutline(): Promise<void> {
    const ids = this.state.selection;
    const pruned = ids.filter((id) => !ids.some((other) => other !== id && this.isDescendant(other, id)));
    if (pruned.length === 0) return;
    const text = this.outlineText(pruned);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be blocked */
    }
    this.toast(`Copied outline (${text.split("\n").length} lines)`);
  }

  async cutSelection(): Promise<void> {
    await this.copySelection();
    this.deleteSelection();
  }

  async paste(anchorId?: string | null): Promise<void> {
    // Prefer the full-fidelity `text/rnode` payload that copySelection writes;
    // fall back to whatever plain text is on the clipboard (external sources,
    // or older engines that can't read custom MIME types).
    let text: string | null = null;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes("text/rnode")) {
          text = await item.getType("text/rnode").then((blob) => blob.text());
          break;
        }
      }
    } catch {
      /* clipboard read with MIME types blocked — fall through to readText */
    }
    if (text === null) text = await navigator.clipboard.readText().catch(() => null);
    if (!text) return;
    let parsed: { app?: string; payload?: { rootId: string; nodes: MindNode[]; relationships: { fromId: string; toId: string; label?: string }[] } } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.app !== "r-node" || !parsed.payload) {
      // Plain text on the clipboard: XMind-style, paste it straight into the
      // selected topic instead of rejecting it as "not a map".
      const target = this.selectionNode;
      if (target) {
        this.typeToEdit(text);
        this.toast("Pasted into topic");
      } else {
        this.toast("Clipboard does not contain a map");
      }
      return;
    }
    const payload = parsed.payload;
    const anchor = anchorId ?? this.state.selection[this.state.selection.length - 1] ?? this.sheet.rootNodeId;
    const anchorNode = this.model.node(anchor);
    const srcRoot = payload.nodes.find((n) => n.id === payload.rootId);
    if (!anchorNode || !srcRoot) return;
    const type: NodeType = anchorNode.type === "central" ? "main" : "subtopic";
    const ops = this.remapOps(payload.nodes, anchor, anchorNode.childrenIds.length, type);
    if (ops.length === 0) return;
    for (const rel of payload.relationships ?? []) {
      const from = this.lastRemap.get(rel.fromId);
      const to = this.lastRemap.get(rel.toId);
      if (from && to) {
        ops.push(
          makeOp<Op & { type: "createRelationship" }>("createRelationship", {
            relationship: { id: uid("rel"), fromId: from, toId: to, label: rel.label },
          })
        );
      }
    }
    this.execOps(ops);
    this.select(this.lastRemap.get(srcRoot.id)!);
    this.toast("Pasted");
  }

  private lastRemap = new Map<string, string>();

  /** Build createNode ops that clone a subtree under a new parent, remapping ids. */
  private remapOps(source: MindNode[], parentId: string, index: number, rootType: NodeType): Op[] {
    const idMap = new Map<string, string>();
    this.lastRemap = idMap;
    const ops: Op[] = [];
    const srcRoot = source.find((n) => !source.some((o) => o.childrenIds.includes(n.id)));
    if (!srcRoot) return [];
    const newRoot = uid("n");
    idMap.set(srcRoot.id, newRoot);
    ops.push(
      makeOp<Op & { type: "createNode" }>("createNode", {
        id: newRoot,
        nodeType: rootType,
        parentId,
        index,
        title: srcRoot.title,
        titleRuns: srcRoot.titleRuns,
        style: srcRoot.style,
        task: srcRoot.task,
      })
    );
    const queue = [srcRoot];
    while (queue.length > 0) {
      const src = queue.shift()!;
      for (const cid of src.childrenIds) {
        const c = source.find((n) => n.id === cid);
        if (!c) continue;
        const newId = uid("n");
        idMap.set(cid, newId);
        ops.push(
          makeOp<Op & { type: "createNode" }>("createNode", {
            id: newId,
            nodeType: "subtopic",
            parentId: idMap.get(src.id)!,
            index: src.childrenIds.indexOf(cid),
            title: c.title,
            titleRuns: c.titleRuns,
            style: c.style,
            task: c.task,
          })
        );
        queue.push(c);
      }
    }
    return ops;
  }

  beginRelationship(fromId: string): void {
    this.state.relFrom = fromId;
    this.state.message = "Click another topic to link it — Escape to cancel";
    this.notify();
  }

  clearRelFrom(): void {
    this.state.relFrom = null;
    this.state.message = null;
    this.notify();
  }

  createRelationship(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const exists = this.sheet.relationships.some((r) => (r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId));
    if (exists) {
      this.toast("Relationship already exists");
      return;
    }
    this.execOps([
      makeOp<Op & { type: "createRelationship" }>("createRelationship", {
        relationship: { id: uid("rel"), fromId, toId },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Overlay selection: relationships, groups, summaries
  // -------------------------------------------------------------------------

  selectRelationship(id: string | null): void {
    this.state.selection = [];
    this.state.groupSel = null;
    this.state.summarySel = null;
    this.state.relSel = id;
    this.notify();
  }

  selectGroup(id: string | null): void {
    this.state.selection = [];
    this.state.relSel = null;
    this.state.summarySel = null;
    this.state.groupSel = id;
    this.notify();
  }

  selectSummary(id: string | null): void {
    this.state.selection = [];
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.summarySel = id;
    this.notify();
  }

  setRelationship(id: string, patch: Partial<Relationship>): void {
    const rel = this.sheet.relationships.find((r) => r.id === id);
    if (!rel) return;
    this.execOps([makeOp<Op & { type: "setRelationship" }>("setRelationship", { id, relationship: { ...rel, ...patch }, prev: { ...rel } })]);
  }

  deleteSelectedRelationship(): void {
    const id = this.state.relSel;
    if (!id) return;
    const rel = this.sheet.relationships.find((r) => r.id === id);
    if (!rel) return;
    this.execOps([makeOp<Op & { type: "deleteRelationship" }>("deleteRelationship", { id, relationship: rel })]);
    this.state.relSel = null;
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Groups & summaries
  // -------------------------------------------------------------------------

  /** The selected nodes, iff they are at least two SIBLINGS (what a
   *  group/brace can span). Returns null otherwise. */
  private selectedSiblings(): MindNode[] | null {
    const ids = this.state.selection;
    if (ids.length < 2) return null;
    const nodes = ids.map((id) => this.model.node(id)).filter((n): n is MindNode => !!n);
    if (nodes.length < 2) return null;
    const parent = nodes[0].parentId;
    if (!parent || nodes.some((n) => n.parentId !== parent)) return null;
    return nodes;
  }

  createGroupFromSelection(): void {
    // A group can enclose ANY selected topics — siblings, cousins, nodes from
    // different branches (the box is just the union of their bounds). Only
    // the summary brace needs a sibling column.
    const ids = this.state.selection;
    if (ids.length < 2) {
      this.toast("Select at least two topics to group");
      return;
    }
    const nodes = ids.map((id) => this.model.node(id)).filter((n): n is MindNode => !!n);
    if (nodes.length < 2) {
      this.toast("Select at least two topics to group");
      return;
    }
    this.execOps([makeOp<Op & { type: "createGroup" }>("createGroup", { group: { id: uid("grp"), memberIds: nodes.map((n) => n.id), label: "group" } })]);
    this.toast("Group created");
  }

  createSummaryFromSelection(): void {
    const nodes = this.selectedSiblings();
    if (!nodes) {
      this.toast("Select at least two sibling topics to summarize");
      return;
    }
    this.execOps([makeOp<Op & { type: "createSummary" }>("createSummary", { summary: { id: uid("sum"), memberIds: nodes.map((n) => n.id), label: "Summary" } })]);
    this.toast("Summary created");
  }

  setGroup(id: string, patch: Partial<Group>): void {
    const g = this.sheet.boundaries.find((x) => x.id === id);
    if (!g) return;
    this.execOps([makeOp<Op & { type: "setGroup" }>("setGroup", { id, group: { ...g, ...patch }, prev: { ...g, memberIds: [...g.memberIds] } })]);
  }

  setSummary(id: string, patch: Partial<Summary>): void {
    const s = this.sheet.summaries.find((x) => x.id === id);
    if (!s) return;
    this.execOps([makeOp<Op & { type: "setSummary" }>("setSummary", { id, summary: { ...s, ...patch }, prev: { ...s, memberIds: [...s.memberIds] } })]);
  }

  deleteGroup(id: string): void {
    const g = this.sheet.boundaries.find((x) => x.id === id);
    if (!g) return;
    this.execOps([makeOp<Op & { type: "deleteGroup" }>("deleteGroup", { id, group: g })]);
    this.state.groupSel = null;
    this.notify();
  }

  deleteSummary(id: string): void {
    const s = this.sheet.summaries.find((x) => x.id === id);
    if (!s) return;
    this.execOps([makeOp<Op & { type: "deleteSummary" }>("deleteSummary", { id, summary: s })]);
    this.state.summarySel = null;
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Structure / layout controls
  // -------------------------------------------------------------------------

  setStructure(patch: Partial<Sheet["structure"]>): void {
    const cur = this.sheet.structure;
    this.execOps([makeOp<Op & { type: "setStructure" }>("setStructure", { config: { ...cur, ...patch }, prev: cur })]);
    // Changing the structure is an explicit global reflow. Clear manual
    // overrides so the new structure does not immediately fight old ones.
    this.scheduleLayout(true, true);
  }

  autoLayoutAll(): void {
    // Run immediately and clear manual flags so auto-layout takes over
    applyLayout(this.sheet, true, this.measurer, true);
    this.notify();
    this.toast("Layout recalculated");
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  zoomAt(sx: number, sy: number, factor: number, vw: number, vh: number): void {
    this.state.camera = zoomAt(this.state.camera, vw, vh, sx, sy, factor);
    this.notify();
  }

  panBy(dx: number, dy: number): void {
    this.state.camera = panBy(this.state.camera, dx, dy);
    this.notify();
  }

  fitView(vw: number, vh: number): void {
    this.state.camera = fitBounds(this.state.camera, vw, vh, this.mapBounds());
    this.state.camera = { ...this.state.camera, scale: Math.max(this.state.camera.scale, 0.4) };
    this.notify();
  }

  centerOnNode(id: string): void {
    const node = this.model.node(id);
    if (!node) return;
    const m = measureNode(node, this.measurer);
    this.state.camera = centerOn(this.state.camera, node.position.x + m.w / 2, node.position.y + m.h / 2);
    this.notify();
  }

  zoomStep(factor: number, vw: number, vh: number): void {
    this.zoomAt(vw / 2, vh / 2, factor, vw, vh);
  }

  private mapBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const res = layoutSheet(this.sheet, false, this.measurer);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, p] of res.positions) {
      const n = this.model.node(id);
      if (!n) continue;
       const m = measureNode(n, this.measurer);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + m.w > maxX) maxX = p.x + m.w;
      if (p.y + m.h > maxY) maxY = p.y + m.h;
    }
    if (!isFinite(minX)) return { minX: -200, minY: -200, maxX: 200, maxY: 200 };
    return { minX, minY, maxX, maxY };
  }

  // -------------------------------------------------------------------------
  // Keyboard navigation
  // -------------------------------------------------------------------------

  navigate(dir: NavDir): void {
    const node = this.selectionNode ?? this.model.rootNode;
    const sheet = this.sheet;
    const rootId = sheet.rootNodeId;

    // build a center X map from layout positions + manual positions
    const layout = layoutSheet(this.sheet, false, this.measurer);
    const centerX = (id: string): number => {
      const n = this.model.node(id);
      if (!n) return 0;
      const measured = measureNode(n, this.measurer);
      const p = layout.positions.get(id);
      if (p) return p.x + measured.w / 2;
      return n.position.x + measured.w / 2;
    };

    if (dir === "left" || dir === "right") {
      if (node.type === "central") {
        const kids = node.childrenIds.map((id) => this.model.node(id)).filter((k): k is any => !!k);
        const rootCx = centerX(rootId);
        const rightKids = kids.filter((k) => centerX(k.id) >= rootCx);
        const leftKids = kids.filter((k) => centerX(k.id) < rootCx);
        if (dir === "right" && rightKids.length) this.select(rightKids[0].id, { center: true });
        if (dir === "left" && leftKids.length) this.select(leftKids[0].id, { center: true });
        return;
      }

      const branchRootId = this.model.branchRootId(node.id);
      const rootCx = centerX(rootId);
      const branchCx = centerX(branchRootId);
      const isLeftWing = branchCx < rootCx;

      if (dir === "right") {
        if (isLeftWing) {
          if (node.parentId) this.select(node.parentId, { center: true });
        } else {
          if (node.childrenIds.length && !node.collapsed) this.select(node.childrenIds[0], { center: true });
        }
        return;
      }

      if (dir === "left") {
        if (isLeftWing) {
          if (node.childrenIds.length && !node.collapsed) this.select(node.childrenIds[0], { center: true });
        } else {
          if (node.parentId) this.select(node.parentId, { center: true });
        }
        return;
      }
    }

    if (dir === "up") {
      if (!node.parentId) return;
      const parent = this.model.requireNode(node.parentId);
      const idx = parent.childrenIds.indexOf(node.id);
      if (idx > 0) this.select(parent.childrenIds[idx - 1], { center: true });
      else this.select(parent.id, { center: true });
      return;
    }

    // down
    if (!node.parentId) return;
    const parent = this.model.requireNode(node.parentId);
    const idx = parent.childrenIds.indexOf(node.id);
    if (idx >= 0 && idx < parent.childrenIds.length - 1) this.select(parent.childrenIds[idx + 1], { center: true });
    else if (node.parentId !== rootId) this.select(parent.id, { center: true });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  setSearch(q: string): void {
    this.state.search = q;
    const query = q.trim().toLowerCase();
    let results: string[] = [];
    if (query) {
      results = this.model
        .visibleIds(this.sheet.rootNodeId)
        .filter((id) => {
          const n = this.model.node(id);
          return !!n && (n.title.toLowerCase().includes(query) || n.notes.toLowerCase().includes(query));
        });
    }
    this.state.searchResults = results;
    this.state.searchIndex = results.length > 0 ? 0 : 0;
    this.notify();
    if (results.length > 0) this.jumpToSearch(0);
  }

  jumpToSearch(offset: number): void {
    const results = this.state.searchResults;
    if (results.length === 0) return;
    const next = (this.state.searchIndex + offset + results.length) % results.length;
    this.state.searchIndex = next;
    this.select(results[next], { center: true });
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Theme & UI toggles
  // -------------------------------------------------------------------------

  togglePalette(): void {
    this.state.showPalette = !this.state.showPalette;
    this.notify();
  }

  toggleOutliner(): void {
    this.state.showOutliner = !this.state.showOutliner;
    this.notify();
  }

  toggleInspector(): void {
    this.state.showInspector = !this.state.showInspector;
    this.notify();
  }

  toggleZen(): void {
    this.state.zen = !this.state.zen;
    this.notify();
  }

  setMode(mode: "select" | "pan"): void {
    this.state.mode = mode;
    this.notify();
  }

  /**
   * Dev-only (perf spike): bulk-generate a balanced tree of `count` topics
   * under the root as a single op batch. Exposed via window.__rnode.
   */
  debugGenerateBalancedTree(count: number): { opsMs: number; totalNodes: number } {
    const sheet = this.sheet;
    const ops: Op[] = [];
    const queue: string[] = [sheet.rootNodeId];
    const BRANCH = 8;
    let created = 0;
    const t0 = performance.now();
    while (created < count && queue.length > 0) {
      const parentId = queue.shift()!;
      const isRoot = parentId === sheet.rootNodeId;
      for (let i = 0; i < BRANCH && created < count; i++) {
        const id = uid("n");
        ops.push(
          makeOp<Op & { type: "createNode" }>("createNode", {
            id,
            nodeType: isRoot ? "main" : "subtopic",
            parentId,
            index: 0,
            title: `Topic ${created}`,
          })
        );
        queue.push(id);
        created++;
      }
    }
    const opsMs = performance.now() - t0;
    this.execOps(ops);
    return { opsMs, totalNodes: Object.keys(sheet.nodes).length };
  }

  // -------------------------------------------------------------------------
  // Document management
  // -------------------------------------------------------------------------

  newDocument(): void {
    const doc = DocumentModel.blank("Untitled map");
    doc.settings.theme = "light";
    this.state.docs = [...this.state.docs, doc];
    this.state.activeDocId = doc.documentId;
    this.switchToDoc(doc.documentId);
    this.state.sync = "dirty"; // new doc not persisted until the user saves
    this.notify();
    this.toast("New document created");
  }

  /** Create a doc from the roadmap template; returns its id. */
  duplicateSample(): string {
    const doc = DocumentModel.sample();
    doc.settings.theme = "light";
    this.state.docs = [...this.state.docs, doc];
    this.state.sync = "dirty";
    this.notify();
    return doc.documentId;
  }

  duplicateDocument(id: string): void {
    const src = this.state.docs.find((d) => d.documentId === id);
    if (!src) return;
    const copy: RnodeDocument = structuredClone(src);
    copy.documentId = uid("d");
    copy.title = src.title + " (copy)";
    copy.createdAt = nowIso();
    copy.updatedAt = nowIso();
    this.state.docs = [...this.state.docs, copy];
    this.state.sync = "dirty";
    this.notify();
    this.toast("Document duplicated");
  }

  renameDocument(id: string, title: string): void {
    const doc = this.state.docs.find((d) => d.documentId === id);
    if (!doc) return;
    doc.title = title;
    doc.updatedAt = nowIso();
    this.state.sync = "dirty";
    this.notify();
  }

  toggleArchive(id: string): void {
    const doc = this.state.docs.find((d) => d.documentId === id);
    if (!doc) return;
    doc.archived = !doc.archived;
    this.state.sync = "dirty";
    this.notify();
  }

  deleteDocument(id: string): void {
    this.state.docs = this.state.docs.filter((d) => d.documentId !== id);
    if (this.state.activeDocId === id) {
      const next = this.state.docs[0];
      if (next) this.switchToDoc(next.documentId);
      else {
        this.model = new DocumentModel(DocumentModel.blank());
        this.state = this.makeState();
      }
    }
    this.state.sync = "dirty";
    this.notify();
  }

  switchToDoc(id: string): void {
    this.commitDraftOnLeave();
    const doc = this.state.docs.find((d) => d.documentId === id);
    if (!doc) return;
    this.model = new DocumentModel(doc);
    this.history.clear();
    this.state.activeDocId = id;
    this.state.selection = [];
    this.state.editingId = null;
    this.state.search = "";
    this.state.searchResults = [];
    this.state.sync = "saved"; // the loaded doc is its persisted version
    this.notify();
    this.scheduleLayout(false);
  }

  setSheetTitle(title: string): void {
    const sheet = this.sheet;
    this.execOps([makeOp<Op & { type: "setSheetTitle" }>("setSheetTitle", { title, prev: sheet.title })]);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  exportJson(): void {
    const json = JSON.stringify(this.model.doc, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    this.download(blob, this.docFileName());
    this.toast("Document exported as JSON");
  }

  exportMarkdown(): void {
    const md = this.toMarkdown(this.sheet, this.sheet.rootNodeId, 0);
    const blob = new Blob([md], { type: "text/markdown" });
    this.download(blob, `${this.model.doc.title.replace(/[^\w-]+/g, "_")}.md`);
    this.toast("Document exported as Markdown");
  }

  private toMarkdown(sheet: Sheet, id: string, depth: number): string {
    const node = sheet.nodes[id];
    if (!node) return "";
    const bullet = depth === 0 ? `# ${node.title}` : `${"-".repeat(1)} ${node.title}`;
    const prefix = depth === 0 ? "" : "  ".repeat(depth - 1);
    let out = depth === 0 ? `${bullet}\n` : `${prefix}- ${node.title}\n`;
    for (const c of node.childrenIds) out += this.toMarkdown(sheet, c, depth + 1);
    return out;
  }

  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
