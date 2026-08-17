# Lane B — text parity audit (measure ↔ render ↔ runs)

Scope: `src/layout/measure.ts`, `src/render/renderer.ts` (text path),
`src/ui/lexicalRuns.ts`, `src/core/codeHighlight.ts`, `src/styles.css`
(`.topic-rich-*`, `--font`). Context read but not restructured: `RichEditor.tsx`
(Lane D), `pasteSanitizer.ts` (the second producer of runs), `dev/parity.ts`
(the I10 harness), `src/core/text.ts` / `types.ts` (Lane A1).

Method: trace of the three implementations against §3 of AGENT_GUIDE.md,
cross-checked against the harness corpus, `tests/measure.test.ts`,
`tests/lexicalRuns.test.ts`, and one empirical run of `wrapRunLines` (scratch
test, since deleted). **No code was changed by this audit.**

---

## The representational question, answered

> Do the two sides describe a laid-out line with the same vocabulary?

Mostly yes — with two exceptions, one of which is the strongest finding in this
lane (F1) and one of which is the answer the audit is fishing for (F2):

- `renderTextBitmap` consumes `line.baseline`, `line.height`, `line.indent`,
  `line.gapPx`, `line.bullet` and `line.width` field-by-field from the
  `TextRunLine` that `wrapRunLines` produced. It does **not** recompute the line
  box (Rule 1) or the baseline (Rule 2) — the expensive, measured rules live in
  exactly one place and the renderer obeys them. Good.
- **But** every geometric field on `TextRunLine` is declared *optional* and the
  renderer re-derives each one under a `??` fallback (F2). The fallbacks are
  dead today (the single producer always sets every field) and they re-encode
  the two formulas §3 explicitly disavows.
- The run → font-metrics resolution (bold/italic/size/family) is spelled twice,
  and the two spellings are not the same text (F3).
- The two run→block converters in `lexicalRuns.ts` reconstruct block structure
  with loop-carried state instead of a boundary-carrying type, and the two
  converters disagree with `wrapRunLines` about what a `\n` run before a
  `paraGap` run means (F1).

---

## Rule-by-rule scorecard (encoded once vs re-expressed)

| §3 rule | Where it lives | Verdict |
|---|---|---|
| 1. Line box = max(above)+max(below), strut included | `wrapRunLines` `boxOf`/`strutBox` only; renderer consumes `height`/`baseline` | ✅ once — *except* dead `??` fallbacks re-encode the wrong formula (F2) |
| 2. Baseline computed in `wrapRunLines` only | `push()` sets `baseline: lineAbove`; renderer consumes it | ✅ once — dead `?? lh * 0.8` fallback (F2) |
| 3. Block gap from the strut | `blockGapPx = strut * LINE_HEIGHT_FACTOR * BLOCK_GAP_FACTOR`; CSS via `--rnode-block-gap` (set from the same constants) | ✅ once in TS — CSS fallback `0.75em` is a dead literal copy (F4) |
| 4. paraGap opens a block without `\n` | `wrapRunLines` `openParagraph`; both producers set paraGap | ✅ once — but see F1 (the *with* `\n` case disagrees) |
| 5. Bullet column / hang indent / left-align | `BULLET_WIDTH_EM`, `textIndent`, `bullet.x`, CSS `li` padding/text-indent/align | ✅ geometry once — bullet *glyph table* `• ◦ ▪` duplicated in CSS `::before` (F4) |
| 6. Trailing spaces hang | `push()` pops trailing whitespace, `width = visibleWidth` | ✅ once |
| 7. Over-wide token breaks mid-word | `fitPrefix` in `wrapRunLines`; CSS `overflow-wrap: break-word` | ✅ once |
| 8. Blank line between blocks is real; trailing `\n` closes | `lastContentIdx` + empty-paragraph emit | ⚠️ half — the `\n`-then-`paraGap` shape (the one the producers emit) is absorbed (F1) |

I9 constants: `LINE_HEIGHT_FACTOR`, `BLOCK_GAP_FACTOR`, `BULLET_WIDTH_EM`,
`TEXT_INSET`, `FONT_STACK` are all imported into RichEditor and the renderer
from `measure.ts` — the overlay CSS vars are **set from the constants**, not
hard-typed. The violations are the dead CSS fallbacks, the second monospace
literal, and the comment-only `FONT_STACK` ↔ `--font` link (F4, F5).

---

## F1 — The `\n`-then-`paraGap` shape diverges by one line + one gap, and the harness cannot see it  *(behavioral, highest severity)*

**Summary.** Both run producers emit `\n` immediately before a `paraGap` run —
`editorStateToRuns` for a blank paragraph between two blocks
(`<p>a</p><p><br></p><p>b</p>` → `[{a}, {"\n"}, {b, paraGap}]`, lexicalRuns.ts:153-168)
and `pasteSanitizer.walkBlocks`/`plainTextToRuns` for every pasted block boundary
(pasteSanitizer.ts:310-318, 451-456). On that shape the two sides draw different
numbers of lines:

- **Canvas** (`wrapRunLines`, measure.ts:334-338): the `\n` opens an empty
  paragraph, then the `paraGap` run's `openParagraph()` **reuses** it
  (`if (last.length > 0) push` is false), so the blank line is absorbed. Output:
  `[a]`, gap, `[b]` — **2 lines**.
- **Editor** (`runsToParagraphNodes`, lexicalRuns.ts:304-316): `paraGap` always
  opens a new group, and the `\n` run lands *inside* the previous group, where
  `inlineChildren` turns it into a `<br>` (lexicalRuns.ts:218-228). Output:
  `<p>a<br></p><p>b</p>` — **3 lines**, and both `<p>`s take the block margin.

At 14px base that is 17.5px (the `<br>` line) + 10.5px (the second margin) =
**28px of vertical drift** on every such node. For a typed blank paragraph the
canvas is wrong (Rule 8 says the blank line is real); for a pasted paragraph
break the *editor* is wrong (the `<br>` is spurious). The runs cannot
distinguish the two origins, so the fix must make the two sides agree on the
runs they share — e.g. canvas emits the blank line (matching the browser) and
`runsToParagraphNodes` stops turning a `\n` that precedes a `paraGap` boundary
into a `<br>` — and pin the choice in the I8 tests.

**Why the harness is green anyway.** The corpus's `empty-paragraph` case
(dev/parity.ts:136-138) uses `[{a},{"\n"},{"\n"},{b}]` — *no* `paraGap` — a shape
neither producer emits (verified: this shape yields 3 flush lines on both sides
and passes). Its `what` text ("the canvas collapses it") describes the pre-fix
bug. Adding the real shape as a corpus case makes it BREAKS immediately: canvas
2 lines vs browser 3.

Evidence: measure.ts:334-338 (`openParagraph` reuses the empty paragraph),
measure.ts:419 (`gapBefore` — the blank line never gets a gap), lexicalRuns.ts:168
(the `g[0].text !== "\n"` guard), lexicalRuns.ts:218-228 + 304-316 (the `<br>`),
pasteSanitizer.ts:310-318, 451-456 (producer shape), dev/parity.ts:136-138
(corpus gap). Empirically confirmed with a scratch vitest run: the paraGap shape
returns 2 lines (`gapPx 10.5` on line 2), the `\n\n` shape returns 3.

**VALIDATION.** Fixing this touches measure.ts / lexicalRuns.ts / styles.css:
I10 requires a browser parity harness run at **0 divergences**
(`npm run dev` → `http://localhost:5173/dev/parity.html`), plus a new corpus
case for the `\n`+`paraGap` shape, plus an I8 round-trip test pinning the shape
(3 cycles). Also re-run `npm run typecheck` and `npm test`.

---

## F2 — `TextRunLine` geometry is optional; the renderer re-derives it under dead fallbacks  *(representational — the duplication the audit targets)*

**Summary.** Every geometric field the renderer consumes is declared optional
(`height?`, `baseline?`, `indent?`, `gapPx?`, measure.ts:280-301) even though
`wrapRunLines` unconditionally sets all of them in all three emit sites
(`push()` measure.ts:444-453; blank-paragraph emit measure.ts:458-463; final
strut line measure.ts:465). The renderer then carries a parallel formula under
each `??`:

```ts
const lh = line.height ?? size * LINE_HEIGHT_FACTOR;   // renderer.ts:1105,1127
const baselineY = yCursor + (line.baseline ?? lh * 0.8); // renderer.ts:1134
const indent = line.indent ?? 0;                         // renderer.ts:1144
yCursor += line.gapPx ?? 0;                              // renderer.ts:1128
```

- `size * LINE_HEIGHT_FACTOR` is the exact "largest font-size × 1.25" formula
  the measure's own comment says was wrong (measure.ts:345-346).
- `lh * 0.8` re-encodes the 0.8/0.2 ascent split that lives in
  `HEURISTIC_MEASURER` and in `boxOf`'s no-metrics fallback (measure.ts:39, 342).
- `isList = indent > 0 || !!line.bullet` (renderer.ts:1146) re-derives Rule 5's
  condition from two fields instead of one `list` flag on the line.
- The harness mirrors *the same fallbacks* in its canvas side
  (`canvasLines`, dev/parity.ts:253-267), so if a future change makes
  `wrapRunLines` stop emitting a field, the harness re-derives the old formula
  too and both "sides" share the mistake — the very failure mode I9 exists to
  prevent.

**Impact.** No live divergence (the fields are always present), but the
contract is a lie: it invites the renderer to reconstruct layout, and any
reconstruction is a second definition. The fields should be **required**
(`height: number; baseline: number; indent: number; gapPx?: number`) with the
renderer's `??` branches deleted, so a missing field is a compile error instead
of a silent re-derivation.

**VALIDATION.** Touching measure.ts / renderer.ts text path requires the I10
harness run at **0 divergences**, plus `npm run typecheck` and `npm test`.

---

## F3 — Run → font-metrics resolution is spelled twice, with an extra rule on the renderer side  *(I9 duplication)*

**Summary.** The mapping from `(run, node style)` to the metrics input is
defined in `runMetrics` (measure.ts:305-311):

```ts
fontWeight: run.bold ? 700 : style.fontWeight,
italic: (run.italic ?? false) || (style.italic ?? false),
fontSize: run.fontSize ?? style.fontSize ?? 14,
```

and re-derived in `renderTextBitmap`'s `fontOf` + inline re-measure
(renderer.ts:1117-1125, 1148-1153), which adds a rule that does not exist on the
measure side:

```ts
const bold = (seg.run.bold ?? false) || baseWeight >= 700;  // renderer.ts:1119
```

For the weights the UI can produce (400/600/700 — Inspector.tsx:168, doc.ts:127-216;
paste normalizes weight to the `bold` boolean, pasteSanitizer.ts:164) both
spellings agree. But `baseWeight >= 700` is a *different* rule than
`run.bold ? 700 : style.fontWeight`: with a node weight of 800/900 and a
non-bold run, `runMetrics` measures the run at 800/900 while the painter draws
and re-measures it at 700 — centered text would drift left and per-segment
`x +=` would no longer sum to `line.width`. The painter also re-measures every
segment for x-advance (renderer.ts:1153) instead of consuming the widths
`wrapRunLines` already measured, which is only consistent while the two
spellings agree. This is precisely the I9 "two copies drift" scenario, currently
latent.

**Fix shape:** export `runMetrics` from measure.ts and have `fontOf` consume it
(the draw font string is the same inputs the measurer uses — there is no reason
for the painter to own a second resolution).

**VALIDATION.** I10 harness at **0 divergences**; `npm run typecheck`;
`npm test`.

---

## F4 — styles.css re-encodes shared constants as literals  *(I9)*

**Summary.** The constants are set from TS via RichEditor (RichEditor.tsx:111-113)
**and** repeated as dead CSS fallbacks:

- `var(--rnode-bullet-w, 1.2em)` (styles.css:875, 878, 884) — literal copy of
  `BULLET_WIDTH_EM`.
- `var(--rnode-block-gap, 0.75em)` (styles.css:892-893) — literal copy of
  `BLOCK_GAP_FACTOR * LINE_HEIGHT_FACTOR` (0.6 × 1.25).

The fallbacks are unreachable today (RichEditor always sets both vars), so they
are pure duplicate-constant surface: if the JS-set vars are ever removed or
renamed, the CSS silently keeps a stale copy with no harness failure (the
harness sets the vars from the constants too). Either drop the fallbacks or
generate them from the constants in the Vite/TS layer.

Second copy: the bullet glyph table lives twice — `BULLET_CHARS = ["•","◦","▪"]`
+ `bulletChar` clamp (measure.ts:270-274) and the three `li::before` content
rules (styles.css:880-886). They agree only because both clamp at depth 3; a
fourth glyph needs a coordinated change in both files with no test linking them.

Third: the bullet column is sized from `bulletRun?.fontSize ?? strut`
(measure.ts:414) while the CSS `padding-left: var(--rnode-bullet-w)` resolves
against the *li's* font size (the base size — `applyInline` never reads
font-size and headings are skipped inside list items, pasteSanitizer.ts:161-176,
302-306, so the run font-size is unreachable there in practice). Latent, but the
measure comment "in em of the list item's font size" and the code disagree on
what "the item's font size" means.

**VALIDATION.** Touching styles.css `.topic-rich-*` or measure.ts requires the
I10 harness at **0 divergences**, `npm run typecheck`, `npm test`.

---

## F5 — The harness's corpus text and header describe pre-fix bugs, and `FONT_STACK` ↔ `--font` is comment-enforced only

**Summary.**

1. Nearly every `what` string in the corpus describes the *historical bug* the
   case was built to catch, not what the case now verifies: "canvas counts the
   trailing space in line width" (parity.ts:104), "canvas indents via listGlyph
   spaces" (:125), "the canvas collapses it, the editor shows it" (:137),
   "the canvas bitmap clips it" (:142), "accumulated token widths vs whole-line
   shaping" (:155, dismissed in AGENT_GUIDE §5), "the canvas uses the line
   height (26px)" (heading cases). All of those behaviors were fixed; the
   strings read like a bug list and imply coverage that does not exist — F1 is
   the concrete casualty.
2. The header claims "the live overlay inherits `--font` instead [of the canvas
   stack] is a separate (P0) defect" (parity.ts:21-22). Stale: RichEditor sets
   `fontFamily: ns.fontFamily ?? FONT_STACK` (RichEditor.tsx:100), so the live
   overlay already uses the imported constant; the harness's "forced" font is a
   no-op today.
3. `FONT_STACK` (measure.ts:95-100) and `--font` (styles.css:10) are byte-
   identical strings but have **no shared source**: `--font` feeds body chrome,
   `FONT_STACK` feeds topic text, and the I9 "must stay identical" rule is
   enforced by a comment and a harness that does not read `--font` at all. A
   change to one literal cannot fail any check.
4. `--mono` (styles.css:11) is a *second* monospace literal, different from
   `CODE_FONT_STACK` (measure.ts:102) and not I9-managed. It is used only by the
   palette UI (styles.css:1105), never by a code topic (those are read-only), so
   it is not a parity break — but it is an unmanaged third spelling of "the
   monospace stack".

**VALIDATION.** Updating the corpus is a change to `dev/parity.ts` (the I10
instrument): re-run the harness to **0 divergences** and confirm `window.__parity`
is green; `npm run typecheck` and `npm test` for any producer changes.

---

## Bottom line

The measured rules (1, 2, 3, 6, 7 and the block-gap/strut math) are genuinely
encoded once in `wrapRunLines` and the renderer consumes them — the architecture
holds where it was hardest to hold. The failures are at the *boundary
vocabulary*: the optional-with-fallback geometry (F2), the duplicated
run→metrics resolution (F3), the constant literals in CSS (F4), and above all
the `\n`-before-`paraGap` shape where measure and `lexicalRuns` implement two
different blank-line semantics that the harness corpus — whose descriptions are
stale (F5) — does not exercise. F1 is a user-visible 28px/line drift on pasted
and blank-paragraph-rich nodes; the other four are latent divergence,
duplication, and documentation debt, in that order.
