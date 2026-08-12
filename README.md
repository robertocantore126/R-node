<img width="189" height="189" alt="6a357c99-15ea-4ef6-b917-cac1fe279918-remove-bg-io" src="https://github.com/user-attachments/assets/5f3b0327-59a9-4e8d-92f9-141164861046" />

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
- **Local-first** — documents save when you decide (Ctrl+S, no hidden
  autosave). On the web they live in localStorage; on desktop each document is
  **one `.rnode` file** (a SQLite database holding the document *and* its
  images).
- **Images in nodes** — drop or paste an image onto a topic, resize it with a
  slider or a canvas handle, and share the map as a single `.rnode.zip`.
  Originals are preserved at full resolution; the canvas only ever decodes
  pre-scaled levels inside a byte budget.
- **Rich text on the canvas** — bold, italic, colours, headings and lists live
  in the topic itself, drawn by the canvas and edited in an overlay that
  matches it pixel for pixel (see [Text](#text-rich-text-on-a-canvas)).
- **Extensible by design** — a pure, framework-free core (document model,
  operation system, layout engine) that web, desktop and mobile clients share.

---

## Status

**Phase 1 (core editor) is implemented and tested; node images and the desktop
app have landed.** 188 unit tests passing across 13 suites, typecheck clean,
performance-verified at 10k topics, editor/canvas text parity measured at
0 divergences (16/16 cases).

| | |
|---|---|
| Document model | versioned JSON schema, tree with stable IDs, multi-sheet schema (first sheet active) |
| Operation system | every edit is an idempotent, replayable op with an inverse — undo/redo for free, collaboration-ready |
| Rendering | single `<canvas>`, viewport culling, shapes, curved connectors, relationships, marquee selection, PNG export |
| Layout | mind map with balanced branches, exact measured extents, no overlap by construction |
| Text | rich text per topic (`TextRun[]`): bold/italic/underline/strikethrough, colours, heading sizes, nested bullet lists — drawn by the canvas, edited in a single Lexical overlay |
| Editing | create / sibling / child / promote, rename, delete, duplicate, copy/paste/cut, drag-and-drop reparenting, type-to-edit |
| Structure ops | collapse/expand, sort siblings, tasks, notes, styles, relationships (arrows), groups, summaries |
| Images | attach by drop/paste, three stored levels (original / 1024px / 256px), decode-at-paint-size with a byte-budgeted bitmap cache, resize slider + canvas handle, select / delete / reassign |
| Workspace | outliner, inspector, command palette, search, light theme, Zen mode, manual save |
| Import/export | JSON, Markdown, PNG; `.rnode.zip` with images (complete or compact); clipboard import sanitized from Word / Google Docs / Draw.io |
| Desktop | Tauri 2 shell; each document is one `.rnode` SQLite file (document + assets in a single transaction), native open/save dialogs, drag files from the OS onto topics |

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
| `Delete` / `Backspace` | delete branch (or the selected image / relationship / group) |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` | undo / redo |
| `Ctrl/Cmd+D` | duplicate topic |
| `Ctrl/Cmd+C` / `X` / `V` | copy / cut / paste |
| `Ctrl/Cmd+Shift+C` | copy selection as an outline |
| `Ctrl/Cmd+K` | command palette |
| `Ctrl/Cmd+F` | search |
| `Ctrl/Cmd+S` | save now |
| `Ctrl/Cmd+O` | open a document |
| `Ctrl/Cmd+E` | export JSON |
| `Ctrl/Cmd+Enter` | toggle task complete |
| `Ctrl/Cmd+1` / `0` | fit map to view |
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
| [docs/ADR-001-immagini-e-piattaforma.md](docs/ADR-001-immagini-e-piattaforma.md) | decision record: where images live, the decode-memory budget, and the desktop platform choice (A1+B1) |
| [docs/ELEMENTI_VISUALI.md](docs/ELEMENTI_VISUALI.md) | reference sheet: every modifiable visual element (theme, node, sheet, text), every GUI element, logo/branding assets |

The code is split into clean, framework-free layers — only the UI uses React:

```
src/
├── core/      document schema, model + tree walks, operation system, history
├── layout/    measurement + placement engines (pure math, fully testable)
├── render/    camera/viewport, canvas renderer, themes, hit-testing, PNG export
├── editor/    store (orchestration), keyboard shortcuts, context, export bridge,
│              image-import pipeline (Web Worker)
├── persist/   storage adapters (localStorage on web; `.rnode` SQLite via Tauri)
│              + content-addressed asset store (IndexedDB on web, SQLite on desktop)
└── ui/        React shell: canvas, sidebar, topbar, outliner, inspector, palette
dev/           text parity harness + session tracer (development only, not shipped)
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

### Images in nodes

An image attaches to a topic (drop it on the node, or paste with a topic
selected) and is drawn above the text inside the same box. On import the
original is stored **intact** plus two derived levels (1024px and 256px on the
long side); the canvas decodes only the level closest to what is actually
painted, inside a byte-budgeted LRU cache, so a map with hundreds of images
stays fluid. Resize with the Inspector slider or the canvas handle
(proportions locked); select, delete or reassign an image without touching the
node. The decision behind this — storage, decode-memory budget, and why the
desktop is the primary home for images — is recorded in
[docs/ADR-001-immagini-e-piattaforma.md](docs/ADR-001-immagini-e-piattaforma.md).

### Performance

Verified with a permanent perf suite (`tests/perf.test.ts`). At 10k topics ops
stay linear (~0.005–0.008 ms/op); the numbers the suite prints on each run are
the reference — it reports `applyOps`, `layout`, `writeback` and tree walks
separately at 1k / 5k / 10k so a regression is attributable to one subsystem.
The real constraint at scale is *web* storage (a 10k map is ~3.6 MB in
localStorage); on desktop the document is a single `.rnode` SQLite file, and
images live in a content-addressed store behind a byte-budgeted decode cache
(measured at ~17 MB peak for 306 on-screen bitmaps, against a 128 MB budget —
see ADR-001 §12).

---

## Desktop app (Tauri 2 + Rust)

R-node runs as a native desktop app. Each document is **one `.rnode` file** — a
SQLite database that holds the document JSON *and* its images, committed in a
single transaction, so "a document" is a single file on disk (no folder, no
sidecars). Open and save use native dialogs, and you can drag image files from
the OS onto topics. The shell is compiled and working on this machine.

Requirements: [Rust](https://rustup.rs) (stable) and the Tauri CLI
(`cargo install tauri-cli --locked`), plus `npm install`. WebView2 is built
into Windows 11.

```bash
cargo tauri dev       # dev build — starts Vite and opens the desktop window
cargo tauri build     # release build → installer in src-tauri/target/release/
```

The web target keeps working unchanged (`npm run dev`) — it persists to
localStorage and shares all the same code; only the storage adapter differs.
Documents without images export as `.rnode.json`; maps with images share as a
single `.rnode.zip` (complete = originals, compact = display levels only).

---

## Testing

```bash
npm test
```

188 tests across 13 suites: document operations, undo/redo round-trips,
reparenting and subtree moves, layout geometry (no-overlap, straddle,
size-aware balance, upward propagation), text measurement (line boxes, block
gaps, bullet columns, mid-word breaks), the Lexical ↔ runs bridge (including
round-trip idempotence), clipboard sanitization, viewport math, the asset
store and image import pipeline, the Tauri storage adapter, export (including
`.rnode.zip` round-trips), and performance ceilings at 1k/5k/10k topics.

Text parity between the canvas and the editor is checked separately, in a real
browser, at `http://localhost:5173/dev/parity.html` — jsdom cannot do it
because it has no layout engine.

---

## Reporting a bug

Don't describe the symptom — capture it. While running `npm run dev` the app
records its own decisions in a rolling buffer.

**When something looks wrong, press the ⏺ button in the toolbar** (or
`Ctrl+Shift+D`, which also asks what you expected). A `rnode-trace-*.json`
file downloads. Attach that file. It carries the last few hundred events:
which inputs were acted on, which were deliberately ignored *and why*, what
the renderer actually drew each frame, how long layout took, and any errors —
with the events that preceded them.

Both capture **and then reset**, in that order: by the time you reach for the
button the bug has already happened, so clearing first would throw away the
evidence. Because the buffer restarts, each capture covers only what happened
since the previous one — hit it once to get a clean slate, reproduce, hit it
again, and the second file contains the repro and nothing else.

Console entry points: `__rnodeTrace.capture()` returns the same bundle as an
object (handy for inspecting in place), `__rnodeTrace.download()` skips the
prompt, `__rnodeTrace.clear()` resets, `__rnodeTrace.enabled` tells you
whether recording is on.

The tracer is **development-only** — it is compiled out of production builds,
so a `npm run build` bundle records nothing.

Why this instead of a written report: the decisive facts are invisible from
outside the app. "The connector lines disappear when I pan" cannot tell anyone
whether the renderer skipped them or drew them where you could not see them —
two different bugs. A capture answers that in one line. How to read one is in
[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) §4bis.

---

## Roadmap

- **Phase 1 — Core editor (done):** document model, ops + undo/redo, canvas
  renderer, mind-map layout, keyboard + mouse editing, drag-and-drop, marquee,
  outliner, inspector, palette, manual save, rich text topics with measured
  editor/canvas parity, JSON/Markdown/PNG export.
- **Images & desktop (done):** content-addressed asset store, drop/paste
  import in a Web Worker, decode-at-paint-size with a byte budget, resize
  slider + handle, portable `.rnode.zip`, Tauri bring-up, and single-file
  `.rnode` (SQLite) desktop documents. (ROADMAP tasks T12a–T20.)
- **Phase 2 — Visual richness (in progress):** markers, labels, rich notes,
  boundaries, callouts.
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
