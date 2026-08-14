# T23 — Shape library panel · implementation hand-off

A brief for one implementation session. Disposable: delete this file in the
commit that finishes the task.

**Branch:** cut a new one from the current HEAD.
**Contract:** `docs/AGENT_GUIDE.md` — read §1, §2, §3 and §6 first. This brief
does not replace it.

---

## What the user asked for

A library panel in the **lower half of the right column**, under the Inspector,
moving with it. In it: a button that opens a sheet to paste a subgraph, which
is then named and saved. Saved shapes persist in the panel and can be **dragged
onto the map**; the drag must land **on a topic**, and the shape is inserted as
that topic's child.

## The one assumption to confirm before starting

"Paste the code" means **an R-node subgraph in the format `copySelection`
already writes**:

```ts
{ app: "r-node", payload: { rootId: string, nodes: MindNode[], relationships: Relationship[] } }
```

This is deliberate and load-bearing: it is the same JSON the clipboard already
carries (`store.ts:2611`) and the same one `paste` already instantiates
(`store.ts:2770`). **Do not invent a second format.** It means the user can
build a shape by hand on the canvas, copy it, and paste it straight into the
library — and an LLM asked for a shape emits that same thing.

---

## What already exists (reuse, do not rewrite)

| Need | Already there |
|---|---|
| Subgraph serialisation | `copySelection` → `text/rnode` payload |
| Instantiating one under an anchor, with id remapping | the `paste` path, `store.ts:2770` |
| Fixed coordinates the layout will not move | `position.manual` — `mindmap.ts:71`, `:400` |
| Edges independent of the tree | `Relationship` (schema says so explicitly) |
| Drag-over-canvas with a ghost preview and node hit-testing | `CanvasView` `onDragOver`/`onDrop`, `acceptsExternalDrop`, `ensureExternalGhost` |
| Small user-level persistence in localStorage | `src/editor/recentColors.ts` — copy its shape exactly |
| Topology validation | `validateSheet` (T1) |

## Steps

### 1 — The library store

**File:** `src/editor/shapeLibrary.ts` (new)

```ts
export interface ShapeTemplate {
  id: string;          // slug, unique
  name: string;        // what the user typed
  createdAt: string;   // ISO
  payload: { rootId: string; nodes: MindNode[]; relationships: Relationship[] };
}

export function listShapes(): ShapeTemplate[];
export function saveShape(name: string, payload: unknown): ShapeTemplate; // throws on invalid
export function removeShape(id: string): void;
```

- One localStorage key, plain JSON, exactly like `recentColors.ts`: a read that
  throws must never break the panel, it returns an empty list.
- `saveShape` **validates before storing**: the payload must parse, carry
  `app: "r-node"`, and build a sheet that `validateSheet` accepts. A template
  that would corrupt a map must be refused at the door, with the reason, not
  when someone drops it three weeks later.

### 2 — The panel

**Files:** `src/ui/ShapeLibrary.tsx` (new), `src/App.tsx`, `src/styles.css`

The right column currently holds `<Inspector />` alone. It becomes a flex
column: Inspector on top (grows, scrolls), library below (fixed height, ~40%).

> **The trap, and it is not hypothetical.** Commit `cb5b5df` fixed exactly this
> class of bug in exactly this column: a grid/flex item keeps `min-height:
> auto`, refuses to shrink below its content, stretches its row, and the canvas
> beside it gets resized — clearing its buffer and panning the camera. Both new
> children need `min-height: 0`, and the library's own list needs
> `overflow-y: auto`. Verify with the canvas height before and after opening a
> shape list long enough to overflow: `.canvas-area` must not move by a pixel.

Contents: a **"+ Add shape"** button and the saved shapes as draggable rows
(name, topic count, a delete affordance).

### 3 — Add flow

Button → a sheet with a textarea, a Paste hint, and a name field. On confirm:
`saveShape(name, text)`. On failure show the validation message; do not save.

Reuse whatever modal styling exists (`HelpOverlay`, the palette) rather than
inventing a third dialog look.

### 4 — Drag onto a topic

Rows are `draggable`. On dragstart:

```ts
e.dataTransfer.setData("application/x-rnode-shape", template.id);
e.dataTransfer.effectAllowed = "copy";
```

In `CanvasView`:
- `onDragOver`: if the DataTransfer carries that type, hit-test the topic under
  the cursor. Over a topic → `store.setDrop({ mode: "child", nodeId: hit })` and
  `dropEffect = "copy"`. Over empty canvas → `dropEffect = "none"`: the user
  asked that a drop must land on a topic.
- `onDrop`: read the id, load the template, instantiate under the hit topic.
  Refuse on empty canvas **and say why** — `trace.ignored("drop:shape", "not
  over a topic")`. §4bis: a mute refusal is indistinguishable from a bug.

### 5 — Instantiate

**File:** `src/editor/store.ts`

```ts
insertShape(template: ShapeTemplate, anchorId: string): void
```

- Remap every id, exactly as the paste path does — **call into that code, do not
  duplicate it**. Two id-remappers will drift.
- The template's root becomes a child of `anchorId`; every node keeps
  `position.manual: true` so the layout leaves the geometry alone.
- **One `execOps` batch** — `history.push` makes one `HistoryEntry` per batch, so
  one Ctrl+Z removes the whole shape. Several batches would need N undos and
  would be wrong.
- Run `validateSheet` on the result before committing if the batch is built
  outside `execOps`; otherwise the dev-mode check in `execOps` already covers it.

---

## Definition of done (§6)

1. `npm run typecheck` → 0 errors.
2. `npm test` → all green, no new skips.
3. `.canvas-area` height and width are **unchanged** when the library panel
   fills and scrolls. Measure it, do not eyeball it — this is the bug the column
   already had once.
4. Parity harness only if you touch a §3 file. You should not need to.
5. At least one test that fails without your change. Suggested: `saveShape`
   refuses a payload whose `parentId` does not resolve; `insertShape` produces
   one history entry, not N.
6. No files outside the lists above.

## Do not

- Do not invent a second subgraph format, and do not add fields to the payload.
- Do not write a second id remapper.
- Do not store templates inside the document — this is a user library across
  documents, like recent colours.
- Do not make the shape a single opaque node. It is N native topics plus
  relationships; that is what keeps export, search, the outliner, undo and
  `validateSheet` working for free.
- Do not "fix" anything you notice in passing. Say it in the final message (§1.3).

## How this will be reviewed

1. `git diff`: files outside the lists → rejected.
2. The canvas-height measurement from §3 of Definition of done.
3. Negative controls: your new tests reverted one at a time.
4. One undo after a drop must remove the entire shape.
5. A malformed template must be refused by `saveShape`, with the reason shown.
