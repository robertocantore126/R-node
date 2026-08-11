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
