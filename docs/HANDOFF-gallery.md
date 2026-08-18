# Handoff — gallery topics: finish the job (T25b)

Instructions for the next agent. Written 2026-08-18. Everything below has been
checked against the code at commit `20ca655`; where something is **unverified**
it says so explicitly.

Repo: `C:\Users\39389\Documents\XuanZhi9\r-node` · branch `gallery-node`.

```
20ca655  Make a topic a tier list, ranked by dragging      <- to be REVERTED
f61c673  Fill a topic with a grid of captioned pictures    <- KEEP, this is the gallery
e6e011d  Run as a single instance, and ship it as 0.1.1    <- main
```

**Read `docs/AGENT_GUIDE.md` §1, §2, §3 before touching anything.** It is the
contract. The notes below do not replace it.

---

## 0. Working conditions

**Another session is editing this repo concurrently.** As of writing, these are
modified/untracked and are NOT yours: `src/dev/trace.ts`,
`src/editor/shortcuts.ts`, `src/persist/storage.ts`, `vite.config.ts`,
`src-tauri/Cargo.toml`, `docs/AGENT_GUIDE.md`, `docs/TRACER_COVERAGE.md`,
`tests/tracer2.test.ts`. Leave them alone, never `git add .`, and stage files by
name. If one of them changes under you mid-task, stop and say so.

Commands:

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run check:map
```

The dev server is `npm run dev` on `http://127.0.0.1:5173/`. The desktop shell
is `cargo tauri dev`.

---

## 1. Invariants you can break by accident

These have all been paid for once already.

- **I1 — one `<canvas>`.** There is never a DOM node per topic. Anything you
  draw for a gallery is drawn by `src/render/renderer.ts`. Do not reach for
  html2canvas or a div-based grid.
- **§3 parity contract.** The canvas and the Lexical editing overlay both render
  topic TITLES, and they must agree to within 0.5px; `dev/parity.html` measures
  it. **Captions are deliberately outside this**: they are plain strings drawn
  only by the canvas. The moment a caption becomes editable in an overlay, you
  own the parity contract for it. Task 5 below is specified to avoid that — keep
  it that way unless you are prepared to add harness cases.
- **I7 — every op carries its own inverse.** Gallery edits ride on `setStyle`,
  which already carries `prev`. Do not invent a new op type; undo works for free.
- **I9 — shared constants live once**, in `src/layout/measure.ts`, and are read
  by the measure, the renderer, the SVG export and the PDF export. A hand-copied
  number is how the canvas and an export start disagreeing.
- **`nodeImageIds` (`src/core/ops.ts`) is the root set of the asset garbage
  collector** (`referencedAssetIds` in `src/persist/assets.ts`) *and* decides
  which decoded bitmaps may stay in the renderer's cache. An asset id that is
  reachable from a node but missing from that function gets its bytes deleted.
  Both failures are silent and land long after the edit that caused them.
- **Layout is derived data** (I6): never put geometry in an op or in history.

---

## 2. Task 0 — remove the tier list, keep the gallery

The user prefers the gallery (the plain captioned grid) and wants the tier-list
node gone.

```bash
git revert --no-commit 20ca655
```

Then **put three things back before committing** — they were added in that
commit but have nothing to do with tier lists, and the gallery wants them:

1. `Renderer.renderNodeImage(...)` and `Renderer.preloadNodeImages(...)` in
   `src/render/renderer.ts` — renders ONE topic to a PNG/JPEG blob at 2x by
   redrawing it into an offscreen canvas. No DOM rasteriser is needed because
   of I1. It pre-decodes the pictures first, because the live paint path is
   fire-and-forget and an export that inherited that would produce a chart full
   of holes.
2. `setExportNodeImageHandler` / `runExportNodeImage` in
   `src/editor/exportBridge.ts`, and the handler registration in
   `src/ui/CanvasView.tsx` (it lives in the view because only the renderer can
   draw a node).
3. `EditorStore.downloadBlob` (public wrapper over the private `download`).

Then move the **PNG / JPEG buttons** from the deleted `TierListSection` into
`GallerySection` in `src/ui/Inspector.tsx`, so a gallery topic can be saved as a
picture. This was verified working: it produced a 1406x1059 PNG of one node.

`gridCells` in `measure.ts` was also added by that commit. It is a shared
"cards in a wrapping grid" helper. **Keep it** and use it in `galleryExtent`
(task 1) instead of the inline arithmetic there, or delete it — but do not leave
two implementations of the same grid.

Everything else from `20ca655` goes: `TierItem`/`TierRow`/`Style.tierList` in
`types.ts`, the tier branch in `nodeImageIds`, `tierListLayout` /
`positionedTierList` / the `TIER_*` constants in `measure.ts`, `drawTierList` /
`drawTierCell` / `wrapCardText` / `drawTierDrop` / `hitTestTierCell` /
`tierDropAt` in `renderer.ts`, all `*Tier*` methods in `store.ts`, the tier drag
wiring in `CanvasView.tsx`, `TierListSection` / `TierRowControls` in
`Inspector.tsx`, and `tests/tierList.test.ts`.

Check afterwards: `npm run typecheck`, `npm test`, `npm run check:map` all clean,
and `grep -ri tierlist src/ tests/` returns nothing.

---

## 3. Task 1 — five images per row, then wrap

Today `galleryExtent` (`src/layout/measure.ts`) computes the column count from
an available width (`MAX_GALLERY_W`, or an explicit `Style.width`). The user
wants a fixed default of **5 per row**, wrapping to a new line after that.

- Add `export const GALLERY_COLS = 5;` beside the other `GALLERY_*` constants.
- In `galleryExtent`, when `Style.gallery.cols` is absent use `GALLERY_COLS`
  instead of the width-derived fit. Keep the explicit `cols` override — the
  Inspector already exposes it.
- **Keep the rule that the column count is derived from the NODE ALONE**, never
  from the placed box. The column count decides the width, so reading the width
  back to decide the columns is a loop, and resolving that loop differently in
  the measure and in the painter is exactly how the canvas and the exports come
  to disagree. There is a test for this — "derives the columns from the node
  alone, never from the placed box" in `tests/gallery.test.ts`.
- Update the tests in `tests/gallery.test.ts` that assume width-based wrapping
  ("lays six default cells in one row", "wraps into an explicit node width").
  Six cells must now be 5 + 1 on two lines.

The Inspector's Columns field should show `5` as the default rather than `0/auto`.

---

## 4. Task 2 — drag an image file into a gallery from outside

**Status: implemented but never verified end to end. Verify first.**

`src/ui/CanvasView.tsx`, in the canvas `onDrop` handler, already has:

```ts
if (store.doc.node(target)?.style.gallery) {
  const rects = rendererRef.current?.galleryCellRects(currentRenderState(), target) ?? [];
  const at = galleryInsertIndex(rects, world.x, world.y);
  const res = await store.addGalleryImageFilesAt(target, [file], at);
  ...
}
```

Test it by dragging a PNG from Explorer onto a gallery topic. Things to check,
because none of them have been:

- Only **one** file is handled (`firstImageFile(e.dataTransfer.files)`). Dropping
  five files should add five. Fix by iterating, and keep it ONE undo step —
  `addGalleryImageFilesAt` already batches through a single `setStyle`, so
  collect the files and make one call, not one call per file.
- The drag ghost (`extDropSideRef`, `imageSlotWorldRect`) still speaks in terms
  of the four edge slots. Over a gallery topic it should preview the insertion
  gap instead — reuse the caret from `drawGalleryDrop` rather than inventing a
  second indicator.
- A drop on a topic that is NOT a gallery must keep its current slot behaviour
  untouched.

---

## 5. Task 3 — double click must not open the text editor on a gallery topic

A gallery topic's body is pictures; double-clicking it currently mounts the
Lexical overlay for the title, which the user does not want.

Follow the **code-topic precedent exactly** — it solves the identical problem
and there are two places, not one:

- `src/ui/CanvasView.tsx` `onDblClick` (~line 1143): there is already
  `if (store.sheet.nodes[hit]?.style.code) { store.select(hit); return; }`.
  Add `|| ...style.gallery` to the same guard.
- `src/editor/store.ts` `startEdit` (~line 1414) refuses code topics too, and
  `pasteToEdit` (~line 1445) mirrors it. Add the same refusal for gallery
  topics in both, with a `trace.ignored(...)` line like the code one.

Both matter: the CanvasView guard stops the overlay from starting to mount, and
the store guard is the actual invariant. A guard in only one of them leaves a
path (keyboard, paste) that still opens the editor.

**Decide and state what renaming a gallery topic looks like instead.** The title
still exists and is still drawn above the grid. The Inspector's Topic field
already edits it, so the honest answer is "rename it in the Inspector" — say so
in a `data-help-more` tooltip so it is not a silent dead end.

---

## 6. Task 4 — right-click → new gallery topic

`src/ui/NodeContextMenu.tsx` already has `New code topic` calling
`store.createCodeTopic(node.id)`. Add `New gallery topic` beside it.

Model `createGalleryTopic(parentId?)` on `createCodeTopic`
(`src/editor/store.ts` ~line 1801): create the node with one `createNode` op
whose `style` already carries `gallery: { items: [] }`.

One wrinkle: `putGallery` deliberately drops the field when `items` is empty, so
"a gallery with no pictures" is not a state it will preserve. Either

- seed the new topic with an empty gallery and relax that rule for a topic the
  user explicitly created as a gallery, or
- have the menu item create the topic and immediately open the file picker.

Pick one, and write down in the code WHY — the current rule exists so that
"not a gallery" and "a gallery of nothing" are not two states that
`galleryExtent` has to distinguish.

---

## 7. Task 5 — the caption under a picture must be selectable

The user wants to click the file-name caption under a picture and act on it.

**Do this the cheap way, and do not put an editor on the canvas.** Captions are
plain strings precisely so the §3 parity contract never applies to them; an
inline editable caption means a second renderer over the same text and a new set
of harness cases, for a one-line label at a fixed size.

Specified behaviour:

- `Renderer.hitTestGalleryCell` currently tests the PICTURE rect only. Extend it
  (or add a sibling) so the caption band under a cell is also a target, and
  report which of the two was hit.
- Clicking a caption selects that cell and focuses the matching caption input in
  the Inspector's gallery list, with the text selected so typing replaces it.
  `GalleryRow` in `src/ui/Inspector.tsx` is that input; give it a ref keyed by
  the selected cell index.
- Dragging from the caption should still drag the CARD, not start a selection —
  the existing pointer-down path already begins a cell drag, so make sure the
  caption hit joins that path rather than swallowing it.

If the user later insists on true inline editing on the canvas, that is a
separate task with a real cost: read AGENT_GUIDE §3 in full and add parity
harness cases, exactly as T24 accepts for shape-node labels.

---

## 8. Verification — do all of it, do not skip the app

1. `npm run typecheck` — clean.
2. `npm test` — all green. Update `tests/gallery.test.ts` for the 5-column
   default rather than deleting the assertions.
3. `npm run check:map` — clean.
4. `http://localhost:5173/dev/parity.html` — must report **0 diverging**. You
   are not changing the text path, so any divergence means you touched something
   you did not mean to.
5. **In the running app**, with real image files:
   - a gallery of 6 pictures shows 5 + 1 on two lines;
   - dragging a file in from Explorer adds it at the gap under the cursor;
   - double-clicking a gallery topic does NOT open the editor, and does open it
     on a normal topic;
   - right-click → New gallery topic works;
   - clicking a caption focuses its Inspector field;
   - the PNG button still saves the node as a picture.

The store is exposed as `window.__rnode.store` in dev, which is the quickest way
to drive the app from the console. Note that `window.viewSize` (1200x800) is
what the app maps pointer coordinates with, NOT the canvas element's
`getBoundingClientRect()` — they differ when the window is a different size, and
using the wrong one makes synthetic pointer events miss their target. This cost
an hour once.

---

## 9. Traps already paid for

- **The asset GC.** Adding any new place an asset id can live means updating
  `nodeImageIds`. See §1.
- **Extent cache.** `extentKey` in `measure.ts` lists everything the measure
  reads. A field missing there makes the layout silently reuse a stale size,
  which shows up as overlapping topics far from the cause. The gallery entry
  covers item count, cell size, columns and whether any caption exists — it
  deliberately does NOT include caption TEXT, so typing does not re-measure the
  sheet.
- **Exports read `pos.insets`.** `src/export/svg.ts` and `src/export/pdf.ts` were
  changed to place the title from `positionedImageSlots(...).insets` rather than
  re-deriving it from the image slots. Keep it that way: the grid reserves space
  from the bottom and only the insets know about it.
- **Tauri's global is frozen.** Unrelated to this work, but if you see a blank
  desktop window while the browser is fine, the fault is in a path that only
  runs under Tauri. `window.__TAURI__.core` is `Object.freeze`d, so assigning to
  `core.invoke` throws in strict mode; `window.__TAURI_INTERNALS__.invoke` is the
  unfrozen seam. A throw inside a `useEffect` unmounts the React tree and leaves
  a white window with no visible error.

---

## 10. Definition of done

- The tier-list feature is gone; `grep -ri tierlist src/ tests/` is empty.
- Single-node PNG/JPEG export survives, wired to the gallery section.
- Galleries wrap at 5 per row by default, with the explicit `cols` override
  still working and still derived from the node alone.
- Files dropped from outside land in the gallery at the cursor's gap, several at
  a time, in one undo step.
- Double click never opens the editor on a gallery topic, from any entry point,
  and the Inspector says where to rename it instead.
- Right-click offers `New gallery topic`.
- Clicking a caption focuses its Inspector field; the canvas still has no text
  editor over a caption.
- typecheck, tests, check:map and the parity harness all clean, and every item in
  §8.5 checked by hand in the running app.

Commit as one change with a message that says WHY, in the style of the existing
history (`git log` — read a few). Stage files by name; the working tree contains
another session's work.
