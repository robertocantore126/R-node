# HANDOFF — bug-fix batch (six tasks, in order)

You are fixing six confirmed defects in R-node. Each one was verified against
the code at the time this document was written; each comes with the exact site,
the evidence, the fix, and the test that must exist when you are done.

**Work one task at a time, in the order given, and commit each separately.** Do
not start task N+1 before task N is committed with its gate passing. Do not
widen a task's scope — if you find something else while you are in the file,
write it at the bottom of this document under "Found while working" and move on.

---

## 0 · Before you touch anything

Read these two, in this order. They are the contract; a change that violates
them is wrong even if it compiles and the tests pass.

1. `CLAUDE.md` (repo root) — orientation and the concept map.
2. `docs/AGENT_GUIDE.md` — the invariants (referred to below as I4, I7, §4…).

Commands, all from the repo root:

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run check:map
```

All three must pass before every commit. `npm test` is currently 535 passing
across 27 files; that number only goes up, never down.

### Traps that will cost you an hour if you skip this section

- **`@lexical/selection` is NOT a dependency.** `docs/AGENT_GUIDE.md` §4
  prescribes `$patchStyleText` for task 6, but that package is not installed.
  **Do not `npm install` it.** Task 6 below gives a dependency-free fix that
  achieves the same thing. Adding a dependency is not yours to decide.
- **Undo/redo lives only in `src/editor/store.ts`** (I4). Lexical has no
  HistoryPlugin, and layout is derived data that never enters an op or the
  history. Nothing in these six tasks should add an op type.
- **Ops compute their own inverse** (`src/core/ops.ts`, `inverseOf`). If you
  change what an op carries, you change its inverse too.
- **Do not touch `src/layout/measure.ts`'s text path, the text path of
  `src/render/renderer.ts`, `src/ui/lexicalRuns.ts`'s measurement-facing
  behaviour, the `.topic-rich-*` CSS, or `src/ui/RichEditor.tsx`'s layout
  without re-running the parity harness** (`npm run dev`, then
  `http://localhost:5173/dev/parity.html`, which must report 0 diverging).
  Task 6 touches `lexicalRuns.ts` and `RichEditor.tsx` but only the
  colour-writing path, which no measurement reads. Keep it that way.
- **Test environments.** `vite.config.ts` sets `environment: "node"` for all
  tests. A test that needs a DOM must start with the literal first line
  `// @vitest-environment jsdom` (see `tests/pasteSanitizer.test.ts`). A test
  that constructs an `EditorStore` must start with `import "fake-indexeddb/auto";`
  before any other import (see `tests/store.test.ts`, `tests/codeNode.test.ts`).
- **Test naming.** Only `tests/**/*.test.ts` is collected. Existing tests are
  named after behaviour, not after a bug id: write
  `it("keeps the size of a run when its colour changes")`, never
  `it("fixes N1")`. The bug id is for this document only and must not appear
  in the code or in a commit message.
- **Commit messages** in this repo are an imperative sentence describing the
  change, no prefix, no scope tag. Look at `git log` before writing one.

---

## 1 · External image drops always land in the top slot

**Severity: medium. Smallest fix in the batch — start here.**

### Site

`src/ui/CanvasView.tsx`, the `onDrop` handler. Find this sequence (line numbers
will have drifted; match on the code):

```ts
if (!acceptsExternalDrop(e.dataTransfer)) return;
e.preventDefault();
clearExternalGhost();
const { x, y } = localPoint(e as unknown as RPointerEvent);
const world = screenToWorld(/* … */);
const target = rendererRef.current?.hitTest(/* … */) ?? null;
const side = extDropSideRef.current ?? "top";
```

### Evidence

`clearExternalGhost` (same file, the `useCallback`) contains
`extDropSideRef.current = null;`. It is called **before** the ref is read, so
`side` evaluates to `"top"` on every external drop. During `dragover` the ghost
snaps to the nearest slot and writes `extDropSideRef.current = side`, so the
preview promises a side the drop never honours.

Internal image drags are a different path (they read `drag.imgDropSlot` before
cleanup) and are **not** affected. Do not change them.

### Fix

Read the ref into a local **before** `clearExternalGhost()` runs, and use the
local afterwards. Do not reorder anything else in the handler —
`clearExternalGhost` also revokes a pending object URL and must still run early.

### Gate

`tests/` has no DOM-level drop harness and you are not to build one. This task
has no automated gate. Instead:

- Add a one-line comment at the call site naming the hazard, so the next person
  who reorders these lines is warned: `clearExternalGhost` nulls the ref, so it
  must be read first.
- Verify by hand in the browser (`npm run dev`) and record what you saw in the
  commit message: drag an image file from the OS onto the **right** edge of a
  topic and confirm it lands in the right slot, not the top one.

**Done when:** the three commands pass, and the commit message states the manual
check you performed and its outcome.

---

## 2 · The PDF export can throw after the file is already built

**Severity: medium. This is a latent crash that recent work made more likely.**

### Site

`src/export/pdf.ts`, near the end of `sheetToPdf`:

```ts
const minFontPt = Math.min(...fontSizes, Infinity);
```

`fontSizes` is declared earlier in the same function as `const fontSizes: number[] = [];`
and is pushed to in `drawTitle` and `drawCaptions`.

### Evidence

`fontSizes` gains one entry **per emitted style run**, not per topic. A large
map produces tens of thousands of entries, and spreading an array of that size
into a function call can exceed the engine's argument limit and throw
`RangeError`. It throws *after* the blob has been assembled successfully, so a
perfectly good PDF is lost to a report line.

### Fix

Stop accumulating the array at all. Track the minimum in a scalar as the runs
are emitted:

- Replace `const fontSizes: number[] = [];` with a single
  `let minFontPt = Infinity;`.
- Replace each `fontSizes.push(pt)` with `minFontPt = Math.min(minFontPt, pt)`.
- Delete the `Math.min(...fontSizes, Infinity)` line and use the scalar.

The value must stay identical: `Infinity` when nothing was emitted, which the
existing code already handles (`Number.isFinite(minFontPt) ? minFontPt : undefined`).
The `minFontPt` reported in `report.units` is rounded the same way it is today —
do not change the rounding.

### Gate

Add to `tests/exportPdf.test.ts`:

- a test that a map with many topics still reports a finite `minFontPt` and does
  not throw. Use the existing `mapOf(n)` helper with a large `n` — pick the
  smallest `n` that would have produced enough runs to be meaningful, and say in
  a comment why that number.
- a test that an empty map (the existing `survives an empty map` fixture) still
  reports the same thing it reports today. Check what that is before you change
  anything, and assert the unchanged value.

**Done when:** the three commands pass and no array of per-run font sizes
remains in the file.

---

## 3 · The PDF paints 4- and 8-digit hex colours grey

**Severity: low. Do it immediately after task 2 — same file, same function area.**

### Site

`src/export/pdf.ts`, `function rgb(color: string): string`. It handles
`rgb()`/`rgba()` notation and then:

```ts
const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css);
if (!hex) return "0.5 0.5 0.5";
```

### Evidence

The document importer admits a wider range: `src/editor/store.ts` validates a
run colour with `/^#[0-9a-fA-F]{3,8}$/`, and `src/ui/lexicalRuns.ts` reads one
back with `/color:\s*(#[0-9a-fA-F]{3,8})\b/`. So `#rgba` (4) and `#rrggbbaa` (8)
reach the exporter, miss this regex, and are painted mid-grey — a coloured
phrase silently becomes grey with nothing to indicate it happened.

### Fix

Accept 3, 4, 6 and 8 hex digits. The alpha nibble(s) are **dropped**, not
blended: a PDF fill colour has no alpha, and the honest thing is to draw the
colour at full opacity rather than to guess a background to blend against. Say
that in a comment.

Do not touch the `rgb()`/`rgba()` branch above it, and do not change the
mid-grey fallback for genuinely unparseable input.

### Gate

Add to `tests/exportPdf.test.ts` a test asserting the emitted colour operator
(the `r g b rg` numbers in the content stream), never the input string:

- a run coloured `#3366ccff` emits the same operator as one coloured `#3366cc`.
- a run coloured `#36c` emits that same operator too (this case already works;
  assert it so the shorthand branch cannot regress while you edit the regex).
- a run coloured with something unparseable still emits the mid-grey fallback.

The existing `richSheet` helper in that file builds a topic from a `TextRun[]`;
reuse it rather than writing a new fixture.

**Done when:** the three commands pass.

---

## 4 · Deleting the last document leaves the old history armed

**Severity: high — it corrupts a document the user did not ask to change.**

### Site

`src/editor/store.ts`, `deleteDocument(id: string)`, the branch taken when no
document is left:

```ts
} else {
  this.model = new DocumentModel(DocumentModel.blank());
  this.state = this.makeState();
  // … applyDocFile(null) …
}
```

### Evidence

`switchToDoc` — the *other* place that swaps `this.model` — calls
`this.history.clear()` immediately after. This branch does not. So the undo
stack of the **deleted** document survives against a **new, unrelated** blank
model. Two outcomes, both bad:

- `applyOp` for `setTitle`, `setStyle` and `setPosition` dereferences
  `nodes[op.id]` with no guard (`src/core/ops.ts`), so undo throws `TypeError`
  part-way through a batch, leaving an inverse half-applied.
- For the ops that *are* null-safe, undo silently inserts the deleted
  document's nodes into the blank sheet.

The UI offers it: `makeState()` reads the still-populated stack, so the undo
button stays enabled.

### Fix

Clear the history in that branch, for the same reason `switchToDoc` does. Put
the reason in a comment — that a new model must never inherit another
document's stack — because the absence of the call is exactly what made this
bug, and the next person needs to see why it is there.

While you are in the function: check whether any **other** site assigns
`this.model` without clearing the history. If one exists, fix it in the same
commit and say so in the message. If none exists, say that too.

### Gate

Add to `tests/store.test.ts` (it already has a `memoryAdapter` and the imports
you need):

- create a store, make an edit that pushes an op, delete the last document, and
  assert the undo stack is empty — assert through the public snapshot
  (`canUndo` on the state) rather than reaching into `history`.
- then call undo and assert it neither throws nor changes the blank document's
  node count.

**Done when:** the three commands pass and both assertions are present. The
second one is the one that matters: a test that only checks the flag would pass
against a stack that is merely hidden.

---

## 5 · A corrupt saved document blanks the app on boot

**Severity: high — no error, no UI, no recovery, just a white page.**

### Site

Two files.

`src/main.tsx`:

```ts
void store.init().then(() => {
  createRoot(document.getElementById("root")!).render(/* … */);
});
```

`src/editor/store.ts`, `async init()`. Its `try` wraps **only**
`docs = await this.adapter.load();`.

### Evidence

Two throws sit outside that `try`:

- `this.model = new DocumentModel(docs[0])` — the constructor throws when
  `doc.sheets.length === 0` (`src/core/doc.ts`), and the desktop adapter only
  checks `Array.isArray(sheets)`, so `sheets: []` passes validation and kills
  the constructor.
- `this.focusRoot()` — reads the `rootNode` getter, which throws
  `"sheet root node missing"` when `rootNodeId` points at a node that is not in
  the sheet.

`main.tsx` has no `.catch`, so either one becomes an unhandled rejection: React
never mounts, and there is no error UI and no toast. The comment at the top of
`init()` says a corrupt document "must never blank the app" — that promise is
what these two throws break.

### Fix

Two independent layers. Do both; neither substitutes for the other.

1. **In `init()`** — make the failure land in the recovery path that already
   exists. Bring the model construction (and anything else that can throw on
   malformed input) inside the guarded region, so a document that cannot be
   opened falls back to the sample map and sets `initError`, exactly as an
   adapter failure does today. The user must end up with a working app and a
   toast saying why. Reuse the existing `initError` / `documentLoadErrorLabel`
   machinery rather than inventing a second reporting channel.
2. **In `main.tsx`** — attach a `.catch` that mounts *something* regardless: at
   minimum a plain, styled message with the error text and no dependency on the
   store having initialised. This is the backstop for the next throw nobody
   predicted, so it must not itself be able to throw.

Do not change what the adapter accepts. Widening validation there is a
different, larger decision and is out of scope for this task.

### Gate

In `tests/store.test.ts`:

- an adapter whose `load()` resolves with `[{ …, sheets: [] }]` — assert
  `init()` resolves (does not reject), that the store ends up on a usable
  document, and that the error was reported through the existing channel.
- an adapter whose `load()` resolves with a document whose `rootNodeId` names a
  node absent from `sheet.nodes` — same three assertions.

The `main.tsx` backstop is not unit-testable here and does not need a test;
state in the commit message that you verified it by temporarily throwing inside
`init()` and observing the fallback UI, then removed the temporary throw.

**Done when:** the three commands pass and both adapters are covered.

---

## 6 · Recolouring text deletes its font size

**Severity: medium. Read the trap in §0 before starting.**

### Site

`src/ui/RichEditor.tsx`:

```ts
function applyColor(editor: LexicalEditor, color: string): void {
  editor.update(() => {
    const sel = $getSelection();
    if (!sel) return;
    for (const n of sel.getNodes()) {
      if ($isTextNode(n)) n.setStyle(`color: ${color}`);
    }
  });
}
```

and `clearColor` beside it, which calls `n.setStyle("")`.

### Evidence

Per-run font size lives in that same style string.
`src/ui/lexicalRuns.ts` writes it (`makeTextNode` pushes both
`color: …` and `font-size: Xpx` into one `setStyle`) and reads it back
(`textNodeToRun`, via the module-private `FONT_SIZE_RE`).
`TextNode.setStyle()` **replaces** the whole string, so recolouring a sized run
deletes its size; the next `editorStateToRuns` drops it and the commit persists
the loss. It also breaks round-trip idempotency (I8) for that content.
`clearColor` destroys the size too, which its label does not promise.

`docs/AGENT_GUIDE.md` §4 documents this exact failure and prescribes
`$patchStyleText` — **which is not installed. See §0.**

**Scope correction, verified:** heading sizes are *not* affected. A heading's
size comes from the block walk in `lexicalRuns.ts` (`ctx.headingSize`), not from
the style string, so it survives recolouring. The content that loses its size is
a run with an explicit `font-size`, which in practice means pasted text. Do not
claim in a comment or commit message that headings were affected.

### Fix

The style string's format is owned by `src/ui/lexicalRuns.ts` — it is the only
place that writes and parses it. So the surgical edit belongs there, not in the
editor component:

- Export one helper from `lexicalRuns.ts` that sets or removes **only** the
  colour declaration on a `TextNode`, leaving every other declaration in the
  string untouched. It must round-trip: setting a colour on a node that has a
  size must leave the size readable by `textNodeToRun` afterwards.
- Have `applyColor` and `clearColor` call it instead of `setStyle`.

Do not change what `makeTextNode` writes, do not change either regex's accepted
range, and do not add a new style declaration to the format.

### Gate

`tests/lexicalRuns.test.ts` already exercises this module. Add there, and match
how that file works: it runs in the default **node** environment with a
headless Lexical editor (`createEditor` from `lexical`), with no
`// @vitest-environment jsdom` line. Do not add one.

- a run with both a colour and a `fontSize`, recoloured, still reports its
  `fontSize` through `editorStateToRuns`.
- the same run with its colour **cleared** still reports its `fontSize`.
- a run with a `fontSize` and no colour, given a colour, keeps the size.
- round-trip idempotency: runs → editor → recolour → runs → editor → runs is
  stable in everything but the colour.

**Done when:** the three commands pass, the four cases above exist, and — because
this task touched `lexicalRuns.ts` — the parity harness reports 0 diverging
(see §0; state the result in the commit message).

---

## Out of scope

A wider review listed further findings. **None of them are yours in this
batch.** Do not fix them, do not refactor around them, and do not mention them
in your commits. Among them: the global dirty flag across documents, missing
`pointercancel` handling in the editor, manual position pins cleared outside the
op system, multi-root copy keeping only the first subtree, internal paste
stripping relationship styling, the Outliner committing stale titles, and the
SVG export rendering code topics through the rich-text path.

If one of them blocks a task above, stop and say so instead of expanding.

---

## Definition of done for the batch

- Six commits, one per task, each with `npm test`, `npm run typecheck` and
  `npm run check:map` passing at that commit.
- Every task's gate present and passing. A task with a fix and no gate is not
  done.
- The test count went up, and no existing test was weakened, skipped or deleted
  to make a change pass. If an existing test genuinely encoded the old wrong
  behaviour, say so explicitly in the commit message and quote the assertion you
  changed.
- Nothing outside the files named above was modified, except a test file.

## Found while working

<!-- Append anything you noticed but did not fix. One line each: file, what,
     why you left it. Do not act on these. -->
