# R-node — Bug Hunt (branch `gallery-node` @ `602de9f`)

> **Status of this document: LIVE.** Every finding below was verified against
> the working tree at `602de9f` on 2026-08-19 — by reading the code and, where
> marked, by running a throwaway probe test (created under `tests/`, run, then
> deleted; the tree is clean). Nothing here is carried over untested from the
> earlier report. Findings the earlier report raised that are **now fixed** are
> listed under "Closed since the last hunt" and must not be re-reported.
>
> Baseline: `npm test` 496 passed (27 files), `npm run typecheck` 0 errors.
> No project files were modified by this investigation.

## Summary

| # | Severity | Finding | New? |
|---|---|---|---|
| 1 | **HIGH** | Opening any document strips headings, bullets and paragraph gaps from every title | new |
| 2 | **HIGH** | Changing a gallery's cell shape does not resize the topic; the grid spills out of its box | new |
| 3 | MEDIUM | Children of a floating topic are invisible on canvas and absent from SVG/PDF export | still open |
| 4 | MEDIUM | `Shift+Tab` creates a child instead of promoting; the palette advertises it anyway | still open |
| 5 | MEDIUM | Starting an export aborts an in-flight save | still open |
| 6 | MEDIUM | Renaming a topic in the Inspector or Outliner destroys its rich formatting | still open |
| 7 | MEDIUM | A cyclic `.rnode.json` crashes the app on import (`RangeError`) | still open |
| 8 | MEDIUM | Orphan GC deletes image blobs belonging to other open documents (web) | still open |
| 9 | LOW | A malformed `gallery` style crashes or produces an infinitely tall box | new |
| 10 | LOW | Dropping images into the middle of a gallery costs N+1 undo steps, not 1 | new |
| 11 | LOW | `toggleTaskComplete` discards the task's progress value | still open |
| 12 | NIT | HTML export filename does not strip backslashes (SVG and PDF do) | new |
| 13 | NIT | PDF export paints 8-digit hex colours grey | new |

---

# 1. [HIGH] Opening any document strips headings, bullets and paragraph gaps

**Files:** `src/editor/store.ts:115` (`sanitizeTitleRuns`), called from
`src/editor/store.ts:1234` (`validateImportedDoc`).

## Bug

`sanitizeTitleRuns` rebuilds every imported `TextRun` from scratch and copies
only `text`, `bold`, `italic`, `underline` and `color`. The three block-level
fields of `TextRun` — `fontSize` (headings), `paraGap` (paragraph boundary) and
`listIndent` (bullet depth) — are silently dropped.

Worse: once `paraGap`/`listIndent` are gone, `normalizeRuns` sees adjacent runs
as identically formatted and **merges them**, so two separate blocks collapse
into one run of text.

## Why this is bigger than the portable-file path

All three document-open flows funnel through `importDocumentFromJson` →
`validateImportedDoc`:

- `.rnode.json` open (`store.ts:1177`),
- `.rnode.zip` open (`store.ts:1172`),
- **`openDesktop()` — the desktop app's primary "Open a document"**
  (`store.ts:899`), which calls `this.importDocumentFromJson(JSON.stringify(doc))`
  on a document it has just read intact out of the `.rnode` file.

The normal restart path (`LocalStorageAdapter.load`) does *not* sanitize, so the
loss shows up only when a document is explicitly opened — and
`importDocumentFromJson` then sets `state.sync = "dirty"`, so **the next Ctrl+S
writes the flattened text back and the loss becomes permanent.**

Invariant I5 (`title === runsToPlain(titleRuns)`) still holds afterwards, so
nothing detects it.

## Verified (probe)

Authored runs, round-tripped through `importDocumentFromJson`:

```
AUTHORED: [{"text":"Big heading","fontSize":24,"bold":true},
           {"text":"body paragraph","paraGap":true},
           {"text":"first bullet","listIndent":1},
           {"text":"nested bullet","listIndent":2,"color":"#ff0000"}]

REOPENED: [{"text":"Big heading","bold":true},
           {"text":"body paragraphfirst bullet"},
           {"text":"nested bullet","color":"#ff0000"}]

I5 holds after import: true
```

Heading size gone, paragraph gap gone, both list indents gone, and two blocks
merged into a single run.

## Expected

Carry `fontSize`, `paraGap` and `listIndent` through the sanitizer with the same
type-guarding the other fields already get (finite positive number; boolean;
positive integer).

---

# 2. [HIGH] Changing a gallery's cell shape does not resize the topic

**Files:** `src/layout/measure.ts:979` (`extentKey`), consumed by `measureTopic`
(`measure.ts:1002`). UI trigger: `src/ui/Inspector.tsx:390-399`.

## Bug

`extentKey` is the measure cache key, and its own doc comment states the rule —
"a field missing here means the layout silently reuses a stale size". The
gallery contributes:

```ts
`${g.items.length}:${g.cellW ?? ""}:${g.cols ?? ""}:${anyCaption ? 1 : 0}`
```

`aspect` is **not** in the key — yet `galleryExtent` reads it
(`measure.ts:809-813`) to compute `cellPicH = round(cellW / aspect)`, which
drives the entire grid height. The Inspector's "Cell shape" `<select>`
(square / 4:3 / 3:4 / 16:9 / 2:3) calls `setGalleryLayout(nodeId, { aspect })`,
which changes *only* `aspect`. The key is unchanged, so `measureTopic` hands
back the cached box while the painter draws the new grid.

The cache is long-lived, so this is not theoretical: the store keeps one
measurer for its whole life (`store.ts:256`, used by `applyLayout` at
`store.ts:565`) and the renderer keeps another (`renderer.ts:92`).

## Verified (probe)

Three cells, `cellW: 96`, source pictures 200×100:

```
TRUE box h   square: 143.5   wide 16:9: 101.5     (distinct keys, no collision)

square -> wide : box h stays 143.5, grid now needs 54  -> 42px of dead space
wide -> square : box h stays 101.5, grid now needs 96
                 grid top y = -4.5   (the box top is y = 0)
                 the grid starts ABOVE the topic and overlaps its title
```

The cache also collides across *nodes*: two topics differing only in `aspect`
share one entry.

## Second-order effect

The SVG and PDF exports build a **fresh** measurer (`CanvasView.tsx:357`,
`:464`), so they compute the correct box. Change a cell shape and export: the
file's layout no longer matches the screen.

## Expected

Add `aspect` to the gallery segment of `extentKey`.

---

# 3. [MEDIUM] A subtree under a floating topic is invisible and unexported

**Files:** `src/render/renderer.ts:258-260`, `src/export/svg.ts:105-112`
(`placeAll`), `src/export/pdf.ts:226-233` (`placeAll`).

## Bug

All three traverse BFS from `rootNodeId`, then run a second pass to pick up
unparented nodes:

```ts
for (const n of Object.values(sheet.nodes)) {
  if (n.type === "floating" && !seen.has(n.id)) add(n);   // renderer
}
```

`add(n)` places the floating node — and never enqueues `n.childrenIds`. The
floating topic itself is drawn and exported; **everything beneath it is not.**

`src/core/validate.ts:105-107` already handles this correctly (it re-walks from
each floating node), which is exactly why the document passes validation while
being half-invisible.

## Verified (probe)

Floating topic → child → grandchild, built through the store's own
`createFloatingAt` / `createChild`:

```
total nodes in sheet : 27
nodes in SVG export  : 25
SVG has ZZFLOATING   : true
SVG has ZZCHILD      : false
SVG has ZZGRAND      : false
child pos : {"x":802,"y":500,"manual":false}
grand pos : {"x":1104,"y":500,"manual":false}
```

The children exist, carry real positions, are saved, and are counted by the
outliner and search — they are simply never traversed by the three painters.

`layoutSheet` also assigns them no position (it starts from the root only), so
they keep whatever `createChild` gave them.

---

# 4. [MEDIUM] `Shift+Tab` creates a child instead of promoting

**File:** `src/editor/shortcuts.ts:74`.

```ts
if (e.shiftKey && !["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) parts.push("Shift");
```

`Tab` is excluded from the Shift prefix, so Shift+Tab builds the combo `"Tab"`
and resolves to `create-child` (`shortcuts.ts:17`). The mapping
`"Shift+Tab": "promote"` on line 18 is dead configuration, and `store.promote()`
is unreachable from the keyboard.

`src/ui/Palette.tsx:49` shows the hint **"Shift+Tab"** beside "Promote topic",
so the UI actively teaches the broken key. Promote is still reachable through
that palette entry and the Inspector button (`Inspector.tsx:81`).

---

# 5. [MEDIUM] Starting an export aborts an in-flight save

**File:** `src/editor/store.ts:371-379` (`beginLongOp`), `:417-422` (`endLongOp`).

One `AbortController` and one `state.op` slot are shared by every heavy
operation, and `beginLongOp` opens with `this.opAbort?.abort()`.

- The `.rnode.zip` save (`store.ts:1038`) takes that signal and threads it into
  `estimateRnodeZip`/`buildRnodeZip`, which honour it. Clicking any export
  (`beginExport` → `beginLongOp`, `CanvasView.tsx:321/354/406/461`) while that
  save is running **cancels the save**.
- The reverse misfires differently: exports never read a signal, so a save
  started during an export does not stop it, but the export's `endExport()` in
  its `finally` clears the *save's* progress bar and nulls its controller.

---

# 6. [MEDIUM] Renaming in the Inspector or Outliner destroys rich formatting

**Files:** `src/ui/Inspector.tsx:75`, `src/ui/Outliner.tsx:60`.

Both commit with `titleRuns: plainToRuns(title)` — a single unstyled run. Any
bold, italic, colour, heading size, bullet or paragraph structure on that title
is discarded the moment the user changes one character in either plain-text
field. The op carries `prevRuns`, so Ctrl+Z restores it, but nothing warns.

---

# 7. [MEDIUM] A cyclic `.rnode.json` crashes the app on import

**File:** `src/editor/store.ts:1212` (`validateImportedDoc`).

`validateImportedDoc` checks shapes and types but **never calls
`validateSheet`**, so a document whose `childrenIds` form a cycle is accepted
and handed straight to the layout engine.

## Verified (probe)

A two-node document, `a → b → a`:

```
import THREW: RangeError: Maximum call stack size exceeded
```

Note the asymmetry: `src/editor/shapeLibrary.ts:209` *does* run `validateSheet`
on a shape template before storing it. A whole document currently gets less
checking than a five-node piece of clip art.

---

# 8. [MEDIUM] Orphan GC deletes blobs owned by other open documents (web)

**Files:** `src/editor/store.ts:2846` (`gcOrphans`),
`src/persist/assets.ts:426` (`referencedAssetIds`), `:444` (`collectOrphans`).

On web every document shares one IndexedDB (`DEFAULT_DB_NAME = "r-node-assets"`,
`assets.ts:78`; `getAssetStore()` returns a single shared instance).
`collectOrphans` lists **every blob in that database** and treats as orphan
anything not referenced by `this.sheet` — the *active* document only.

Documents accumulate (`newDocument`: `state.docs = [...state.docs, doc]`), so
running "collect orphans" with two documents open deletes the images of the one
that is not in front. The confirmation dialog warns that the blob deletion is
not undoable, and it is right.

Desktop is unaffected: `TauriAssetStore` keeps assets inside the current
`.rnode` file, so its scope already matches the document.

---

# 9. [LOW] A malformed `gallery` style crashes or produces an infinite box

**File:** `src/editor/store.ts:1240` — the importer casts style straight
through: `style: (typeof node.style === "object" && node.style ? node.style : {}) as Style`.

Nothing validates the gallery sub-object, and `galleryExtent` (`measure.ts:804`)
trusts it.

## Verified (probe)

```
cols: 0.5      -> {"w":-4,"h":null,"cellW":96,"cols":0,"rows":null,...}
                  (h and rows are Infinity; the measured box is h: Infinity)
items: "nope"  -> TypeError: g.items.some is not a function
```

`galleryExtent:818` does `Math.min(count, Math.floor(g.cols))` after checking
only `g.cols > 0`, so any fraction below 1 yields `cols === 0` and
`rows = ceil(count/0) = Infinity`. `gridCells` guards this with
`Math.max(1, cols)`; `galleryExtent` does not.

Not reachable from the UI — the Inspector's column input is guarded
(`Inspector.tsx:411`: `v > 0 ? Math.floor(v) : undefined`) — so this needs a
hand-edited or third-party-written file.

---

# 10. [LOW] A mid-gallery drop costs N+1 undo steps

**Files:** `src/editor/store.ts:2806` (`addGalleryImageFilesAt`), called from
`src/ui/CanvasView.tsx:1443`.

The call site promises otherwise:

> ALL dropped image files go in at once, as ONE undo step:
> addGalleryImageFilesAt imports through a single setStyle, so this is one
> call, not one call per file.

`addGalleryImageFiles` is indeed a single `setStyle`, but when the drop lands
before the end of the grid, `addGalleryImageFilesAt` then calls
`moveGalleryItem` once per imported file — and each of those is its own
`setNodeStyle` → `execOps` → its own `HistoryEntry`.

## Verified (probe)

Dropping 3 pictures at index 0 of a 2-cell gallery: **4 undo steps**, with the
intermediate states showing the pictures sliding into place one at a time.
(The ordering itself is correct: `["n0","n1","n2","a","b"]`.)

A drop at the end of the grid genuinely is one step.

---

# 11. [LOW] `toggleTaskComplete` discards progress

**File:** `src/editor/store.ts` (`toggleTaskComplete`).

```ts
progress: current.status === "completed" ? 0 : 100
```

Completing a task sitting at 60% overwrites it with 100; un-completing it writes
0 rather than restoring what it was. Undoable, but the original value does not
survive the round trip.

---

# 12. [NIT] HTML export filename does not strip backslashes

`src/ui/CanvasView.tsx:432` uses `/[\/:*?"<>|]+/g` — inside a character class
`\/` is just `/`, so backslash is not in the set. The SVG (`:386`) and PDF
(`:483`) siblings use `/[\\/:*?"<>|]+/g` and do strip it.

---

# 13. [NIT] PDF export paints 8-digit hex colours grey

`src/export/pdf.ts:194` (`rgb`) accepts only `#rgb` and `#rrggbb`, returning
`0.5 0.5 0.5` otherwise. `sanitizeTitleRuns` (`store.ts:128`) admits
`/^#[0-9a-fA-F]{3,8}$/`, so a run coloured `#rrggbbaa` survives import, renders
correctly on canvas and in SVG, and turns grey in the PDF.

---

# Closed since the last hunt — do not re-report

| Earlier finding | Status now |
|---|---|
| BUG-001 — desktop save overwrites another document's file | **Fixed.** Each document carries its own path in `docFilePaths` (`store.ts:215`), set on open/save-as and followed by `switchToDoc` (`store.ts:3897`). |
| Tauri global patching crashes the desktop window | **Fixed and documented.** `installTrace` wraps `wrapTauriInvoke` in try/catch with the frozen-`__TAURI__.core` explanation (`trace.ts:744-765`); the desktop simply records no `rust:*` events. |

# Checked and found correct

Recorded so the next pass does not re-derive them:

- `nodeImageIds` (`ops.ts:36`) already covers gallery cells, so the asset GC,
  the `.rnode.zip` writer and the renderer's bitmap cache all see them.
- `applyOp` for `setStyle` assigns a fresh object (`ops.ts:161`), so the `prev`
  reference an inverse depends on is never aliased (I7 holds).
- `preloadNodeImages` omits `this.dpr` from its bucket arithmetic, but
  `renderNodeImage` sets `this.dpr = 1` for the duration of the draw
  (`renderer.ts:1664`), so preload and paint agree on the cache key.
- `ellipsizeToWidth`'s binary search terminates and is shared by all three
  painters; `coverCrop` and `galleryInsertIndex` are correct at their edges.
- `moveGalleryCellTo`'s same-row index arithmetic is right, and its cross-node
  case really does emit both style writes in one batch.
- `installTrace` is properly gated behind the DEV flag (`trace.ts:739`).
- The SVG and HTML export data-URI providers call `meta()` before `get()`, so
  the blob's MIME type is never empty.
- The gallery import path (`addGalleryImageFiles`) has **no test coverage** —
  `tests/gallery.test.ts` exercises the geometry and the GC, never the import.
