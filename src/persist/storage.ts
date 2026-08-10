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

/** Placeholder for the desktop build — wired to Tauri commands when Rust lands. */
export class TauriStorageAdapter implements StorageAdapter {
  readonly label = "sqlite (rust)";
  async load(): Promise<RnodeDocument[]> {
    // window.__TAURI__ ? await invoke("list_documents") : []
    return [];
  }
  async save(_docs: RnodeDocument[]): Promise<void> {
    // await invoke("save_document", { doc })
  }
}
