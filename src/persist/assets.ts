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
 * Desktop implementation: the levels are real files under the current
 * document folder `<root>/assets/<id>/<level>` (ADR-001 §12 chooses B1 —
 * original files the user keeps, not a browser cache the OS can evict).
 * `meta` lives next to them as a JSON file, written through the same command.
 *
 * The root is MUTABLE state, set by open/save-as (T19). The Renderer captures
 * this same instance in its constructor — the trap is that opening another
 * document must never mint a new store, or the renderer would keep reading
 * the previous folder. Only the root changes.
 */
export class TauriAssetStore implements AssetStore {
  private metaCache = new Map<string, AssetMeta>();
  /** Current document folder; lazily the app-data assets dir before the
   *  first save, then whatever open/save-as chose. Null resets to default. */
  private root: string | null = null;
  private defaultRoot: Promise<string> | null = null;

  private invoke(): TauriInvoke {
    const api = typeof window !== "undefined" ? window.__TAURI__ : undefined;
    if (!api) throw new Error("TauriAssetStore used outside the Tauri webview");
    return api.core.invoke;
  }

  /** Switch this store to a document folder. Same instance, new root. */
  setRoot(root: string | null): void {
    this.root = root;
    this.defaultRoot = null;
    this.metaCache.clear();
  }

  private async rootDir(): Promise<string> {
    if (this.root) return this.root;
    this.defaultRoot ??= this.invoke()("default_asset_root") as Promise<string>;
    return this.defaultRoot;
  }

  async put(levels: Record<AssetLevel, AssetBlob>, meta: Omit<AssetMeta, "id">): Promise<string> {
    const id = await sha256Hex(await levels.original.blob.arrayBuffer());
    await this.putUnderId(id, levels, { ...meta, id });
    return id;
  }

  async putUnderId(id: string, levels: Record<AssetLevel, AssetBlob>, meta: AssetMeta): Promise<void> {
    const root = await this.rootDir();
    const invoke = this.invoke();
    for (const level of ["original", "large", "small"] as const) {
      const bytes = new Uint8Array(await levels[level].blob.arrayBuffer());
      await invoke("put_asset", { root, id, level, bytes });
    }
    await invoke("put_asset", {
      root,
      id,
      level: "meta",
      bytes: new TextEncoder().encode(JSON.stringify(meta)),
    });
    this.metaCache.set(id, meta);
  }

  async get(id: string, level: AssetLevel): Promise<Blob | null> {
    const root = await this.rootDir();
    const bytes = (await this.invoke()("get_asset", { root, id, level })) as number[] | null;
    if (!bytes) return null;
    const mime = this.metaCache.get(id)?.mime;
    return new Blob([new Uint8Array(bytes)], mime ? { type: mime } : undefined);
  }

  async meta(id: string): Promise<AssetMeta | null> {
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    const root = await this.rootDir();
    const bytes = (await this.invoke()("get_asset", { root, id, level: "meta" })) as number[] | null;
    if (!bytes) return null;
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as AssetMeta;
    this.metaCache.set(id, meta);
    return meta;
  }

  async delete(id: string): Promise<void> {
    const root = await this.rootDir();
    await this.invoke()("delete_asset", { root, id });
    this.metaCache.delete(id);
  }

  async list(): Promise<string[]> {
    return (await this.invoke()("list_assets", { root: await this.rootDir() })) as string[];
  }

  /**
   * Point this store at a NEW document folder, copying every referenced
   * asset (all three levels + meta) from the current root into it FIRST.
   * Reading happens before the switch: after it, get() would read the new,
   * empty folder. Same per-asset iteration the zip exporter uses (T19: a
   * folder instead of an archive) — a document saved into a fresh folder
   * never points at ids that are not there.
   */
  async adoptRoot(newRoot: string, ids: string[]): Promise<void> {
    // The reads below go through this.rootDir(), still the OLD root: the
    // switch happens only after every asset is copied.
    // Only the BYTES matter for the copy: the folder layout stores raw files,
    // w/h live in the meta JSON.
    const payloads: { id: string; meta: AssetMeta; blobs: Record<AssetLevel, Blob> }[] = [];
    for (const id of ids) {
      const [meta, original, large, small] = await Promise.all([
        this.meta(id),
        this.get(id, "original"),
        this.get(id, "large"),
        this.get(id, "small"),
      ]);
      if (!meta || !original || !large || !small) continue; // referenced but absent
      payloads.push({ id, meta, blobs: { original, large, small } });
    }
    const invoke = this.invoke();
    for (const { id, meta, blobs } of payloads) {
      for (const level of ["original", "large", "small"] as const) {
        const bytes = new Uint8Array(await blobs[level].arrayBuffer());
        await invoke("put_asset", { root: newRoot, id, level, bytes });
      }
      await invoke("put_asset", {
        root: newRoot,
        id,
        level: "meta",
        bytes: new TextEncoder().encode(JSON.stringify(meta)),
      });
    }
    this.root = newRoot;
    this.defaultRoot = null;
    this.metaCache.clear();
  }
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
