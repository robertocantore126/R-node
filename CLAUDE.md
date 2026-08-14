# R-node

Visual thinking workspace: mind maps on a single Canvas2D, keyboard-first,
local-first. React + TypeScript + Vite; the engine (`src/core`, `src/layout`,
`src/render`) is framework-free.

## Read before changing anything

**[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) is the contract.** It holds the
non-negotiable invariants, the editor↔canvas parity rules, the traps already
paid for, and the definition of done. A change that violates it is wrong even
if it compiles and the tests pass.

**[docs/ROADMAP.md](docs/ROADMAP.md)** is the ordered task list. Take one task
at a time, in order, and do not widen its scope.

Reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (structure, phases) ·
[docs/RICH_TEXT_EDITOR.md](docs/RICH_TEXT_EDITOR.md) (rich text in detail).

## Commands

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

App at `http://localhost:5173/`, text parity harness at
`http://localhost:5173/dev/parity.html` (must report 0 diverging).

## Concept Map (shortcuts)

Only the places where the words in a prompt differ from the words in the code.
Everything else — `theme.ts`, `shortcuts.ts`, `pasteSanitizer.ts`, `Outliner`,
`Inspector` — is one grep away and deliberately not listed.

- Node box size, padding, line breaks -> `src/layout/measure.ts` — the box is a
  **topic** (`measureTopic`, `MIN_TOPIC_W`, `MAX_TOPIC_W`, `wrapRunLines`);
  "node" alone matches ~1100 occurrences and finds nothing.
- Bold / italic / colour inside a title -> `src/core/types.ts` — a title is a
  `TextRun[]` (`MindNode.titleRuns`), never a string; the Lexical ↔ runs
  conversion is `src/ui/lexicalRuns.ts`.
- Zoom, pan, "where the view is" -> `src/render/viewport.ts` — the object is a
  `Camera` (`zoomAt`, `panBy`, `worldToScreen`); the code never says "viewport
  state".
- Save / open a document (.rnode.json, .rnode.zip) -> `src/editor/exportBridge.ts`
  (`buildRnodeZip`, `importRnodeZip`), driven from `src/editor/store.ts`.
  **Not** `src/export/`, which only produces SVG/PNG/HTML artifacts.
- Image bytes -> `src/persist/assets.ts` — an `AssetStore` in IndexedDB keyed by
  SHA-256; the document itself carries only `AttachmentInfo` metadata.
- Dashed boundary around sibling topics -> `src/core/types.ts` — stored as
  `Sheet.boundaries`, but the type is called `Group`.
- Undo -> `src/core/ops.ts` — each op computes its own reverse (`inverseOf`,
  `applyWithInverse`); `src/core/history.ts` only stacks them.
- Autosave -> no timer exists. Persistence goes through a `StorageAdapter`
  (`LocalStorageAdapter` on web, `TauriStorageAdapter` on desktop) in
  `src/persist/storage.ts`.
- Where a topic ends up on screen -> `src/layout/mindmap.ts` (`layoutSheet`,
  `applyLayout`); `position.manual === true` means user-placed, and layout must
  preserve it.

Paths here are checked by `npm run check:map` — a failure means this section is
stale, not that the code is wrong.

## The three things people get wrong here

1. **Text parity is measured, not assumed.** Touching `src/layout/measure.ts`,
   the text path of `src/render/renderer.ts`, `src/ui/lexicalRuns.ts`, the
   `.topic-rich-*` CSS or `src/ui/RichEditor.tsx` means re-running the harness.
2. **Undo/redo lives only in the store.** Lexical has no HistoryPlugin, and
   layout is derived data that never enters an op or the history.
3. **Several "obvious improvements" are already implemented** — the text
   measurer cache and atomic history batches among them, and there is no
   autosave timer to fix. See AGENT_GUIDE.md §5 before acting on any
   improvement list.
