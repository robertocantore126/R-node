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
import { SCHEMA_VERSION, type AttachmentInfo, type Group, type MindNode, type NodeType, type Position, type Relationship, type RnodeDocument, type Sheet, type Style, type Summary, type TaskInfo, type TextRun } from "../core/types";
import { isEmptyRuns, nodeRuns, normalizeRuns, plainToRuns, runsEqual, runsToPlain, trimRuns } from "../core/text";
import { applyLayout, layoutSheet } from "../layout/mindmap";
import { createCanvasTextMeasurer, measureNode, MIN_TOPIC_W, type TextMeasurer } from "../layout/measure";
import { centerOn, fitBounds, panBy, zoomAt, type Camera } from "../render/viewport";
import { THEMES } from "../render/theme";
import type { DropIndicator } from "../render/renderer";
import { DocumentLoadError, documentLoadErrorLabel, LocalStorageAdapter, TauriStorageAdapter, type StorageAdapter } from "../persist/storage";
import { collectOrphans, getAssetStore, referencedAssetIds, TauriAssetStore, type AssetStore } from "../persist/assets";
import { buildRnodeZip, estimateRnodeZip, importRnodeZip, type RnodeZipMode, type ZipPhase } from "./exportBridge";
import { importImageFile, validateImageSource, type ImportedImage } from "./imageImport";

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: { description?: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle>;
  }
}

/** Human-readable size for the pre-export estimate toast. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type PortableFormat = "json" | "zip";

/**
 * Storage key of the picked file handle for a document+format pair. The
 * portable format of a document CHANGES when images appear or disappear
 * (save switches between .rnode.json and .rnode.zip): a key on the docId
 * alone would silently write zip bytes into the user's .json file. One
 * handle per format means removing the images later goes back to the
 * original file, and the format switch merely re-asks where to save.
 */
export function portableFileKey(docId: string, format: PortableFormat): string {
  return `r-node.file-handle.${docId}:${format}`;
}

/**
 * Filesystem-safe base name for a document title. The name typed in the GUI
 * is the name of the real file (desktop .rnode and the portable saves): the
 * save dialog is pre-filled with it and a later rename renames the file.
 */
export function docFileBaseName(title: string): string {
  // Only the characters the filesystem actually refuses are removed. The rule
  // used to replace everything outside [\w-], which turned "Mappa tesi" into
  // "Mappa_tesi" — harmless while the file name was write-only, corrosive now
  // that the GUI title and the file name are bound: the mangled form came back
  // as the title on the next open, and every cycle degraded it further.
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, ""); // Windows silently drops trailing dots and spaces
  // CON, PRN, AUX… are device names on Windows: a file cannot be called that.
  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return "Untitled map";
  return base.slice(0, 120); // leave room for the directory and ".rnode"
}

/** The title a `.rnode` path carries: "C:\maps\Mappa tesi.rnode" → "Mappa tesi". */
export function titleFromDocPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.rnode$/i, "").trim() || "Untitled map";
}

/** Directory of a file path (with trailing separator), or "" when none. */
function pathDirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i < 0 ? "" : p.slice(0, i + 1);
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
  /** The node whose IMAGE is selected (image selection is exclusive: the
   *  node itself is not in `selection` then). Null = no image selected. */
  imageSel: string | null;
  /** Heavy operation in flight (a save with images, which builds the
   *  .rnode.zip). The status bar shows a progress bar with a cancel button;
   *  null = nothing heavy running. progress is 0..1, null = indeterminate. */
  op: {
    kind: "save";
    label: string;
    progress: number | null;
    cancellable: boolean;
  } | null;
}

export class EditorStore {
  private state: EditorState;
  private snap: EditorState;
  private listeners = new Set<() => void>();
  private model: DocumentModel;
  private history = new History();
  private adapter: StorageAdapter;
  /** Abort controller of the running heavy operation (state.op); null when
   *  nothing is running. Cancel aborts it; the operation rejects with an
   *  AbortError and reports "Save cancelled". */
  private opAbort: AbortController | null = null;
  /**
   * File System Access handles (per document) so later saves silently
   * OVERWRITE the .rnode.json the user picked instead of re-downloading.
   * Handles are persisted in IndexedDB to survive reloads.
   */
  /**
   * Sanitized document title when the current desktop root was established
   * (open or save-as). A rename in the GUI changes the title; on save the
   * REAL file is renamed to match ONLY when the title moved away from this
   * baseline — a file opened with a different internal title is never
   * silently renamed on the first save. Null = no desktop root yet.
   */
  private fileHandles = new Map<string, FileSystemFileHandle>();
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * One-position save queue (T21-B): a save is in flight, and a request
   * arrived while it was running. The request is NEVER dropped — dropping it
   * would report "Saved" while the disk holds a stale version — instead the
   * save is re-run once when the current one finishes, with the content that
   * exists at that moment.
   */
  private saveInFlight = false;
  private saveQueued = false;
  /** Assets that could not be copied into the current file by the last save
   *  (adoptFile skips referenced-but-absent assets); the final toast reports
   *  the number instead of staying silent (T21-C). */
  private lastSaveSkipped = 0;
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
  private imageResizeState: { nodeId: string; original: Style } | null = null;
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
      imageSel: null,
      op: null,
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
  // Heavy-operation feedback (progress bar + cancel in the status bar)
  // -------------------------------------------------------------------------

  /** Start a heavy operation: creates a fresh AbortController and shows the
   *  progress bar. A new op supersedes a stuck previous one. */
  private beginLongOp(label: string, cancellable: boolean): AbortSignal {
    this.opAbort?.abort();
    this.opAbort = new AbortController();
    this.state.op = { kind: "save", label, progress: 0, cancellable };
    this.notify();
    return this.opAbort.signal;
  }

  private setOpProgress(label: string, progress: number | null): void {
    if (!this.state.op) return;
    this.state.op = { ...this.state.op, label, progress };
    this.notify();
  }

  /** Map a zip-phase fraction onto the overall bar scale: the estimate
   *  (prepare) is quick, reading assets is fast IndexedDB work, compression
   *  dominates for hundreds of MB. */
  private opProgress(phase: ZipPhase, fraction: number): void {
    const map: Record<ZipPhase, { label: string; base: number; span: number }> = {
      prepare: { label: "Saving document…", base: 0, span: 0.05 },
      read: { label: "Reading images…", base: 0.05, span: 0.1 },
      compress: { label: "Compressing…", base: 0.15, span: 0.85 },
    };
    const m = map[phase];
    this.setOpProgress(m.label, Math.min(1, m.base + fraction * m.span));
  }

  private endLongOp(): void {
    this.opAbort = null;
    this.state.op = null;
    this.notify();
  }

  /** Cancel the running heavy operation (the abort controller). The operation
   *  rejects with an AbortError and reports "Save cancelled". */
  cancelLongOp(): void {
    this.opAbort?.abort();
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    // A corrupt/unreadable stored document must never blank the app: load the
    // reason, fall back to the sample map, and tell the user WHY instead of a
    // bare "cannot open the document".
    let docs: RnodeDocument[] = [];
    let initError: string | null = null;
    // Desktop: the adapter restored the path of the file open last session, so
    // the asset store must be pointed at it BEFORE anything reads an image.
    // Both roots always move together — that pairing is the T19 trap.
    if (this.adapter instanceof TauriStorageAdapter && this.adapter.currentPath) {
      const assetStore = getAssetStore();
      if (assetStore instanceof TauriAssetStore) assetStore.setRoot(this.adapter.currentPath);
    }
    try {
      docs = await this.adapter.load();
    } catch (e) {
      const err = e instanceof DocumentLoadError ? e : new DocumentLoadError("sqlite", e instanceof Error ? e.message : String(e));
      trace.error(`init:${err.kind}`, err.message);
      initError = documentLoadErrorLabel(err.kind);
      // The remembered file is gone or unreadable (moved, deleted, on an
      // unplugged drive). Forget it: leaving the pointer would make the next
      // save recreate an empty document at a path the user no longer has.
      if (this.adapter instanceof TauriStorageAdapter) this.adapter.setRoot(null);
    }
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
    // The file name is the document's name (the user's choice). Adopting it
    // here is what makes the title in the GUI and the name on disk the same
    // thing across a restart, instead of two values that drift apart.
    if (docs.length > 0 && this.adapter instanceof TauriStorageAdapter && this.adapter.currentPath) {
      this.adoptFileTitle(this.adapter.currentPath);
    }
    if (initError) this.toast(`Could not open the saved document — ${initError}`);
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

  /**
   * Apply the pending layout IMMEDIATELY (no 30ms debounce). Used after
   * structural ops (node creation) so the result appears in its FINAL
   * position on the very first paint — a new topic must not flash at the
   * provisional estimated spot and then jump to its layout slot 30ms later.
   */
  private settleLayoutNow(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
    applyLayout(this.sheet, false, this.measurer);
    this.notify();
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
    if (this.saveInFlight) {
      // One-position queue, deliberately NOT an early return: the second
      // Ctrl+S arrived after the running save started reading, so the content
      // changed under it. Dropping the request would show "Saved" while the
      // file on disk holds a stale version. Mark the re-run; the running
      // save re-executes exactly once when it finishes.
      this.saveQueued = true;
      this.toast("Save queued — will run when the current save finishes");
      return;
    }
    this.saveInFlight = true;
    try {
      await this.performSave();
    } finally {
      this.saveInFlight = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.saveNow(); // exactly one re-run, with the content of THAT moment
      }
    }
  }

  private async performSave(): Promise<void> {
    try {
      if (this.adapter instanceof TauriStorageAdapter) {
        // Desktop: the document IS a single .rnode file — save writes the
        // document row only. The first save has no file yet: it becomes a
        // "Save as…" that picks one, copies the referenced assets into it
        // and switches both the adapter and the asset store to it. Every
        // later save just rewrites the document row (T20).
        //
        // The progress bar exists for BOTH platforms. It used to be raised
        // only around the web zip, so on the desktop — the only place the app
        // is really used — Ctrl+S showed nothing at all until the final toast,
        // and a first save copying hundreds of images looked like a freeze.
        this.beginLongOp("Saving document…", false);
        try {
          if (!this.adapter.hasRoot) {
            const ok = await this.saveAsDesktop();
            if (!ok) {
              this.state.sync = "dirty";
              this.toast("Save cancelled — no file chosen");
              return;
            }
          } else {
            // The GUI rename already renamed the file. This second call is the
            // net under it: if that rename failed (collision, locked file), the
            // save is the next chance to bring the two names back together.
            await this.syncFileNameToTitle();
            this.setOpProgress("Writing document…", 0.9);
            await this.adapter.save([this.model.doc]);
          }
        } finally {
          this.endLongOp();
        }
        this.state.sync = "saved";
        this.toast(
          this.lastSaveSkipped > 0
            ? `Saved — ${this.lastSaveSkipped} image${this.lastSaveSkipped === 1 ? "" : "s"} could not be copied (missing from the source file)`
            : "Saved"
        );
        return;
      }
      await this.adapter.save(this.state.docs);
      // Images live outside the document (T12a): a plain .rnode.json would
      // arrive without them. With images the portable save is a .rnode.zip.
      const hasImages = referencedAssetIds(this.sheet).size > 0;
      const fileWritten = hasImages
        ? await this.writePortableZip()
        : await this.writePortableFile(JSON.stringify(this.model.doc, null, 2));
      this.state.sync = "saved";
      this.toast(fileWritten ? "Saved" : "Saved locally (no file chosen)");
    } catch (e) {
      this.state.sync = "dirty";
      if (e instanceof Error && e.name === "AbortError") {
        // The user cancelled the running heavy save: a queued re-run would
        // redo exactly the work they stopped, so the queue is dropped too.
        this.saveQueued = false;
        this.toast("Save cancelled");
      } else {
        this.toast("Save failed — check storage");
      }
    }
  }

  /**
   * Desktop "Save as…": native file picker → copy every referenced asset
   * into the chosen `.rnode` file (all three levels + meta — the same
   * per-asset data the zip exporter iterates, inside SQLite instead of an
   * archive), then write the document and switch the storage adapter AND the
   * asset store to the file. The Renderer holds the same asset store
   * instance, so it starts reading the new file without any re-instantiation
   * (the T19 trap, unchanged).
   */
  async saveAsDesktop(): Promise<boolean> {
    // The save dialog already knows the name: pre-fill it with the document
    // title typed in the GUI, so the real file takes that name.
    const file = await this.pickDesktopFile("save", docFileBaseName(this.model.doc.title));
    if (!file) return false;
    const assetStore = getAssetStore();
    if (!(assetStore instanceof TauriAssetStore) || !(this.adapter instanceof TauriStorageAdapter)) {
      return false;
    }
    // adoptFile reads from the current path FIRST, then switches: the assets
    // are never re-written into the same store before the file exists. Its
    // return value counts the referenced assets that could not be copied
    // (missing from the source) — the final "Saved" toast reports them.
    this.lastSaveSkipped = await assetStore.adoptFile(
      file,
      [...referencedAssetIds(this.sheet)],
      // Copying the images IS the first save on a picture-heavy map: without
      // this the bar would sit at zero for the whole of it.
      (phase, done, total) => {
        const base = phase === "read" ? 0.05 : 0.35;
        const span = phase === "read" ? 0.3 : 0.55;
        this.setOpProgress(
          phase === "read" ? `Reading images… ${done}/${total}` : `Copying images… ${done}/${total}`,
          base + (total > 0 ? (done / total) * span : span)
        );
      }
    );
    this.adapter.setRoot(file);
    // The chosen file's name becomes the document's name, so the title in the
    // GUI matches what the user just typed into the save dialog.
    this.adoptFileTitle(file);
    // The ACTIVE document is saved, not docs[0]: on desktop the sidebar may
    // still carry the never-saved sample, and saving it over the chosen file
    // would corrupt the document on disk.
    await this.adapter.save([this.model.doc]);
    return true;
  }

  /**
   * Make the document wear its file's name.
   *
   * The title in the GUI and the name on disk are one value seen from two
   * places, and the file is the side the user can see in Explorer — so on open
   * the file wins. Nothing is written: this removes the case that started all
   * of it, opening `progetto.rnode` and being shown "Untitled map".
   */
  private adoptFileTitle(path: string): void {
    const title = titleFromDocPath(path);
    this.model.doc.title = title;
    const entry = this.state.docs.find((d) => d.documentId === this.model.doc.documentId);
    if (entry) entry.title = title;
  }

  /**
   * Rename the real file to match the title the user just confirmed.
   *
   * It runs on the rename itself, not at the next save: two names are not
   * "linked" if they agree only after a Ctrl+S the user might never press.
   *
   * This replaces a rename that copied every asset into a fresh file through
   * the IPC and then deleted the old one — work proportional to the images, so
   * renaming a map full of pictures cost as much as saving it from scratch.
   * `rename_document` moves a directory entry instead: same cost at 1MB and at
   * 1GB. The asset store is switched with the adapter, never after: they read
   * the same file and a gap between them is the T19 trap.
   *
   * On a name collision the file keeps its name and the toast says so. The
   * typed title is deliberately left alone — silently reverting what someone
   * just wrote is worse than a mismatch they have been told about.
   */
  private renameChain: Promise<void> = Promise.resolve();

  /**
   * Renames run one at a time, in order.
   *
   * Rename in the GUI and press Ctrl+S straight away and two renames overlap:
   * the second still reads the OLD path, tries a move whose source has already
   * gone, and reports failure for an operation that in fact succeeded. Queueing
   * makes the save observe the path the rename just installed.
   */
  private syncFileNameToTitle(): Promise<void> {
    this.renameChain = this.renameChain.then(() => this.renameFileToTitleOnce());
    return this.renameChain;
  }

  private async renameFileToTitleOnce(): Promise<void> {
    if (!(this.adapter instanceof TauriStorageAdapter)) return;
    const current = this.adapter.currentPath;
    if (!current) return; // never saved: the first "Save as…" chooses the name
    if (typeof window === "undefined" || !window.__TAURI__) return;
    const base = docFileBaseName(this.model.doc.title);
    const target = pathDirname(current) + base + ".rnode";
    if (target.toLowerCase() === current.toLowerCase()) return;
    try {
      await window.__TAURI__.core.invoke("rename_document", { from: current, to: target });
    } catch (e) {
      trace.error("rename", String(e));
      this.toast(`Could not rename the file to "${base}.rnode" — it is still "${titleFromDocPath(current)}.rnode"`);
      return;
    }
    this.adapter.setRoot(target);
    const assetStore = getAssetStore();
    if (assetStore instanceof TauriAssetStore) assetStore.setRoot(target);
    this.toast(`Renamed to "${base}.rnode"`);
    this.notify();
  }

  /**
   * Desktop "Open…": native file picker → read the document from the file →
   * switch both the adapter and the asset store to it. The path is switched
   * only after the document is known to be valid, so a wrong file never moves
   * the app away from the current document.
   */
  async openDesktop(): Promise<boolean> {
    const file = await this.pickDesktopFile("open");
    if (!file) return false;
    const assetStore = getAssetStore();
    if (!(assetStore instanceof TauriAssetStore) || !(this.adapter instanceof TauriStorageAdapter)) {
      return false;
    }
    let doc: RnodeDocument | null;
    try {
      doc = await this.adapter.readDocumentAt(file);
    } catch (e) {
      const err = e instanceof DocumentLoadError ? e : new DocumentLoadError("sqlite", e instanceof Error ? e.message : String(e));
      trace.error(`open:${err.kind}`, err.message);
      this.toast(`Cannot open "${file.split(/[\\/]/).pop() ?? file}" — ${documentLoadErrorLabel(err.kind)}`);
      return false;
    }
    if (!doc) {
      this.toast("Not a valid R-node document in that file");
      return false;
    }
    assetStore.setRoot(file);
    this.adapter.setRoot(file);
    this.importDocumentFromJson(JSON.stringify(doc));
    // The file's name IS the document's name from here on. Nothing is renamed
    // on disk — the title simply stops disagreeing with the file it came from.
    this.adoptFileTitle(file);
    this.toast(`Opened "${titleFromDocPath(file)}"`);
    return true;
  }

  /**
   * Re-entrancy guard: the native dialog is modal, so a second click while
   * one is open must not queue another dialog — stacked pickers were part of
   * the "Open keeps reopening" report. The flag is reset when the dialog
   * closes (picked or cancelled), never by a timeout.
   */
  private pickBusy = false;

  private async pickDesktopFile(mode: "open" | "save", suggestedName?: string): Promise<string | null> {
    if (typeof window === "undefined" || !window.__TAURI__) return null;
    if (this.pickBusy) return null;
    this.pickBusy = true;
    try {
      return (
        ((await window.__TAURI__.core.invoke("pick_document_file", {
          mode,
          suggestedName: mode === "save" ? suggestedName : undefined,
        })) as string | null) ?? null
      );
    } catch {
      return null;
    } finally {
      this.pickBusy = false;
    }
  }

  /**
   * Write a portable file (`.rnode.json` or `.rnode.zip`): stored file handle
   * → silent overwrite; File System Access picker → user chooses once, then
   * every later save overwrites the same file; download as fallback. Returns
   * true when a file was written or downloaded, false when the user cancelled
   * the picker (the document is still persisted to app storage).
   */
  private async writePortableBytes(
    blob: Blob,
    fileName: string,
    pickerType: { description: string; accept: Record<string, string[]> },
    format: PortableFormat
  ): Promise<boolean> {
    const docId = this.model.doc.documentId;
    const key = portableFileKey(docId, format);
    const otherKey = portableFileKey(docId, format === "zip" ? "json" : "zip");

    // 1) Reuse the stored handle for THIS format → silent overwrite, no
    //    dialog, no download. The other format's handle is left alone: if the
    //    document loses its images later, the save goes back to that file.
    let handle = this.fileHandles.get(key) ?? null;
    if (!handle) {
      handle = await this.loadFileHandle(key);
      if (handle) this.fileHandles.set(key, handle);
    }
    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch {
        // Handle stale (file moved/deleted) → drop it and ask again.
        this.fileHandles.delete(key);
        await this.clearFileHandle(key);
      }
    }

    // 2) No handle but the API exists → let the user pick where to save.
    if (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function") {
      // Reaching the picker with a handle for the OTHER format means the
      // portable format of this document just changed: say why, instead of
      // silently asking for a new location.
      const otherHandle = this.fileHandles.get(otherKey) ?? (await this.loadFileHandle(otherKey));
      if (otherHandle) {
        this.toast(
          format === "zip"
            ? "The document now contains images — choose where to save the .rnode.zip"
            : "The images were removed — choose where to save the .rnode.json"
        );
      }
      try {
        const picked = await window.showSaveFilePicker({ suggestedName: fileName, types: [pickerType] });
        const writable = await picked.createWritable();
        await writable.write(blob);
        await writable.close();
        this.fileHandles.set(key, picked);
        await this.storeFileHandle(key, picked);
        return true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return false;
        // picker failed (permission/unsupported) → fall back to download
      }
    }

    // 3) Fallback: download the file with the CURRENT content.
    this.download(blob, fileName);
    return true;
  }

  /**
   * Referenced assets whose original bytes are gone (a compact .rnode.zip
   * import). A complete export of them would silently ship the resized
   * level, so the count is shown before generating (T18-B).
   */
  private degradedAssetCount(): number {
    const referenced = referencedAssetIds(this.sheet);
    return this.sheet.attachments.filter((a) => a.originalLost && referenced.has(a.id)).length;
  }

  private async writePortableFile(json: string): Promise<boolean> {
    return this.writePortableBytes(
      new Blob([json], { type: "application/json" }),
      this.docFileName(),
      { description: "R-node document", accept: { "application/json": [".rnode.json", ".json"] } },
      "json"
    );
  }

  /**
   * Portable save with images. The size is estimated and shown BEFORE the
   * zip is built — generating first and telling the user after would be the
   * wrong order for a file that can weigh hundreds of MB.
   */
  private async writePortableZip(): Promise<boolean> {
    const store = getAssetStore();
    // The estimate is computed BEFORE generating — the size tells the user
    // WHY this save is heavy — and both phases report into the progress bar
    // with an abort controller, so a hundreds-of-MB save can be cancelled
    // instead of leaving the UI blocked with no idea how long it will take.
    const signal = this.beginLongOp("Saving document…", true);
    try {
      const hooks = { signal, onProgress: (p: ZipPhase, f: number) => this.opProgress(p, f) };
      const estimate = await estimateRnodeZip(this.model.doc, this.sheet, store, "complete", hooks);
      const degraded = this.degradedAssetCount();
      const est = formatBytes(estimate);
      this.toast(
        degraded > 0
          ? `${degraded} asset${degraded === 1 ? "" : "s"} lost their original in a compact import — saving display levels (~${est})`
          : `Saving .rnode.zip (~${est})…`
      );
      const bytes = await buildRnodeZip(this.model.doc, this.sheet, store, "complete", hooks);
      return this.writePortableBytes(
        new Blob([bytes.slice().buffer], { type: "application/zip" }),
        this.docZipName(),
        { description: "R-node document with images", accept: { "application/zip": [".rnode.zip"] } },
        "zip"
      );
    } finally {
      this.endLongOp();
    }
  }

  /**
   * Manual export in either mode (complete = originals, compact = display
   * levels only). Downloads the file directly: the save flow owns the file
   * handle, an explicit export asks the OS for a location every time.
   */
  async exportRnodeZip(mode: RnodeZipMode): Promise<void> {
    const store = getAssetStore();
    const estimate = await estimateRnodeZip(this.model.doc, this.sheet, store, mode);
    const est = formatBytes(estimate);
    // Compact is explicitly lossy, so only complete mode must warn about
    // assets whose originals are gone (T18-B).
    const degraded = mode === "complete" ? this.degradedAssetCount() : 0;
    this.toast(
      degraded > 0
        ? `${degraded} asset${degraded === 1 ? "" : "s"} lost their original in a compact import — exporting display levels (~${est})`
        : `Exporting .rnode.zip (~${est})…`
    );
    const bytes = await buildRnodeZip(this.model.doc, this.sheet, store, mode);
    this.download(new Blob([bytes.slice().buffer], { type: "application/zip" }), this.docZipName());
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

  /**
   * Open a portable file (file picker): .rnode.zip (map + images), .rnode.json
   * and legacy .rmind.json (plain documents). The container is sniffed by its
   * PK\x03\x04 magic bytes, never by extension alone.
   */
  async loadFile(): Promise<void> {
    // Desktop: "Open" picks the .rnode file itself. The web file-input flow
    // below stays for the browser.
    if (this.adapter instanceof TauriStorageAdapter) {
      await this.openDesktop();
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rnode.json,.rmind.json,.rnode.zip,application/json,application/zip";
    const file: File | null = await new Promise((resolve) => {
      input.onchange = (): void => resolve(input.files?.[0] ?? null);
      input.click();
    });
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, 4);
      const isZip = head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
      if (isZip) {
        const doc = await importRnodeZip(new Uint8Array(buf), getAssetStore());
        if (!doc) {
          this.toast("Not a valid R-node file");
          return;
        }
        const id = this.importDocumentFromJson(JSON.stringify(doc));
        this.toast(id ? `Opened ${file.name}` : "Not a valid R-node file");
        return;
      }
      const text = new TextDecoder().decode(buf);
      const id = this.importDocumentFromJson(text);
      if (id) this.toast(`Opened ${file.name}`);
      else this.toast("Not a valid R-node file");
    } catch (e) {
      trace.error("loadFile", e instanceof Error ? e.message : String(e));
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
    return `${docFileBaseName(this.model.doc.title)}.rnode.json`;
  }

  private docZipName(): string {
    return `${docFileBaseName(this.model.doc.title)}.rnode.zip`;
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
    this.state.imageSel = null;
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
    this.state.imageSel = null;
    this.notify();
  }

  clearSelection(): void {
    this.commitDraftOnLeave();
    if (
      this.state.selection.length === 0 &&
      !this.state.relSel &&
      !this.state.groupSel &&
      !this.state.summarySel &&
      !this.state.imageSel
    )
      return;
    this.state.selection = [];
    this.state.editingId = null;
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.summarySel = null;
    this.state.imageSel = null;
    this.notify();
  }

  /** Select the IMAGE of a node (exclusive: clears every other selection). */
  selectImage(nodeId: string): void {
    this.commitDraftOnLeave();
    this.state.selection = [];
    this.state.editingId = null;
    this.state.pendingInsert = null;
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.summarySel = null;
    this.state.imageSel = nodeId;
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
    this.state.imageSel = null;
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
    // The layout must settle BEFORE the editor opens, or the overlay would
    // mount on the provisional position and the topic would appear to jump.
    this.settleLayoutNow();
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
    this.settleLayoutNow();
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
    this.settleLayoutNow();
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
    this.settleLayoutNow();
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
      this.state.imageSel = null;
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

  /**
   * Main-topic drag (live repositioning): a movable node (root child or
   * floating topic) FOLLOWS the cursor during the drag — ephemeral manual
   * position, no op, no history — and its subtree re-flows around it on
   * every move, so the whole branch slides with the pointer. commitNodeDrag
   * emits ONE setPosition op whose `prev` is the PRE-drag position, so a
   * single undo restores the exact pre-drag state.
   */
  private nodeDragState: { nodeId: string; origPos: Position } | null = null;

  /** A node drag started: capture the pre-drag position for the final op. */
  beginNodeDrag(nodeId: string): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    this.nodeDragState = { nodeId, origPos: { ...node.position } };
  }

  /**
   * Live position during the drag. The layout runs SYNCHRONOUSLY (the 30ms
   * debounce of scheduleLayout would starve during a continuous drag — the
   * subtree would never follow until the pointer stops); manual is set
   * transiently so applyLayout does not snap the node back to its slot.
   */
  setNodeDragDraft(nodeId: string, worldX: number, worldY: number): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    node.position = { ...node.position, x: worldX, y: worldY, manual: true };
    applyLayout(this.sheet, false, this.measurer);
    this.notify();
  }

  /** Restore the pre-drag position (the drag left the free-position zone). */
  resetNodeDragDraft(nodeId: string): void {
    const d = this.nodeDragState;
    if (!d || d.nodeId !== nodeId) return;
    const node = this.model.node(nodeId);
    if (!node) return;
    node.position = { ...d.origPos };
    applyLayout(this.sheet, false, this.measurer);
    this.notify();
  }

  /**
   * End of the drag: restore the model to the pre-drag state, then commit
   * through dropAt — its ops therefore carry `prev: origPos` (undo restores
   * exactly) and releaseManualPosition sees the ORIGINAL manual flag.
   *
   * The tree is then settled SYNCHRONOUSLY: dropAt's execOps only schedules
   * the 30ms-debounced layout, and waiting for it would (a) leave the
   * released subtree detached from its new position for a few frames (the
   * release glitch) and (b) let a late reflow fire while the user has
   * already moved on — e.g. clicking another node that then visibly shifts.
   */
  commitNodeDrag(draggedId: string, targetId: string | null, mode: "child" | "before" | "after" | "floating", worldX: number, worldY: number): void {
    const d = this.nodeDragState;
    this.nodeDragState = null;
    if (d) {
      const node = this.model.node(d.nodeId);
      if (node) node.position = { ...d.origPos };
    }
    this.dropAt(draggedId, targetId, mode, worldX, worldY);
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
    applyLayout(this.sheet, false, this.measurer);
    this.notify();
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
  // Node image (T12-4) — the op carries only the id, never the bytes
  // -------------------------------------------------------------------------

  /** Attach (or remove, with imageId = null) an image reference on a node. */
  setNodeImage(nodeId: string, imageId: string | null): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    const prevImageId = node.style.image ?? null;
    if (prevImageId === imageId) return;
    this.execOps([
      makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId, imageId, prevImageId }),
    ]);
  }

  /**
   * Delete the SELECTED image (Backspace/Delete with the image selected):
   * removes only the reference from the node, never the node itself. The
   * attachment card stays (it may be shared; collectOrphans is the GC).
   */
  deleteSelectedImage(): void {
    const nodeId = this.state.imageSel;
    if (!nodeId) return;
    const node = this.model.node(nodeId);
    this.state.imageSel = null;
    if (!node?.style.image) {
      this.notify();
      return;
    }
    this.setNodeImage(nodeId, null);
    this.notify();
  }

  /**
   * Move a node's image reference to another node (image drag & drop). Both
   * reference changes are ONE undoable batch: undo restores the image to its
   * original node. After the move the image on the TARGET stays selected.
   */
  assignImageToNode(fromNodeId: string, toNodeId: string): void {
    if (fromNodeId === toNodeId) return;
    const from = this.model.node(fromNodeId);
    const to = this.model.node(toNodeId);
    if (!from || !to) return;
    const imageId = from.style.image;
    if (!imageId) return;
    const ops: Op[] = [];
    const prevFrom = from.style.image ?? null;
    const prevTo = to.style.image ?? null;
    if (prevFrom !== prevTo) {
      ops.push(
        makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId: fromNodeId, imageId: null, prevImageId: prevFrom })
      );
      ops.push(
        makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId: toNodeId, imageId, prevImageId: prevTo })
      );
      this.execOps(ops);
    }
    this.selectImage(toNodeId);
  }

  /**
   * Attach an imported image: register its metadata card (idempotent,
   * content-addressed — the same image shared by N nodes has one card) and
   * reference it from the node in a single undoable op. The card is NOT
   * removed by undo: it may be shared, and collectOrphans is the GC.
   */
  attachImage(nodeId: string, card: AttachmentInfo): void {
    if (!this.sheet.attachments.some((a) => a.id === card.id)) {
      this.sheet.attachments.push({ ...card });
    }
    this.setNodeImage(nodeId, card.id);
  }

  /**
   * Full import+attach flow (T13-2): validate, import in the worker, store
   * the three levels in the AssetStore, then reference the node. Every
   * rejection says why (rule §4bis of AGENT_GUIDE).
   */
  async attachImageFile(nodeId: string, file: Blob & { name?: string }): Promise<{ ok: boolean; reason?: string }> {
    const v = validateImageSource(file.type, file.size);
    if (!v.ok) {
      trace.ignored(
        "drop",
        v.reason.startsWith("unsupported") ? "unsupported mime" : "too large",
        { mime: file.type, bytes: file.size }
      );
      return { ok: false, reason: v.reason };
    }
    let imported: ImportedImage;
    try {
      imported = await importImageFile(file);
    } catch (err) {
      trace.ignored("drop", "decode failed", { error: String(err) });
      return { ok: false, reason: String(err) };
    }
    const assetStore = getAssetStore();
    const id = await assetStore.put(imported.levels, imported.meta);
    this.attachImage(nodeId, {
      id,
      mime: imported.meta.mime,
      w: imported.meta.w,
      h: imported.meta.h,
      bytes: imported.meta.bytes,
      name: imported.meta.name,
    });
    trace.applied("drop:image", { bytes: imported.meta.bytes, w: imported.meta.w, h: imported.meta.h });
    return { ok: true };
  }

  /**
   * Garbage-collect the unreferenced image assets (T21-A): the palette
   * command that finally calls the long-dormant collectOrphans. It shows
   * how many cards, blobs and BYTES would be recovered, then asks for
   * confirmation. On confirm: the orphan CARDS are removed in ONE undoable
   * op (they modify the document), then the blobs are deleted — which is
   * NOT undoable. The confirmation must say so: undoing after this restores
   * the cards without their bytes.
   */
  async gcOrphans(assetStore?: AssetStore): Promise<void> {
    const store = assetStore ?? getAssetStore();
    const report = await collectOrphans(this.sheet, store);
    if (report.cards.length === 0 && report.blobs.length === 0) {
      this.toast("Nothing to collect — no orphaned images");
      return;
    }
    let bytes = 0;
    for (const id of report.blobs) bytes += await store.size(id);
    const cardsLabel = `${report.cards.length} card${report.cards.length === 1 ? "" : "s"}`;
    const blobsLabel = `${report.blobs.length} image blob${report.blobs.length === 1 ? "" : "s"}`;
    const confirmed =
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(
            `Delete ${cardsLabel} and ${blobsLabel} (${formatBytes(bytes)})?\n\n` +
              "This operation is NOT undoable: an undo after it would restore the cards without their image bytes."
          )
        : false;
    if (!confirmed) {
      this.toast("Collection cancelled");
      return;
    }
    // 1) Cards first — a single undoable batch (the whole attachments list
    // minus the orphans, with the previous list for the inverse).
    if (report.cards.length > 0) {
      this.execOps([
        makeOp<Op & { type: "setAttachments" }>("setAttachments", {
          attachments: this.sheet.attachments.filter((a) => !report.cards.includes(a.id)),
          prev: this.sheet.attachments,
        }),
      ]);
    }
    // 2) Then the blobs — NOT undoable, and deliberately after the cards:
    // the op above is the undoable half; the byte deletion is the purge half.
    for (const id of report.blobs) await store.delete(id);
    this.toast(`Removed ${cardsLabel} and ${blobsLabel} (${formatBytes(bytes)})`);
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

  // -------------------------------------------------------------------------
  // Image resize (T14) — same draft pattern as the width drag: live width is
  // an ephemeral mutation (no op), one setStyle op commits the whole gesture.
  // -------------------------------------------------------------------------

  /** A resize drag on the image handle: capture the pre-drag style. */
  beginImageResize(nodeId: string): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    this.imageResizeState = { nodeId, original: { ...node.style } };
  }

  /** Live image width during the drag/slider: ephemeral, no op, no history. */
  setImageResizeDraft(nodeId: string, width: number): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    const w = Math.max(48, Math.round(width));
    node.style = { ...node.style, imageWidth: w };
    this.scheduleLayout(false);
    this.notify();
  }

  /** End of the gesture: one batch op; undo restores the pre-drag width. */
  commitImageResize(): void {
    const r = this.imageResizeState;
    this.imageResizeState = null;
    if (!r) return;
    const node = this.model.node(r.nodeId);
    if (!node) return;
    const w = node.style.imageWidth;
    if (w !== undefined && w !== r.original.imageWidth) {
      this.execOps([
        makeOp<Op & { type: "setStyle" }>("setStyle", {
          id: r.nodeId,
          style: { ...node.style, imageWidth: w },
          prev: r.original,
        }),
      ]);
    } else {
      // click without a real change — restore, no op
      node.style = r.original;
      this.scheduleLayout(false);
      this.notify();
    }
  }

  /** Remove the custom imageWidth (back to the natural display size). */
  resetImageWidth(nodeId: string): void {
    const node = this.model.node(nodeId);
    if (!node) return;
    if (node.style.imageWidth === undefined) return;
    this.execOps([
      makeOp<Op & { type: "setStyle" }>("setStyle", {
        id: nodeId,
        style: { ...node.style, imageWidth: undefined },
        prev: node.style,
      }),
    ]);
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
    let items: ClipboardItems | null = null;
    try {
      items = await navigator.clipboard.read();
    } catch {
      /* clipboard read with MIME types blocked — fall through to readText */
    }
    if (items) {
      // An image on the clipboard beats text (T13-2): with a node selected, a
      // copied/screenshotted image attaches instead of inserting text.
      const imageItem = items.find((i) => i.types.some((t) => t.startsWith("image/")));
      if (imageItem) {
        const type = imageItem.types.find((t) => t.startsWith("image/"))!;
        const blob = await imageItem.getType(type);
        const node = this.selectionNode ?? (anchorId ? this.model.node(anchorId) : null);
        if (node) {
          await this.attachImageFile(node.id, new File([blob], "pasted-image", { type: blob.type || type }));
        } else {
          trace.ignored("paste:image", "no node selected");
        }
        return;
      }
      for (const item of items) {
        if (item.types.includes("text/rnode")) {
          text = await item.getType("text/rnode").then((blob) => blob.text());
          break;
        }
      }
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
    this.state.imageSel = null;
    this.state.relSel = id;
    this.notify();
  }

  selectGroup(id: string | null): void {
    this.state.selection = [];
    this.state.relSel = null;
    this.state.summarySel = null;
    this.state.imageSel = null;
    this.state.groupSel = id;
    this.notify();
  }

  selectSummary(id: string | null): void {
    this.state.selection = [];
    this.state.relSel = null;
    this.state.groupSel = null;
    this.state.imageSel = null;
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
    // The active document's model is what gets saved (and what the desktop
    // rename-on-save detection reads): keep the two titles in sync so the
    // GUI name becomes the real file's name.
    if (this.state.activeDocId === id) {
      this.model.doc.title = title;
      // Desktop: the file on disk takes the new name NOW, not at the next
      // save. Fire-and-forget — the rename reports its own outcome and must
      // not make renaming in the GUI feel like a blocking operation.
      void this.syncFileNameToTitle();
    }
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
