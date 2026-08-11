# R-node

**A cross-platform visual thinking and mind-mapping workspace.**

R-node is a keyboard-first mind-mapping application designed for brainstorming,
knowledge organization, project planning and presentations. It is built
original from the ground up — brand, design system and code are our own, and
nothing is copied from other mind-mapping products.

- **Fast** — single-canvas rendering, no DOM or SVG element per topic; smooth
  at 10,000+ topics.
- **Keyboard-first** — Enter/Tab/Shift+Tab to create and structure topics,
  arrows to navigate, every action undoable.
- **Local-first** — documents save when you decide (Ctrl+S, no hidden autosave); a desktop build with
  SQLite persistence is scaffolded and ready.
- **Rich text on the canvas** — bold, italic, colours, headings and lists live
  in the topic itself, drawn by the canvas and edited in an overlay that
  matches it pixel for pixel (see [Text](#text-rich-text-on-a-canvas)).
- **Extensible by design** — a pure, framework-free core (document model,
  operation system, layout engine) that web, desktop and mobile clients share.

---

## Status

**Phase 1 (core editor) — implemented and tested.** 101 unit tests passing,
typecheck clean, performance-verified at 10k topics, editor/canvas text parity
measured at 0 divergences.

| | |
|---|---|
| Document model | versioned JSON schema, tree with stable IDs, multi-sheet schema (first sheet active) |
| Operation system | every edit is an idempotent, replayable op with an inverse — undo/redo for free, collaboration-ready |
| Rendering | single `<canvas>`, viewport culling, shapes, curved connectors, relationships, PNG export |
| Layout | mind map with balanced branches, exact measured extents, no overlap by construction |
| Text | rich text per topic (`TextRun[]`): bold/italic/underline, colours, heading sizes, nested bullet lists — drawn by the canvas, edited in a single Lexical overlay |
| Editing | create / sibling / child / promote, rename, delete, duplicate, copy/paste/cut, drag-and-drop reparenting |
| Structure ops | collapse/expand, sort siblings, tasks, notes, styles, relationships |
| Workspace | outliner, inspector, command palette, search, light theme, Zen mode, manual save |
| Import/export | JSON, Markdown, PNG; clipboard import sanitized from Word / Google Docs / Draw.io |

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

The dev server also serves the **text parity harness** at
`http://localhost:5173/dev/parity.html`, which must report 0 diverging cases
(see [Text](#text-rich-text-on-a-canvas)).

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

Documentation map:

| Document | What it is for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | full design document: PRD, information architecture, schema, API design, sync and layout strategy, security model, phased plan, risk register |
| [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) | **read before changing code** — invariants, the editor↔canvas parity contract, traps already paid for, definition of done |
| [docs/ROADMAP.md](docs/ROADMAP.md) | the ordered task list, one task at a time |
| [docs/RICH_TEXT_EDITOR.md](docs/RICH_TEXT_EDITOR.md) | how rich text is modelled, measured, drawn and edited |

The code is split into clean, framework-free layers — only the UI uses React:

```
src/
├── core/      document schema, model + tree walks, operation system, history
├── layout/    measurement + placement engines (pure math, fully testable)
├── render/    camera/viewport, canvas renderer, themes, hit-testing, PNG export
├── editor/    store (orchestration), keyboard shortcuts, context, export bridge
├── persist/   storage adapters (localStorage now; IndexedDB, SQLite next)
└── ui/        React shell: canvas, sidebar, topbar, outliner, inspector, palette
dev/           text parity harness (development only, not shipped)
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

### Text: rich text on a canvas

A topic title is not a string but a sequence of styled runs (`TextRun[]`), so
one topic can carry bold, italics, colours, heading sizes and nested bullet
lists. Keeping that on a single canvas means two renderers must agree:

- **the canvas** draws every topic at rest, with a per-topic bitmap cache so
  pan and zoom only blit;
- **one Lexical overlay** — never more than one — owns the topic being edited,
  and the canvas skips it so nothing is drawn twice.

The two share the measurement (`wrapRunLines`), the constants
(`LINE_HEIGHT_FACTOR`, `BLOCK_GAP_FACTOR`, `BULLET_WIDTH_EM`, `FONT_STACK`,
`TEXT_INSET`) and the resolved colours — the overlay wears the node's own fill
and text colour, so double-clicking a topic does not change how it looks.

Because the canvas *imitates* the browser's text layout, that agreement is
**measured, not assumed**: `dev/parity.html` renders a corpus of cases into the
real editable DOM, extracts the browser's true line boxes character by
character, and diffs them against the canvas measurement — break points,
baselines, line advances, lefts and total height. Current state: 16 of 16
cases aligned, worst residual 0.5px.

Pasting from Word, Google Docs or Draw.io is sanitized into that model:
structure and emphasis survive, scripts, layout CSS and foreign fonts do not.

Full detail in [docs/RICH_TEXT_EDITOR.md](docs/RICH_TEXT_EDITOR.md).

### Performance

Verified with a permanent perf suite (`tests/perf.test.ts`). At 10k topics ops
stay linear (~0.005 ms/op); the numbers the suite prints on each run are the
reference — it reports `applyOps`, `layout`, `writeback` and tree walks
separately at 1k / 5k / 10k so a regression is attributable to one subsystem.
The real constraint at scale is storage (a 10k map is ~3.6 MB in
localStorage), which is exactly what the IndexedDB/SQLite adapters solve.

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
# 3. From r-node/:
npm install
cargo tauri dev
```

Then swap in `TauriStorageAdapter` (in `src/persist/storage.ts`) to persist
through SQLite instead of localStorage. Bundle icons and `bundle.active` are
already configured, so `cargo tauri build` can produce an installer once Rust
is installed.

---

## Testing

```bash
npm test
```

101 tests across 8 suites: document operations, undo/redo round-trips,
reparenting and subtree moves, layout geometry (no-overlap, straddle,
size-aware balance, upward propagation), text measurement (line boxes, block
gaps, bullet columns, mid-word breaks), the Lexical ↔ runs bridge (including
round-trip idempotence), clipboard sanitization, viewport math, and
performance ceilings at 1k/5k/10k topics.

Text parity between the canvas and the editor is checked separately, in a real
browser, at `http://localhost:5173/dev/parity.html` — jsdom cannot do it
because it has no layout engine. Automating it is task T2 in
[docs/ROADMAP.md](docs/ROADMAP.md).

---

## Roadmap

- **Phase 1 — Core editor (done):** document model, ops + undo/redo, canvas
  renderer, mind-map layout, keyboard + mouse editing, drag-and-drop,
  outliner, inspector, palette, manual save, rich text topics with measured
  editor/canvas parity, JSON/Markdown/PNG export.
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
