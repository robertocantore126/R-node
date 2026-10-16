/**
 * The desktop `.rnode` file, read and written in the browser.
 *
 * A `.rnode` is an SQLite database (T20): one `document` row with the JSON,
 * one `assets` row per (id, level) with the image bytes, and a `meta` table
 * that names the app and the schema version. The desktop reaches it through
 * rusqlite (`src-tauri/src/lib.rs`); the web build has no filesystem and no
 * native SQLite, so it runs SQLite itself, compiled to WebAssembly (sql.js),
 * on an in-memory copy of the file.
 *
 * That makes the web flow whole-file, like `.rnode.zip`: open = bytes → DB →
 * document + assets into the IndexedDB store; save = fresh DB → bytes → one
 * write. The schema below MUST stay byte-identical to the Rust `SCHEMA`
 * constant, so a file written here opens on the desktop and vice versa.
 *
 * sql.js is loaded lazily: the WASM (~650 KB) is fetched the first time a
 * `.rnode` is opened or saved, never on app start.
 */
import type { Database, SqlJsStatic } from "sql.js";
import type { RnodeDocument, Sheet } from "../core/types";
import { referencedAssetIds, type AssetBlob, type AssetLevel, type AssetMeta, type AssetStore } from "./assets";

/** Same text as `SCHEMA` in src-tauri/src/lib.rs. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document  (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets    (id TEXT NOT NULL,      -- SHA-256
                                      level TEXT NOT NULL,   -- original | large | small | meta
                                      bytes BLOB NOT NULL,
                                      PRIMARY KEY (id, level));
`;

const APP_NAME = "r-node";
const SCHEMA_VERSION = "1";

/** Long side of the display levels (same values the image pipeline uses). */
const LEVEL_LONG_SIDE: Record<Exclude<AssetLevel, "original">, number> = { large: 1024, small: 256 };

const LEVELS: readonly AssetLevel[] = ["original", "large", "small"];

/** "SQLite format 3\0" — the first 16 bytes of every SQLite database. */
const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

export function isSqliteFile(head: Uint8Array): boolean {
  if (head.length < SQLITE_MAGIC.length) return false;
  return SQLITE_MAGIC.every((b, i) => head[i] === b);
}

let sqlPromise: Promise<SqlJsStatic> | null = null;

/**
 * The SQLite engine, loaded once. The `?url` import makes Vite emit the WASM
 * as an asset next to the bundle, so a self-hosted build serves it from its
 * own origin — no CDN. Tests pass their own engine instead (node has no Vite).
 */
function loadSql(): Promise<SqlJsStatic> {
  sqlPromise ??= (async () => {
    const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
      import("sql.js"),
      import("sql.js/dist/sql-wasm-browser.wasm?url"),
    ]);
    return initSqlJs({ locateFile: () => wasmUrl });
  })().catch((e) => {
    sqlPromise = null; // a failed fetch must not poison every later attempt
    throw e;
  });
  return sqlPromise;
}

/**
 * Test seam: node has no Vite to resolve the `?url` WASM import, so tests
 * hand in an engine they initialised themselves (`initSqlJs()` finds the
 * WASM next to the module in node). Every later load returns it.
 */
export function setSqlEngine(sql: SqlJsStatic): void {
  sqlPromise = Promise.resolve(sql);
}

export interface RnodeFileHooks {
  /** Abort between assets; the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Fraction (0..1) of the referenced assets processed so far. */
  onProgress?: (fraction: number) => void;
  /** Injected engine (tests). Defaults to the lazily loaded sql.js. */
  sql?: SqlJsStatic;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof DOMException !== "undefined") throw new DOMException("Operation aborted", "AbortError");
  const e = new Error("Operation aborted");
  e.name = "AbortError";
  throw e;
}

/**
 * Pixel size of a display level, derived from the original's size the same
 * way the levels were made (long side capped, never upscaled). The IndexedDB
 * record wants a w/h per level; the `.rnode` stores only bytes, and decoding
 * every image on open just to measure it would cost more than the open.
 */
function levelSize(meta: AssetMeta, level: AssetLevel): { w: number; h: number } {
  if (level === "original") return { w: meta.w, h: meta.h };
  const scale = Math.min(1, LEVEL_LONG_SIDE[level] / Math.max(meta.w, meta.h, 1));
  return { w: Math.max(1, Math.round(meta.w * scale)), h: Math.max(1, Math.round(meta.h * scale)) };
}

export interface BuiltRnodeFile {
  bytes: Uint8Array;
  /** Referenced assets that could not be written (missing from the store). */
  skipped: number;
}

/**
 * Build a `.rnode` file for one document: the document row plus every
 * referenced asset (three levels + the meta card), exactly what the desktop
 * "Save as…" copies into a new file.
 */
export async function buildRnodeFile(
  doc: RnodeDocument,
  sheet: Sheet,
  store: AssetStore,
  hooks: RnodeFileHooks = {}
): Promise<BuiltRnodeFile> {
  const SQL = hooks.sql ?? (await loadSql());
  const db = new SQL.Database();
  try {
    db.exec(SCHEMA);
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('app', ?), ('schemaVersion', ?)", [APP_NAME, SCHEMA_VERSION]);
    db.run("INSERT INTO document (id, json) VALUES (1, ?)", [JSON.stringify(doc)]);

    const ids = [...referencedAssetIds(sheet)];
    const insert = db.prepare("INSERT OR IGNORE INTO assets (id, level, bytes) VALUES (?, ?, ?)");
    let skipped = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        throwIfAborted(hooks.signal);
        const id = ids[i];
        const [meta, ...blobs] = await Promise.all([store.meta(id), ...LEVELS.map((l) => store.get(id, l))]);
        if (!meta || blobs.some((b) => !b)) {
          skipped++; // referenced but absent: same rule as the desktop adoptFile
        } else {
          for (let l = 0; l < LEVELS.length; l++) {
            insert.run([id, LEVELS[l], new Uint8Array(await blobs[l]!.arrayBuffer())]);
          }
          insert.run([id, "meta", new TextEncoder().encode(JSON.stringify(meta))]);
        }
        hooks.onProgress?.((i + 1) / ids.length);
      }
    } finally {
      insert.free();
    }
    throwIfAborted(hooks.signal);
    return { bytes: db.export(), skipped };
  } finally {
    db.close();
  }
}

export type RnodeReadError = "not-rnode" | "invalid-json" | "incompatible-schema";

export type ReadRnodeResult =
  | { ok: true; doc: RnodeDocument; skipped: number }
  | { ok: false; error: RnodeReadError };

/**
 * Open a `.rnode` file: copy every referenced asset into `store` (under the
 * id the document already uses — content addressing, first write wins) and
 * return the document. Assets no node points to are left behind, like the
 * zip importer does.
 */
export async function readRnodeFile(
  bytes: Uint8Array,
  store: AssetStore,
  hooks: RnodeFileHooks = {}
): Promise<ReadRnodeResult> {
  if (!isSqliteFile(bytes)) return { ok: false, error: "not-rnode" };
  const SQL = hooks.sql ?? (await loadSql());
  let db: Database;
  try {
    db = new SQL.Database(bytes);
  } catch {
    return { ok: false, error: "not-rnode" };
  }
  try {
    let json: string | null = null;
    try {
      const rows = db.exec("SELECT json FROM document WHERE id = 1");
      json = (rows[0]?.values[0]?.[0] as string | undefined) ?? null;
    } catch {
      return { ok: false, error: "not-rnode" }; // SQLite, but no R-node tables
    }
    if (json == null) return { ok: false, error: "not-rnode" };

    let doc: RnodeDocument;
    try {
      doc = JSON.parse(json) as RnodeDocument;
    } catch {
      return { ok: false, error: "invalid-json" };
    }
    const sheet = Array.isArray(doc?.sheets) ? doc.sheets[0] : undefined;
    if (!sheet) return { ok: false, error: "incompatible-schema" };

    const ids = [...referencedAssetIds(sheet)];
    const select = db.prepare("SELECT level, bytes FROM assets WHERE id = ?");
    let skipped = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        throwIfAborted(hooks.signal);
        const id = ids[i];
        const found = new Map<string, Uint8Array>();
        select.bind([id]);
        while (select.step()) {
          const [level, data] = select.get() as [string, Uint8Array];
          found.set(level, data);
        }
        select.reset();

        const metaBytes = found.get("meta");
        if (!metaBytes || LEVELS.some((l) => !found.get(l)?.byteLength)) {
          skipped++;
        } else {
          const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as AssetMeta;
          const levels = {} as Record<AssetLevel, AssetBlob>;
          for (const l of LEVELS) {
            levels[l] = { blob: new Blob([found.get(l)!.slice().buffer], { type: meta.mime }), ...levelSize(meta, l) };
          }
          await store.putUnderId(id, levels, { ...meta, id });
        }
        hooks.onProgress?.((i + 1) / ids.length);
      }
    } finally {
      select.free();
    }
    return { ok: true, doc, skipped };
  } finally {
    db.close();
  }
}
