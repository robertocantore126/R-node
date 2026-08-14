# T24 — Special shape node · implementation hand-off

Disposable: delete this file in the commit that finishes the task.
Read `docs/AGENT_GUIDE.md` §1, §2, §3, §6 first. Conventions shared with the
shape library are in `T23-HANDOFF.md`; this brief does not repeat them.

---

## What it is

**One** topic whose silhouette is an arbitrary path — a crescent, a shield, an
arrow — instead of one of the nine built-in `TopicShape`s. It has a **fixed
size**, and its label **is editable** like any other topic.

Deliberately not the same thing as a structure template (T23), which is N
topics with base shapes that resize to their text. The split is what makes both
tractable: a fixed-size node never has to negotiate its outline against a
growing label.

## What already exists

- **Fixed size is not a new mechanism.** `measure.ts:708`:
  `if (style.width && style.height) return { w: style.width, h: style.height };`
  A shape node is a node with both set. Measurement short-circuits there.
- **Shapes are already a switch** over a traced path: `renderer.ts:760`,
  `traceShape(ctx, p, shape, radius)`.
- **The prompt is written**: `SHAPE_NODE_PROMPT` in `src/editor/shapePrompts.ts`,
  with the crescent as a worked example. Do not rewrite it; wire the copy button
  to it.

## Why the label spills today

`measure.ts:745-746` wraps the text at the node's **bounding box**:

```ts
const maxW = style.width ? Math.max(MIN_TOPIC_W, style.width) : MAX_TOPIC_W;
const textW = Math.max(24, maxW - pad * 2 - TEXT_INSET - sidePadW);
```

A crescent is concave, so the label runs out onto its horns. The fix is the
`textBox`, and the way to express it is the important part below.

## Steps

### 1 — Model

`src/core/types.ts`, three optional fields on `Style` (no migration):

```ts
shapePath?: string;                                  // SVG path data, 0..1 box
shapeTextBox?: { x: number; y: number; w: number; h: number };  // same space
```

`shape: "custom"` selects them. Add `"custom"` to `TopicShape`.

### 2 — The text box IS an inset. Do not invent a second concept.

`textInsets(slots)` in `measure.ts` already returns `{ top, bottom, left, right }`
and is already consumed by the layout measure, the canvas renderer, the editing
overlay and the parity harness. Commit `4244928` created it precisely because
those four disagreed about where text may go, and the disagreement was invisible
until the overlay opened.

Convert `shapeTextBox` into those same insets, in world units, and feed them
through that helper. A parallel path would reproduce the bug that helper exists
to prevent.

**This is why the harness matters here.** The label stays editable, so the
Lexical overlay is a second renderer over the same text: §3 applies in full. Add
a parity case with a shape node's insets, exactly as four were added for image
slots, and report 0 diverging.

### 3 — Draw it

`renderer.ts`, a `"custom"` branch in `traceShape`:

```ts
const p2 = new Path2D();
p2.addPath(new Path2D(style.shapePath), new DOMMatrix().translate(x, y).scaleNonUniform(w, h));
```

`traceShape` currently traces into the context's current path and lets the
caller fill. A `Path2D` cannot be appended to that, so return `Path2D | null`
and have the callers use `ctx.fill(path)` / `ctx.stroke(path)` when it is
non-null. Keep the built-in shapes on the existing route.

Two consequences worth taking:
- Hit-testing can become exact with `ctx.isPointInPath(p2, x, y)` — a click in
  the hollow of a crescent then correctly misses it.
- **The SVG export gets easier**, not harder: the path is already SVG. Emit it
  with a transform rather than re-deriving the outline.

### 4 — Validate what an LLM produced

`src/editor/shapeLibrary.ts` (T23's module). A shape is refused, with a reason,
if:
- the path is longer than a sane cap (suggest 4000 chars) or contains anything
  outside `M L H V C S Q T A Z m l h v c s q t a z`, digits, separators, signs
  and exponents;
- any coordinate is NaN, or the path fails to construct;
- `shapeTextBox` is not fully inside `[0,1]²`;
- **the text box is not inside the filled shape** — check it, do not trust it.
  Build the `Path2D` on an offscreen canvas and `isPointInPath` the four corners
  and the centre of the box. This is the rule an LLM breaks most often: it
  reasons about the outline's extremes and proposes a box that fits the bounding
  rectangle, not the silhouette.

### 5 — Straight relationships (needed by T23, specified here)

Structure templates connect their topics with **straight segments**. Relationship
geometry is currently always a bezier.

- Add `connector?: ConnectorStyle` to `Relationship`. **Reuse the existing
  union** (`"curved" | "straight" | "elbow"` — already in `types.ts` for
  `StructureConfig`); do not declare a second one. Absent = `"curved"`, so every
  saved document keeps the look it has.
- `drawRelationship` branches on it. The endpoints still have to be trimmed to
  the node borders and the arrowhead still has to point along the line.
- **§2/I9:** `bezierEnterRect`, `bezierExitRect`, `bezierPoint` and `bezierSlice`
  are listed as shared between the renderer and the SVG export. The straight
  equivalent — segment-to-rect intersection — belongs in the same place in
  `measure.ts`, consumed by both. Two copies will drift, and the arrowheads are
  where it will show.
- T23's `saveShape` then sets `connector: "straight"` on every relationship it
  normalises.

## Definition of done (§6)

1. `npm run typecheck` → 0 errors, `npm test` → all green.
2. **Parity harness: 0 diverging**, with a new case covering a shape node's text
   insets. Non-negotiable: the label is editable, so §3 applies.
3. Tests that fail without the change: a shape node keeps its size whatever its
   title; a `textBox` poking outside the path is refused; a relationship with
   `connector: "straight"` is drawn as a segment trimmed to both borders.
4. No files outside: `src/core/types.ts`, `src/layout/measure.ts`,
   `src/render/renderer.ts`, `src/export/svg.ts`, `src/editor/shapeLibrary.ts`,
   `dev/parity.ts`, and their tests.

## Do not

- Do not make the label read-only to dodge §3. That was the right trade for code
  topics, which are *content*; a shape node is a topic and must stay renameable.
- Do not put colour in the path or in the template. The theme paints it.
- Do not let a shape node resize to its text. Fixed size is the decision that
  makes the outline tractable.
- Do not duplicate the border-trimming maths between renderer and SVG export.
