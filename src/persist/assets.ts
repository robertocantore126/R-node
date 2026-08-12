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
  /**
   * Store levels under a caller-supplied id. The `.rnode.zip` importer needs
   * it: a compact export carries no original, so re-deriving the id from the
   * stored levels (what `put` does) would change it and every reference in
   * the imported document would break. Idempotent like `put`: an id that
   * already exists is left untouched.
   *
   * INVARIANT EXCEPTION (AGENT_GUIDE I11): by taking the id as an argument
   * this breaks `id === sha256(original)`. That is only reachable through the
   * .rnode.zip importer, and only for assets whose original is lost (the
   * compact mode carries display levels only) — those assets carry the
   * `originalLost` flag on their AttachmentInfo card so an export can warn.
   */
  putUnderId(id: string, levels: Record<AssetLevel, AssetBlob>, meta: AssetMeta): Promise<void>;
  get(id: string, level: AssetLevel): Promise<Blob | null>;
  meta(id: string): Promise<AssetMeta | null>;
  /**
   * Exact byte weight of every stored level of an asset (original + large +
   * small + the meta row). Used by the orphan-GC command to tell the user
   * how many bytes would be recovered BEFORE the confirmation.
   */
  size(id: string): Promise<number>;
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
    await this.putUnderId(id, levels, { ...meta, id });
    return id;
  }

  async putUnderId(id: string, levels: Record<AssetLevel, AssetBlob>, meta: AssetMeta): Promise<void> {
    const db = await this.db();
    const record: AssetRecord = { id, ...levels, meta };
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
  }

  async get(id: string, level: AssetLevel): Promise<Blob | null> {
    const record = await txGet<AssetRecord>(await this.db(), id);
    return record?.[level]?.blob ?? null;
  }

  async meta(id: string): Promise<AssetMeta | null> {
    const record = await txGet<AssetRecord>(await this.db(), id);
    return record?.meta ?? null;
  }

  async size(id: string): Promise<number> {
    const record = await txGet<AssetRecord>(await this.db(), id);
    if (!record) return 0;
    // Exact, not estimated: blob.size is the byte length of what was stored,
    // and the meta is serialized the same way the desktop backend stores it
    // (JSON.stringify), so the two backends agree on the weight.
    return (
      record.original.blob.size +
      record.large.blob.size +
      record.small.blob.size +
      new TextEncoder().encode(JSON.stringify(record.meta)).length
    );
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
 * Tauri v2 exposes its API as `window.__TAURI__` when `withGlobalTauri` is
 * enabled in tauri.conf.json. That global is the detection switch for the
 * desktop build: it exists only inside the WebView2 window, never in a plain
 * browser tab — exactly what the factory needs.
 */
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: TauriInvoke;
      };
    };
  }
}

/**
 * Desktop implementation: the levels live INSIDE the current `.rnode` file
 * (a SQLite database) — `<path>/assets(id, level)` rows, served by the Rust
 * commands. `meta` is one more level row, written through the same command.
 *
 * The path is MUTABLE state, set by open/save-as (T20). The Renderer
 * captures this same instance in its constructor — the trap is that opening
 * another document must never mint a new store, or the renderer would keep
 * reading the previous file. Only the path changes.
 */
export class TauriAssetStore implements AssetStore {
  private metaCache = new Map<string, AssetMeta>();
  /** Current document file; lazily `<app-data>/scratch.rnode` before the
   *  first save, then whatever open/save-as chose. Null resets to default. */
  private path: string | null = null;
  private defaultPath: Promise<string> | null = null;

  private invoke(): TauriInvoke {
    const api = typeof window !== "undefined" ? window.__TAURI__ : undefined;
    if (!api) throw new Error("TauriAssetStore used outside the Tauri webview");
    return api.core.invoke;
  }

  /** Switch this store to a document file. Same instance, new path. */
  setRoot(path: string | null): void {
    this.path = path;
    this.defaultPath = null;
    this.metaCache.clear();
  }

  private async currentPath(): Promise<string> {
    if (this.path) return this.path;
    this.defaultPath ??= this.invoke()("default_document_path") as Promise<string>;
    return this.defaultPath;
  }

  async put(levels: Record<AssetLevel, AssetBlob>, meta: Omit<AssetMeta, "id">): Promise<string> {
    const id = await sha256Hex(await levels.original.blob.arrayBuffer());
    await this.putUnderId(id, levels, { ...meta, id });
    return id;
  }

  async putUnderId(id: string, levels: Record<AssetLevel, AssetBlob>, meta: AssetMeta): Promise<void> {
    const path = await this.currentPath();
    const invoke = this.invoke();
    for (const level of ["original", "large", "small"] as const) {
      const bytes = new Uint8Array(await levels[level].blob.arrayBuffer());
      await invoke("put_asset", { path, id, level, bytes });
    }
    await invoke("put_asset", {
      path,
      id,
      level: "meta",
      bytes: new TextEncoder().encode(JSON.stringify(meta)),
    });
    this.metaCache.set(id, meta);
  }

  async get(id: string, level: AssetLevel): Promise<Blob | null> {
    const path = await this.currentPath();
    const raw = await this.invoke()("get_asset", { path, id, level });
    const bytes = toBytes(raw);
    if (!bytes || bytes.byteLength === 0) return null; // empty body = absent
    const mime = this.metaCache.get(id)?.mime;
    return new Blob([bytes], mime ? { type: mime } : undefined);
  }

  async meta(id: string): Promise<AssetMeta | null> {
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    const path = await this.currentPath();
    const raw = await this.invoke()("get_asset", { path, id, level: "meta" });
    const bytes = toBytes(raw);
    if (!bytes || bytes.byteLength === 0) return null;
    const meta = JSON.parse(new TextDecoder().decode(bytes)) as AssetMeta;
    this.metaCache.set(id, meta);
    return meta;
  }

  async size(id: string): Promise<number> {
    // Exact: reads the real bytes and sums their lengths (the SQLite backend
    // computes the same sum as SUM(length(bytes)) over the level rows). Four
    // round-trips per asset, fine for the explicit, rare GC command.
    const [original, large, small] = await Promise.all([
      this.get(id, "original"),
      this.get(id, "large"),
      this.get(id, "small"),
    ]);
    const card = await this.meta(id);
    let total = 0;
    for (const b of [original, large, small]) if (b) total += b.size;
    if (card) total += new TextEncoder().encode(JSON.stringify(card)).length;
    return total;
  }

  async delete(id: string): Promise<void> {
    const path = await this.currentPath();
    await this.invoke()("delete_asset", { path, id });
    this.metaCache.delete(id);
  }

  async list(): Promise<string[]> {
    return (await this.invoke()("list_assets", { path: await this.currentPath() })) as string[];
  }

  /**
   * Point this store at a NEW document file, copying every referenced asset
   * (all three levels + meta) from the current path into it FIRST. Reading
   * happens before the switch: after it, get() would read the new, empty
   * file. Same per-asset iteration the zip exporter uses — a document saved
   * into a fresh file never points at ids that are not there.
   */
  async adoptFile(
    newPath: string,
    ids: string[],
    onProgress?: (phase: "read" | "write", done: number, total: number) => void
  ): Promise<number> {
    // The reads below go through this.currentPath(), still the OLD file: the
    // switch happens only after every asset is copied. Only the BYTES matter
    // for the copy — w/h live in the meta JSON.
    //
    // Returns how many referenced assets could NOT be copied (missing meta or
    // any level): skipping is right (failing the whole save for one image
    // would be worse), but the caller must tell the user, not stay silent.
    const payloads: { id: string; meta: AssetMeta; blobs: Record<AssetLevel, Blob> }[] = [];
    let skipped = 0;
    for (const id of ids) {
      const [meta, original, large, small] = await Promise.all([
        this.meta(id),
        this.get(id, "original"),
        this.get(id, "large"),
        this.get(id, "small"),
      ]);
      if (!meta || !original || !large || !small) {
        skipped++; // referenced but absent
        continue;
      }
      payloads.push({ id, meta, blobs: { original, large, small } });
      onProgress?.("read", payloads.length + skipped, ids.length);
    }
    const invoke = this.invoke();
    let written = 0;
    for (const { id, meta, blobs } of payloads) {
      for (const level of ["original", "large", "small"] as const) {
        const bytes = new Uint8Array(await blobs[level].arrayBuffer());
        await invoke("put_asset", { path: newPath, id, level, bytes });
      }
      await invoke("put_asset", {
        path: newPath,
        id,
        level: "meta",
        bytes: new TextEncoder().encode(JSON.stringify(meta)),
      });
      onProgress?.("write", ++written, payloads.length);
    }
    this.path = newPath;
    this.defaultPath = null;
    this.metaCache.clear();
    return skipped;
  }
}

/**
 * Raw IPC bytes arrive as an ArrayBuffer (Tauri 2 custom-protocol path for
 * `tauri::ipc::Response`); the postMessage fallback and test mocks may hand
 * back a Uint8Array or a plain number[]. Normalize all of them to a
 * Uint8Array, or null when the value is not bytes at all.
 */
function toBytes(raw: unknown): Uint8Array<ArrayBuffer> | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) {
    // Fresh buffer: a view over a SharedArrayBuffer or a foreign buffer must
    // not leak into Blob (BlobPart wants ArrayBuffer-backed views).
    return Uint8Array.from(raw);
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  return null;
}

/**
 * The one factory every caller must use. The three former `new
 * IndexedDbAssetStore()` sites (store.ts, renderer.ts, RichEditor.tsx) each
 * opened their OWN database: images written through one store were invisible
 * to the others. A singleton also means the desktop build and the web build
 * each pick their backend exactly once, at first use.
 */
let sharedStore: AssetStore | null = null;

export function getAssetStore(): AssetStore {
  if (!sharedStore) {
    const tauri = typeof window !== "undefined" && !!window.__TAURI__;
    sharedStore = tauri ? new TauriAssetStore() : new IndexedDbAssetStore();
  }
  return sharedStore;
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
