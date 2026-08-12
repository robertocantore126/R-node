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
    } catch {
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

  /** Read the document from `<path>` WITHOUT switching this adapter's path. */
  async readDocumentAt(path: string): Promise<RnodeDocument | null> {
    try {
      const text = (await this.invoke("read_document", { path })) as string | null;
      if (!text) return null;
      const doc = JSON.parse(text) as RnodeDocument;
      return Array.isArray(doc.sheets) ? doc : null;
    } catch {
      return null;
    }
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
