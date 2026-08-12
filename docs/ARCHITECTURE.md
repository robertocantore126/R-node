# R-node — Architecture

Status: **Phase 1 (core editor) done; node images and the desktop app
shipped.** The web and desktop targets share one codebase, one document model
and one op stream. AI services and the full security model remain explicitly
deferred per the product owner; the seams for both exist but are not built.

> This file describes the **structure and the plan**. Before changing code,
> read [AGENT_GUIDE.md](AGENT_GUIDE.md) — the invariants, the editor↔canvas
> parity contract and the definition of done — and take work from
> [ROADMAP.md](ROADMAP.md), in order.

## 1. Product requirements (v0.1 scope)

A visual thinking workspace: mind maps, trees, org charts, timelines,
matrices, freeform canvases — keyboard-first, canvas-rendered, offline-first,
multi-client (desktop Tauri, web, mobile later).

Acceptance for Phase 1:
- Create a map without reading docs.
- Enter/Tab/Shift+Tab create sibling/child/promote; typing starts immediately.
- Every edit is undoable/redoable (single gesture = single undo step).
- Maps stay readable as they grow (layout never overlaps).
- Canvas and Outliner stay synchronized.
- Saving is explicit (Ctrl+S) and nothing is silently lost: there is no
  autosave timer. `saveNow()` writes through the storage adapter AND the
  portable `.rnode.json`.
- The interface is original (no Xmind assets or pixel layouts).

## 2. Information architecture

```
Workspace (local-first, adapter-backed)
 ├── Documents (list, archived flag, pinned)
 │    └── Document (schemaVersion, title, settings, themeId)
 │         └── Sheets (multiple later; Phase 1 = one active)
 │              ├── structure config (type, orientation, spacing…)
 │              ├── nodes (Record<id, MindNode>) — tree
 │              ├── relationships (independent of hierarchy)
 │              └── (boundaries, summaries, callouts, zones… Phase 3)
 ├── Templates (sample roadmap template today)
 └── Assets (Phase 4+)
```

## 3. Component tree

```
App
 ├── Sidebar        — documents, search, create/duplicate/archive/delete
 ├── TopBar         — title, undo/redo, save status, zoom, export, palette, theme, zen
 ├── Workspace
 │    ├── CanvasArea
 │    │    ├── CanvasView   — <canvas> renderer + pointer/wheel handling
 │    │    ├── RichEditor   — the ONE Lexical overlay for the topic being edited
 │    │    └── Outliner     — synchronized indented list (bottom sheet)
 │    └── Inspector  — node style/task/notes + sheet structure controls
 ├── StatusBar      — zoom %, selection, sync, hints
 └── Palette        — command palette (Ctrl+K)
```

Engine modules (framework-free, all testable):
```
core/      types (schema) · doc (model+walks) · ops (op system) · history (undo/redo) · tree
layout/    mindmap.ts (measure, place, bounds)
render/    viewport.ts (camera) · renderer.ts (canvas paint, hit-test, PNG export) · theme.ts
editor/    store.ts (orchestration) · shortcuts.ts · context.ts · view.ts · exportBridge.ts
persist/   storage.ts (web: localStorage · desktop: one .rnode SQLite file) · assets.ts (AssetStore: IndexedDB on web, SQLite on desktop)
```

## 4. Document schema

`src/core/types.ts` is the single source of truth (versioned `SCHEMA_VERSION`).
Design rules: IDs everywhere (never indices), relationships independent of the
tree, nodes keyed by id, `position.manual` marks user-placed nodes the layout
engine must preserve. Example node carries `{ id, type, parentId, childrenIds,
title, position, style, collapsed, labels, markers, notes, task, metadata }`.

## 5. API design (editor <-> engine)

The editor never mutates the document directly. Every change is an **Op**:
`{ opId, actorId, ts, type, …payload }`. Ops are self-contained, idempotent,
and carry the data needed to reverse themselves. The store applies ops via
`applyWithInverse(sheet, op)` which returns the inverse ops; `History` keeps
batches so multi-op gestures undo in one step. The same op stream will feed
collaboration (OT/CRDT) unchanged — each op already has `actorId`/`ts`.

## 6. Synchronization strategy

Deferred to Phase 5, but prepared for:
- Ops as the unit of sync (idempotent + replayable + tagged).
- Local-first: adapter writes are the source of truth; a sync layer replays
  ops against the local document after reconnect.
- Conflict resolution policy TBD (CRDT per-node vs. OT with server ordering)
  — documented as an open decision below.

## 7. Layout-engine strategy

Pure functions in `src/layout/`:
- `measure.ts` — the single source of truth for topic extents. Pluggable
  `TextMeasurer`: the renderer injects a canvas-backed one (real `measureText`
  with caching); pure code and tests use a deterministic heuristic. `measureTopic`
  computes width/height from wrapped text, padding, shape allowances (circle is
  square, diamond/hexagon grow the box) and explicit overrides. Layout and paint
  use the SAME measurer and the SAME word-wrap, so they never disagree.
- `mindmap.ts` — `subtreeHeight` (block height; collapsed subtrees count as
  leaves) and `layoutSheet` (mindmap / logic / tree / org / timeline / freeform).
- `applyLayout` — writes positions back, never touching `manual` nodes unless
  forced. Layout is derived data, excluded from undo history.

### Layout behavior (observable model)

The engine reproduces the observable behavior of classic mind-mapping tools
(behavioral description; no proprietary code):

1. **Every topic has an extent** — `width = textWidth + padding*2 + shape`,
   `height = lines*lineHeight + padding*2 + shape`; a two-line title makes the
   topic taller.
2. **Subtree block** — a topic's block = its own extent + its descendants,
   plus sibling spacing; the block grows when any descendant grows.
3. **Straddle distribution** — children are split into an above group and a
   below group (balanced by total block height, leaning below like Xmind),
   each separated from the parent box by a guaranteed gap: `blockH =
   aboveTotal + gap + parentH + gap + belowTotal`. No child can ever overlap
   its parent, and growing a topic's own title pushes its neighbors apart.
4. **Upward propagation** — any deep change recomputes the whole map
   (full relayout on a 30 ms debounce): the branch redistributes, the root
   re-splits children left/right by subtree height (size-aware balance, not
   raw count), and the overall map area changes. Stable positions for
   untouched branches are a Phase 3 refinement (incremental layout).

Renderer: single Canvas2D with viewport culling; WebGPU/WebGL2 is the
upgrade path only if ADR-001 §12 is reopened (renderer is isolated behind
`Renderer` with hit-test + export).

## 8. Import/export strategy

Today: JSON (native `.rnode.json`), Markdown, PNG (canvas export) and
`.rnode.zip` (document + images: complete = originals, compact = display
levels only). Import: `.rnode.json` / `.rmind.json` / `.rnode.zip`, Markdown
outline, clipboard paste of JSON subtrees, and sanitized rich text from
Word / Google Docs / Draw.io. Phase 4+: SVG, PDF, DOCX, PPTX, OPML, FreeMind,
MindManager, OCR, background workers.

## 9. Security model (deferred, seams exist)

- Deferred by owner: auth, RBAC, encryption, XSS hardening (rich text comes
  with sanitization), audit logs.
- In place today: all data local, no network calls, no telemetry, XSS risk
  minimized by canvas rendering (HTML only for text editing).
- AI privacy rules (consent before upload, snapshots before transformation)
  are documented requirements for Phase 6.

## 10. Phased plan

- **Phase 1 (done):** document model, ops + undo/redo, one sheet, central/main/
  subtopic/floating, canvas renderer, keyboard + mouse, zoom/pan, drag-drop
  with drop indicator, manual save, outliner, inspector, palette, tests.
- **Images & desktop (done):** content-addressed asset store, node images
  (drop/paste, resize, byte-budgeted decode), portable `.rnode.zip`, Tauri
  bring-up, single-file `.rnode` (SQLite) desktop documents.
- **Phase 2 (in progress):** themes/styles, markers, labels, rich notes,
  boundaries, callouts — relationships UI, summaries, groups and attachments
  have already landed.
- **Phase 3:** logic/tree/org/timeline/fishbone/matrix/treetable/mixed.
- **Phase 4:** Gantt, search+, templates, presentation, Zen polish.
- **Phase 5:** accounts, sharing, comments, real-time ops sync, version history.
- **Phase 6:** AI provider abstraction + the 9 AI features.
- **Phase 7:** ecosystem: full import/export, plugins, mobile clients.

Each phase ends with: working code, tests, docs, accessibility + performance
check, known limitations.

## 11. Risk register

| Risk | Mitigation |
|---|---|
| Canvas2D perf at 10k nodes | Culling + layout caching; WebGL2/WebGPU path isolated |
| Rust toolchain missing on a new machine | Core is framework-free TS: tests and the web build need no Rust; desktop needs `rustup` (per-user install) |
| Ops replay drift after schema changes | Versioned schema + migration tests; ops carry explicit data |
| Manual-position fights with auto layout | `manual` flag honored; force-layout is explicit |
| Undo of complex gestures | Batch history entries + inverse-op capture |

## 12. Assumptions & open decisions

- One active sheet per document in Phase 1 (schema supports many).
- Web persists to localStorage; desktop persists to one `.rnode` file
  (SQLite) holding document and images in a single transaction. IndexedDB
  (web assets) and SQLite (desktop) are adapters behind the same interfaces,
  not rewrites.
- Sync conflict model (CRDT vs OT) — open, will be chosen in Phase 5.
- Layout animations — deferred to Phase 3 (stable positions already).
- Light theme only (`ThemeName = "light"`). The renderer already takes the
  theme as data, so adding a dark one is a palette, not a refactor.
- Fonts: system stack (no bundling).

## Tech-stack mapping (per owner)

| Layer | Now | Later |
|---|---|---|
| Desktop shell | Tauri 2 (`src-tauri/`), compiled and working | — |
| Document engine | `src/core` (TS) | Rust crate mirroring the same schema/ops |
| Persistence | web: localStorage · desktop: one `.rnode` SQLite file (document + assets) | IndexedDB (web) |
| Renderer | Canvas2D | WebGPU / WebGL2 — only if ADR-001 §12 is reopened |
| UI | React + TS + Vite | unchanged |
| Layout/export perf | TS, debounced | Rust background tasks / Web Workers |
