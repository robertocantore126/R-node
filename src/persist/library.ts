/**
 * The document LIBRARY: every map the app knows, of which exactly ONE is open.
 *
 * The editor holds a single document in memory. The others are entries here —
 * a title for the sidebar plus the stored body — and are loaded only when the
 * user opens them. Switching away from a map "parks" it: its body is written
 * here (with `unsaved` set when its changes are not in its file yet), and it
 * leaves memory.
 *
 * Two implementations:
 *  - IndexedDbLibrary (web): persistent, one record per document, so a heavy
 *    map never has to fit the ~5 MB localStorage quota together with all the
 *    others, and opening the app reads one map, not every map.
 *  - MemoryLibrary (desktop, tests): parked bodies as serialized text for the
 *    session. On the desktop a map with a file and no unsaved changes is
 *    parked WITHOUT a body — it is read back from its file.
 *
 * `put` serializes the document synchronously, before its first await: what
 * is parked is the map as it was at the call, whatever the caller does next.
 */
import type { RnodeDocument } from "../core/types";
import { referencedAssetIds } from "./assets";
import { LocalStorageAdapter, type StorageAdapter } from "./storage";
import { trace } from "../dev/trace";

export interface LibraryEntry {
  documentId: string;
  title: string;
  updatedAt: string;
  archived?: boolean;
  /** Its changes are stored here but not in its file yet. */
  unsaved?: boolean;
}

export interface PutOptions {
  unsaved?: boolean;
  /** false = record the entry only (desktop: the body is in its file). */
  body?: boolean;
}

export interface DocumentLibrary {
  /** True when parked maps survive a restart (the web library). */
  readonly persistent: boolean;
  list(): Promise<LibraryEntry[]>;
  get(id: string): Promise<RnodeDocument | null>;
  put(doc: RnodeDocument, opts?: PutOptions): Promise<void>;
  remove(id: string): Promise<void>;
  /** Images referenced by every stored map except `exceptId` — the other
   *  roots of the shared image store (see collectOrphans). */
  assetIds(exceptId: string): Promise<Set<string>>;
  /** Remember / recall the map to reopen at the next start. */
  setLastOpen(id: string): Promise<void>;
  getLastOpen(): Promise<string | null>;
}

function entryOf(doc: RnodeDocument, opts: PutOptions): LibraryEntry {
  return {
    documentId: doc.documentId,
    title: typeof doc.title === "string" ? doc.title : "Untitled",
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : "",
    archived: doc.archived ? true : undefined,
    unsaved: opts.unsaved ? true : undefined,
  };
}

function assetIdsOf(doc: RnodeDocument): string[] {
  const ids = new Set<string>();
  try {
    for (const sheet of doc.sheets ?? []) for (const id of referencedAssetIds(sheet)) ids.add(id);
  } catch {
    // A stored map that fails the open check still keeps whatever it can name.
  }
  return [...ids];
}

/** Session-only library: desktop and tests. */
export class MemoryLibrary implements DocumentLibrary {
  readonly persistent = false;
  private entries = new Map<string, LibraryEntry>();
  private bodies = new Map<string, string>();
  private assets = new Map<string, string[]>();
  private lastOpen: string | null = null;

  async list(): Promise<LibraryEntry[]> {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  async get(id: string): Promise<RnodeDocument | null> {
    const json = this.bodies.get(id);
    return json ? (JSON.parse(json) as RnodeDocument) : null;
  }

  put(doc: RnodeDocument, opts: PutOptions = {}): Promise<void> {
    this.entries.set(doc.documentId, entryOf(doc, opts));
    this.assets.set(doc.documentId, assetIdsOf(doc));
    if (opts.body === false) this.bodies.delete(doc.documentId);
    else this.bodies.set(doc.documentId, JSON.stringify(doc));
    return Promise.resolve();
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
    this.bodies.delete(id);
    this.assets.delete(id);
  }

  async assetIds(exceptId: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [id, list] of this.assets) if (id !== exceptId) for (const a of list) out.add(a);
    return out;
  }

  async setLastOpen(id: string): Promise<void> {
    this.lastOpen = id;
  }

  async getLastOpen(): Promise<string | null> {
    return this.lastOpen;
  }
}

const DB_NAME = "r-node-library";
const DB_VERSION = 1;
const ENTRIES = "entries";
const BODIES = "bodies";
const META = "meta";

interface StoredEntry extends LibraryEntry {
  assetIds: string[];
}

function openLibraryDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: "documentId" });
      if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`openLibraryDb("${name}"): upgrade blocked by an open connection`));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Web library: one IndexedDB record per map (entry and body apart, so the
 *  sidebar never reads a body). */
export class IndexedDbLibrary implements DocumentLibrary {
  readonly persistent = true;
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** Writes still in flight: read back from here, so a map parked a moment
   *  ago is never "missing" while its transaction commits. */
  private pending = new Map<string, { entry: StoredEntry; json: string | null }>();

  constructor(private readonly dbName: string = DB_NAME) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openLibraryDb(this.dbName).catch((e) => {
      this.dbPromise = null;
      throw e;
    });
    return this.dbPromise;
  }

  async list(): Promise<LibraryEntry[]> {
    const db = await this.db();
    const stored = await request(db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).getAll() as IDBRequest<StoredEntry[]>);
    const byId = new Map<string, LibraryEntry>();
    for (const { assetIds: _ids, ...e } of stored) byId.set(e.documentId, e);
    for (const [id, p] of this.pending) {
      const { assetIds: _ids, ...e } = p.entry;
      byId.set(id, e);
    }
    return [...byId.values()];
  }

  async get(id: string): Promise<RnodeDocument | null> {
    const p = this.pending.get(id);
    if (p) return p.json ? (JSON.parse(p.json) as RnodeDocument) : null;
    const db = await this.db();
    const json = await request(db.transaction(BODIES, "readonly").objectStore(BODIES).get(id) as IDBRequest<string | undefined>);
    return json ? (JSON.parse(json) as RnodeDocument) : null;
  }

  async put(doc: RnodeDocument, opts: PutOptions = {}): Promise<void> {
    // Serialized NOW, before any await: the caller may edit or drop the map.
    const entry: StoredEntry = { ...entryOf(doc, opts), assetIds: assetIdsOf(doc) };
    const json = opts.body === false ? null : JSON.stringify(doc);
    const id = doc.documentId;
    this.pending.set(id, { entry, json });
    const db = await this.db();
    const tx = db.transaction([ENTRIES, BODIES], "readwrite");
    tx.objectStore(ENTRIES).put(entry);
    if (json !== null) tx.objectStore(BODIES).put(json, id);
    await done(tx);
    trace.mark("persist", "persist:save", { via: "library", docId: id, chars: json?.length ?? 0 });
    // Cleared only once stored, and only by the write that is still the
    // latest. A FAILED write keeps its copy here: the map stays openable for
    // the session instead of vanishing with the transaction.
    if (this.pending.get(id)?.entry === entry) this.pending.delete(id);
  }

  async remove(id: string): Promise<void> {
    this.pending.delete(id);
    const db = await this.db();
    const tx = db.transaction([ENTRIES, BODIES], "readwrite");
    tx.objectStore(ENTRIES).delete(id);
    tx.objectStore(BODIES).delete(id);
    await done(tx);
  }

  async assetIds(exceptId: string): Promise<Set<string>> {
    const db = await this.db();
    const stored = await request(db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).getAll() as IDBRequest<StoredEntry[]>);
    const out = new Set<string>();
    for (const e of stored) if (e.documentId !== exceptId && !this.pending.has(e.documentId)) for (const a of e.assetIds ?? []) out.add(a);
    for (const [id, p] of this.pending) if (id !== exceptId) for (const a of p.entry.assetIds) out.add(a);
    return out;
  }

  async setLastOpen(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put(id, "lastOpen");
    await done(tx);
  }

  async getLastOpen(): Promise<string | null> {
    const db = await this.db();
    return (await request(db.transaction(META, "readonly").objectStore(META).get("lastOpen") as IDBRequest<string | undefined>)) ?? null;
  }
}

/**
 * The web adapter: the library above, opening ONE map.
 *
 * `load` returns the map to reopen (the last one open), never the whole
 * library. `save` writes the given maps INTO the library (upsert) — it never
 * replaces the library with the list it is given, so saving the open map can
 * never drop the others.
 *
 * First start after the change: the maps of the old single-key localStorage
 * store are copied in. That key is left exactly as it was, as a backup; the
 * app no longer writes it.
 */
export class BrowserLibraryAdapter implements StorageAdapter {
  readonly label = "browser library (IndexedDB)";
  readonly library: IndexedDbLibrary;

  constructor(library: IndexedDbLibrary = new IndexedDbLibrary(), private readonly legacy: StorageAdapter = new LocalStorageAdapter()) {
    this.library = library;
  }

  async load(): Promise<RnodeDocument[]> {
    let entries = await this.library.list();
    if (entries.length === 0) {
      const old = await this.legacy.load();
      const keyed = old.filter((d) => typeof d?.documentId === "string" && d.documentId.length > 0);
      for (const d of keyed) await this.library.put(d);
      if (keyed.length > 0) {
        await this.library.setLastOpen(keyed[0].documentId);
        trace.mark("data", "data:migrate", { from: "localStorage", to: "library", docs: keyed.length });
      }
      entries = await this.library.list();
    }
    if (entries.length === 0) return [];
    const last = await this.library.getLastOpen();
    const pick = (last && entries.find((e) => e.documentId === last)) ||
      [...entries].filter((e) => !e.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ||
      entries[0];
    const doc = await this.library.get(pick.documentId);
    trace.mark("persist", "persist:load", { via: "library", docs: doc ? 1 : 0, known: entries.length });
    return doc ? [doc] : [];
  }

  async save(docs: RnodeDocument[]): Promise<void> {
    for (const d of docs) {
      if (typeof d?.documentId !== "string") continue;
      await this.library.put(d);
    }
    if (docs[0] && typeof docs[0].documentId === "string") await this.library.setLastOpen(docs[0].documentId);
  }
}
