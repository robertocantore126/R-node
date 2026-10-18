import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentModel } from "../src/core/doc";
import { EditorStore } from "../src/editor/store";
import { applyLayout } from "../src/layout/mindmap";
import { slotKey } from "../src/core/ops";
import type { RnodeDocument } from "../src/core/types";
import { IndexedDbAssetStore, type AssetBlob, type AssetLevel, type AssetMeta } from "../src/persist/assets";
import { buildRnodeFile, isSqliteFile, readRnodeFile } from "../src/persist/rnodeFile";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let dbCounter = 0;
function freshStore(): IndexedDbAssetStore {
  dbCounter += 1;
  return new IndexedDbAssetStore(`rnode-file-test-${dbCounter}`);
}

function levels(tag: string): Record<AssetLevel, AssetBlob> {
  return {
    original: { blob: new Blob([`ORIGINAL-${tag}`], { type: "image/png" }), w: 2048, h: 1024 },
    large: { blob: new Blob([`LARGE-${tag}`], { type: "image/png" }), w: 1024, h: 512 },
    small: { blob: new Blob([`SMALL-${tag}`], { type: "image/png" }), w: 256, h: 128 },
  };
}

/** A blank map whose root shows one image, stored in `store`. */
async function docWithImage(store: IndexedDbAssetStore): Promise<{ doc: RnodeDocument; id: string; meta: AssetMeta }> {
  const doc = DocumentModel.blank("Mappa con immagine");
  const sheet = doc.sheets[0];
  const id = await store.put(levels("a"), { mime: "image/png", w: 2048, h: 1024, bytes: 10, name: "foto.png" });
  const meta = (await store.meta(id))!;
  sheet.attachments.push({ ...meta });
  (sheet.nodes[sheet.rootNodeId].style as Record<string, unknown>)[slotKey("top")] = id;
  return { doc, id, meta };
}

describe(".rnode file in the browser", () => {
  it("round-trips a freeform diagram with local geometry, links, notes and image bytes", async () => {
    const assets = freshStore();
    const imageId = await assets.put(levels("freeform"), {mime:"image/png", w:2048, h:1024, bytes:10, name:"diagram.png"});
    const editor = new EditorStore({label:"test", async load(){return [];}, async save(){}});
    editor.createFreeformTopic(editor.sheet.rootNodeId);
    const board = editor.doc.requireNode(editor.getSnapshot().selection[0]);
    editor.sheet.attachments.push({... (await assets.meta(imageId))!});
    const a = editor.createFreeformItem(board.id,board.position.x+80,board.position.y+90,"Label")!;
    const b = editor.createFreeformItem(board.id,board.position.x+280,board.position.y+180,"",imageId)!;
    editor.doc.requireNode(b).notes = "Important diagram notes";
    editor.createRelationship(a,b);
    const {bytes} = await buildRnodeFile(editor.doc.doc,editor.sheet,assets,{sql:SQL});
    const restoredAssets = freshStore();
    const restored = await readRnodeFile(bytes,restoredAssets,{sql:SQL});
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("Freeform file could not be read");
    const sheet = restored.doc.sheets[0]; applyLayout(sheet,true);
    expect(sheet.nodes[board.id].style.freeform).toBe(true);
    expect(sheet.nodes[a].position.x-sheet.nodes[board.id].position.x).toBe(80);
    expect(sheet.nodes[b].position.y-sheet.nodes[board.id].position.y).toBe(180);
    expect(sheet.nodes[b].notes).toBe("Important diagram notes");
    expect(sheet.relationships.some((r)=>r.fromId===a && r.toId===b)).toBe(true);
    expect(sheet.nodes[b].style.image).toBe(imageId);
    expect(await (await restoredAssets.get(imageId,"original"))!.text()).toBe("ORIGINAL-freeform");
  });

  it("writes the same schema the desktop backend creates", async () => {
    // The two sides must agree on the tables byte for byte: lib.rs owns the
    // format, so its SCHEMA constant is the reference this file is held to.
    // CRLF only exists in a Windows checkout: the compiled constant (and every
    // desktop file seen so far) carries LF.
    const rust = readFileSync(resolve(__dirname, "../src-tauri/src/lib.rs"), "utf8").replace(/\r\n/g, "\n");
    const rustSchema = /const SCHEMA: &str = "([\s\S]*?)";/.exec(rust)?.[1];
    expect(rustSchema).toBeTruthy();

    const store = freshStore();
    const { doc } = await docWithImage(store);
    const { bytes } = await buildRnodeFile(doc, doc.sheets[0], store, { sql: SQL });

    const reference = new SQL.Database();
    reference.exec(rustSchema!);
    const tables = (db: InstanceType<SqlJsStatic["Database"]>): unknown[][] =>
      db.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")[0].values;
    const written = new SQL.Database(bytes);
    expect(tables(written)).toEqual(tables(reference));
    expect(written.exec("SELECT key, value FROM meta ORDER BY key")[0].values).toEqual([
      ["app", "r-node"],
      ["schemaVersion", "1"],
    ]);
    expect(written.exec("PRAGMA integrity_check")[0].values).toEqual([["ok"]]);
    written.close();
    reference.close();
  });

  it("round-trips the document and every image level", async () => {
    const source = freshStore();
    const { doc, id, meta } = await docWithImage(source);
    const { bytes, skipped } = await buildRnodeFile(doc, doc.sheets[0], source, { sql: SQL });
    expect(skipped).toBe(0);
    expect(isSqliteFile(bytes)).toBe(true);

    const target = freshStore();
    const result = await readRnodeFile(bytes, target, { sql: SQL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual(doc);
    expect(result.skipped).toBe(0);
    for (const level of ["original", "large", "small"] as const) {
      expect(await (await target.get(id, level))!.text()).toBe(`${level.toUpperCase()}-a`);
    }
    expect(await target.meta(id)).toEqual(meta);
  });

  it("stores the rows the desktop reads: document JSON and one row per level", async () => {
    const store = freshStore();
    const { doc, id } = await docWithImage(store);
    const { bytes } = await buildRnodeFile(doc, doc.sheets[0], store, { sql: SQL });
    const db = new SQL.Database(bytes);
    expect(JSON.parse(db.exec("SELECT json FROM document WHERE id = 1")[0].values[0][0] as string)).toEqual(doc);
    expect(db.exec("SELECT id, level FROM assets ORDER BY level")[0].values).toEqual([
      [id, "large"],
      [id, "meta"],
      [id, "original"],
      [id, "small"],
    ]);
    db.close();
  });

  it("counts a referenced image missing from the store instead of failing the save", async () => {
    const store = freshStore();
    const { doc } = await docWithImage(store);
    (doc.sheets[0].nodes[doc.sheets[0].rootNodeId].style as Record<string, unknown>)[slotKey("bottom")] = "f".repeat(64);
    const { bytes, skipped } = await buildRnodeFile(doc, doc.sheets[0], store, { sql: SQL });
    expect(skipped).toBe(1);
    const result = await readRnodeFile(bytes, freshStore(), { sql: SQL });
    expect(result.ok && result.skipped).toBe(1);
  });

  it("rejects files that are not R-node documents", async () => {
    const store = freshStore();
    expect(await readRnodeFile(new TextEncoder().encode("not sqlite at all"), store, { sql: SQL })).toEqual({
      ok: false,
      error: "not-rnode",
    });
    const other = new SQL.Database();
    other.exec("CREATE TABLE notes (t TEXT)");
    expect(await readRnodeFile(other.export(), store, { sql: SQL })).toEqual({ ok: false, error: "not-rnode" });
    other.close();

    const badJson = new SQL.Database();
    badJson.exec("CREATE TABLE document (id INTEGER PRIMARY KEY, json TEXT NOT NULL); INSERT INTO document VALUES (1, '{oops');");
    expect(await readRnodeFile(badJson.export(), store, { sql: SQL })).toEqual({ ok: false, error: "invalid-json" });
    badJson.close();
  });

  it("stops between images when the save is cancelled", async () => {
    const store = freshStore();
    const { doc } = await docWithImage(store);
    const ac = new AbortController();
    ac.abort();
    await expect(buildRnodeFile(doc, doc.sheets[0], store, { sql: SQL, signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
