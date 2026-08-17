# LANE A1 — Document model and op/undo machinery (`src/core/*`, 7 files, ~1,240 lines)

Audit scope: `types.ts`, `ops.ts`, `doc.ts`, `validate.ts`, `text.ts`,
`history.ts`, `tree.ts`. `src/editor/store.ts` is Lane A2's file — findings
that land there are noted under CROSS-BOUNDARY only. I7 was re-read first and
every finding below respects it: inversion never reads the sheet, and any
inverse that needs post-apply data carries it in the op (captured at apply
time).

---

## 1. The exported `inverseOf` violates its own documented contract for `createNode` — a latent trap, guarded only by a caller-side special case (ops.ts)

`inverseOf`'s docblock (ops.ts:9-11) promises: *"inverseOf returns the
operation(s) that exactly reverse it."* The `createNode` case (ops.ts:261-264)
returns a `deleteNode` with **`subtree: []`**:

```ts
case "createNode":
  return [makeOp("deleteNode", { id: op.id, parentId: op.parentId, index: op.index, subtree: [], removedRelationships: [] }, m)];
```

`applyOp`'s `deleteNode` only deletes `op.subtree` entries (ops.ts:128-136), so
this inverse deletes **nothing**: it splices the id out of the parent's
`childrenIds` and leaves the node object in `sheet.nodes` as an orphan whose
`parentId` still points at the parent. That is not a reversal of `createNode`
— it is a corruption `validateSheet` would flag on the next check
("appears 0 times in its childrenIds").

Why it exists: `createNode`'s exact inverse needs the node as it exists
*after* apply, which a pure `inverseOf(op)` cannot know without reading the
sheet — and I7 forbids inversion from consulting the document. So the code
papers over it in `applyWithInverse` (ops.ts:325-336), which special-cases
createNode and captures the clone into the delete op's `subtree`. The
mechanism is sound; the exported function is the hole.

Reachability: I grepped every caller. `inverseOf` has **zero callers outside
ops.ts itself** — the store, all of `tests/ops.test.ts`, and `perf.test.ts`
go through `applyWithInverse`, and the tests never import `inverseOf`. So this
is latent, not live. The danger is that it is exported and documented as the
inversion API: the Rust document engine and the future sync layer read
`ops.ts` as the spec, and any "why is createNode special-cased?" refactor of
`applyWithInverse` silently breaks undo of node creation with no failing test
(the wrong case is untested).

**Fix (my file, minimal):** stop exporting `inverseOf` — make it module-private
and delete the `createNode` case (it can never be correct there), so the
export surface promises only what is true. Defense in depth: leave the case in
as a `throw` naming `applyWithInverse` for createNode. Either way, add a test
that the documented inversion entry (`applyWithInverse` on a createNode, then
replay of the returned inverse) restores the exact pre-creation tree — the
existing undo tests already cover this path implicitly; make it explicit.

## 2. `setPosition` is lossy over `Position`: it silently destroys `branchFree` (ops.ts)

`applyOp`'s `setPosition` rebuilds the position from a fixed set of fields
(ops.ts:164-166):

```ts
nodes[op.id].position = { x: op.x, y: op.y, manual: op.manual, offsetX: op.offsetX, offsetY: op.offsetY };
```

The op payload deliberately carries `offsetX`/`offsetY` so those survive an
apply/invert round trip. The one optional `Position` field it does **not**
carry is `branchFree?: boolean` (types.ts:212) — so the op is not lossless
over the type it mutates. Any document carrying `branchFree: true` ("Locks a
direct child of the central topic while its descendants reflow") loses it on
the first setPosition op — a drag commit, a promote/demote, a manual-position
release, an undo of any of those (the inverse is also a setPosition and is
equally lossy). The flag is gone for good: no op carries it, so no undo can
bring it back.

Today `branchFree` is set by **nothing** — the only occurrence in the
codebase is the type declaration (grep: 1 match, types.ts:212); the app's
"Free positioning branch" checkbox maps to `position.manual` instead. So
right now this is a schema-compat landmine for imported documents and the
declared feature, not a live data-loss bug — but the op makes the loss
irreversible the moment the flag is used.

**Fix (my file + cross-boundary producers):** add `branchFree?: boolean` to
the `setPosition` op payload, thread it through `applyOp` and the inverse
(`prev.branchFree`), and pass it at the store's ~15 makeOp sites. Decide on
`branchFree` itself: wire it or drop it — a declared-never-written field that
ops silently erase is worse than either.

## 3. The two parallel switches (applyOp / inverseOf) — considered, and honestly not worth collapsing

The prompt asks whether a per-op record `{ apply, invert }` would collapse the
two switches. My assessment after reading both: **no — keep the switches.** The
two switches are exhaustive over the tagged union (TypeScript errors on a
missing case), the union narrowing is precisely what makes them safe, and a
`Record<Op["type"], { apply, invert }>` table would lose that narrowing or
require heavy generic gymnastics to regain it. Adding an op costs three edits
(union, applyOp, inverseOf) plus the store producers — the same "several
switches" class as the store finding, but small and idempotent.

The one place the parallel shape genuinely bit is finding 1: the
apply-time-capture seam for createNode lives *outside* `inverseOf`, in
`applyWithInverse`, which is exactly why the exported `inverseOf` has a wrong
case sitting in it. That seam is real and would become per-op data in a record
design — but the honest fix is finding 1 (don't export the half-true
function), not a table.

Minor shape note: the envelope (`opId`/`actorId`/`ts`) is repeated across all
22 variants; it could be hoisted into a base type. Cosmetic, not worth its own
finding.

## 4. `moveNode.fromIndex` is carried by every producer but never read (ops.ts)

`applyOp`'s `moveNode` locates the node with `indexOf` and ignores
`op.fromIndex` (ops.ts:170-182); the inverse swaps from/to and is equally
indexOf-driven. Yet the store computes `fromIndex` carefully at **ten** makeOp
sites (`childrenIds.indexOf(...)`), and the final-index semantics are
documented. So `fromIndex` is payload with no apply or invert consumer — dead
weight that silently encodes an assumption nothing checks.

**Fix:** either (a) assert it — in the DEV-only spirit of `validateSheet`,
have applyOp verify `op.fromIndex` equals the actual `indexOf` position and
throw otherwise, which turns a stale op into an immediate named failure; or
(b) drop it from the payload and the producers. (a) is the better use: the
sync layer wants the field, and the assert is what makes it trustworthy.

## 5. Representable-but-never-constructed nodes: `NodeType` admits tree shapes nothing builds, and "the central node" is unenforced (types.ts)

Specific impossible-but-representable combinations, verified by grep:

- **A node with `type: "summary"` or `type: "callout"` in `sheet.nodes`.**
  Real summary/callout state lives in `Sheet.summaries` / `Sheet.callouts`;
  no code path constructs a node wearing those types (`makeNode` accepts any
  `NodeType`; the createNode op's `nodeType` is `MindNode["type"]`), the
  store only ever builds central/main/subtopic/floating, and the renderer
  only special-cases central/main/floating — such a node would render as an
  ordinary topic. **Nothing rejects it**: validateSheet never checks
  `node.type`.
- **Two `central` nodes, or a `central` that is not `sheet.rootNodeId`, or a
  `central` with a parent.** validateSheet only checks that the *root*
  (`rootNodeId`) has `parentId === null` — it never checks that the root is
  central, that there is exactly one central, or that a central node is the
  root. The "one central, unparented, at the root" rule exists only in
  construction conventions.
- **A `floating` node with a non-null `parentId`.** The type comment says
  floating is "free, unparented", but the orphan-walk special case only kicks
  in for *unreachable* nodes — a floating node with a parent passes every
  check and behaves as an ordinary child.

**Fix, split by what each layer can express:**
- Type-level (my files): introduce `TreeNodeType = "central" | "main" |
  "subtopic" | "floating"` and use it for `MindNode.type` and the createNode
  op's `nodeType`. Nothing outside types.ts references the summary/callout
  literals, so the narrowing is safe today.
- Validate-level (my file): add — exactly one central and it equals the root;
  floating ⇒ `parentId === null`; `type ∈ TreeNodeType`.

## 6. validate.ts: the division of labor is right, but the file is incomplete for three same-class invariants

The prompt asks whether validate.ts checks invariants the type system could
make unrepresentable. **It does not** — every check (root resolution,
reference resolution, bidirectional parent/children coherence, cycles vs.
orphans) is a value-level invariant over id-based references that TypeScript
cannot express. That division is correct, and the ordering rationale in the
file header is sound. The gap is the opposite direction: three invariants of
the same *dangling-reference* / *maintained-value* class are missing:

1. **Group/summary member ids are never resolved.** validateSheet validates
   `relationships[].fromId/toId` but never `boundaries[].memberIds` or
   `summaries[].memberIds`. A group holding a dead member id passes
   validation. This is not hypothetical: the store's `deleteNodes` drops a
   group/summary only when **all** its members die (A2's file, store.ts:1856-
   1866), so deleting one member of a multi-node group leaves a dangling id
   that only this check would catch.
2. **I5 is never enforced.** `node.title === runsToPlain(node.titleRuns)` and
   titleRuns normalization are documented in text.ts as "maintained by every
   writer" — but nothing verifies them, and validate.ts is the natural home
   (a value invariant; the type system cannot express it).
3. **The type-shape rules from finding 5** (single central, floating
   unparented, no summary/callout-typed nodes).

None of these could be pushed into the type system — they belong in this file,
which is currently 129 lines and would grow by roughly a third. That is the
right price for closing the three gaps.

## Q3 answer (Group vs. Sheet.boundaries): naming mismatch only — per the exclusions, not a finding

`Group` is stored in `Sheet.boundaries`, but `Group.memberIds` *is* the
membership (the dashed box is derived from member geometry at render), the
ops are named after the type (createGroup/deleteGroup/setGroup), and no
caller re-derives a relationship the type already knows. The
type-name/field-name mismatch is cosmetic and excluded by the brief; nothing
structural follows from it.

---

## Invariants verified

- **I7** — Every op carries its own inverse data (verified per variant:
  `prev`/`prevRuns`/`prevOrder`/`prevImageId`/`prev: {...position}`/full old
  objects; deleteNode carries `subtree`+`removedRelationships`; restoreNode
  and deleteOp pairs carry the captured subtree). The only wrinkle is finding
  1: the *mechanism* is sound (apply-time capture, carried in the op), but the
  exported `inverseOf` exposes a case where the claim is false.
- **I5** — Maintained by every writer (text.ts header, applyDraftRuns,
  setTitle op construction) but **unenforced** — finding 6.2.
- The undo/redo batching contract (one history entry per batch) lives in
  history.ts and is sound: `push` reverses+flattens per-op inverse lists into
  undo order; undo/redo are pure replays with no branching on op kind.

## Findings summary (ranked)

1. Exported `inverseOf(createNode)` returns a non-reversal (empty subtree) —
   latent trap, untested, zero external callers; unexport/throw + test.
2. `setPosition` is lossy over `Position` — drops `branchFree`; the op must
   carry it (and `branchFree` is declared-never-written today).
3. validate.ts is the right home but incomplete: group/summary member
   resolution, I5, and the type-shape rules are missing.
4. `NodeType` admits summary/callout as tree-node types and nothing enforces
   "exactly one central / floating unparented" — narrow the node type, add
   the checks.
5. `moveNode.fromIndex` is carried by ten producers but read by none — assert
   or drop.
6. The per-op record design was considered and rejected (finding 3 of the
   brief); the parallel switches are exhaustive and idiomatic.

## CROSS-BOUNDARY

- Finding 2's fix needs the store's ~15 `setPosition` producers to pass
  `branchFree` (Lane A2).
- Finding 4's type narrowing changes `MindNode.type` and the createNode op
  payload, which the store's `validateImportedDoc` casts straight through:
  an imported legacy doc carrying a summary/callout-typed node would newly
  fail validation at open — the importer needs a drop-or-reject decision
  (Lane A2), and the renderer's node-type switch is unaffected.
- Finding 6.1's group-member check would immediately expose the store's
  `deleteNodes` dangling-member path (a group surviving the deletion of one
  of its members keeps a dead id) as a validation failure — the store must
  prune dead member ids when deleting (Lane A2).
- Nothing in this report requires a change to `src/editor/store.ts`'s op
  producers beyond the payload plumbing above; the inversion/history core is
  self-contained in `src/core/`.
