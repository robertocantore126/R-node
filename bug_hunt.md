# r-node — Bug Hunt

> Deep static/dynamic investigation of the r-node codebase.
> Scope: branch `image-editing-parity` @ `a433fc5`. A concurrent session's layout-settle work (committed as `a433fc5`, touching only `store.ts` layout timing + a new test) was excluded from this analysis; all findings were re-verified against the current HEAD and the cited code is unchanged. No project files were modified; hypotheses were verified with throwaway probe tests run outside the repo (removed afterwards) and by code tracing.

## Summary

- Scan status: complete pass over all 47 source modules (~14.8k lines) + test suite (19 test files, 256 tests)
- Files inspected: all of `src/` (core, editor, render, layout, persist, export, ui, dev, viewer)
- Tests inspected: `tests/*.test.ts` (store, ops, renderer, layout, measure, validate, assets, exportBridge, exportSvg, image*, pasteSanitizer, lexicalRuns, tauriAdapter, viewport, colors, perf)
- Confirmed bugs: **4**
- Probable bugs: **4**
- Suspicious areas: **6**
- Critical: 0
- High: 2
- Medium: 5
- Low: 1

Verification methods used:
- Static tracing of execution paths (input → validation → transformation → state → side effects → output).
- Runtime probes (vitest, throwaway files under `tests/`, deleted immediately after): confirmed the Shift+Tab mapping, the missing layout placement for floating subtrees, and the layout-engine stack overflow on a cyclic tree.
- Cross-module contract checks (ops vs store vs layout vs renderer vs exports).

---

# Confirmed Bugs

## [HIGH] — BUG-001 — Desktop: saving after creating/deleting a document overwrites the `.rnode` file with whatever document is active

**Confidence:** HIGH

**File:** `src/editor/store.ts`
**Line:** 583–595 (`performSave`), 639–673 (`saveAsDesktop`), 3129–3143 (`deleteDocument`); `src/persist/storage.ts:220` (`TauriStorageAdapter.save`)

### Bug

On desktop the document **is** a single `.rnode` file (`TauriStorageAdapter`), but the store allows multi-document flows that end in the *active* document being written over the file that previously held a *different* document. `deleteDocument` and `newDocument` never touch the adapter root, so a subsequent Ctrl+S writes whatever `this.model.doc` is at that moment into the remembered file path — destroying the previous file's content.

### Root Cause

`performSave` (desktop branch) always does `this.adapter.save([this.model.doc])` — one document, the active one, into `adapter.currentPath`. Nothing ties the file back to the document it was created from. The web path saves all docs (`this.adapter.save(this.state.docs)`); the desktop path deliberately saves one, but nothing prevents the user from having several docs in `state.docs` (sample + opened + new) or from deleting the active one.

### Execution Path

1. `newDocument()` (TopBar "+ New") → `state.docs = [old, blank]`, `activeDocId = blank`, adapter root **unchanged**.
2. Ctrl+S → `performSave` → `hasRoot === true` → `syncFileNameToTitle()` renames the old file to the blank doc's title → `adapter.save([blank])` writes the blank document **into the old file**.
3. The original document's content is gone from disk. Restart → `load()` returns the blank doc.

Same path with `deleteDocument(activeId)` → the file is overwritten by the next save (the tooltip only promises "Removed from app storage", not file destruction).

### Trigger

Desktop build. Create a new document (or delete a document) and then press Save, while a real `.rnode` file is the current root.

### Observed Behavior

The previous document is silently replaced on disk by the newly active one.

### Expected Behavior

Either each document gets its own file (save-as per doc), or the multi-doc UI is disabled/guarded on the single-file backend so a save can never clobber a different document.

### Impact

Permanent loss of the open document — the worst class of bug this investigation targets. No confirmation, no warning, no recovery (undo cannot reach disk).

### Evidence

`saveAsDesktop`'s own comment admits the hazard ("the sidebar may still carry the never-saved sample, and saving it over the chosen file would corrupt the document on disk") — the guard only covers the sample, not user-created or deleted docs. `deleteDocument` (3129) and `newDocument` (3099) do not reset `adapter.setRoot(null)`.

---

## [HIGH] — BUG-002 — A topic dropped onto a floating topic disappears: the whole subtree is invisible and omitted from every export

**Confidence:** HIGH (verified with a runtime probe)

**File:** `src/render/renderer.ts:226` (`computePlacement`), `src/layout/mindmap.ts:121–137, 182–262` (`subtreeHeight`/`placeMindmap`), `src/editor/store.ts:1826` (`dropAt`, "child" mode)

### Bug

A floating topic (created with double-click on empty canvas) can accept a child via drag & drop ("child" drop mode), and the model explicitly blesses that shape — `validateSheet`'s comment calls "a child dropped onto a floating topic … a legitimate document". But the renderer, the layout engine and every export only ever walk (a) the tree from the root and (b) nodes with `type === "floating"`. **Children of a floating topic are never placed, never drawn, never hittable, never counted, never exported.**

### Root Cause

- `computePlacement` BFS starts at `rootNodeId`; the second pass adds only `n.type === "floating"` nodes, not their descendants.
- `layoutSheet` never visits floating subtrees (mindmap/hierarchical placers walk from the root only; only `freeform` iterates every node), so the dropped child receives no layout position.
- `dropAt` mode `"child"` has no guard on the target's type — only `isDescendant` and existence are checked.

### Execution Path

`dblclick empty canvas → createFloatingAt` → drag any topic over the floating topic → drop indicator (mode "child") shown → release → `commitNodeDrag → dropAt(mode "child")` → `moveNode` with `toParentId = floatingId` → node is now a child of the floating topic → next render: node not in `placed` → **invisible**. The SVG export (`placeAll`, second pass `if (seen.has(node.id) || node.parentId) continue`) drops it too.

### Trigger

Drag any topic onto a floating topic. Verified: `layoutSheet` assigns **no position** to either the floating topic or its child (probe), while `validateSheet` passes on the same document.

### Observed Behavior

The dropped topic (and its subtree) vanishes from the canvas; the user cannot select it (not hittable), cannot find it in search (`visibleIds` walks from root), and it is missing from PNG/SVG/HTML/PDF exports and the outliner. Only undo brings it back.

### Expected Behavior

Either floating topics can host children (render/layout/export them), or the "child" drop onto a floating topic is rejected with feedback — the current state offers a drop that silently swallows content.

### Impact

Core drag & drop produces wrong results: dropped content effectively disappears from the document's visible state. High, because it is realistic during normal use.

### Evidence

Probe: `positions.has(floatingId) === false`, `positions.has(childId) === false` for a valid sheet containing a floating topic with a child; `validateSheet` does not throw. Renderer: `renderer.ts:226` second pass adds only `type === "floating"`.

---

## [MEDIUM] — BUG-003 — Shift+Tab performs "create child" (same as Tab); the promote command is unreachable from the keyboard

**Confidence:** HIGH (verified with a runtime probe)

**File:** `src/editor/shortcuts.ts:73`

### Bug

The combo builder explicitly excludes `Tab` from the Shift modifier:
`if (e.shiftKey && !["Tab", "ArrowUp", ...].includes(e.key)) parts.push("Shift")`.
For Shift+Tab the resulting combo is `"Tab"`, which resolves to `"create-child"` — so Shift+Tab **creates a child**, exactly like Tab, and the entry `"Shift+Tab": "promote"` in `DEFAULT_SHORTCUTS` is dead code.

### Root Cause

Two contradictory definitions in the same initial commit: the exclusion list treats Tab like the arrow keys (modifier ignored), while the key map defines a distinct Shift+Tab action. The exclusion wins.

### Execution Path

`keydown(Shift+Tab)` → `handleShortcut` → combo `"Tab"` → action `"create-child"` → `store.createChild()`.

### Trigger

Any keypress of Shift+Tab with a topic selected.

### Observed Behavior

A new empty child topic is created (probe: `calls: ['createChild']`). `promote()` is only reachable via the Inspector button or the Palette item.

### Expected Behavior

Shift+Tab should call `store.promote()` (per the key map, the Palette hint "Shift+Tab", and the README's "Enter/Tab/Shift+Tab to create and structure topics").

### Impact

Keyboard workflow broken; wrong action executed. Recoverable via undo, but surprising and silently wrong.

### Evidence

Probe: `handleShortcut(store, {key:"Tab", shiftKey:true})` → `createChild`. The exclusion list also swallows Shift for the arrow keys — that part looks intentional; the `Tab` entry is the defect.

---

## [MEDIUM] — BUG-004 — Importing a malformed (cyclic) `.rnode.json` crashes the app: layout engine stack overflow; several uncapped tree walks hang

**Confidence:** HIGH (verified with a runtime probe)

**File:** `src/layout/mindmap.ts:121–137, 182–262, 297–380` (recursions); `src/editor/store.ts:1057–1077` (`importDocumentFromJson`/`validateImportedDoc` — no topology validation); `src/core/doc.ts:75–118` (`visibleIds`, `depth`, `branchRootId`); `src/editor/store.ts:3183–3189` (`toMarkdown`), `2414–2432` (`outlineText`); `src/render/renderer.ts:736` (`hiddenCount`); `src/core/tree.ts` (`isDescendant`)

### Bug

`importDocumentFromJson` sanitizes types but never runs `validateSheet` (topology). A document whose `childrenIds`/`parentId` form a cycle passes import, and the first `applyLayout` (30 ms after import, via `scheduleLayout`) recurses forever in `subtreeHeight` → **`RangeError: Maximum call stack size exceeded`**. Even where the layout survives (e.g., a floating-only cycle), `toMarkdown`, `outlineText`, `visibleIds`, `hiddenCount`, `isDescendant`, `DocumentModel.depth` and `branchRootId` either recurse without a guard or loop without a hop cap on cyclic trees.

### Root Cause

`validateImportedDoc` (1077) rebuilds nodes but performs no reachability/cycle check, and the import path is the only route a foreign document takes into the model. Additionally, `validateSheet` itself only runs in dev (`execOps`: `if (import.meta.env?.DEV ?? true)`), so in a production build even *internally generated* corruption is never caught and reaches these walks.

### Execution Path

`Open .rnode.json (cyclic) → loadFile → importDocumentFromJson → switchToDoc → scheduleLayout → (30ms) applyLayout → layoutSheet → subtreeHeight → subtreeHeight → … → RangeError`.

### Trigger

Opening a hand-edited or third-party `.rnode.json` that contains a parent/child cycle (or a cycle involving the root).

### Observed Behavior

Probe: `layoutSheet` on a 2-node cycle throws `RangeError: Maximum call stack size exceeded`. The app's layout timer throws on every run; `exportMarkdown`, search, and navigation crash synchronously.

### Expected Behavior

Import should validate topology (`validateSheet`) and reject the file with a clear message; all tree walks should be cycle-safe (visited set) or hop-capped regardless of environment.

### Impact

App crash/hang on plausible input; in production builds the safety net is compiled out entirely.

### Evidence

Probe reproduced the stack overflow. The codebase already contains the right tool (`validateSheet`) — it is simply not invoked on import.

---

# Probable Bugs

## [MEDIUM] — BUG-005 — Orphan GC can delete image blobs still referenced by other open documents (web, multi-doc)

**Confidence:** PROBABLE

**File:** `src/editor/store.ts:2196` (`gcOrphans`), `src/persist/assets.ts:219–233` (`collectOrphans` / `referencedAssetIds`)

### Bug

The asset store is a singleton shared by **all** documents (content-addressed), but `collectOrphans(sheet, store)` computes reachability from the **current sheet only**. On the web build, where `state.docs` can hold several documents in one localStorage/IndexedDB, running "Collect orphaned images" while document B references an image that document A does not → the GC reports it as an orphan and deletes the blob → document B's image is broken, silently.

### Root Cause

`referencedAssetIds(sheet)` (assets.ts:206) is single-sheet; the GC confirmation only counts the current sheet's orphan cards/blobs. The multi-document ownership of blobs is never considered.

### Trigger

Web build, two documents sharing an image, GC command run while the non-owning document is active.

### Observed Behavior

Blob deleted; the other document keeps its attachment card but its image no longer decodes (renderer shows a broken slot).

### Expected Behavior

GC must consider the union of all open documents' referenced ids (or run per-document with a warning).

### Impact

Silent image loss in another document. Not reproduced at runtime; code path is unambiguous.

---

## [MEDIUM] — BUG-006 — Starting an export while a save is in flight cancels the save (long-op controller collision)

**Confidence:** PROBABLE

**File:** `src/editor/store.ts:343–355` (`beginLongOp`), `:908` (`writePortableZip`), `:358–359` (`beginExport`); `src/ui/CanvasView.tsx` (SVG/HTML/PDF handlers call `beginExport`)

### Bug

`beginLongOp` unconditionally aborts the previous operation (`this.opAbort?.abort()`). Exports and the portable zip save share this single controller. A user who presses Ctrl+S (zip save with images, cancellable, runs for seconds) and then clicks any export (SVG / viewer / PDF) triggers `beginExport` → the save's AbortController is aborted → `buildRnodeZip` throws AbortError → `performSave` reports **"Save cancelled"** even though the user never cancelled — and the queued re-run is dropped. The document stays unsaved.

### Root Cause

One global "long op" slot with abort semantics, shared by two unrelated user intentions. Exports never check the signal (so they are never actually cancelled), only the save is harmed.

### Execution Path

`Ctrl+S (zip) → beginLongOp(cancellable) → compress loop → [user clicks "Export ▾ → Interactive viewer"] → beginExport → opAbort.abort() → throwIfAborted in buildRnodeZip → AbortError → toast "Save cancelled"`.

### Trigger

Web build, image-heavy map (save takes >1 s), export started during the save.

### Observed Behavior

Save silently cancelled with a misleading toast; unsaved changes remain unsaved.

### Expected Behavior

Exports should not cancel a running save (queue, or a separate controller per op kind), and the cancellation should never be attributed to the user.

### Impact

Data not persisted when the user believes it was being saved. Race window small on desktop, realistic on web with images.

---

## [MEDIUM] — BUG-007 — Editing a rich-styled title in the Outliner or Inspector silently destroys all formatting

**Confidence:** PROBABLE

**File:** `src/ui/Outliner.tsx:60`, `src/ui/Inspector.tsx:63`

### Bug

Both plain-text editors commit with `titleRuns: plainToRuns(text)` — a single unstyled run. Any title containing bold/italic/color/headings/list structure (created through the Lexical canvas editor) is flattened to plain text the moment it is edited in the outline panel or the inspector. Undo restores, but a subsequent save persists the loss.

### Root Cause

These surfaces treat the title as a plain string and rebuild `titleRuns` from scratch instead of preserving/updating the existing run structure.

### Trigger

A node with styled text is edited in the Outline panel or Inspector title field.

### Observed Behavior

Formatting gone after blur/Enter.

### Expected Behavior

Either edit in a rich editor or preserve existing runs for unchanged segments.

### Impact

Real data loss (styling), limited to a secondary editing surface. Undo mitigates.

---

## [LOW] — BUG-008 — `toggleTaskComplete` destroys the task's progress value

**Confidence:** CONFIRMED

**File:** `src/editor/store.ts:2390–2395`

### Bug

`toggleTaskComplete` sets `progress: current.status === "completed" ? 0 : 100`. A task tracked at 40 % → toggle to completed → 100 → toggle back → 0. The original 40 % is unrecoverable (undo aside) — the value is *reset*, not *preserved*, so completing and un-completing a task loses its progress.

### Impact

Low: incorrect state on a secondary feature; undoable.

---

# Suspicious Areas

## SUS-001 — `normalizeBranchColors` is not applied on `switchToDoc`

**File:** `src/editor/store.ts` (`switchToDoc`, `normalizeBranchColors`)

### Why suspicious

`normalizeBranchColors` (which strips legacy palette *stamps* so depth-based fill inheritance works) runs in the constructor, in `init`, and in `importDocumentFromJson` — but **not** in `switchToDoc`. On the web multi-doc build, switching to a second document leaves its stamped fills in place, so `resolveFill` behaves differently per document (children keep the old soft tint even under a coloured branch).

### What needs verification

Whether the visual difference is user-observable with legacy documents, and whether a normalizing pass on switch is warranted.

## SUS-002 — `moveNode` op itself never validates the destination; only `dropAt` guards cycles

**File:** `src/core/ops.ts:130–151` (`applyOp` "moveNode")

### Why suspicious

`applyOp("moveNode")` happily moves a node into its own descendant — cycle creation is prevented only by the store's `dropAt`/`promote`/`demote` guards. Any future replay path (the op log is explicitly designed to feed a collaboration layer) or a hand-crafted op can build a cycle, and every uncapped walk in the codebase (see BUG-004) then hangs or crashes. The op layer itself carries no invariant.

### What needs verification

Whether collab replay is in scope; if so, cycle checks belong in `applyOp`, not only in the UI.

## SUS-003 — `execOps` leaves the sheet mutated when `validateSheet` throws (no rollback)

**File:** `src/editor/store.ts:359–368`

### Why suspicious

Ops are applied (mutating the sheet) before validation; an invariant violation throws after the fact, leaving a half-applied batch in memory and the batch already pushed to history. In dev the app keeps running on a corrupt tree; the only recovery is a reload.

### What needs verification

Whether any current caller can produce an op batch that violates invariants (probably not today), and whether validate-before-apply or rollback would be safer for the collab future.

## SUS-004 — `renameDocument` marks the document dirty even when the title did not change

**File:** `src/editor/store.ts` (`renameDocument`), `src/ui/TopBar.tsx` (title input `onBlur`)

### Why suspicious

Blurring the title field with no edit still sets `sync = "dirty"` and fires the desktop rename chain. "Saved" flips to "Unsaved changes" spuriously, and the file can be renamed for no reason.

### What needs verification

Whether the dirty flag matters beyond cosmetics (it gates the save-status UI; a save will then rewrite the file unnecessarily).

## SUS-005 — `openDb` caches a rejected promise on a transient upgrade block

**File:** `src/persist/assets.ts:60–77`

### Why suspicious

`req.onblocked` rejects the `db()` promise, and `dbPromise ??=` caches it forever: a blocked upgrade (another tab holding the old version) permanently bricks the asset store for the session, even after the block clears.

### What needs verification

Whether `onblocked` can realistically fire in this app (single-window desktop; web multi-tab possible), and whether the promise should be cleared on rejection.

## SUS-006 — Children of floating topics are also missing from search, outliner and counts

**File:** `src/core/doc.ts:75–85` (`visibleIds`), `src/ui/Outliner.tsx`

### Why suspicious

Consistent with BUG-002: the *whole* floating-subtree gap is systemic (layout, render, exports, search, outliner, counters all treat floating subtrees as non-existent). If the product intent is "floating topics are leaf-only", the drop UI must enforce it; if not, every consumer needs the floating-root walk.

### What needs verification

Product intent for floating subtrees; the fix then lands either in `dropAt` (reject child drops onto floating topics) or in every tree consumer.

---

# Investigation Notes

- **Node-width slider (Inspector)** fires one `setNodeStyle` op per `onChange` tick: a single drag produces dozens of undo entries and re-runs layout per tick, while the *image* slider correctly uses draft + single commit. Inconsistent history behaviour; a UX defect rather than a correctness bug.
- **Shift+arrow keys** deliberately ignore the Shift modifier (shortcuts.ts:73) — consistent with the exclusion list; only the `Tab` member of the list is wrong.
- **`DocumentModel.depth()` / `branchRootId()` / `isDescendant`** have no hop cap (doc.ts:87–118, tree.ts). Not reachable with valid trees, but they are the reason a single cycle freezes the UI (infinite loop, not crash) in `navigate`/`isDescendant` callers.
- **`setSearch`** has a dead ternary (`this.state.searchIndex = results.length > 0 ? 0 : 0;`) — both branches are 0.
- **`resetImageWidth`** writes `imageWidth: undefined` into the style object; harmless (JSON drops it, readers use `?? natural`).
- **`beginLongOp`/`endLongOp` symmetry**: when an export is started during a save (BUG-006), the *export's* `endLongOp` also clears the save's progress bar — cosmetic on top of the abort.
- **`toggleTaskComplete` in the Outliner** uses the same destructive progress reset as BUG-008 (outliner check button).
- **SVG export label chip** estimates width (`label.length * 7`) instead of measuring — cosmetic divergence from the canvas, deliberately documented in code.
- **`applyOp("setPosition")`** drops legacy `offsetX/offsetY` for ops that don't carry them (undo restores them); affects only pre-side-slot documents. Low impact, documented legacy fields.
- **Probe methodology**: temporary vitest file under `tests/__probe.test.ts`, executed and deleted; no project file was modified. The concurrent uncommitted changes to `store.ts` (layout settle) and `tests/layoutSettle.test.ts` belong to another session and were not analysed.

---

# Scan Coverage

## Inspected

- Core: `types.ts`, `ops.ts`, `doc.ts`, `history.ts`, `tree.ts`, `validate.ts`, `text.ts`
- Editor: `store.ts` (full), `exportBridge.ts`, `imageImport.ts` (+worker), `externalImage.ts`, `shortcuts.ts`, `context.ts`, `view.ts`
- Layout: `measure.ts`, `mindmap.ts`
- Render: `renderer.ts` (full), `theme.ts`, `viewport.ts`
- UI: `CanvasView.tsx` (full), `RichEditor.tsx`, `Palette.tsx`, `Inspector.tsx`, `Outliner.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `lexicalRuns.ts`, `pasteSanitizer.ts`, `imageDrop.ts`, `help.ts`, `HelpOverlay.tsx`
- Persist: `storage.ts`, `assets.ts`
- Export: `svg.ts`, `htmlViewer.ts`, `report.ts`, `viewer/main.ts`
- Dev: `trace.ts`, `stress.ts` (skim), `pdfProbe.ts` (skim)
- App shell: `App.tsx`, `main.tsx`
- Tests: 19 test files read/skimmed for coverage comparison

## Not fully verified

- `src/dev/pdfProbe.ts` and `src/dev/stress.ts` (dev-only, skimmed — not user-facing).
- Rich-text round-trip edge cases inside Lexical (StrictMode double-mount of the editor seed) — dev-only behaviour, inconclusive without running the UI.
- The Rust side (`src-tauri/`) — commands are trusted IPC boundaries; `classifyTauriReadError` and the IPC byte paths were reviewed only from the TS side.

## Areas requiring runtime verification

- BUG-001 (desktop save clobber) — code path is unambiguous, but a live two-document desktop session would confirm the UX impact.
- BUG-002 (floating subtree) — drop flow should be exercised in the app; the layout/placement side is probe-verified.
- BUG-005 (cross-document GC) — needs a two-document web session with a shared image.
- BUG-006 (export cancels save) — needs a slow zip save + export in a live session.
- SUS-005 (IndexedDB upgrade block) — needs two tabs opened simultaneously.
