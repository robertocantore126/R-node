# State machines in R-node

Every piece of state with a lifecycle, whether it is an explicit machine, and
why. Read this before adding a flag, a `null`-means-off field or an async guard.

## The pattern

A machine is a discriminated union (`kind`, plus only the data that state needs)
and a table of allowed moves, driven through `Machine` in
`src/editor/machine.ts`. There is no library and no statechart.

- `to(next, event)` is the only way to change `kind`. Data inside a state may be
  updated in place.
- An illegal move throws under test. For a user it is recorded with
  `trace.invariant` and applied, so a bug in a table cannot break a session.
- Every move is traced as `state:machine` with `machine`, `from`, `to`, `event`.
- The table has one required key per kind, so a new state without its moves does
  not compile.

**Use one when** states exclude each other and getting that wrong loses work or
leaves the UI stuck. **Do not use one for** a value that is simply present or
absent (`ctxMenu: CtxMenuState | null`) or for flags that are truly independent
(`showSidebar`, `showInspector`).

## Reading live state

In the running app, or from a test harness driving it:

```js
window.__rnode.machines()
// { canvasGesture: { kind: "idle" }, saveFlow: { kind: "idle" },
//   longOps: [], interaction: { target: { kind: "none" }, editingId: null, ... } }
```

A bug capture (the record button in the top bar) contains the same moves as
`state:machine` events, each next to the input that caused it.

## Explicit machines

| Name | Where | States | Guarantee |
|---|---|---|---|
| `canvasGesture` | `src/ui/canvasGesture.ts`, driven by `CanvasView` | `idle`, `pan`, `marquee`, `node-drag`, `resize-topic`, `resize-freeform`, `resize-image`, `move-image`, `move-cell`, `connect`, `chart-grow` | A mouse or pen press is exactly one gesture. It starts and ends at `idle`. Release commits; Escape, `pointercancel` and lost capture roll back. |
| `saveFlow` | `src/editor/editorMachines.ts`, driven by `EditorStore.saveNow` | `idle`, `saving` (with `queued`) | One save at a time. A request during a save re-runs once, unless the user cancelled or the target was refused. |
| `longOps` | `LongOps` in `src/editor/editorMachines.ts` | A stack of `save`, `export` and `open` operations | Operations overlap safely. The bar shows the newest, and Cancel only reaches that one. |
| `interaction` | Read-only view built in the `EditorStore` constructor | `target` (a `SelectionTarget`), `editingId`, `hasDraft`, `relFrom`, `mode` | `setSelectionTarget` is the only way to write the selection fields, so at most one kind of thing is selected. A gallery cell stays inside `nodes` because its topic remains selected. |

### Canvas gesture rules

- While a gesture has something to commit (`gestureHoldsKeyboard`), keys are held
  off so Delete or undo cannot change the document under a drag. A pan does not
  hold them, so typing continues during one.
- `store.beginNodeDrag`, `beginResize` and `beginImageResize` pair with one
  commit and one cancel. Reaching idle without either leaves a topic displaced.
- `endGesture` clears every preview ref. A new preview must be cleared there.

## Implicit, and deliberately left that way

Each was read and judged sound. Convert one only if a real defect or a new state
makes the current form wrong.

| State | Where | Lifecycle | Why it stays |
|---|---|---|---|
| Inline edit session | `state.editingId`, `editingDraftRuns`, `editOriginal`, `pendingInsert` in the store | idle → editing → committed or cancelled | Every write is in `startEdit`, `typeToEdit`, `commitEdit`, `cancelEdit` and `commitDraftOnLeave`. The fields move together, and the contract (I2, I3, I4) is covered by tests. |
| Link mode | `state.relFrom` | off → picking a target | Null or an id says it all. Cleared on document switch. |
| Tool mode | `state.mode` | `select` or `pan` | Already a closed union. |
| Unsaved changes | `editRev`, `savedRev`, `state.sync` | Counters compared per document | Counting beats a state here: an edit during a write stays unsaved by arithmetic. See "Known wrinkle". |
| Panels and windows | `showPalette`, `showOutliner`, `showWebSearch`, `showInspector`, `showSidebar`, `quizOpen`, `flashcardsOpen` | open or closed | Independent by design. The quiz and deck windows are non-modal. |
| Map search | `searchOpen`, `search`, `searchResults`, `searchIndex` | closed → open | One owner, reset together in `closeSearch` and `switchToDoc`. |
| Touch gestures | `src/ui/touchGestures.ts` | none → one finger → pinch, with a long-press timer | Already one self-contained class, separate from mouse and pen. |
| Canvas popovers | `ctxMenu`, `ffInsert`, `captionEdit` in `CanvasView` | Null means closed | Each is present or absent, and each closes itself. |
| External drag preview | `extGhostRef`, `extGhostSrc`, `extDropSideRef` | HTML drag in → over → drop or leave | One teardown, `clearExternalGhost`. Native drag events drive it, not pointers. |
| Quiz run | `index`, `picked`, `results`, `done` in `QuizWindow` | question → answered → result | Local to one window, remounted per quiz by its `key`. |
| Flashcard run | `order`, `pos`, `flipped` in `FlashcardWindow` | card → flipped → next | `done` is already derived from `pos`. |
| Web search panel | `status`, `error`, `seq` in `WebSearchPanel` | idle → loading → results, empty or error | Already a status union; `seq` discards superseded responses. |
| Startup | `EditorStore.boot` | loading → ready | Always resolves, so the UI always mounts. |
| Close guard | `closing` in `closeGuard.ts` | One-way latch | A single boolean. |
| Native file picker | `pickBusy` | One dialog at a time | A re-entrancy guard, released in `finally`. |
| File rename | `renameChain` | A promise queue | Ordering is the whole requirement. |
| Debounces | `layoutTimer`, `msgTimer`, `paintRaf` with its fallback, `pendingPastes` | Pending or not | Timers, with nothing to decide. |
| Startup fit | `interactedRef` and `fitTimer` | Once, unless the user got there first | One-shot. |
| Small field edits | Sidebar `renaming`, `CaptionField` `done`, `RichEditor` `seeded` and `plainNext`, `ShapeLibrary` `adding` | Local to one component | Short-lived, and the two-effect split in `RichEditor` is a recorded trap (AGENT_GUIDE §4). |
| Viewer pan | `dragging` in `src/viewer/main.ts` | Dragging or not | One gesture, with its own cancel. |

## Known wrinkle

`state.sync` is derived from the counters except in three places that write
`"dirty"` directly: first run with no stored document, a failed save and a
cancelled one. A failed save of an unchanged document therefore reads "Unsaved
changes" until the next edit or switch, though the close guard correctly stays
quiet. It only ever over-reports, so it is left alone.
