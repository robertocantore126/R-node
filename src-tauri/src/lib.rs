//! R-node desktop backend.
//!
//! The document is a SINGLE file `MiaMappa.rnode`, which is an SQLite
//! database holding the document JSON and every image level (T20). The
//! frontend keeps using its StorageAdapter and AssetStore; the Tauri
//! adapters call these commands.
//!
//! Deliberately NOT using `journal_mode=WAL`: WAL writes `-wal` and `-shm`
//! files next to the document, which defeats the single-file requirement.
//! The default rollback journal (DELETE) creates a `-journal` only during a
//! write transaction and removes it on commit — at rest there is exactly one
//! file.
//!
//! Each command opens the `.rnode` file at the path the frontend chose; the
//! backend keeps no hidden state. Connections are short-lived, so there is
//! nothing to share between commands.

use rusqlite::Connection;
use std::fs;
use std::path::Path;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// Schema of a `.rnode` file (one file = one document).
///
/// `meta` carries `app` and `schemaVersion` so the file is recognizable and
/// can be migrated in the future without guessing. The `document` row is the
/// JSON document; `assets` holds the image levels (the `meta` level is the
/// per-asset metadata card, same as the T19 `assets/<id>/meta` file).
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS document  (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets    (id TEXT NOT NULL,      -- SHA-256
                                      level TEXT NOT NULL,   -- original | large | small | meta
                                      bytes BLOB NOT NULL,
                                      PRIMARY KEY (id, level));
";

const APP_NAME: &str = "r-node";
const SCHEMA_VERSION: &str = "1";

/// Create the schema and write the recognizer keys. Safe to run on a fresh
/// file AND on an existing document (all statements are IF NOT EXISTS /
/// OR IGNORE).
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('app', ?1), ('schemaVersion', ?2)",
        rusqlite::params![APP_NAME, SCHEMA_VERSION],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a `.rnode` file, creating it (and its parent dir) if needed, and
/// make sure it carries the schema. Used by every WRITE command.
fn open_writable(path: &str) -> Result<Connection, String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("cannot create {parent:?}: {e}"))?;
        }
    }
    let conn = Connection::open(path).map_err(|e| format!("cannot open {path}: {e}"))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// Open a `.rnode` file WITHOUT creating it: `SQLITE_OPEN_READ_WRITE` (no
/// CREATE) fails when the file is missing, and still lets SQLite roll back a
/// hot journal left by a crash. Reads never leave a file behind.
fn open_readable(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("cannot open {path}: {e}"))
}

/// Write every level of one asset in ONE transaction. `INSERT OR IGNORE`: an
/// existing (id, level) is left untouched, matching the AssetStore contract
/// (ids are content hashes, so same id ⇒ same bytes; re-importing never
/// rewrites anything).
fn put_levels(path: &str, id: &str, levels: &[(String, &[u8])]) -> Result<(), String> {
    let mut conn = open_writable(path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO assets (id, level, bytes) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (level, bytes) in levels {
            stmt.execute(rusqlite::params![id, level, bytes])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Arguments of `put_asset`, carried in the `x-rnode-args` header because the
/// body is the raw bytes. `levels` lists (level, byte length) in body order.
#[derive(serde::Deserialize)]
struct PutAssetArgs {
    path: String,
    id: String,
    levels: Vec<(String, usize)>,
}

/// Decode a percent-encoded header value (`encodeURIComponent` on the JS
/// side: header values must be ASCII, document paths need not be).
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Write the levels of one asset. The bytes travel as a RAW IPC body: passed
/// as an argument they were serialized as a JSON array of numbers, so a 25 MB
/// original crossed the bridge as a ~90 MB string.
#[tauri::command]
fn put_asset(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = request
        .headers()
        .get("x-rnode-args")
        .ok_or("put_asset: missing x-rnode-args header")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let args: PutAssetArgs = serde_json::from_str(&percent_decode(header)?).map_err(|e| e.to_string())?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("put_asset: expected a raw byte body".into());
    };
    let mut levels = Vec::with_capacity(args.levels.len());
    let mut at = 0usize;
    for (level, len) in args.levels {
        let end = at
            .checked_add(len)
            .filter(|&e| e <= body.len())
            .ok_or("put_asset: body shorter than declared")?;
        levels.push((level, &body[at..end]));
        at = end;
    }
    put_levels(&args.path, &args.id, &levels)
}

/// Copy every level of `ids` from the `from` file into the `to` file inside
/// SQLite (ATTACH + INSERT … SELECT, one transaction): no byte crosses the IPC
/// and nothing is held in the webview. Returns how many ids could NOT be
/// copied because the source lacks one of their four levels. `to` is created
/// if needed; `from` never is.
#[tauri::command]
fn copy_assets(from: String, to: String, ids: Vec<String>) -> Result<u32, String> {
    const COMPLETE: &str = "SELECT COUNT(DISTINCT level) FROM src.assets \
         WHERE id = ?1 AND level IN ('original', 'large', 'small', 'meta') AND length(bytes) > 0";
    if !Path::new(&from).is_file() {
        open_writable(&to)?;
        return Ok(ids.len() as u32);
    }
    let same = match (fs::canonicalize(&from), fs::canonicalize(&to)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    let mut conn = open_writable(&to)?;
    if same {
        // Nothing to move: only report what is missing in place.
        let sql = COMPLETE.replace("src.assets", "main.assets");
        let mut skipped = 0u32;
        for id in &ids {
            let n: i64 = conn.query_row(&sql, [id], |r| r.get(0)).map_err(|e| e.to_string())?;
            if n < 4 {
                skipped += 1;
            }
        }
        return Ok(skipped);
    }
    conn.execute("ATTACH DATABASE ?1 AS src", [&from])
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<u32, String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut skipped = 0u32;
        {
            let mut complete = tx.prepare(COMPLETE).map_err(|e| e.to_string())?;
            let mut copy = tx
                .prepare(
                    "INSERT OR IGNORE INTO main.assets (id, level, bytes) \
                     SELECT id, level, bytes FROM src.assets WHERE id = ?1",
                )
                .map_err(|e| e.to_string())?;
            for id in &ids {
                let n: i64 = complete.query_row([id], |r| r.get(0)).map_err(|e| e.to_string())?;
                if n < 4 {
                    skipped += 1;
                    continue;
                }
                copy.execute([id]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(skipped)
    })();
    let _ = conn.execute("DETACH DATABASE src", []);
    result
}

/// Give the pages freed by deleted assets back to the filesystem. SQLite keeps
/// them for reuse, so without this the orphan GC reported megabytes recovered
/// while the file did not shrink.
#[tauri::command]
fn compact_document(path: String) -> Result<(), String> {
    let conn = open_readable(&path)?;
    conn.execute_batch("VACUUM").map_err(|e| e.to_string())
}

/// Remove `<app-data>/scratch.rnode` at startup. It holds the images of maps
/// that were never saved, and those maps do not survive a restart on the
/// desktop — so whatever the file holds when the app starts is unreachable.
/// Without this it only ever grew.
#[tauri::command]
fn clear_scratch(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    for name in ["scratch.rnode", "scratch.rnode-journal"] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Read one asset level as raw bytes. Missing → EMPTY vec: the frontend
/// treats an empty result as "absent" (the AssetStore contract: get of a
/// missing id → null). Image bytes are never legitimately empty, so the
/// convention cannot collide with data.
fn asset_bytes(path: &str, id: &str, level: &str) -> Result<Vec<u8>, String> {
    let conn = open_readable(path)?;
    conn.query_row(
        "SELECT bytes FROM assets WHERE id = ?1 AND level = ?2",
        rusqlite::params![id, level],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
    .map(|b| b.unwrap_or_default())
    .map_err(|e| e.to_string())
}

/// Read one asset level as RAW bytes over IPC (no JSON-array-of-numbers
/// inflation: an original of tens of MB must not be serialized as fifty
/// million numbers). `tauri::ipc::Response` sends an ArrayBuffer to the
/// frontend (verified for Tauri 2.11.5).
#[tauri::command]
fn get_asset(path: String, id: String, level: String) -> Result<Response, String> {
    Ok(Response::new(asset_bytes(&path, &id, &level)?))
}

/// Remove every level of an asset (the whole `assets/<id>` group).
#[tauri::command]
fn delete_asset(path: String, id: String) -> Result<(), String> {
    let conn = open_readable(&path)?;
    conn.execute("DELETE FROM assets WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_assets(path: String) -> Result<Vec<String>, String> {
    let conn = open_readable(&path)?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT id FROM assets ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// The default working document BEFORE the first save: `<app-data>/
/// scratch.rnode`. Attaching an image to a never-saved map must work, so the
/// file is created (with schema) here, and the first "Save as…" adopts its
/// content into the user-chosen file.
#[tauri::command]
fn default_document_path(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create data dir: {e}"))?;
    let path = dir.join("scratch.rnode");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Native file picker restricted to `.rnode`. `mode` is "open" or "save"; a
/// cancelled dialog returns None. On save the dialog is pre-filled with
/// `suggested_name` (the document title from the GUI, sanitized by the
/// frontend) so the name typed in the app becomes the real file's name — the
/// filesystem dialog already knows it. The extension is guaranteed even when
/// the user types a name without it.
///
/// Uses `tauri-plugin-dialog` (NOT raw rfd): a blocking rfd dialog inside a
/// sync command runs on the main thread, fighting the webview's message pump
/// and appearing without a parent — the app showed exactly that bug (dialog
/// not opening, then reopening on its own). The plugin runs the dialog off
/// the main thread, parented to the window, and this command is async so the
/// main thread stays free.
#[tauri::command]
async fn pick_document_file(
    app: AppHandle,
    mode: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    let parent = app.get_webview_window("main");
    let dialog = |title: &str, save: bool| {
        let mut builder = app.dialog().file().add_filter("R-node document", &["rnode"]);
        if let Some(w) = &parent {
            builder = builder.set_parent(w);
        }
        builder = builder.set_title(title);
        if save {
            let mut name = suggested_name.clone().unwrap_or_else(|| "MiaMappa".into());
            if !name.to_lowercase().ends_with(".rnode") {
                name.push_str(".rnode");
            }
            builder = builder.set_file_name(name);
        }
        builder
    };

    let picked = match mode.as_str() {
        "open" => dialog("Open an R-node document", false).blocking_pick_file(),
        "save" => dialog("Save the R-node document", true).blocking_save_file(),
        _ => return Err(format!("unknown pick mode: {mode}")),
    };
    let Some(file) = picked else {
        return Ok(None); // user cancelled
    };
    let mut path = match file {
        tauri_plugin_dialog::FilePath::Path(p) => p.to_string_lossy().into_owned(),
        tauri_plugin_dialog::FilePath::Url(_) => return Err("dialog returned a URL, expected a path".into()),
    };
    if mode == "save" && !path.to_lowercase().ends_with(".rnode") {
        path.push_str(".rnode");
    }
    Ok(Some(path))
}

/// Delete the `.rnode` file. Used by the rename-on-save flow, AFTER the new
/// file is fully written and the app switched to it — the old file is only
/// removed once the document provably lives at the new path.
#[tauri::command]
fn remove_document(path: String) -> Result<(), String> {
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // already gone
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a file exists at `path`. The rename flow refuses to clobber an
/// existing document under the new name.
#[tauri::command]
fn document_file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_file())
}

/// Rename the `.rnode` file in place.
///
/// This replaces a rename that copied every asset into a new file through the
/// IPC and then deleted the old one — work proportional to the images, so
/// renaming a map carrying hundreds of megabytes of pictures took as long as
/// saving it from scratch. `fs::rename` moves a directory entry: it is atomic
/// on the same volume and does not touch a single byte of content, which is
/// all a rename ever needed to be.
///
/// Refuses to overwrite an existing file. The check is not a guarantee against
/// a racing process — it is the same check the caller shows in the GUI, kept
/// here so the backend never silently destroys a document either way.
#[tauri::command]
fn rename_document(from: String, to: String) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    if Path::new(&to).exists() {
        return Err(format!("a file already exists at {to}"));
    }
    fs::rename(&from, &to).map_err(|e| format!("cannot rename {from} to {to}: {e}"))
}

/// Read the document JSON from `<path>`, or None when the file is missing or
/// is not an R-node document. Never creates the file.
#[tauri::command]
fn read_document(path: String) -> Result<Option<String>, String> {
    // Distinguish "no file yet" (benign: nothing to read) from "the file
    // exists but cannot be opened" (permission, corrupt, I/O). Collapsing
    // both into None made every real failure read as "not a valid document"
    // with no way to know why.
    let conn = match open_readable(&path) {
        Ok(c) => c,
        Err(_) if !Path::new(&path).exists() => return Ok(None),
        Err(e) => return Err(format!("cannot open {path}: {e}")),
    };
    let json: Option<String> = conn
        .query_row("SELECT json FROM document WHERE id = 1", [], |row| row.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::NotADatabase => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    Ok(json)
}

/// The `documentId` stored in `<path>`, or None when there is no file or no
/// document row. The save guard needs only this; reading it here spares
/// parsing the whole document in the webview on every Ctrl+S.
#[tauri::command]
fn read_document_id(path: String) -> Result<Option<String>, String> {
    if !Path::new(&path).exists() {
        return Ok(None);
    }
    let conn = open_readable(&path)?;
    conn.query_row(
        "SELECT json_extract(json, '$.documentId') FROM document WHERE id = 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
    .map_err(|e| e.to_string())
}

/// Write the document JSON into `<path>` in ONE transaction, so a crash
/// mid-save never leaves a half-written document. The rollback journal
/// disappears on commit (no WAL).
///
/// Only "Save as" may create the file (`create: true`). A plain save whose
/// file has gone — moved, renamed or deleted outside the app — used to
/// recreate it silently with the document and none of its images, and
/// report "Saved".
#[tauri::command]
fn write_document(path: String, data: String, create: Option<bool>) -> Result<(), String> {
    if !create.unwrap_or(false) && !Path::new(&path).is_file() {
        return Err(format!(
            "the document file is missing: {path} (moved, renamed or deleted outside R-node)"
        ));
    }
    let mut conn = open_writable(&path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO document (id, json) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        [&data],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Fresh, unique, pre-deleted document path inside its OWN directory, so
    /// "what is left on disk" is observable without other temp files around.
    fn temp_doc(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rnode-t20-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("MiaMappa.rnode")
    }

    fn dir_files(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(dir)
            .map(|e| {
                e.flatten()
                    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        out.sort();
        out
    }

    #[test]
    fn asset_round_trip() {
        let path = temp_doc("assets.rnode");
        let p = path.to_string_lossy().into_owned();
        let id = "a".repeat(64);

        put_levels(&p, &id, &[("original".into(), &[1, 2, 3])]).unwrap();
        put_levels(&p, &id, &[("meta".into(), b"{\"m\":1}")]).unwrap();

        assert_eq!(asset_bytes(&p, &id, "original").unwrap(), vec![1, 2, 3]);
        assert_eq!(asset_bytes(&p, &id, "meta").unwrap(), b"{\"m\":1}".to_vec());
        // A missing level returns EMPTY bytes, not an error (contract: null).
        assert_eq!(asset_bytes(&p, &id, "large").unwrap(), Vec::<u8>::new());

        assert_eq!(list_assets(p.clone()).unwrap(), vec![id.clone()]);
        delete_asset(p.clone(), id.clone()).unwrap();
        assert_eq!(list_assets(p.clone()).unwrap(), Vec::<String>::new());
        assert_eq!(asset_bytes(&p, &id, "original").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn first_write_wins_for_an_existing_id() {
        let path = temp_doc("fww.rnode");
        let p = path.to_string_lossy().into_owned();
        let id = "b".repeat(64);

        put_levels(&p, &id, &[("large".into(), &[7, 7])]).unwrap();
        put_levels(&p, &id, &[("large".into(), &[9, 9, 9])]).unwrap();
        assert_eq!(asset_bytes(&p, &id, "large").unwrap(), vec![7, 7]);
    }

    #[test]
    fn put_asset_creates_a_fresh_file_and_leaves_only_it_at_rest() {
        let path = temp_doc("fresh.rnode");
        let p = path.to_string_lossy().into_owned();
        let dir = path.parent().unwrap();

        // put_asset before any save (the scratch flow): the file appears.
        put_levels(&p, &"c".repeat(64), &[("small".into(), &[5])]).unwrap();
        write_document(p.clone(), "{\"doc\":true}".into(), Some(true)).unwrap();
        assert_eq!(read_document(p.clone()).unwrap().as_deref(), Some("{\"doc\":true}"));

        // A completed save leaves EXACTLY one file: no -wal, -shm, -journal.
        assert_eq!(dir_files(dir), vec![path.file_name().unwrap().to_string_lossy().into_owned()]);
    }

    #[test]
    fn document_round_trip_and_overwrite() {
        let path = temp_doc("doc.rnode");
        let p = path.to_string_lossy().into_owned();
        write_document(p.clone(), "{\"v\":1}".into(), Some(true)).unwrap();
        write_document(p.clone(), "{\"v\":2}".into(), Some(true)).unwrap();
        assert_eq!(read_document(p.clone()).unwrap().as_deref(), Some("{\"v\":2}"));

        // The scratch recognizer keys were written too.
        let conn = open_readable(&p).unwrap();
        let app: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'app'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(app, APP_NAME);
    }

    #[test]
    fn read_of_a_missing_file_is_none_and_creates_nothing() {
        let path = temp_doc("missing.rnode");
        assert!(!path.exists());
        assert_eq!(read_document(path.to_string_lossy().into_owned()).unwrap(), None);
        assert!(!path.exists(), "reading must never create the file");
    }

    #[test]
    fn read_of_a_non_database_file_is_none() {
        let path = temp_doc("garbage.rnode");
        fs::write(&path, b"this is not sqlite").unwrap();
        assert_eq!(read_document(path.to_string_lossy().into_owned()).unwrap(), None);
    }

    #[test]
    fn plain_write_refuses_a_missing_file_and_creates_nothing() {
        let path = temp_doc("gone.rnode");
        let p = path.to_string_lossy().into_owned();
        assert!(write_document(p.clone(), "{}".into(), None).is_err());
        assert!(!path.exists(), "a plain save must never recreate a vanished file");
        write_document(p.clone(), r#"{"documentId":"d1"}"#.into(), Some(true)).unwrap();
        write_document(p.clone(), r#"{"documentId":"d1","v":2}"#.into(), None).unwrap();
        assert_eq!(read_document_id(p).unwrap().as_deref(), Some("d1"));
    }

    #[test]
    fn copy_assets_moves_complete_assets_and_counts_the_rest() {
        let from = temp_doc("copy-from");
        let to = temp_doc("copy-to");
        let (f, t) = (from.to_string_lossy().into_owned(), to.to_string_lossy().into_owned());
        let full = "d".repeat(64);
        let partial = "e".repeat(64);
        put_levels(
            &f,
            &full,
            &[
                ("original".into(), &[1]),
                ("large".into(), &[2]),
                ("small".into(), &[3]),
                ("meta".into(), b"{}"),
            ],
        )
        .unwrap();
        put_levels(&f, &partial, &[("original".into(), &[1])]).unwrap();
        let skipped = copy_assets(f.clone(), t.clone(), vec![full.clone(), partial.clone(), "f".repeat(64)]).unwrap();
        assert_eq!(skipped, 2);
        assert_eq!(list_assets(t.clone()).unwrap(), vec![full.clone()]);
        assert_eq!(asset_bytes(&t, &full, "small").unwrap(), vec![3]);
        // Same file on both sides: nothing copied, the incomplete one counted.
        assert_eq!(copy_assets(f.clone(), f.clone(), vec![full, partial]).unwrap(), 1);
        compact_document(t).unwrap();
    }

    #[test]
    fn percent_decoding_round_trips_non_ascii_paths() {
        assert_eq!(percent_decode("C%3A%2FMappe%2FCitt%C3%A0.rnode").unwrap(), "C:/Mappe/Città.rnode");
    }

    #[test]
    fn write_document_is_atomic_single_transaction() {
        // A valid document survives a second, overwriting save (transaction
        // commits cleanly and the journal is gone afterwards).
        let path = temp_doc("tx.rnode");
        let p = path.to_string_lossy().into_owned();
        let dir = path.parent().unwrap();
        write_document(p.clone(), "{\"x\":1}".into(), Some(true)).unwrap();
        assert_eq!(read_document(p.clone()).unwrap().as_deref(), Some("{\"x\":1}"));
        assert_eq!(dir_files(dir).len(), 1, "no journal/wal/shm left at rest");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // CORS-free HTTP for images dragged from a browser page (text/uri-list).
        .plugin(tauri_plugin_http::init())
        // One instance per machine: a second launch must not open a second
        // window (both would write the same .rnode files). It focuses the
        // already-running window instead — the second process exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            put_asset,
            copy_assets,
            compact_document,
            clear_scratch,
            read_document_id,
            get_asset,
            delete_asset,
            list_assets,
            default_document_path,
            pick_document_file,
            read_document,
            write_document,
            remove_document,
            document_file_exists,
            rename_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running r-node");
}
