<img width="189" height="189" alt="6a357c99-15ea-4ef6-b917-cac1fe279918-remove-bg-io" src="https://github.com/user-attachments/assets/5f3b0327-59a9-4e8d-92f9-141164861046" />
# R-mind

**A cross-platform visual thinking and mind-mapping workspace.**

R-mind is a keyboard-first mind-mapping application designed for brainstorming,
knowledge organization, project planning and presentations. It is built
original from the ground up — brand, design system and code are our own, and
nothing is copied from other mind-mapping products.

- **Fast** — single-canvas rendering, no DOM or SVG element per topic; smooth
  at 10,000+ topics.
- **Keyboard-first** — Enter/Tab/Shift+Tab to create and structure topics,
  arrows to navigate, every action undoable.
- **Local-first** — documents autosave to your browser; a desktop build with
  SQLite persistence is scaffolded and ready.
- **Extensible by design** — a pure, framework-free core (document model,
  operation system, layout engine) that web, desktop and mobile clients share.

---

## Status

**Phase 1 (core editor) — implemented and tested.** 45 unit tests passing,
typecheck clean, performance-verified at 10k topics.

| | |
|---|---|
| Document model | versioned JSON schema, tree with stable IDs, multi-sheet schema (first sheet active) |
| Operation system | every edit is an idempotent, replayable op with an inverse — undo/redo for free, collaboration-ready |
| Rendering | single `<canvas>`, viewport culling, shapes, curved connectors, relationships, PNG export |
| Layout | mind map with balanced branches, exact measured extents, no overlap by construction |
| Editing | create / sibling / child / promote, rename, delete, duplicate, copy/paste/cut, drag-and-drop reparenting |
| Structure ops | collapse/expand, sort siblings, tasks, notes, styles, relationships |
| Workspace | outliner, inspector, command palette, search, themes, Zen mode, autosave |
| Import/export | JSON, Markdown, PNG |

---

## Quick start

Requirements: [Node.js](https://nodejs.org) 18+ (npm).

```bash
npm install
npm run dev        # start dev server → http://localhost:5173
npm test           # run the test suite (vitest)
npm run typecheck  # TypeScript check only
npm run build      # typecheck + production build → dist/
```

Open `http://localhost:5173` and start typing — select the central topic and
press **Tab** to add the first branch. The sample roadmap document shows the
main interactions.

### Keyboard reference

| Keys | Action |
|---|---|
| `Enter` | create sibling topic |
| `Tab` | create child topic |
| `Shift+Tab` | promote topic (move up a level) |
| `Arrow keys` | navigate between topics |
| `F2` / double-click | edit topic text |
| `Space` | collapse / expand branch |
| `Delete` / `Backspace` | delete branch |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | undo / redo |
| `Ctrl/Cmd+D` | duplicate topic |
| `Ctrl/Cmd+C` / `X` / `V` | copy / cut / paste |
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+F` | search |
| `Ctrl/Cmd+S` | save now |
| `Ctrl/Cmd+E` | export JSON |
| `Ctrl/Cmd+Enter` | toggle task complete |
| `Ctrl/Cmd+T` | toggle theme (dark/light) |
| `Ctrl/Cmd+1` / `0` | fit map to view / reset zoom |
| `Ctrl/Cmd+=` / `-` | zoom in / out |
| `Ctrl/Cmd+Shift+F` | Zen (focus) mode |
| `Escape` | close editor / clear selection |
| Drag | move / reparent (drop indicator shows child vs sibling) |
| Scroll / `Ctrl+scroll` / middle-drag | pan / zoom / pan |

Shortcuts live in a single profile object (`src/editor/shortcuts.ts`) so they
can be rebound without touching the editor logic.

---

## Architecture

See `docs/ARCHITECTURE.md` for the full design document (PRD, information
architecture, schema, API design, sync strategy, layout strategy,
import/export, security model, phased plan, risk register, open decisions).

The code is split into clean, framework-free layers — only the UI uses React:

```
src/
├── core/      document schema, model + tree walks, operation system, history
├── layout/    measurement + placement engines (pure math, fully testable)
├── render/    camera/viewport, canvas renderer, themes, hit-testing, PNG export
├── editor/    store (orchestration), keyboard shortcuts, context, export bridge
├── persist/   storage adapters (localStorage now; IndexedDB, SQLite next)
└── ui/        React shell: canvas, sidebar, topbar, outliner, inspector, palette
```

### Document model & operations

The editor never mutates the document directly. Every change is an **Op**:

```ts
{ opId, actorId, ts, type, ...payload }
```

Ops are self-contained, idempotent and carry everything needed to reverse
themselves. The store applies them through a history layer that batches
multi-step gestures (e.g. create + rename) into a single undo step. Because
every edit is already an op with an actor and timestamp, the same stream is
the future synchronization unit (OT/CRDT) — no rewrite needed when
collaboration lands.

### Layout engine

Pure functions in `src/layout/`:

- **Shared measurement** — one measurer (canvas-backed in the app, a
  deterministic heuristic in tests) drives both layout and paint, so a topic
  can never be sized differently by the two.
- **Subtree blocks** — every topic's extent is its own box plus its
  descendants; collapsed branches count as leaves.
- **Straddle distribution** — children split above/below the parent box,
  balanced by block height, with guaranteed gaps: no overlaps, ever.
- **Size-aware balance** — root branches split left/right by subtree height,
  not raw count.
- **Upward propagation** — any deep change recomputes the map (debounced) and
  rebalances up to the root.

Manual positions are preserved; layout is derived data and never pollutes
undo history.

### Performance

Verified with a permanent perf suite (`tests/perf.test.ts`) and live browser
measurements at 10k topics: ops are linear (~0.004 ms/op), layout ~11 ms,
full generation + paint ~242 ms, sustained rendering ~9 ms/frame even at
minimum zoom. The real constraint at scale is storage (a 10k map is ~3.6 MB
in localStorage), which is exactly what the IndexedDB/SQLite adapters solve.

---

## Desktop app (Tauri 2 + Rust)

The `src-tauri/` shell is scaffolded and ready — it adds SQLite persistence
for the same JSON documents, exposed to the frontend as
`list_documents` / `load_document` / `save_document` / `delete_document`.
It is **not compiled yet** because Rust isn't installed on this machine.

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

Then swap in `TauriStorageAdapter` (in `src/persist/storage.ts`) to persist
through SQLite instead of localStorage. Bundle icons for `tauri build` still
need to be added (`bundle.active` is false until then).

---

## Testing

```bash
npm test
```

45 tests across 6 suites: document operations, undo/redo round-trips,
reparenting and subtree moves, layout geometry (no-overlap, straddle,
size-aware balance, upward propagation), measurement math, viewport math,
and performance ceilings at 1k/5k/10k topics.

---

## Roadmap

- **Phase 1 — Core editor (done):** document model, ops + undo/redo, canvas
  renderer, mind-map layout, keyboard + mouse editing, drag-and-drop,
  outliner, inspector, palette, autosave, JSON/Markdown/PNG export.
- **Phase 2 — Visual richness:** themes/styles polish, markers, labels, rich
  notes, boundaries, summaries, relationships UI, callouts, attachments.
- **Phase 3 — Structures:** logic chart, tree chart, org chart, timeline,
  fishbone/Ishikawa, matrix, tree table, mixed structures.
- **Phase 4 — Productivity:** Gantt, full-text search+, templates,
  presentation mode, Zen polish, incremental layout (stable positions for
  untouched branches).
- **Phase 5 — Collaboration:** accounts, sharing, comments, real-time op
  sync, version history, offline sync.
- **Phase 6 — AI:** provider abstraction, map-from-prompt/text, expand,
  summarize, restructure, task extraction, map chat — with previews, diffs
  and privacy controls.
- **Phase 7 — Ecosystem:** full import/export (SVG, PDF, DOCX, PPTX, OPML,
  FreeMind…), plugins, mobile clients.

Each phase ends with working code, tests, docs, accessibility + performance
checks, and a list of known limitations.
