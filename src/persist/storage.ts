/**
 * Persistence layer.
 *
 * Adapter interface so the editor never cares where documents live:
 *  - localStorage: default for the web MVP (autosave, crash-safe enough);
 *  - IndexedDB: later web upgrade;
 *  - SQLite via the Rust document engine: desktop (Tauri commands).
 */
import type { RnodeDocument } from "../core/types";

export interface StorageAdapter {
  readonly label: string;
  load(): Promise<RnodeDocument[]>;
  save(docs: RnodeDocument[]): Promise<void>;
}

/**
 * Why opening a document failed. "R-node cannot open the document" is not a
 * diagnosis; each kind maps to a user-facing label and the original backend
 * message is always preserved on the error, so the trace buffer carries the
 * exact reason.
 */
export type DocumentLoadErrorKind =
  | "not-found" // file does not exist
  | "permission" // exists but not readable
  | "corrupt" // exists but is not a valid SQLite/.rnode database
  | "sqlite" // other SQLite/IO failure while reading
  | "invalid-json" // the document row is not valid JSON
  | "incompatible-schema"; // JSON, but not an R-node document

export class DocumentLoadError extends Error {
  readonly kind: DocumentLoadErrorKind;

  constructor(kind: DocumentLoadErrorKind, message: string) {
    super(message);
    this.name = "DocumentLoadError";
    this.kind = kind;
  }
}

export function documentLoadErrorLabel(kind: DocumentLoadErrorKind): string {
  switch (kind) {
    case "not-found":
      return "file not found";
    case "permission":
      return "permission denied";
    case "corrupt":
      return "the file is corrupt (not a valid .rnode database)";
    case "sqlite":
      return "SQLite error while reading the file";
    case "invalid-json":
      return "the document row is not valid JSON";
    case "incompatible-schema":
      return "not an R-node document (no sheets)";
  }
}

/**
 * Map a rejected Tauri `read_document` call to a typed error. The kind is a
 * best-effort reading of the backend message; the message itself is always
 * preserved verbatim because it is what the developer needs.
 */
function classifyTauriReadError(path: string, e: unknown): DocumentLoadError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  let kind: DocumentLoadErrorKind;
  if (/not a database|malformed|file is encrypted/i.test(lower)) kind = "corrupt";
  else if (/permission|denied|access/i.test(lower)) kind = "permission";
  else if (/no such file|unable to open database file/i.test(lower)) kind = "not-found";
  else kind = "sqlite";
  return new DocumentLoadError(kind, `${msg} (${path})`);
}

// Storage key for the R-node brand. The app was previously named "R-mind":
// the old key is read once and migrated so existing documents are never lost.
const KEY = "r-node.docs.v1";
const LEGACY_KEY = "r-mind.docs.v1";

/** Rename the built-in sample document when migrating from the old app name. */
function migrateSample(doc: RnodeDocument): RnodeDocument {
  if (doc.title === "R-mind — Roadmap") doc.title = "R-node — Roadmap";
  const sheet = doc.sheets[0];
  const root = sheet.nodes[sheet.rootNodeId];
  if (root && root.title === "R-mind") root.title = "R-node";
  return doc;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly label = "localStorage";

  async load(): Promise<RnodeDocument[]> {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((d) => d && typeof d === "object" && Array.isArray(d.sheets));
      }
      // No data under the new key yet — migrate from the legacy "r-mind" key.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (!legacy) return [];
      const parsed = JSON.parse(legacy);
      if (!Array.isArray(parsed)) return [];
      const docs = parsed.filter((d) => d && typeof d === "object" && Array.isArray(d.sheets));
      docs.forEach(migrateSample);
      if (docs.length > 0) {
        try {
          localStorage.setItem(KEY, JSON.stringify(docs));
        } catch (e) {
          console.error("storage migration write failed", e);
        }
      }
      return docs;
    } catch (e) {
      // Corrupt localStorage must never block the app, but it must not be
      // silent either: a bare "cannot open the document" with no reason is
      // what this logging is here to prevent.
      console.error("r-node: stored documents could not be parsed; starting empty", e);
      return [];
    }
  }

  async save(docs: RnodeDocument[]): Promise<void> {
    try {
      localStorage.setItem(KEY, JSON.stringify(docs));
    } catch (e) {
      console.error("localStorage save failed", e);
      throw e;
    }
  }
}

/**
 * Desktop: the document is ONE `.rnode` file (a SQLite database, T20). The
 * document JSON lives in its `document` table; the images are served by
 * TauriAssetStore from the same file. The path is mutable state set by
 * open/save-as — the same pattern as the asset store, so a file switch never
 * re-creates anything. No localStorage on desktop: the document survives
 * even if the webview profile is wiped.
 */
export class TauriStorageAdapter implements StorageAdapter {
  readonly label = "document file (rust)";
  private root: string | null = null;

  /** The document file this adapter serves. Null = nothing chosen yet. */
  setRoot(path: string | null): void {
    this.root = path;
  }

  get hasRoot(): boolean {
    return this.root !== null;
  }

  /** The current document path, or null before the first open/save-as. */
  get currentPath(): string | null {
    return this.root;
  }

  private invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    if (typeof window === "undefined" || !window.__TAURI__) {
      throw new Error("TauriStorageAdapter used outside the Tauri webview");
    }
    return window.__TAURI__.core.invoke(cmd, args);
  }

  /**
   * Read the document from `<path>` WITHOUT switching this adapter's path.
   *
   * Returns `null` only for the benign "nothing to read" cases (no document
   * row / not an R-node document). Every real failure throws a
   * `DocumentLoadError` whose `kind` says WHY — corrupt file, invalid JSON,
   * incompatible schema, permission — instead of collapsing into `null`.
   */
  async readDocumentAt(path: string): Promise<RnodeDocument | null> {
    let text: string | null;
    try {
      text = (await this.invoke("read_document", { path })) as string | null;
    } catch (e) {
      throw classifyTauriReadError(path, e);
    }
    // null = the backend reported "nothing to read" (no file yet / not an
    // R-node document). Benign: the caller reports it as invalid, not broken.
    if (text == null) return null;
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new DocumentLoadError(
        "invalid-json",
        `the document row in "${path}" is not valid JSON`
      );
    }
    if (!Array.isArray((doc as RnodeDocument)?.sheets)) {
      throw new DocumentLoadError(
        "incompatible-schema",
        `"${path}" is not an R-node document (schemaVersion ${(doc as RnodeDocument)?.schemaVersion ?? "unknown"})`
      );
    }
    return doc as RnodeDocument;
  }

  async load(): Promise<RnodeDocument[]> {
    if (!this.root) return [];
    const doc = await this.readDocumentAt(this.root);
    return doc ? [doc] : [];
  }

  async save(docs: RnodeDocument[]): Promise<void> {
    const doc = docs[0];
    if (!doc) return;
    if (!this.root) throw new Error("TauriStorageAdapter: no document file chosen");
    await this.invoke("write_document", { path: this.root, data: JSON.stringify(doc) });
  }
}
