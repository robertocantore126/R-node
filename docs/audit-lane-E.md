# Lane E — export & standalone viewer audit (PDF / SVG / .rnode / viewer)

Scope: `src/export/pdf.ts`, `src/export/svg.ts`, `src/editor/exportBridge.ts`,
`src/viewer/main.ts`, `src/export/report.ts`, `src/export/htmlViewer.ts`.
Context read but not restructured: `src/render/renderer.ts` (Lane B, the other
half of the duplication question), `src/layout/measure.ts` (I9 constants, Lane B),
`src/persist/assets.ts` (putUnderId / referencedAssetIds, Lane F), `src/core/types.ts`
(Lane A1), `src/editor/store.ts` (the degraded warnings).

Method: trace of each exporter against the renderer's drawing code and against
the shared constants in measure.ts; the I11 path traced end to end
(compact import → originalLost → complete export → manifest). **No code was
changed by this audit.**

---

## The structural question, answered

> Beyond the I9 constants, do the two renderers share a description of what to
> draw, or does each walk the document and decide independently?

**Each walks the document and decides independently. There is no shared
draw-list or scene description — and extracting one would be exactly the large,
speculative refactor this audit is told to reject.** The canvas renderer draws
through a camera transform with viewport culling, per-frame bitmap caches and
hit-testing; the SVG exporter emits strings; the PDF exporter emits per-page
operator streams under band clipping. Those three execution models share almost
nothing worth forcing into one scene graph.

**But the finding is not empty.** The *pure geometry* is duplicated verbatim in
all three, outside the I9-sanctioned set. I9 already forced the arrowheads and
the bezier trimmers into measure.ts because "two copies of that arithmetic
drift — visibly, at the arrowheads". The same argument applies, unmet, to:

- the **connector curve** (control-point factor `0.45`, plus the
  vertical-tree endpoint rule): renderer.ts:414-456, svg.ts:133-159,
  pdf.ts:157-185 — three copies, byte-identical today;
- the **relationship curve** (control-point factor `0.35`): renderer.ts:1262-1272,
  svg.ts:166-172, pdf.ts:190-199 — three copies;
- **`placeAll`** (BFS from root, skip collapsed, then floating nodes):
  svg.ts:104-130 and pdf.ts:135-155 — two verbatim copies (the renderer's
  `computePlacement` is a third walk with culling added);
- the **stroke widths** `1.7` (connector) and `1.5` (relationship):
  renderer.ts:449 / svg.ts:158-159 / pdf.ts:478, 551-552.

These are small, stateless, pure functions — the same shape as
`bezierEnterRect`. Moving `connectorCurve(parent, child, structure)` and
`relationshipCurve(a, b)` into measure.ts next to the trimmers is a low-risk
extraction, not a refactor, and it is the natural completion of I9. This is the
recommendation; a scene-graph unification is **SKIP** (see E2 for the boundary).

---

## E1 — Relationships export wrong: the default dash, the straight connector, and the dropped label  *(behavioral)*

**E1a — `lineStyle: undefined` means dashed on canvas, solid in SVG/PDF.**
A fresh relationship is created as `{ id, fromId, toId }` with **no** `lineStyle`
(store.ts:2939), and the Inspector renders that as "dashed"
(`value={rel.lineStyle ?? "dashed"}`, Inspector.tsx:300). The three sides
disagree on the default:

- renderer.ts:314 — `rel.lineStyle ?? "dashed"` → **dashed**;
- svg.ts:206 — two-way comparison, `undefined` falls through to **solid**;
- pdf.ts:537 — same two-way comparison, `undefined` → `[] 0 d` → **solid**.

So **every relationship a user draws is dashed on the map and solid in both
document exports.** Old documents with `lineStyle` absent diverge the same way.
No test pins this (exportSvg/exportPdf tests never assert a dash), and the
self-audit cannot see it (E5).

**E1b — `connector: "straight"` is ignored by both exports.** The renderer
honours the T23/T24 straight geometry (renderer.ts:1279-1301, via the shared
`segmentExitRect`); svg.ts:166-208 and pdf.ts:190-199 always build the 0.35
Bezier. A straight relationship exports as a curve — a fidelity gap that is
neither declared in the exporters' KNOWN GAPS headers nor caught by the report
(which only counts relationships *emitted*, and these are).

**E1c — PDF drops relationship labels silently.** `drawRelationship`
(pdf.ts:532-546) draws the curve and the arrowheads but never the label, while
the renderer (renderer.ts:1319-1330) and the SVG (svg.ts:199-207) draw the chip.
The PDF's KNOWN GAPS header (pdf.ts:33-42) lists shapes, code topics, groups and
summaries — not relationship labels — so the omission is undeclared, and the
coverage counter reports the relationship as emitted. (Related: the SVG's chip
width is a `label.length * 7 + 10` heuristic, svg.ts:197, versus the renderer's
`ctx.measureText` — documented as "close enough", a deliberate exception to the
"same geometry" rule that will drift for long labels.)

**VALIDATION.** Fixing E1 touches svg.ts / pdf.ts / (maybe) types.ts defaults.
Not an I10 parity file, but the fix must keep `wrapRunLines` untouched (the
exports consume its output) and pass `npm run typecheck` + `npm test`; add an
exportSvg/exportPdf assertion for each of: undefined lineStyle, `"straight"`
connector, and label presence. Re-verify `window.__parity` at 0 divergences if
measure.ts is touched to share the curve helpers.

---

## E2 — No shared scene description (SKIP unification); the I9 gap is the curve geometry

**The SKIP, stated properly.** There is no draw-list or scene description both
renderers could consume without a large speculative refactor: the canvas is a
culled, cached, camera-transformed painter; SVG is a string emitter; PDF is a
banded operator stream (deliberately not a clipped XObject, pdf.ts:25-30). The
codebase has already made the pragmatic call — share *constants and pure
geometry* in measure.ts, keep the walks independent — and that call is right.
A scene graph would mostly move code and add an abstraction the three
execution models do not need.

**The gap.** The I9 shared set stops at the arrowheads and the bezier trimmers.
The curves those trimmers operate on are transcribed, not shared (E-findings
above). They are byte-identical *today* only because each new exporter copied
the previous one (pdf's header says "transcribed from the SVG exporter's
placement"); nothing enforces the next copy. The I9 table's own rationale — "the
two renderers diverge the moment the constant is duplicated" — applies to
`0.45`/`0.35` as much as to `ARROW_LEN`. Also unshared and duplicated:
`placeAll` (svg.ts:104-130 == pdf.ts:135-155), the node shape geometry
(svg `shapeOf` vs pdf `drawBox` vs renderer `drawNode` — pdf only draws a rounded
rect, which its report *does* declare), and the connector/relationship stroke
widths.

**Recommendation (narrow, not speculative):** export `connectorCurve` and
`relationshipCurve` from measure.ts (pure, stateless, ~20 lines each) and
consume them from renderer/svg/pdf; that is the same move I9 already made and
closes the one class of drift the exports still share with the canvas.

**VALIDATION.** Changing measure.ts (even adding pure helpers) touches the I10
file list → run the parity harness at **0 divergences** plus `npm run typecheck`
and `npm test`.

---

## E3 — The map's extent is computed four times, with three different answers

The audit's "three notions of the map's extent" is real, and it is four:

| Site | Pad | Node set |
|---|---|---|
| svg.ts:272-283 (`viewBox`) | `opts.pad ?? 40` | `placeAll` — collapsed subtrees excluded |
| pdf.ts:228-235 (band top / scale from width) | hardcoded `20` | `placeAll` — collapsed excluded |
| viewer/main.ts:88-101 (`boundsOf`, F/home) | `60`/`120` folded into scale | **all nodes, collapsed included** |
| renderer `computePlacement` culling | `40` | `placeAll`-equivalent |

Each serves a different purpose (viewBox, page fit, camera fit, culling), so the
*pads* differing is defensible — but the viewer's `boundsOf` walking *every*
node while the renderer draws only non-collapsed ones means the viewer's **F key
fits the hidden content**: on a map with a collapsed subtree, `fit()` zooms out
to a frame nothing is drawn in. That is a genuine off-by-one between the viewer
and the renderer it embeds. A shared `boundsOf(sheet, { includeCollapsed })`
beside `measureNode` would remove the divergence; at minimum the viewer should
skip collapsed subtrees like `placeAll` does.

**VALIDATION.** Touching viewer/main.ts or measure.ts: typecheck + tests; the
I10 harness only if measure.ts is changed (0 divergences). A viewer fix is
verifiable by opening the exported HTML and pressing F on a map with a
collapsed branch.

---

## E4 — exportBridge: the mode is one typed value (good); `degraded` is an untyped flag with a dead combination  *(I11)*

**What is right (and I11-compliant).** `RnodeZipMode = "complete" | "compact"`
is one union type (exportBridge.ts:35); `originalLost` is one boolean on the
attachment card (types.ts:336, I11's marker); compact import sets it per asset
(exportBridge.ts:386), the store warns before a degraded save/export
(store.ts:914-921, 945-953), and `buildRnodeZip` re-derives degradation from the
cards and writes `degraded: true` into the manifest (exportBridge.ts:259-266).
The chain compact-import → originalLost → complete-export-declares is intact.
The idempotent reimport (content addressing + first-write-wins `putUnderId`)
holds.

**The nits.**

1. `degraded` is computed for **both** modes (exportBridge.ts:261) and merged
   into the manifest as `{ mode, degraded: true }` — so a **compact** export of
   a degraded document writes `{mode:"compact", degraded:true}`, a combination
   nothing ever consumes (degradation only means something for `complete`). The
   manifest is a plain `{ mode?: RnodeZipMode }` read on import (exportBridge.ts:357)
   and `degraded` is never read back. Make the manifest a discriminated union —
   `{mode:"compact"} | {mode:"complete"} | {mode:"complete", degraded:true}` —
   and compute `degraded` only for `complete`.
2. Import sets `originalLost` only `if (mode === "compact" && card)`
   (exportBridge.ts:386). `referencedAssetIds` walks **nodes**, not cards
   (assets.ts:426-435), so a container whose `document.json` references an
   asset *without* a card restores it with a fresh meta and no `originalLost` —
   a later complete export would then claim an original it does not have. The
   normal path always carries cards, but the guard makes the I11 guarantee
   depend on the container being well-formed rather than on the import.

**VALIDATION.** Fixing E4 touches exportBridge.ts / types.ts: typecheck + the
exportBridge tests (`.rnode.zip` round-trip, degraded marking). Not an I10 file;
no parity-harness requirement unless measure.ts is touched.

---

## E5 — The export self-audit only measures node styles and element counts, so E1 stays green

`buildReport`'s fidelity machinery is strong for what it covers: `styleGaps`
compares every node style prop against each exporter's `honoured` list, and
`coverage` warns when an element kind is present but not emitted (groups and
summaries are honestly declared absent by svg and pdf). But its vocabulary ends
there:

- **Relationship properties are never audited** — `lineStyle`, `connector`,
  `bidirectional`, `label`, `color` appear in no `honoured` list and no
  `RENDERED_STYLE_PROPS` entry (report.ts:22-29). That is exactly why E1a (the
  dash default), E1b (straight ignored) and E1c (PDF label drop) all pass with
  zero warnings: the relationship is *emitted*, and emitting is all the report
  checks.
- `htmlViewer` reports `format: "svg"` with the comment "the report's formats
  are the two document ones; this is neither" (htmlViewer.ts:137) — a third
  format value would make the report honest instead of pretending to be a
  document export.
- The SVG relationship label chip width is a heuristic
  (`label.length * 7 + 10`) where the renderer measures (`ctx.measureText`),
  flagged in a comment but invisible to any check.

**Recommendation:** extend the report's coverage to relationship
properties (a `relGaps` list parallel to `styleGaps`), and declare the three
current gaps in each exporter's `honoured`/KNOWN GAPS rather than leaving them
to be discovered by reading the code.

**VALIDATION.** Touching report.ts / svg.ts / pdf.ts: typecheck + tests; not an
I10 file. Any change to measure.ts (e.g. sharing curve helpers for E2) forces
the parity harness at 0 divergences.

---

## Bottom line

The lane's own architecture holds where it matters: text layout in the exports
is inherited from `wrapRunLines` (svg.ts and pdf.ts transcribe the renderer's
*placement*, not its line breaking), colours come from the renderer's
`colorOf`/`linkColorOf` seams, the I9 arrowhead/bezier set is genuinely shared,
and I11's originalLost chain is intact and declared. The failures are: (E1) a
user-visible relationship mismatch — dashed→solid, straight→curved, and the PDF
label drop — that no test or report can catch; (E2) the I9 shared set stops one
step short of the curves themselves, which are transcribed verbatim in three
files; (E3) a viewer fit() that frames collapsed content; and (E4/E5) two
small typing/audit gaps that let the above pass silently. The scene-graph
unification the audit asked about is **SKIP** — the right structure is the one
already in place, with the pure geometry moved into it.
