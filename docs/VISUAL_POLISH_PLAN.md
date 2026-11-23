# Visual polish plan: new look for the mind map, with engine work to pay for it

Instructions for the implementing agent (Gemini). **Write code only.** Do not write
tests, benchmarks, or measurement steps. Rob and Claude measure and verify
afterwards. Each new visual is behind a flag so we can switch it on and off and
compare (section 0).

The look we are aiming for is in `C:\Users\39389\Desktop\r-node-idee-grafiche.html`
(open it in a browser). Each card there shows "today" next to the "proposal". The page's
`drawConnector` / `drawNode` show the geometry; copy the ideas, not the code. That
page has no layout engine, rich text, or caches.

## Before you start

Start from `main` at d1f26ea ("Add background patterns and the Fog theme"). That
commit added the background pattern (`GridPattern`, `drawGrid`, `gridInk`), the
`fog` theme and the TopBar pattern picker. Build on them.

- Work on a new branch `feat/visual-polish`. Do not commit to `main`, and do
  not `git stash`, `git reset` or rewrite history. `dev-browser.bat` is Rob's
  untracked file: leave it alone.
- Read `CLAUDE.md` → `docs/AGENT_GUIDE.md` first (the repo's contract).
- `npm run build` must pass at the end (`tsc` + Vite). Nothing else is required.

## What the renderer does today (read these before editing)

- `src/render/renderer.ts` `render()` (~line 597). It is **one canvas**. **Every** frame
  repaints everything: background, grid, freeforms, group fills, relationships, connectors,
  nodes, ink, search rings, groups, quiz markers and editing overlays. A hover
  change (`state.hoverId`) or a selection change repaints the whole map.
- Placements are cached (`placedCache`, keyed on `state.rev`). Visibility is
  refreshed per camera (`visiblePlacedList`). Text is cached as bitmaps (`textCache`,
  resolution bucket `res = ceil(scale*dpr)` clamped 1..4). Above 100% zoom, free-transform
  text is drawn as vectors on purpose. **Do not change that** (Rob wants it sharp).
- `drawConnector` (~line 886): one `beginPath/bezierCurveTo/stroke` per edge,
  `lineWidth 1.7`. The colour comes from `branchColor()` and is recomputed per edge per frame
  (`branchRoot` walks up the tree).
- `drawNode` (~line 1190): `style.shadow` uses `shadowBlur = 12` (the slowest thing
  Canvas2D does). Then `traceShape` + fill + border + text + collapsed badge (~line 1513:
  a grey circle with a count) + selection/hover via `strokeRing` (square
  `strokeRect`, not rounded).
- `schedulePaint` in `src/ui/CanvasView.tsx` (~line 66) coalesces repaints to one
  per rAF. The only `<canvas>` is at ~line 1904.
- Default styles per node type are in `src/core/doc.ts` `makeNode` (~line 213):
  central 22/700, shape `none`; main 14/600; subtopic 12/400. **The type scale
  already exists in the data.** Do not change these defaults: that would change layout
  of existing maps.
- Exports repeat the connector geometry: `src/export/svg.ts` `connector()`
  (~line 177) and `src/export/pdf.ts` `connectorCurve()` (~line 458).

---

## 0. Flags (do this first)

New file `src/render/visualFlags.ts`:

```ts
export interface VisualFlags {
  taper: boolean;        // V1
  mutedDeep: boolean;    // V2
  flatShadow: boolean;   // V3
  accentStrip: boolean;  // V4
  rootPolish: boolean;   // V5
  junctions: boolean;    // V6
  softSelect: boolean;   // V7
  lod: boolean;          // V8
  animateCollapse: boolean; // V9
  vignette: boolean;     // V10
  overlayLayer: boolean; // E1
  sceneCache: boolean;   // E2
  batchedPaths: boolean; // E3
  motionQuality: boolean;// E5
}
```

- All default `true`. Read overrides from `localStorage["r-node.visual"]` (a JSON
  partial), wrapped in try/catch. Expose `window.__rnode.visual` in
  `src/main.tsx` next to the existing `__rnode` handle, with `get()`, `set(partial)`
  (persists and triggers a repaint) and `reset()`.
- The renderer reads the flags once per frame into a local. It never reads
  `localStorage` inside the frame.
- Each flag switches **only** its own code path. When a flag is off, the result must be
  exactly today's drawing.

---

## Part A: visuals

### V1. Tapered branches (`taper`)
In `drawConnector`, for mind-map style horizontal connectors, draw a filled ribbon
instead of a stroke. Use the same control points. The top edge is the bezier offset by
`-w0/2` at the start and `-w1/2` at the end. Then `lineTo` the bottom edge and go back with
the reversed bezier at `+w/2`, then `closePath`, then `fill`. Widths by the **child's** depth:
depth 1: 7 → 3; depth 2: 3.2 → 1.6; depth 3: 2 → 1.2; deeper: 1.6 → 1.
Width is in world units (it scales with zoom, like today's 1.7).
For vertical connectors (tree/org layouts), offset in x instead of y.
Below screen width 0.75 px (`w * scale < 0.75`), fall back to the plain stroke.
Mirror the same ribbon in `svg.ts` `connector()` (a `<path fill>`) and in
`pdf.ts`. Put the ribbon geometry in one shared helper (e.g.
`src/layout/connectorRibbon.ts`) that returns the 2 beziers. The canvas, SVG and PDF all use it.

### V2. Muted deep text (`mutedDeep`)
Text at depth ≥ 3 that uses the default text colour (no `style.textColor`) is
painted in `theme.textMuted` instead of `theme.text`. This is render-only, with no layout change.
The colour is already part of `textCacheKey`, so the cache stays correct.
Do **not** touch font sizes or weights (they live in the document; see above).

### V3. Flat shadow instead of `shadowBlur` (`flatShadow`)
In `drawNode`, when `n.style.shadow` is on: do **not** set `shadowBlur`. Paint
the node's own shape (`traceShape`) offset by +2 world units in y, once, filled
with a new theme token `shadowFlat` (light ≈ `rgba(28,35,51,0.10)`, dark ≈
`rgba(0,0,0,0.5)`; add a value to every theme in `theme.ts`, including Rob's new `fog`).
Then draw the node as usual. Custom artwork (`shapeParts`) keeps its current path, but
use the same offset trick on the silhouette part only.
Do not turn shadows on for nodes that did not have them. That is a style decision, not ours.

### V4. Accent strip on subtopics (`accentStrip`)
For nodes at depth ≥ 2 with **no explicit `style.fill`** and a rounded or
rectangle shape: fill with `theme.deepFill` instead of `branchSoft`, then paint a
4-unit strip in the branch colour on the side facing the parent (left for nodes
on the right of the root, right for the left side). Use
`ctx.roundRect(x, y, 4, h, [r,0,0,r])` (or the mirrored radii). Do **not** use
`clip()`: it cost +50% per node in the demo. Shift the text 2 units away from
the strip. Do not change the measured width.
SVG export: same strip as a `<path>`.

### V5. Root polish (`rootPolish`)
This applies only when the central topic has a box (its default is `shape: "none"`, so most maps
won't show it). Use a vertical linear gradient from `rootFill` to a 4% darker shade, a
1.5-unit border in `theme.selection` at 55% alpha, and corner radius +4. Cache the
`CanvasGradient` on the renderer, keyed on `theme.name|y|h`. Never create it per frame.

### V6. Junction dots and coloured collapse badge (`junctions`)
- After the connectors, for each visible parent with ≥ 1 visible child at depth ≥ 2:
  draw a 3-unit-radius dot in the branch colour where the connector leaves the
  parent. Draw only one dot per side per parent.
- Collapsed badge (~line 1513): draw a pill instead of a grey circle. Fill it with the branch
  colour, white `+N` text, `600 11px`, height 18, radius 9, width = text + 12.
  Hit testing for the badge (in CanvasView / hit code) must use the new width.
  Find where the badge is hit-tested and use one shared size function.

### V7. Soft selection and hover (`softSelect`)
Replace `strokeRing` for **topics** (not freeform canvases or items; those keep
their handles) with a ring that follows the node's shape and radius, not a square:
- selected: a 6-unit stroke at 22% alpha (the halo), then a 2-unit stroke at full alpha,
  both on the shape inflated by 3 / 1.5 units.
- hover (not selected): no ring. Use the fill darkened 5% (light themes) or
  lightened 10% (dark themes). Use `lighten()` / a new `darken()` in `theme.ts`.
  Memoise per colour in a small `Map`.

### V8. Level of detail when zoomed out (`lod`)
Use `scale = state.camera.scale`. Two thresholds, exported constants in
`visualFlags.ts`:
- `LOD_GREEK = 0.45`: below it, topics skip `drawText` and draw one rounded bar
  (`width = min(textWidth, box-20)`, height 6, centred) in ink derived from the fill
  (`readableOn(fill)` at 25% alpha). Skip images' smoothing quality changes:
  images still draw (they are the content).
- `LOD_BARE = 0.2`: below it, also skip borders, junction dots, badges, the
  accent strip, flat shadows, and ribbons (use thin strokes, `lineWidth 1/scale`).
Code blocks, charts, galleries and freeform canvases keep their own drawing. Apply
greeking only to plain topics' titles.

### V9. Animated collapse/expand (`animateCollapse`)
When `toggleCollapsed` (store.ts ~line 3026) runs on a node with < 300 visible
descendants:
- Before the change, snapshot the visible placements by id. After the new layout,
  run a 160 ms tween (easeOutCubic) in CanvasView. Nodes in both layouts move from
  old to new. Disappearing nodes move to the toggled node's box and fade out.
  Appearing ones do the reverse.
- The renderer gets an optional `state.tween: Map<id, {x,y,alpha}>` that overrides
  `Placed.x/y` and `globalAlpha` while it is set. Do not change `placedCache`.
- During the tween, hit testing uses the final layout. Any other edit cancels the tween.
- Use `schedulePaint` once per frame while the tween runs. When it finishes, nothing is scheduled.

### V10. Vignette background (`vignette`)
Applies only when the document has no custom `background` and the pattern is the theme
default. Make the canvas transparent (skip the `fillRect` of `theme.background` in
`render()`) and give its container a CSS `radial-gradient` from a new theme
token `vignette` (per theme, in `theme.ts` and mirrored as a CSS variable in
`styles.css`). **PNG/PDF exports must still paint a flat background.** Check
every path that calls `render()` for an export (`renderNodeImage`, canvas PDF)
and pass `opaque: true` there.

---

## Part B: engine work that pays for Part A

### E1. Overlay layer (`overlayLayer`)  *(the biggest win)*
Add a second `<canvas>` absolutely positioned over the existing one in
CanvasView, with `pointer-events: none`. Everything that changes on hover or
selection without a document edit is drawn there:
selection/hover rings (V7 tint excepted, see below), search rings, drop indicator,
gallery/ghost drops, relationship editing handles, chart-grow preview, quiz markers
of the current selection, and freeform corner handles.
- Split `render()` into `renderScene(state)` and `renderOverlay(state)`. Both share the
  same camera transform and the placement cache.
- CanvasView keeps a `sceneKey` = `rev|camera|view|theme|background|grid|showHidden|editingId|tween`.
  If only `hoverId`/selection/search/drop changed, repaint **only the overlay**.
- The V7 hover tint changes the scene. With `overlayLayer` on, paint the tint
  on the overlay instead: the hovered node's shape filled with
  `rgba(0,0,0,0.05)` (light) / `rgba(255,255,255,0.08)` (dark). Then a hover costs one
  path, not a full frame.
- The editing node (inline text editor) stays in the scene.

### E2. Scene cache for pan and zoom (`sceneCache`)
Keep an offscreen canvas holding the last scene, plus the camera it was drawn with.
- **Pan, same scale:** blit the cached scene shifted by the camera delta. Then repaint
  only the two exposed strips (set a clip rect to each strip and call
  `renderScene` with the viewport limited to it). Update the cache in place
  (draw the cache onto itself shifted, using a second buffer to avoid overlap). Fall back to
  a full scene repaint when the delta is larger than half the view.
- **Zoom gesture (wheel/pinch) in progress:** draw the cached scene scaled
  (`drawImage` with the scale ratio) for the frames of the gesture. Then do one full
  repaint 120 ms after the last wheel event. Text will look soft for a moment. That is acceptable
  because it is only during the gesture.
- Invalidate on any `sceneKey` change other than the camera.
- The cache is in device pixels and is resized with the view. Free it (`width = 0`) in
  `dispose()` next to the existing cache cleanup (~line 3610).

### E3. Batched paths (`batchedPaths`)
- **Connectors:** group visible edges by colour. Build one `Path2D` per colour
  (ribbons appended into it) and fill or stroke once per colour, instead of once per edge.
  Cache the per-colour `Path2D`s on the renderer, keyed on `placementKey` + the
  visible set's identity (`visiblePlaced` array). Pan inside the same visible set
  reuses them.
- **Branch colour:** memoise `branchColor(node)` per placement (store it on the
  cached `Placed` or in a `Map` that is reset with `placedCache`). Today it walks to the
  branch root for every edge, every frame.
- **Flat shadows (V3):** collect every shadow shape of the frame into one
  `Path2D` and fill it once **before** the nodes. Shadows share one colour, so
  N fills become 1. This is what turns V3 from +50% into ~free.
- **Junction dots (V6):** one `Path2D` per colour, one fill.
- **Node shape paths:** cache a `Path2D` per node for `traceShape`, keyed on
  `x|y|w|h|shape|radius` (WeakMap on the `Placed` object, which changes with the
  layout). Reuse it for shadow, fill, border, the V7 ring and the overlay hit tint.

### E4. Cheap state changes
- Set `ctx.font`, `textAlign` and `textBaseline` only when they differ from the last
  value (keep the last ones on the renderer for the frame). The badge and labels currently set
  them per node.
- Avoid `ctx.save()/restore()` around things that only change `fillStyle` /
  `globalAlpha`. Restore the values by hand instead.
- `setLineDash([])` in `strokeRing` runs on every call. Only reset it when a dash was set.

### E5. Motion quality (`motionQuality`)
While a pan/zoom gesture or a V9 tween is active (CanvasView already knows via the
gesture machine, `canvasGesture`), pass `state.moving = true`. Then:
ribbons become plain strokes, flat shadows and junction dots are skipped, and
`LOD_GREEK` is raised to 0.6. On the first frame after motion stops, the
full-quality frame is drawn (E2 already schedules it).

### E6. Trace counters
Add to the existing `trace.render({...})` call: `overlayOnly` (bool),
`sceneBlit` ("none" | "pan" | "zoom"), `pathBatches` (number of fills/strokes for
connectors), `greeked` (topics drawn as bars). These are for our later
measurement. Do not add any measuring logic beyond the counters.

---

## Order

1. Section 0 (flags).
2. E3 + E4 (no visible change; makes everything after it cheaper).
3. V1, V2, V3, V4, V5, V6, V7. Each is self-contained inside `drawConnector` / `drawNode`.
4. E1 (overlay), then V7's hover tint moved onto it.
5. V8 + E5.
6. E2 (scene cache). This is the riskiest, so do it once everything visual is settled.
7. V9 (tween), then V10 (vignette + export background).
8. Exports: SVG/PDF parity for V1, V4, V6 (and the flat background for V10).

## Out of scope
- Changing default font sizes, layout spacing, or theme palettes.
- Freeform canvases (draw.io mode), ink, charts, galleries and code blocks keep
  their current drawing except where a section names them.
- WebGL/WebGPU or OffscreenCanvas-in-a-worker rendering.

## Report back
Write a short list: per section, the files touched, anything you could not do, and
any place where you had to diverge from this plan and why.
