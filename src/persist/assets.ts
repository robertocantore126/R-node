/**
 * Asset store — image blobs living OUTSIDE the document (ADR-001 §12, T12a).
 *
 * The document keeps only `AttachmentInfo` metadata cards; the bytes are
 * stored in IndexedDB, addressed by content (id = SHA-256 of the original
 * file). The same image attached to N nodes therefore occupies space exactly
 * once, and there are no name collisions. No base64 anywhere: IndexedDB
 * stores native Blobs.
 *
 * The three levels arrive already generated — producing them needs a canvas
 * and is the job of T13. This module only preserves and serves them.
 */
import type { Sheet } from "../core/types";

/** "original" = intatto · "large" = 1024px · "small" = 256px, lato lungo */
export type AssetLevel = "original" | "large" | "small";

export interface AssetBlob {
  blob: Blob;
  w: number;
  h: number;
}

export interface AssetMeta {
  id: string; // SHA-256 of the original
  mime: string;
  w: number; // dimensions of the original
  h: number;
  bytes: number; // weight of the original
  name?: string;
}

export interface AssetStore {
  /** The levels arrive ready-made: generating them is T13's job. */
  put(levels: Record<AssetLevel, AssetBlob>, meta: Omit<AssetMeta, "id">): Promise<string>;
  get(id: string, level: AssetLevel): Promise<Blob | null>;
  meta(id: string): Promise<AssetMeta | null>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Hex-encoded SHA-256 of the given bytes — the content address of an asset. */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stored asset: the three levels plus the metadata card. */
interface AssetRecord {
  id: string;
  original: AssetBlob;
  large: AssetBlob;
  small: AssetBlob;
  meta: AssetMeta;
}

const DEFAULT_DB_NAME = "r-node-assets";
const DB_VERSION = 1;
const STORE = "assets";

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // A version-change upgrade waits for other open connections. Never hang
    // forever: reject loudly instead of leaving the promise pending.
    req.onblocked = () => {
      reject(new Error(`openDb("${dbName}"): upgrade blocked by an open connection`));
    };
  });
}

/** Runs `fn` on the object store and resolves when the transaction completes. */
function txDone(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    fn(tx.objectStore(STORE));
  });
}

/** Fetches a record by key through a short-lived read-only transaction. */
function txGet<T>(db: IDBDatabase, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Default (and, for now, only) AssetStore implementation. IndexedDB stores
 * native Blobs — no base64 inflation — with quotas in the hundreds of MB up
 * to GB, which is why the images cannot live in the document (localStorage
 * caps around 5MB).
 */
export class IndexedDbAssetStore implements AssetStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(this.dbName);
    return this.dbPromise;
  }

  async put(levels: Record<AssetLevel, AssetBlob>, meta: Omit<AssetMeta, "id">): Promise<string> {
    const id = await sha256Hex(await levels.original.blob.arrayBuffer());
    const db = await this.db();
    const record: AssetRecord = { id, ...levels, meta: { ...meta, id } };
    // Existence check and write in ONE readwrite transaction: two concurrent
    // puts of identical content cannot both pass the check. Content-addressed
    // first write wins — an existing id is returned as-is, never rewritten.
    // Deliberately not add()-and-catch: a failed request aborts the
    // transaction unless its error event is default-prevented.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const s = tx.objectStore(STORE);
      const getReq = s.get(id);
      getReq.onsuccess = () => {
        if (getReq.result === undefined) s.put(record);
      };
      getReq.onerror = () => reject(getReq.error);
    });
    return id;
  }

  async get(id: string, level: AssetLevel): Promise<Blob | null> {
    const record = await txGet<AssetRecord>(await this.db(), id);
    return record?.[level]?.blob ?? null;
  }

  async meta(id: string): Promise<AssetMeta | null> {
    const record = await txGet<AssetRecord>(await this.db(), id);
    return record?.meta ?? null;
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await txDone(db, "readwrite", (s) => s.delete(id));
  }

  async list(): Promise<string[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * The single source of truth for "which asset is in use". The roots are the
 * nodes alone: an `attachments` card whose node is gone is garbage too, so
 * it must never act as a root. Future referrers (callouts, boundaries) are
 * added here, in one place.
 */
export function referencedAssetIds(sheet: Sheet): Set<string> {
  const referenced = new Set<string>();
  for (const node of Object.values(sheet.nodes)) {
    if (node.style.image) referenced.add(node.style.image);
  }
  return referenced;
}

export interface OrphanReport {
  /** Cards in sheet.attachments that no node references. */
  cards: string[];
  /** Ids in the store that no node references. */
  blobs: string[];
}

/**
 * What is unreachable from the nodes. Returns an OrphanReport WITHOUT
 * deleting anything: garbage collection must be an explicit user action (a
 * command), never a side-effect of undo or save.
 */
export async function collectOrphans(sheet: Sheet, store: AssetStore): Promise<OrphanReport> {
  const referenced = referencedAssetIds(sheet);
  const cards = sheet.attachments.map((a) => a.id).filter((id) => !referenced.has(id));
  const ids = await store.list();
  const blobs = ids.filter((id) => !referenced.has(id));
  return { cards, blobs };
}
