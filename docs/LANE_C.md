# LANE C — spatial model (placement, camera, canvas host) — findings

Scope: the 5 owned files (CanvasView.tsx, mindmap.ts, theme.ts, viewport.ts,
imageDrop.ts). All quotes verified in the current tree (HEAD 5df321e).
Cross-boundary items are flagged at the end.

---

## 1. Gesture state — the union already exists in substance; the real smell is duplicated booleans, not unreachable combos

The lane brief asks whether scattered interaction state can have two live
gestures at once. The honest answer: **no — not reachable through the pointer
flow — and the design is already a gesture union, just spelled as one ref
object with nullable discriminators.**

All in-progress gestures live in one `DragState` ref
(`CanvasView.tsx:78-108`): `dragging`, `panning`, `resizing` (+ `resizeSide`),
`imgResizing`, `imgDragging`, `marqueeActive`, plus per-gesture parameters
(`startX/Y`, `lastX/Y`, `grabOffsetX/Y`, the resize/image-resize start values,
`imgSlot`/`imgDropSlot`, marquee anchor). Each `pointerdown` branch arms
exactly one discriminator and returns (`CanvasView.tsx:545`): pan (button 2/1
or pan mode, line 574) → resize (603) → image-resize (623) → image-slot → node
hit. Every `pointerup` clears its own gesture (`onPointerUp`, line 874), and
`onPointerMove` (723) resolves them in a **fixed priority order** —
imgResizing → resizing → panning → marquee → imgDragging → dragging. That
order is load-bearing: even a stale flag from a missed pointerup is absorbed by
the priority checks, which is why the multi-flag soup works in practice.

Two genuine smells, both small:

1. **`panning` and `resizing` are duplicated as React state purely for the
   cursor** — `drag.panning` (ref) + `setPanning` (state), synced at four sites
   (574/1017 on down, 914/1042 on up); `drag.resizing` + `setResizing`, synced
   at four sites (603/623 on down, 900/908 on up). Two sources of truth for
   "am I panning/resizing", kept in sync by convention, read only by the
   cursor expression and the marquee div. The narrow fix is one
   `activeGesture: "pan" | "resize" | "img-resize" | null` state (or a single
   `useState` mirroring the discriminator), not a full union rewrite.
2. **Resize hover is recomputed on every move** — the `!drag.dragging` branch
   of `onPointerMove` (line ~810) runs `hitTestResize` + `hitTestImageResize` +
   `hitTest` on every pointer move even when nothing is being dragged. It is
   cheap (placement cached, see §2), so this is a "fine as-is" note, not a
   finding.

The brief's canonical fix — "a gesture union with one active value" — is
already what `DragState` is *in substance*: the arming is exclusive by
construction and the priority order makes it robust. The one structural risk
worth stating: **exclusivity is enforced by convention, not by a single active
value.** Each pointerdown branch clears only the fields it owns and trusts that
the previous pointerup cleared the rest. Adding a future gesture (e.g. a
rotate handle) whose branch forgets to clear a sibling field would be silently
swallowed or would double-arm — the failure mode is real even if no invalid
combination is reachable today. The cheap hardening is to make the
discriminator a single field with a `kind` tag rather than five nullables; that
is what the brief's fix is really buying here, not bug fixing.

---

## 2. Hit-testing — yes it's a linear scan, and no, an index is not the simplifying target

`hitTest` filters the placed array to visible nodes and scans back-to-front
(`renderer.ts:1535-1541`); `nodesInRect` scans all placed nodes per marquee
move (`renderer.ts:1679-1686`); `hitTestResize`/`hitTestImageResize` scan the
selection. So: repeated linear scans per event, true.

The important part is *what the scan costs*: the expensive step — `measureNode`
for every node, documented at 8.7ms and 8,000 allocations on a large map — is
cached by `placedNodes` keyed on
`rev | camera.x | camera.y | camera.scale | viewW | viewH`
(`renderer.ts:200-227`), so within one "turn" the second and later calls are a
Map/array lookup, and a hover's three hit tests cost one placement instead of
three. The residual per-event cost is a few hundred rect comparisons, which is
microseconds against a 16.7ms frame and happens only on pointer events, not per
frame.

A spatial index would not be the simplifying target here: it would need
invalidation tied to layout, which **mutates node positions in place on every
run** (applyLayout writes `n.position`), and it would shave nothing off a path
that is already far under budget. The 1000+ node goal is served by the
placement cache, not by an index. Verdict: **non-finding**, stated plainly —
the scan is fine, the cache is the real fix and already exists. (The one real
hot path nearby — the cache key includes the camera, so a pan drag re-measures
every node each frame — is in the renderer; see CROSS-BOUNDARY.)

---

## 3. Render-loop scheduling — one owner, one trigger path, one documented redundancy

Every paint goes through `schedulePaint` (`CanvasView.tsx:57`): a module-level
rAF singleton with a 100ms `setTimeout` fallback for when the webview is not
compositing. `renderer.render` is called in exactly one place, inside `paint`
(line 225), which is only reachable via `schedulePaint`. All other sites call
`schedule()` (line 228): the store subscription (462), the React re-render
effect (513-515), the ResizeObserver (264/268), the renderer's `onRepaint`
(image decodes), and the marquee move/up paths (791/893).

The one redundancy is documented and neutralized: a store notify triggers both
the `store.subscribe(schedule)` path and the `useEffect([state]) → schedule()`
path for the same change, and the header comment on `schedulePaint` explains
exactly why that used to double-paint and why rAF coalescing now makes it one
paint per frame. Layout scheduling lives in the store (30ms debounce +
`settleLayoutNow`), and CanvasView deliberately bypasses it during a drag
(`setNodeDragDraft` runs `applyLayout` synchronously per move — the comment at
`store.ts:2079` explains the debounce would starve the subtree mid-drag).

One subtlety worth noting: `schedulePaint` is **module-level state**, shared by
any CanvasView instance. That is safe only because I1 guarantees one canvas —
if a second canvas host ever mounts, the singleton would route both instances'
paints into one queue. Fine today, worth a comment.

---

## 4. mindmap.ts — the manual/auto representation: a boolean beside coordinates, with one reachable divergence

`Position.manual` sits next to the coordinates it governs, and the invariant
"coordinates are authoritative iff `manual === true`" is re-derived in about
seven places instead of being enforced: `isAuto()` in layout (`mindmap.ts`),
the write guard in `applyLayout` (writes only non-manual nodes unless
force/clearManual), `resolveIntersections`' shift guard (never moves manual
anchors), `commitResize`'s `keepX` (x persists only for floating/already-manual
nodes), `dropAt`'s `releaseManualPosition` (reparenting hands the topic back to
the engine), `collectManualDescendants`, and the renderer's read of
`position.x/y`. The model is carefully kept consistent by convention, and I
verified the expected safety valves: the "Auto layout" command is
`applyLayout(force=true, clearManual=true)` (`store.ts:3079-3082`), so forced
layout never leaves a manual flag on layout-computed coordinates; and the
drag/resize transient-flag dances (`setNodeDragDraft` flipping `manual:true`
live, `commitNodeDrag` restoring `origPos`; `setResizeDraft`'s transient flag,
`commitResize` restoring or persisting it) are correct as written, with the
caveat that they depend on pointerup always arriving.

**One reachable divergence exists — freeform auto children are never laid out
again and detach from a dragged parent.** The freeform branch of `layoutSheet`
(`mindmap.ts:160-164`) places only manual (or force) nodes:

```ts
if (st.structureType === "freeform") {
  for (const n of Object.values(sheet.nodes)) {
    if (force || n.position.manual) positions.set(n.id, { x: n.position.x, y: n.position.y });
  }
  return { positions, bounds: boundsOf(positions, sheet, size) };
}
```

An auto child (created via Tab under a floating topic: `createChild` →
subtopic with `manual:false` from `createNodePosition`) therefore gets **no
position from layout at all**. Its stored coordinates come from
`createNodePosition` at creation time and are never re-derived, while the
mindmap and hierarchical placers explicitly anchor auto children to a manual
parent's *actual* coordinates ("if the parent has a manual position, use its
actual coordinates so dragged parents correctly anchor their children",
`mindmap.ts` non-root branch). Drag the floating parent in freeform and the
auto child stays behind: a node whose flag says "auto" but whose coordinates
are authoritative-by-accident, contradicting the model every other structure
implements. Reachable: freeform structure + floating topic + Tab (child) +
drag the floating parent.

**Fix (Lane C + a store touch):** the freeform branch should place auto
children relative to their parent's stored position each run (one recursive
pass mirroring `placeMindmap`'s anchoring), or `createChild` under a floating
topic should create the child `manual:true` (store-side). Either restores the
invariant "auto ⇒ coordinates derived by layout" that the other structures
hold.

Minor adjacent notes: `createNodePosition` produces `manual:false` nodes with
concrete coordinates, so "auto + concrete coordinates" is the *normal* state —
fine because every touch re-runs layout, but it is exactly why the invariant
can silently rot (the freeform case is the rot already happening).

---

## 5. Minor

- **`shapeWidthAllowance` mirrors measure.ts's shape allowance**
  (`CanvasView.tsx:110-114` returns `diamond → fontSize`, `hexagon → 14`,
  else 0). measure.ts applies the same two numbers (`measure.ts:817-823`,
  diamond `w += fontSize`, hexagon `w += 14`). It matches today, but it is a
  manual mirror of a shared constant in a file Lane C is told to consume, not
  duplicate (I9-adjacent). A `shapeWidthAllowance` export from measure.ts would
  kill the drift risk; a change to the hexagon allowance would otherwise
  silently mis-size the resize start width.
- **Two zoom factors for the same verb:** wheel zoom uses 1.12
  (`CanvasView.tsx` onWheel), keyboard/buttons use 1.2 (`shortcuts.ts`,
  `TopBar.tsx`). Deliberate (wheel wants finer control) but undocumented.
- **`HOME_CAMERA` in viewport.ts is unused**; `fitBounds` caps fit zoom at
  1.25 while `zoomAt` allows 4.0 — deliberate conservative fit, but the cap
  lives in `fitBounds` while the store re-floors at 0.4 (`fitView`), i.e. fit
  clamping is split across two files.
- **imageDrop.ts and theme.ts are clean.** `nearestImageSide` is pure,
  normalised-distance logic with the aspect-ratio trap documented; theme.ts is
  a deliberate single-light-theme record.

---

## CROSS-BOUNDARY

- **Hit-testing and the placement cache live in renderer.ts (Lane B).** Lane C
  consumes them from CanvasView; the verdict in §2 is really about Lane B's
  `placedNodes` cache. The one hot path worth Lane B's attention: the cache key
  includes `camera.x/y/scale`, so a pan drag re-measures every node per frame
  (8.7ms at 8,000 nodes); at the 1000-node goal this is ~1ms, i.e. fine — but
  if it ever becomes a target, splitting "geometry" from "visibility" in the
  key is the lever, and that is Lane B's call.
- **The transient `manual` flag dance (§4) lives in the store (A2)** — the
  drag/resize drafts and their commit restores. The freeform divergence is
  fixable from either side: layout-side anchoring is Lane C, making Tab-created
  children of floating topics `manual:true` is A2.
- **Schema vs runtime theme:** `RnodeDocument.settings.theme` still types
  `"light" | "dark"` while the runtime `ThemeName` is only `"light"` (theme.ts)
  and the store forces light on every notify. A document saved with a dark
  theme is silently displayed light. Deliberate per the theme.ts comment
  ("Dark theme intentionally removed"), but the schema field (A2/types) now
  lies.
- **Lane D intersection:** the `1.2` zoom factor appears in `shortcuts.ts` and
  `TopBar.tsx` (D) while the wheel uses `1.12` here (C); if a command registry
  lands in D it will need to know the wheel zoom stays separate.
