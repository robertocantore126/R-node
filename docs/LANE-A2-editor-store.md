# LANE A2 — The editor store (`src/editor/store.ts`, 3,458 lines)

Audit scope: exactly the one file I own, `src/editor/store.ts`. `src/core/*`
(types, ops, history, doc, text) is read-only reference and is unchanged by
anything proposed here. Invariants I4/I5/I6/I7 were checked against the code
and hold — see the verification section at the end.

---

## 1. "What the user is currently doing" is 14 fields in 4 families — and there is no active-mode value anywhere

The interaction state is not one value, not one family, but **four independent
families of nullable fields**:

| Family | Fields | Storage |
|---|---|---|
| Tool flag | `mode: "select" \| "pan"` | `EditorState` |
| Edit session | `editingId`, `pendingInsert` | `EditorState` |
| Edit session (continued) | `editingDraftRuns`, `editOriginal` | private class fields |
| Active gesture | `nodeDragState`, `resizeState`, `imageResizeState` | private class fields |
| Selection | `selection`, `relSel`, `groupSel`, `summarySel`, `imageSel`, `imageSlot` | `EditorState` |
| Transient display | `drop`, `hoverId` | `EditorState` |

Fourteen fields. **No single field, and no type-level construct, says what the
user is doing** — "editing vs. dragging vs. drawing a relationship vs. nothing"
is nowhere a first-class value. It is reconstructed by convention.

### The representable-but-forbidden combinations

Every pair below is *representable* by the types (each family is just nullable
fields; nothing stops the wrong two from being set), and each is *guarded
today* — but only by caller discipline, never by the store:

- **`editingId` live while a gesture is live.** `beginNodeDrag` (2070),
  `beginResize` (2409), `beginImageResize` (2487) do not commit the draft and
  do not clear `editingId`. The guard lives entirely in CanvasView's
  pointerdown handler, which calls `store.select(...)` *after* `beginResize`
  / `beginImageResize` and *before* `beginNodeDrag` (CanvasView 601–685), and
  `select()` is what commits the draft. Move one call in CanvasView and an
  edit coexists with a drag.
- **`editingId` live while `relFrom` is set.** `beginRelationship` (2919)
  commits nothing and clears nothing. The guard is RichEditor's
  `onBlur → commitEdit()` firing before the Inspector/TopBar button's `onClick`.
- **`editingId` live alongside an overlay selection.** `startEdit` (1268)
  clears `imageSel`/`imageSlot` but **not** `relSel`/`groupSel`/`summarySel`.
  A dual selection (node + relationship) is representable; only the
  click-before-double-click ordering in CanvasView/Outliner masks it today.
- **Node selection alongside overlay selection.** Every setter manually nulls
  the other four kinds before setting its own. There are ~10 hand-written
  copies of this block (select, selectMany, clearSelection, selectImage,
  startEdit, selectRelationship, selectGroup, selectSummary, deleteNodes,
  deleteSelectedRelationship, deleteGroup, deleteSummary). Two have already
  drifted: `deleteNodes` never clears `editingId`/`pendingInsert`; `startEdit`
  misses the overlay trio. Both are currently masked by event ordering.
- **`imageSlot` set while `imageSel` is null.** The type allows it; every
  writer happens to clear both. Worse, `imageSlot: null` and
  `imageSlot: "top"` are the *same value* — every reader writes
  `this.state.imageSlot ?? "top"`. The slot field is redundant with its
  default.

### Honest verdict on reachability

I traced every entry point (CanvasView pointerdown 560–719, RichEditor blur,
Outliner row, Inspector/TopBar buttons, shortcuts.ts). **I found no live,
user-reachable corruption today.** Every path that could produce a forbidden
combination is intercepted by one of three mechanisms, none of them inside the
store:

1. The canvas pointerdown funnel — every gesture is preceded in the *same
   synchronous handler* by `select()`/`selectImage()`/`clearSelection()`,
   which commit the draft before the gesture state becomes observable.
2. The overlay's `onBlur → commitEdit()` — catches non-canvas clicks
   (Inspector, TopBar, Outliner).
3. Pointer lifecycle — a held drag cannot overlap a double-click; the Outliner
   row's `click` fires before its `dblclick`; the overlay occludes the node
   box so handles are unreachable while editing.

So this is **"guarded by convention", not "guarded by structure"** — and the
convention has already started to decay (the two drift sites above). Per the
audit brief I will not manufacture a live-bug claim; the finding is
structural, and it is the strongest structural finding in the file.

### The canonical fix: one active-mode union

Collapse the four families into three discriminated unions, each of which
makes the forbidden combinations **unrepresentable**:

```ts
// 1) The selection — 6 fields → 1
type Selection =
  | { kind: "none" }
  | { kind: "nodes"; ids: string[] }
  | { kind: "rel" | "group" | "summary"; id: string }
  | { kind: "image"; nodeId: string; slot: ImageSlot }; // slot always "top"|"bottom"|"left"|"right" — null-≡-top disappears

// 2) The gesture — 3 private fields → 1
private gesture: { kind: "node-drag"; nodeId: string; origPos: Position }
               | { kind: "resize"; nodeId: string; original: Style; origPos: Position }
               | { kind: "image-resize"; nodeId: string; original: Style }
               | null = null;

// 3) The edit session — 4 fields across two storage locations → 1
private edit: { id: string; draft: TextRun[]; original: { title: string; titleRuns?: TextRun[] } } | null = null;
// (pendingInsert stays a separate transient: it only ever exists between
//  typeToEdit() and the overlay mount, consumed once.)
```

The ~10 duplicated reset blocks collapse into one `setSelection(sel)` that
assigns the union; `startEdit`, `beginNodeDrag`, `beginResize`,
`beginImageResize`, `beginRelationship` become exhaustive switches that
reject or abort the wrong incoming mode by construction. The consumers that
branch on the four kinds today (CanvasView hit-test precedence 654–710,
shortcuts.ts delete precedence, Inspector's `rel`/`grp`/`sum` resolution)
switch on `selection.kind` once instead of probing five nullable fields.

Cost: `EditorState` is public and read by every panel, so this is a
medium-sized mechanical refactor across ui/ + shortcuts.ts (Lane C/D
territory) — the shape change itself is owned by this file.

---

## 2. Command dispatch does not branch on op kinds in the store — but the selection-kind precedence is duplicated in three consumers

Within `store.ts` there is **no dispatch table over strings or op kinds**:
commands are class methods, and each method builds its own ops with `makeOp`.
`undo()`/`redo()` apply history entries without switching on `op.type`.
So the "add a command ⇒ edit several switches" hazard does *not* exist inside
this file for op kinds.

The real duplication is the **selection-kind precedence chain**, which the
six-field selection forces three separate consumers to re-encode:

- `shortcuts.ts` delete case: `imageSel → relSel → groupSel → summarySel → deleteSelection`
- `CanvasView.tsx` pointerdown: `relFrom? → resize → image-resize → image-slot → rel → group → summary → node → empty`
- `Inspector.tsx`: resolves `rel`/`grp`/`sum` from the three fields separately

Adding a new selectable kind (a callout, a zone) today means editing the
store's state + reset blocks + four `selectX` methods, plus all three consumer
chains. With the §1 union, each consumer gets one `switch (sel.kind)`.

Minor, within-store: the **"release manual position" op** is hand-rolled in
four places — `createParent` (1724), `promote` (1771), `demote` (1795), and
`releaseManualPosition` (which exists as a helper but is only called by
`dropAt`, 1959/1983). `setBranchFreePosition` (2541) and `commitResize` build
close variants. Extract the four callers onto `releaseManualPosition`.

---

## 3. The editing draft's lifecycle is reconstructed from four nullable fields

`startEdit`/`typeToEdit` set four things: `state.editingId`,
`state.pendingInsert`, `private editingDraftRuns`, `private editOriginal`.
`commitEdit` (1395) nulls all four *up front*, then bails if any was missing
(`if (!id || runs === null || !original) return;`) — a null-out-then-abort
shape that turns a desync into a silent no-op rather than an error. The
invariant "`editingId` set ⟺ draft + original set" is maintained by convention
across two storage locations (one in `EditorState`, two private).

Drift evidence: `setEditingDraft(text: string | null)` (1345) — the plain-text
shim whose `null` branch desyncs `editingDraftRuns` without touching
`editingId` — has **no callers** (RichEditor uses `setEditingDraftRuns`).
It is dead code today; if ever called with `null` mid-edit, the next
`commitEdit` would silently discard the draft while the node keeps its
ephemeral title, with no op and no restore. Remove it.

The §1 union (one `private edit` object, `pendingInsert` as the only separate
transient) makes the lifecycle a single value: `edit === null` means "not
editing", and commit/cancel are `if (!this.edit) return`.

---

## 4. Re-scan question — no maintained index is warranted; the honest answer is "no"

The candidates for "re-scans all nodes on every change":

- `navigate()` (3158), `mapBounds()` (3138), and `dropAt`'s floating branch
  (1987) call `layoutSheet()` synchronously — a full layout pass. But these
  are **one-shot user events**, not per-change scans, and positions are
  *derived data* (I6): an index would have to be invalidated on every op,
  and the store's own `notify()` comment documents why identity-keyed caches
  over in-place-mutated nodes serve stale geometry forever. An index would
  add more machinery than it removes.
- `setSearch` re-walks `visibleIds` per keystroke — but the query changed, so
  the recomputation is correct; caching title/notes→ids would need
  maintenance on every `setTitle`/`setNotes` op.

The 30ms `applyLayout` on every draft change is the layout engine reflowing
all nodes while typing — inherent to I6's "layout is derived, recomputed,
debounced" design, and the engine lives outside my boundary (`src/layout/`).
**Finding: none.**

---

## Invariants verified (constraints that bind this file specifically)

- **I4** — Undo/redo live only here: `undo()`/`redo()` (178–192) are the only
  callers of `history.undo()`/`history.redo()`; RichEditor has no
  HistoryPlugin (verified — it is a pure draft generator pushing TextRun[]).
- **I6** — Layout never enters an op: `scheduleLayout`/`settleLayoutNow`
  only call `applyLayout` + `notify()`. The draft/resize/drag live mutations
  (`applyDraftRuns`, `setResizeDraft`, `setNodeDragDraft`) are ephemeral
  in-place mutations with no op and no history entry until their single
  commit — exactly as the invariants demand. `saveNow` commits the draft via
  `commitDraftKeepEditing()` before persisting, so a mid-edit save still
  records the text as a real op.
- **I7** — Ops carry inverse data: every `makeOp` site passes `prev` /
  `prevRuns` / `prevOrder` / `prevImageId` / `prev: { ...position }` / the
  full old object; verified across setTitle, setStyle, setPosition, moveNode,
  sortSiblings, setGroup/Summary, setAttachments.
- **I5** — `node.title === runsToPlain(node.titleRuns)`: maintained in
  `applyDraftRuns` (both assigned from the same `clean`), in `setTitle` op
  construction (`plain = runsToPlain(clean)`), and in `restoreOriginal`
  (restores the previously-consistent pair). No violation found.
- Undo batching is already atomic (`execOps` → one `history.push(ops,
  inverses)` per batch) — not touched, per the brief. No saveTimer/autosave
  exists; only `layoutTimer` — nothing proposed here interacts with that.

---

## Findings summary (ranked)

1. **Strongest structural finding — the store has no active-mode value.**
   14 interaction fields in 4 families; the "editing vs. dragging vs. drawing
   vs. selecting vs. nothing" distinction is reconstructed by convention.
   Forbidden combinations are representable and only guarded by caller
   discipline (canvas pointerdown funnel + overlay blur commit + pointer
   lifecycle), with two drift sites already present (`startEdit` leaves the
   overlay sels; `deleteNodes` leaves `editingId`/`pendingInsert`). Fix: the
   three discriminated unions in §1. **Honest caveat: no live, user-reachable
   corruption found — this is a robustness/structural fix, not a bug fix.**
2. Selection is six fields that encode one union, forcing ~10 duplicated
   reset blocks (two drifted — `deleteNodes` at 1835 never clears
   `editingId`/`pendingInsert`; `startEdit` at 1268 leaves the overlay trio)
   and three duplicated consumer precedence chains (§2). Folded into finding
   1's fix.
3. Edit-session lifecycle is four nullable fields across two storage
   locations with a null-then-bail `commitEdit`; plus dead `setEditingDraft`
   (§3).
4. Minor: `imageSlot: ImageSlot | null` where null ≡ "top" (§1); the
   "release manual position" op duplicated in four sites (§2).
5. No maintained-index finding (§4).

## CROSS-BOUNDARY

No change to `src/core/types.ts` or `src/core/ops.ts` is required for any
finding here. The unions in §1 are purely a change to this file's
`EditorState` shape (and the private fields), which this file owns; the op
layer is untouched because ops carry ids and inverse data, never selection
or gesture state. The ripple is downstream into the consumers that read the
six selection fields (CanvasView, shortcuts.ts, Inspector, TopBar, Outliner
— Lanes C/D) — they switch on `selection.kind` instead of probing five
nullable fields. The `setEditingDraft` removal and the
`releaseManualPosition` consolidation are entirely within this file.
