# T22 — Read-only code topics · implementation hand-off

A brief for one implementation session. Disposable: delete this file in the
commit that finishes the task.

**Branch:** `code-node-spike`, on top of `70eb07c`.
**Roadmap entry:** `docs/ROADMAP.md` → *T22 — Code node di sola lettura · 🧪 SPIKE*.
**Contract you must obey:** `docs/AGENT_GUIDE.md`. Read §1, §2, §3 and §6 before
touching anything. This brief does not replace it.

---

## What already exists (do not redo)

Commit `70eb07c` landed the pure half:

- `Style.code?: { lang: string }` in `src/core/types.ts` — marks a topic as a
  code block. **The source lives in `node.title`**, newlines included.
- `src/core/codeHighlight.ts` — `tokenize(source, lang, palette): TextRun[]`,
  pure, dependency-free, cached by identity. Plus `asCodeLang(string)`.
- `tests/codeHighlight.test.ts` (10 tests), `tests/codePerf.test.ts`.

Colours are **not stored in the document**. They are derived at paint time from
a palette the caller passes in. Keep it that way — see "Do not" below.

## What you are implementing

Four steps, in this order. One commit for the lot (§6), message in English
explaining *why*.

### Step 1 — A palette per theme

**File:** `src/render/theme.ts`

Add `code: CodePalette` (import the type from `src/core/codeHighlight`) to
`RenderTheme`, and fill it for **both** `THEMES.light` and `THEMES.dark`.

- `id` must differ per theme (`"light"` / `"dark"`) — the tokenizer's cache is
  keyed on it, so identical ids across themes would serve one theme's colours
  to the other.
- Pick colours that pass a sane contrast against each theme's own surface. The
  whole point of deriving them is that a document reads correctly in both.

### Step 2 — Measure a code topic

**File:** `src/layout/measure.ts` — **this is a §3 file. Read §3 first.**

A code topic does **not** wrap and **does** keep its leading whitespace. Add a
separate path inside `measureTopicUncached`:

```ts
if (n.style.code) { /* code extent */ }
```

Rules:
- Split `node.title` on `\n`. One line in, one line out — never re-wrap.
- Line height: reuse `LINE_HEIGHT_FACTOR` × the node font size. Do not invent a
  second constant (I9).
- Width = the widest line, measured with the monospace stack, plus padding.
  **Not clamped to `MAX_TOPIC_W`** — code decides its own width — but clamp to a
  sane ceiling (suggest 720) so one long line cannot produce a 20,000px bitmap.
- Height = lines × lineHeight + padding + the title bar from step 3.
- Leading spaces count toward the line's width. They are the indentation.
- Feed the result through the existing `extentKey` cache; add `code` to that key
  or a code topic will keep the extent it had as a normal topic.

**`wrapRunLines` must not change.** The 20 harness cases live on it. If you
believe it must, stop and say so instead (§1.3).

### Step 3 — Draw it

**File:** `src/render/renderer.ts`

In `drawNode`, branch on `n.style.code` before the normal text path:

- A filled rect in a code background colour, plus a title bar strip along the
  top carrying the language label and three small circles (the window chrome —
  it is what makes the block read as code rather than as a topic with odd text).
- The body: `tokenize(n.title, asCodeLang(n.style.code.lang), theme.code)`, then
  draw run by run, line by line, monospace, no wrap.
- Per-run colour is already supported in the text path (`renderer.ts:1082`,
  `bctx.fillStyle = seg.run.color ?? color`) — reuse that machinery rather than
  writing a second one.
- Respect the existing text bitmap cache: a code topic must be rasterized like
  any other, so panning blits instead of re-drawing. Its cache key must include
  the theme's palette id.
- Selection ring, hover ring and handles keep working: they go through
  `strokeRing` and know nothing about content. Do not special-case them.

### Step 4 — Read-only, and a way to create one

**Files:** `src/editor/store.ts`, `src/ui/CanvasView.tsx`, `src/ui/Palette.tsx`

- `startEdit(id)` and `typeToEdit(text)` refuse a code topic **and say why**:
  `trace.ignored("edit:start", "code topic is read-only")`. §4bis is explicit —
  a mute early return makes a deliberate guard indistinguishable from a bug.
- `onDblClick` in `CanvasView` selects the topic and returns, without mounting
  `RichEditor`. Never mount the overlay for a code topic (that is what keeps
  this feature out of the §3 parity contract entirely).
- Delete, copy, drag, undo/redo, styling: unchanged. Only editing is blocked.
- A palette command — same shape as the existing entries in `Palette.tsx:40` —
  that builds a code topic from the clipboard text under the current selection.
  Language: accept a guess or default to `"text"`; do not build a language
  picker in this spike.

---

## Definition of done (§6)

1. `npm run typecheck` → 0 errors.
2. `npm test` → all green. No new `skip`, no threshold raised.
3. **The parity harness at `http://localhost:5173/dev/parity.html` reports 0
   diverging**, because step 2 touches `measure.ts`. Run `npm run dev` first.
   This is not optional and it is the single most likely thing to break.
4. At least one test that **fails without your change**. Suggested: a code topic
   measures one line per `\n` and keeps its indentation; `startEdit` on a code
   topic leaves `editingId` null.
5. No files touched outside the lists above.

## Do not

- **Do not store colours in the document.** A snippet pasted from a dark editor
  would carry that palette into the light theme and stay unreadable forever.
  Source in, colours derived at paint.
- **Do not add a `NodeType`.** That enum drives topology and layout;
  `validateSheet` and the placers read it. A code block changes neither.
- **Do not add a highlighting dependency** (Shiki, Prism, highlight.js). The
  internal tokenizer is deliberate for the spike; choosing a library is a
  separate decision.
- **Do not change `wrapRunLines`, `LINE_HEIGHT_FACTOR`, `BLOCK_GAP_FACTOR` or
  any shared constant** (I9).
- **Do not mount `RichEditor` for a code topic** under any circumstance.
- Do not "fix" anything you notice in passing. Write it in the final message
  instead (§1.3).

## How this will be reviewed

Expect these checks, in this order:

1. `git diff` against `70eb07c`: files outside the lists → rejected.
2. Parity harness re-run. Any divergence → rejected.
3. The lossless property: `runsToPlain(tokenize(src))` still equals `src`, and a
   code topic's `title` still satisfies I5.
4. Negative controls: your new tests are reverted one at a time to confirm each
   actually fails without the code it covers.
5. Read-only verified in the running app via the tracer — a double click on a
   code topic must leave a traced reason, not silence.
6. Perf: `tests/codePerf.test.ts` numbers must not regress by an order of
   magnitude.
