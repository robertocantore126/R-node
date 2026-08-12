//! R-node desktop backend.
//!
//! Phase 1 of the Rust side: SQLite persistence for the same JSON document
//! schema the TS core uses, exposed as Tauri commands. The frontend keeps
//! using its StorageAdapter; the Tauri adapter (`persist/storage.ts`) will
//! call these commands instead of localStorage.
//!
//! Later phases move the document engine (ops, layout, export) into Rust and
//! expose it through the same command surface.

use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct Db(Mutex<Connection>);

#[derive(Serialize)]
struct DocMeta {
    document_id: String,
    title: String,
    updated_at: String,
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create data dir: {e}"))?;
    let conn = Connection::open(dir.join("r-node.sqlite3")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS documents (
            document_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
fn list_documents(state: State<Db>) -> Result<Vec<DocMeta>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT document_id, json_extract(data, '$.title'), updated_at FROM documents ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DocMeta {
                document_id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn load_document(state: State<Db>, document_id: String) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT data FROM documents WHERE document_id = ?1",
        [document_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_document(state: State<Db>, document_id: String, data: String, updated_at: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO documents (document_id, data, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(document_id) DO UPDATE SET data = ?2, updated_at = ?3",
        [&document_id, &data, &updated_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_document(state: State<Db>, document_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM documents WHERE document_id = ?1", [document_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// A path segment from the frontend must never escape the assets tree.
/// Ids are hex SHA-256 and levels come from our own enum, but a hostile or
/// corrupt caller must not be able to write outside the chosen folder.
fn safe_component(part: &str) -> Result<(), String> {
    if part.is_empty()
        || part == "."
        || part == ".."
        || part.contains(['/', '\\', '\0'])
        || part.contains("..")
    {
        return Err(format!("unsafe path component: {part:?}"));
    }
    Ok(())
}

/// Where assets live inside a document folder: `<root>/assets/<id>/<level>`.
/// `root` is explicit and user-chosen (T19): Rust keeps no hidden state, a
/// wrong root is a bug visible in the call, not a desynced app-data dir.
fn assets_dir(root: &str) -> PathBuf {
    PathBuf::from(root).join("assets")
}

#[tauri::command]
fn put_asset(root: String, id: String, level: String, bytes: Vec<u8>) -> Result<(), String> {
    safe_component(&id)?;
    safe_component(&level)?;
    let file = assets_dir(&root).join(&id).join(&level);
    let parent = file.parent().ok_or("no parent dir")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    fs::write(&file, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_asset(root: String, id: String, level: String) -> Result<Option<Vec<u8>>, String> {
    safe_component(&id)?;
    safe_component(&level)?;
    let file = assets_dir(&root).join(&id).join(&level);
    if !file.is_file() {
        return Ok(None); // the AssetStore contract: get of a missing id -> null
    }
    fs::read(&file).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_asset(root: String, id: String) -> Result<(), String> {
    safe_component(&id)?;
    let dir = assets_dir(&root).join(&id);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_assets(root: String) -> Result<Vec<String>, String> {
    let dir = assets_dir(&root);
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                out.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// The default working root before a document folder is chosen: the app-data
/// assets dir. Attaching an image before the first save lands here; the first
/// "Save as…" then copies everything into the chosen folder.
#[tauri::command]
fn default_asset_root(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(dir.join("assets").to_string_lossy().into_owned())
}

/// Native folder picker (rfd): the desktop open/save-as entry point. The
/// frontend never synthesizes paths for the user's documents.
#[tauri::command]
fn pick_document_folder() -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Choose the R-node document folder")
        .pick_folder();
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

/// Read `<root>/document.json`, or None when the folder has none.
#[tauri::command]
fn read_document(root: String) -> Result<Option<String>, String> {
    let file = PathBuf::from(&root).join("document.json");
    if !file.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&file).map(Some).map_err(|e| e.to_string())
}

/// Write `<root>/document.json`, creating the folder if needed. Only the
/// document is rewritten on save: the assets are written once, at import.
#[tauri::command]
fn write_document(root: String, data: String) -> Result<(), String> {
    let dir = PathBuf::from(&root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("document.json"), data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = open_db(app.handle())?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_documents,
            load_document,
            save_document,
            delete_document,
            put_asset,
            get_asset,
            delete_asset,
            list_assets,
            default_asset_root,
            pick_document_folder,
            read_document,
            write_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running r-node");
}
