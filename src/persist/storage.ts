/**
 * Persistence layer.
 *
 * Adapter interface so the editor never cares where documents live:
 *  - localStorage: default for the web MVP (autosave, crash-safe enough);
 *  - IndexedDB: later web upgrade;
 *  - SQLite via the Rust document engine: desktop (Tauri commands).
 */
import type { RmindDocument } from "../core/types";

export interface StorageAdapter {
  readonly label: string;
  load(): Promise<RmindDocument[]>;
  save(docs: RmindDocument[]): Promise<void>;
}

const KEY = "r-mind.docs.v1";

export class LocalStorageAdapter implements StorageAdapter {
  readonly label = "localStorage";

  async load(): Promise<RmindDocument[]> {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((d) => d && typeof d === "object" && Array.isArray(d.sheets));
    } catch {
      return [];
    }
  }

  async save(docs: RmindDocument[]): Promise<void> {
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
  async load(): Promise<RmindDocument[]> {
    // window.__TAURI__ ? await invoke("list_documents") : []
    return [];
  }
  async save(_docs: RmindDocument[]): Promise<void> {
    // await invoke("save_document", { doc })
  }
}
