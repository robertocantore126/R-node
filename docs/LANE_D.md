# LANE D — UI panels, text input, shapes — findings

Scope: the 15 owned files (RichEditor, pasteSanitizer, Inspector, shapeLibrary,
shortcuts, App, shapeArt, shapePrompts, recentColors, Outliner, Sidebar, TopBar,
Palette, NodeContextMenu, ShapeLibrary). All quotes verified in the current tree
(HEAD 5df321e). Cross-boundary items are flagged at the end.

---

## 1. VERIFIED — the same command is described three times (really four)

The shortcut map, the top bar and the command palette each carry their own copy
of the label, the human-readable key binding, the enablement rule and the
handler. The status bar and the sidebar add a fifth and sixth copy of the
*label*.

**Undo** — three sites, same store call:

- `src/editor/shortcuts.ts:26` — `"Mod+z": "undo"`, then
  `case "undo": e.preventDefault(); store.undo();`
- `src/ui/TopBar.tsx` — `title="Undo (Ctrl+Z)" disabled={!state.canUndo}
  onClick={() => store.undo()}`
- `src/ui/Palette.tsx:45` — `{ label: "Undo", hint: "Ctrl+Z", run: () =>
  store.undo() }`

**Save**:

- `shortcuts.ts:35` — `"Mod+s": "save"` → `store.saveNow()`
- `TopBar.tsx` — `title="Save (Ctrl+S)" … onClick={() => void store.saveNow()}`
- `Palette.tsx:34` — `{ label: "Save document", hint: "Ctrl+S", run: () => void
  store.saveNow() }`

**Fit view** — four sites:

- `shortcuts.ts:44` — `"Mod+1": "fit-view"` → `store.fitView(vw, vh)`
- `TopBar.tsx` (zoom-percent button) — `title="Fit view (Ctrl+1)"
  onClick={() => store.fitView(viewSize.w, viewSize.h)}`
- `Palette.tsx:44` — `{ label: "Fit map to view", hint: "Ctrl+1", … }`
- `App.tsx` StatusBar — the literal string `"Ctrl+1 to fit the map"`

**Zoom factor** — the same magic number in two files:

- `shortcuts.ts:188/191` — `store.zoomStep(1.2, vw, vh)` / `store.zoomStep(1 / 1.2, vw, vh)`
- `TopBar.tsx:97/103` — `store.zoomStep(1.2, …)` / `store.zoomStep(1 / 1.2, …)`

Also duplicated: create child/sibling/promote (Palette hints `Tab`/`Enter`/
`Shift+Tab` vs the shortcut map), search (`Mod+f` in shortcuts, `Search
documents…` hint `Ctrl+F` in Palette, the literal `(Ctrl+F)` in the Sidebar
placeholder), Open, New document, and the three panel toggles (each a TopBar
button AND a Palette item).

What lives where today:

- **Key binding** — single source in `DEFAULT_SHORTCUTS`, but the
  human-readable spellings (`"Ctrl+Z"`, `"Ctrl+S"`…) are hand-written strings in
  TopBar titles / `data-help`, Palette hints, Sidebar placeholder and
  StatusBar. Nothing ties them to the map: rebinding `"Mod+z"` today would
  silently leave every button label and palette hint wrong.
- **Enablement** — only TopBar has it: `disabled={!state.canUndo}`,
  `disabled={state.selection.length !== 1}` (Relationship),
  `disabled={state.selection.length < 2}` (Group). shortcuts.ts and Palette
  have no enablement (Ctrl+Z with nothing to undo no-ops silently inside the
  store).
- **Handler** — each site calls the store method itself.

NodeContextMenu is a fourth command surface whose actions (New subtopic, New
code topic, Delete, Change color) exist in neither the shortcut map nor the
palette.

**Fix (entirely in Lane D):** one command registry module
`{ id, label, keyHint, enabled(state), run(store) }`. `DEFAULT_SHORTCUTS`
already maps combo → action id, so it becomes combo → command id; TopBar,
Palette, StatusBar and NodeContextMenu render label/hint/enablement/handler
from the same entries, and the registry supplies the human-readable key hint so
it can never drift from the map. The store already exposes everything the
registry needs (`canUndo`/`canRedo`, selection counts, the command methods), so
no store change is required — see CROSS-BOUNDARY.

---

## 2. VERIFIED — "the current selection" is five store fields plus a view-only marquee, re-derived in every panel

The store's selection is fragmented across five fields
(`src/editor/store.ts:124-155`): `selection: string[]` plus `relSel`,
`groupSel`, `summarySel`, `imageSel` (and `imageSlot`). The setters keep them
mutually exclusive (`selectRelationship`/`selectGroup`/`selectSummary`, lines
2955-2991), but nothing in the type says so, and every panel re-derives its own
view of "what is selected":

- **TopBar** — `state.selection.length !== 1` (Relationship),
  `state.selection.length < 2` (Group).
- **StatusBar** (`App.tsx`) — `state.selection.length > 0` → "N selected".
- **Inspector** — `store.selectionNode` (the *last* id of `selection`) plus a
  defensive `!node && (rel || grp || sum)` precedence and its own "nothing
  selected" empty state.
- **Outliner** — `state.selection.includes(node.id)` per row.
- **NodeContextMenu** — right-clicked `nodeId` for Delete, but the whole
  `selection` for Change color (`store.setSelectionColor`, which loops
  `state.selection`).

A **sixth** representation exists during a marquee drag: the renderer
highlights via `marqueeSel` (`renderer.ts:54, 691`) fed from CanvasView, while
`state.selection` still holds the pre-drag set — panels and canvas disagree for
the duration of the drag.

The precedence "node wins, else relationship, else group, else summary" is
stated nowhere; the shortcuts Delete case re-implements it as `imageSel →
relSel → groupSel → summarySel → deleteSelection` (`shortcuts.ts:130-136`).

**Fix:** a single derived selection view
(`{ kind: "nodes", ids } | { kind: "relationship"|"group"|"summary"|"image", id
} | { kind: "empty" }`) computed once in the store and consumed by every panel.
The definition is a store (A2) change; the consumption is the Lane D half.
Without it, adding a sixth selection kind (e.g. a callout) touches TopBar,
Inspector, Outliner, StatusBar, shortcuts' delete, and the context menu.

---

## 3. VERIFIED — the shape catalog is enumerated three times and has already drifted

- `src/core/types.ts:47-56` — the `TopicShape` union, 10 values **including
  "cloud"** (and "custom").
- `src/ui/Inspector.tsx:8` — `const SHAPES: TopicShape[] = ["rounded", "rect",
  "capsule", "circle", "diamond", "hexagon", "underline", "none"]` — 8 values,
  **no "cloud"**.
- `src/editor/shapeLibrary.ts:51` — `const BASE_SHAPES = new Set<TopicShape>(
  ["rounded", "rect", "capsule", "circle", "diamond", "hexagon", "cloud",
  "underline", "none"])` — 9 values, has "cloud", no "custom".

They already disagree. Consequences in the current build:

- A topic can legally carry `shape: "cloud"`, and the shape library accepts it
  in templates (`normaliseStyle` keeps it — `shapeLibrary.ts:74`), but the
  Inspector dropdown cannot produce it. Worse, the controlled
  `<select value={node.style.shape ?? "rounded"}>` with no matching option
  *renders the first option ("rounded") as its label while the value stays
  "cloud"*: a cloud node is silently shown as rounded in the Style panel.
- The renderer has no "cloud" case in `traceShape` (`renderer.ts:807-837`) — it
  falls to the default `roundRect` — so "cloud" is a phantom shape today:
  accepted by the allow-list, unpickable in the UI, drawn as a plain box.
- "custom" is deliberately absent from both UI lists (a custom silhouette needs
  `shapeParts`), but nothing in the code says why.

**Fix:** one `TOPIC_SHAPES` constant exported next to the `TopicShape` type (or
from a Lane D module both files import), with the renderable set and the
"custom needs parts" exclusion documented once. Both enum sites are Lane D
files; the missing paint path is Lane B (see CROSS-BOUNDARY).

---

## 4. RichEditor — how the editing session's lifecycle is represented (the question asked)

State lives in the store, not the component:

- **Start.** `startEdit(id)` / `typeToEdit(text)` (`store.ts:1268, 1303`) set
  `editingId`, snapshot `editOriginal = { title, titleRuns }`, and seed the
  node with its own title via `applyDraftRuns(...)` so layout keeps measuring
  the topic at its current size until the editor reports its first change.
- **Mount.** One overlay at a time, keyed by `editingId` (CanvasView, I2).
  `DraftSyncPlugin` has exactly the two-effect shape §4 of AGENT_GUIDE
  requires: seeding is a **guarded** effect (a `seeded` ref, one run per
  overlay instance), the update listener is a **separate** effect so it
  survives StrictMode's mount → cleanup → mount without losing the listener.
  Seeding consumes `pendingInsert` (type/paste-to-edit) or falls back to the
  node's runs; every subsequent change is mirrored into the store via
  `setEditingDraftRuns` → `applyDraftRuns` — an ephemeral in-place node
  mutation (no op, no history) that keeps the 30ms layout and the canvas
  repaint tracking the text live.
- **Commit.** `onBlur` on the ContentEditable, Ctrl+Enter in `KeysPlugin`, or
  any selection change (`commitDraftOnLeave` runs before selection setters) →
  `commitEdit()`: ONE `setTitle` op with `prev: editOriginal` (undo restores
  exactly the pre-edit title), then `settleLayoutNow()` so the final geometry
  paints on the first frame. Unchanged content restores the original and
  records nothing.
- **Cancel.** Escape → `cancelEdit()` — restores the original title, no op.
- **Save while editing.** Ctrl+S → `commitDraftKeepEditing()`: a real `setTitle`
  op but the editor stays open, and the committed state becomes the new
  baseline for further Ctrl+S.

The draft never enters the history until commit; an empty committed title is a
valid state (the renderer draws a hint over it), by design — "clearing the text
used to delete the topic".

---

## 5. BUG in an owned file — the toolbar color picker erases font-size (RichEditor.tsx)

`src/ui/RichEditor.tsx:534-550`:

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
function clearColor(editor: LexicalEditor): void {
  ...
  if ($isTextNode(n)) n.setStyle("");
}
```

AGENT_GUIDE §4 names exactly this trap: "TextNode.setStyle() sostituisce
l'intera stringa di stile: usarlo per il colore cancella il font-size." Pasted
headings reach the editor as plain paragraphs whose TextNodes carry
`font-size: 21px` in their style string (`lexicalRuns.ts` `makeTextNode` writes
color and font-size into one style string). Picking a toolbar colour replaces
that whole string with `color: …`; on the next `editorStateToRuns`,
`textNodeToRun` finds no `font-size` and the heading silently shrinks to the
node size when the edit commits. `clearColor` erases the same runs.

**Fix:** `$patchStyleText(sel, { color })` and `$patchStyleText(sel, { color:
null })` from `@lexical/selection` (verified present in the installed package,
`dist/lexical-node.d.ts:45`, accepts `string | null`). RichEditor is a parity
file, so per AGENT_GUIDE §3 the change requires the parity harness at 0
divergences and a regression test that round-trips a font-size+color run
through the toolbar path.

---

## 6. pasteSanitizer verdict — genuinely irregular, not a rule-table candidate

The tag taxonomy is already table-shaped: `DROP_TAGS` and `BLOCK_TAGS` are
named Sets, heading sizes are a map, `cssColor`/`boldWeight` are normalisation
helpers. What remains is structural, not per-name: the Word `mso-list` marker
→ real `<ul><li>` surgery (regex + DOM stack), invalid `<ul><div>` recovery,
nested-list depth clamps, `br` → `\n`, and recursion into unknown elements. A
rule table would only re-encode the two Sets that already exist and cannot
express the list reconstruction. Two small notes: (a) the inline-format tag
list inside `buildClean` is an anonymous array in an `.includes()` call rather
than a named Set beside `DROP_TAGS`/`BLOCK_TAGS` — cosmetic; (b) the two-pass
design (`sanitizeHtml` then `htmlToRuns`) is justified, not redundant:
`htmlToRuns` alone would push `<script>`/`<style>` text into runs, and the
drop-tag pass is what removes them. No change recommended.

---

## 7. Minor — three bespoke popover-dismiss implementations

TopBar's Export menu (mousedown-outside + ref), NodeContextMenu (capture
`pointerdown` + Escape + wheel), and Palette (backdrop `pointerdown`) are three
hand-rolled "close on outside interaction" loops for the same job. Each has a
slightly different need (wheel-close only matters over the canvas), so this is
optional; if a shared hook is added, the wheel case is the one to keep.

---

## 8. Also observed — confirm intent

**NodeContextMenu delete vs color are asymmetric under multi-selection.** Change
color applies to the whole selection (`store.setSelectionColor`), Delete applies
to only the right-clicked node (`store.deleteNodes([node.id])`,
`NodeContextMenu.tsx:104`). The colour row documents its behavior
("right-clicking a topic already inside a marquee multi-selection keeps the
whole selection"); Delete's narrower scope is undocumented. It may be
deliberate ("topic-level" actions per the file header) — if so, it deserves the
same one-line comment the colour row has, because today the two rows in one
menu visibly disagree about what they act on.

---

## CROSS-BOUNDARY

- **Command registry (§1):** lives entirely in Lane D. The store already
  exposes everything the registry needs (commands, `canUndo`/`canRedo`,
  selection counts); if enablement moves into the registry it *consumes* state,
  it does not change the store. Only if the registry were to replace
  `DEFAULT_SHORTCUTS` inside the store would it become an A2 finding.
- **Selection view (§2):** the derived type's definition is a store (A2)
  change; the five+ consuming panels are Lane D. The marquee (`marqueeSel` in
  `renderer.ts`, fed from CanvasView) is Lane C and would also need to feed the
  view for the panels to agree during a drag.
- **"cloud" shape (§3):** the enumeration drift originates in Lane D
  (Inspector dropdown / shapeLibrary allow-list), but the missing paint path is
  `renderer.ts traceShape` and `export/svg.ts` (Lane B). Fixing only the
  dropdown without a renderer case would add a pickable shape that still draws
  as a rounded rect.
- **Toolbar color fix (§5):** touches RichEditor, a §3 parity file — the parity
  harness must be re-run, and any text-layout-adjacent finding needs a parity
  harness run per the lane brief.
