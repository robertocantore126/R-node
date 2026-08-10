# R-mind

A cross-platform visual thinking and mind-mapping workspace. Phase 1 (core
editor) is implemented and running: document model, operation system with
undo/redo, canvas renderer, mind-map layout, keyboard-first editing,
drag-and-drop, outliner, inspector, command palette, autosave, JSON/Markdown/
PNG export.

> Brand, design system and code are original. This project does not use or
> copy Xmind assets, icons, text, or layouts.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest (20 tests)
npm run typecheck  # tsc --noEmit
npm run build      # production build
```

## Controls

| Keys | Action |
|---|---|
| Enter / Tab / Shift+Tab | sibling / child / promote |
| Arrows | navigate |
| F2 / double-click | edit topic |
| Space | collapse / expand |
| Delete | delete branch |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Ctrl+D | duplicate |
| Ctrl+C / V / X | copy / paste / cut |
| Ctrl+K | command palette |
| Ctrl+F | search documents |
| Ctrl+E | export JSON |
| Ctrl+T | theme |
| Ctrl+1 / Ctrl+= / Ctrl+- | fit / zoom in / zoom out |
| Ctrl+Shift+F | Zen mode |
| Drag | move / reparent (drop indicator shows child vs sibling) |
| Scroll / Ctrl+scroll / middle-drag | pan / zoom / pan |

## Architecture

See `docs/ARCHITECTURE.md` for the full 12-point design (PRD, information
architecture, component tree, schema, API, sync strategy, layout strategy,
import/export, security, phases, risks, assumptions).

Layers (all framework-free except the React UI):

```
core/     schema + document model + operation system + history
layout/   mind-map / tree / logic placement (pure math)
render/   camera, canvas renderer, themes, hit-test, PNG export
editor/   store (orchestration), shortcuts, context
persist/  storage adapters (localStorage now; IndexedDB, SQLite next)
ui/       React shell: canvas, sidebar, topbar, outliner, inspector, palette
```

## Desktop (Tauri 2 + Rust)

The `src-tauri/` shell is scaffolded and ready — it adds SQLite persistence
for the same JSON documents, exposed via `list_documents` / `load_document` /
`save_document` / `delete_document` commands. It is **not compiled yet**
because Rust isn't installed on this machine.

To enable it:

```bash
# 1. Install Rust (https://rustup.rs) — per-user, no admin needed
rustup default stable
# 2. Install the Tauri CLI
cargo install tauri-cli --locked
# 3. From r-mind/:
npm install
cargo tauri dev
```

Then the frontend's `TauriStorageAdapter` (in `src/persist/storage.ts`) can be
swapped in to persist through SQLite instead of localStorage. Icons for
`tauri build` bundling still need to be added (`bundle.active` is false until
then).

## Roadmap

- **Phase 1 (done):** core editor as described above.
- **Phase 2:** themes/styles, markers, labels, rich notes, boundaries,
  summaries, relationships UI, callouts, attachments.
- **Phase 3:** logic/tree/org/timeline/fishbone/matrix/treetable/mixed.
- **Phase 4:** Gantt, search+, templates, presentation mode, Zen polish.
- **Phase 5:** accounts, sharing, real-time ops sync, version history.
- **Phase 6:** AI provider abstraction (map-from-prompt, summarize, expand,
  restructure, tasks, chat) with privacy controls.
- **Phase 7:** full import/export, plugins, mobile clients.
