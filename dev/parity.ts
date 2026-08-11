/**
 * Editor ↔ canvas parity harness (dev only — never imported by the app).
 *
 * The canvas reproduces the browser's text layout by hand (wrapRunLines +
 * renderTextBitmap). "Pixel for pixel" is therefore an *imitation*, and every
 * imitation drifts. This harness measures the drift instead of reasoning about
 * it:
 *
 *  1. it renders a corpus of TextRun[] cases into the REAL .topic-rich-editable
 *     DOM (same classes, same CSS, same padding maths as RichEditor);
 *  2. it extracts the browser's TRUE line boxes by walking every character with
 *     a Range and grouping the rects that overlap vertically;
 *  3. it runs wrapRunLines() on the same runs at the same wrap width;
 *  4. it diffs break points, line tops (cumulative vertical rhythm), line
 *     heights and line lefts.
 *
 * Results land on `window.__parity` as JSON and render as a table.
 * Run: npm run dev → http://localhost:5173/dev/parity.html
 *
 * The font family is forced to the canvas stack on both sides so the harness
 * isolates *layout* divergence; the fact that the live overlay inherits --font
 * instead is a separate (P0) defect, not something to drown these numbers in.
 */
import "../src/styles.css";
import {
  BLOCK_GAP_FACTOR,
  BULLET_WIDTH_EM,
  FONT_STACK,
  LINE_HEIGHT_FACTOR,
  MAX_TOPIC_W,
  TEXT_INSET,
  createCanvasTextMeasurer,
  measureTopic,
  wrapRunLines,
} from "../src/layout/measure";
import type { Style, TextRun } from "../src/core/types";

/** The one stack both sides use (measure.FONT_STACK === styles.css --font). */
const CANVAS_FONT = FONT_STACK;
const EPS = 0.5; // px tolerance below which a delta is not a divergence

// ---------------------------------------------------------------------------
// Corpus — one case per suspected divergence
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  what: string;
  runs: TextRun[];
  style?: Partial<Style>;
  boxW?: number;
}

const LOREM =
  "Struttura condivisa fra editor e canvas con parole abbastanza lunghe da mandare a capo il paragrafo almeno tre volte";

const CASES: Case[] = [
  {
    name: "plain-short",
    what: "single line, no wrap — the trivial baseline",
    runs: [{ text: "Central topic" }],
  },
  {
    name: "plain-wrap",
    what: "long paragraph, several wraps — core wrap parity",
    runs: [{ text: LOREM }],
  },
  {
    name: "trailing-spaces",
    what: "wrap points landing on spaces — canvas counts the trailing space in line width, CSS hangs it",
    runs: [{ text: "alfa beta gamma delta epsilon zeta eta theta iota kappa lambda" }],
  },
  {
    name: "two-paragraphs",
    what: "paraGap block gap between two paragraphs",
    runs: [{ text: "Primo blocco di testo" }, { text: "Secondo blocco di testo", paraGap: true }],
  },
  {
    name: "heading-then-body",
    what: "h1 run (26px) + body — block gap uses em of the <p> (14px) but the canvas uses the line height (26px)",
    runs: [{ text: "Titolo grande", fontSize: 26 }, { text: "Corpo del testo normale", paraGap: true }],
  },
  {
    name: "body-then-heading",
    what: "body then h1 — the block gap is em of the FOLLOWING block, so the canvas must size it from the following line too",
    runs: [{ text: "Corpo del testo normale" }, { text: "Titolo grande", fontSize: 26, paraGap: true }],
  },
  {
    name: "mixed-size-line",
    what: "26px and 14px runs on the SAME line — per-inline-box half-leading vs one half-leading per line",
    runs: [{ text: "Grande ", fontSize: 26 }, { text: "e piccolo insieme" }],
  },
  {
    name: "small-run",
    what: "10px run on a 14px base — CSS keeps the 14px strut, the canvas does not",
    runs: [{ text: "minuscolo testo di prova", fontSize: 10 }],
  },
  {
    name: "bullets-flat",
    what: "three flat list items — bullet glyph width + inter-item gap",
    runs: [
      { text: "Primo elemento", listIndent: 1 },
      { text: "\n" },
      { text: "Secondo elemento", listIndent: 1 },
      { text: "\n" },
      { text: "Terzo elemento", listIndent: 1 },
      { text: "\n" },
    ],
  },
  {
    name: "bullets-wrapped",
    what: "list item long enough to wrap — hanging indent on continuation lines",
    runs: [{ text: LOREM, listIndent: 1 }, { text: "\n" }],
  },
  {
    name: "bullets-nested",
    what: "nested list — canvas indents via listGlyph spaces, CSS has padding-left: 0",
    runs: [
      { text: "Livello uno", listIndent: 1 },
      { text: "\n" },
      { text: "Livello due", listIndent: 2 },
      { text: "\n" },
      { text: "Ancora due", listIndent: 2 },
      { text: "\n" },
    ],
  },
  {
    name: "empty-paragraph",
    what: "blank line between paragraphs — the canvas collapses it, the editor shows it",
    runs: [{ text: "sopra" }, { text: "\n" }, { text: "\n" }, { text: "sotto" }],
  },
  {
    name: "long-word",
    what: "token wider than the box — the canvas bitmap clips it, the editor overflows",
    runs: [{ text: "https://example.com/un/percorso/molto/lungo/che/non/entra/nella/box" }],
  },
  {
    name: "bold-across-word",
    what: "emphasis split mid-word — the token must not break between runs",
    runs: [{ text: "para" }, { text: "grafo", bold: true }, { text: " misto con altre parole che vanno a capo" }],
  },
  {
    // Reproduces a real central topic (fontSize 22, padding 4, box 275) where
    // the canvas wrapped to one line MORE than the editor: token widths summed
    // one by one drift from the browser's shaping of the whole line.
    name: "real-topic-22px",
    what: "central-topic metrics — accumulated token widths vs whole-line shaping",
    runs: [
      { text: "Titolo grande", fontSize: 26 },
      { text: "Corpo del testo che va a capo perche e abbastanza lungo", paraGap: true },
      { text: "Primo elemento", listIndent: 1, paraGap: true },
      { text: "\n" },
      { text: "Secondo elemento piu lungo che deve andare a capo da solo", listIndent: 1 },
      { text: "\n" },
      { text: "Annidato", listIndent: 2 },
      { text: "\n" },
    ],
    style: { fontSize: 22, padding: 4 },
    boxW: 275,
  },
  {
    name: "left-align-bullets",
    what: "align:left + bullets — hanging indent is only visible when left aligned",
    runs: [{ text: LOREM, listIndent: 1 }, { text: "\n" }],
    style: { align: "left" },
  },
];

// ---------------------------------------------------------------------------
// runs → DOM (mirrors lexicalRuns.runsToParagraphNodes / buildList)
// ---------------------------------------------------------------------------

function groupRuns(runs: TextRun[]): TextRun[][] {
  const groups: TextRun[][] = [];
  for (const run of runs) {
    if (run.paraGap) groups.push([]);
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1].push({ ...run, paraGap: false });
  }
  if (groups.length === 0) groups.push([]);
  return groups;
}

/** One TextNode as Lexical renders it: <span> + theme classes + inline style. */
function runSpan(text: string, run: TextRun): HTMLElement {
  const el = document.createElement("span");
  const cls: string[] = [];
  if (run.bold) cls.push("rnode-text-bold");
  if (run.italic) cls.push("rnode-text-italic");
  if (run.underline) cls.push("rnode-text-underline");
  if (cls.length > 0) el.className = cls.join(" ");
  const styles: string[] = [];
  if (run.color) styles.push(`color: ${run.color}`);
  if (run.fontSize) styles.push(`font-size: ${run.fontSize}px`);
  if (styles.length > 0) el.setAttribute("style", styles.join("; "));
  el.textContent = text;
  return el;
}

/** Mirrors lexicalRuns.trimBlockNewline: a block's closing \n is not a <br>. */
function trimBlockNewline(runs: TextRun[]): TextRun[] {
  const out = runs.map((r) => ({ ...r }));
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.text === "") {
      out.pop();
      continue;
    }
    if (last.text.endsWith("\n")) {
      last.text = last.text.slice(0, -1);
      if (last.text === "") out.pop();
    }
    break;
  }
  return out;
}

function inlineChildrenDom(runsIn: TextRun[]): Node[] {
  const out: Node[] = [];
  for (const run of trimBlockNewline(runsIn)) {
    const parts = run.text.split("\n");
    parts.forEach((seg, i) => {
      if (i > 0) out.push(document.createElement("br"));
      if (seg.length === 0) return;
      out.push(runSpan(seg, run));
    });
  }
  return out;
}

function buildParagraphDom(runs: TextRun[]): HTMLElement {
  const p = document.createElement("p");
  for (const child of inlineChildrenDom(runs)) p.appendChild(child);
  return p;
}

/** Mirrors lexicalRuns.buildList — including the <p> Lexical nests inside <li>. */
function buildListDom(group: TextRun[]): HTMLElement {
  const root = document.createElement("ul");
  const items: { indent: number; runs: TextRun[] }[] = [];
  let cur: { indent: number; runs: TextRun[] } | null = null;
  for (let i = 0; i < group.length; i++) {
    const run = group[i];
    if (run.listIndent !== undefined) {
      if (cur) items.push(cur);
      cur = { indent: run.listIndent, runs: [run] };
      continue;
    }
    if (!cur) continue;
    if (run.text === "\n" || run.text === "\n\n") {
      let j = i + 1;
      while (j < group.length && (group[j].text === "\n" || group[j].text.trim() === "")) j++;
      if (j < group.length && group[j].listIndent !== undefined) {
        items.push(cur);
        cur = null;
        continue;
      }
    }
    cur.runs.push(run);
  }
  if (cur) items.push(cur);

  const stack: { list: HTMLElement; indent: number }[] = [{ list: root, indent: 0 }];
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop();
    const li = document.createElement("li");
    const clean = item.runs.map((r) => ({ ...r, listIndent: undefined, paraGap: undefined }));
    // inline children, never a nested <p> — mirrors lexicalRuns.buildList
    for (const child of inlineChildrenDom(clean)) li.appendChild(child);
    const childList = document.createElement("ul");
    li.appendChild(childList);
    stack[stack.length - 1].list.appendChild(li);
    stack.push({ list: childList, indent: item.indent });
  }
  stripEmptyLists(root);
  return root;
}

/** Mirrors lexicalRuns.stripEmptyNestedLists: the sub-lists hang off the ITEMS. */
function stripEmptyLists(list: HTMLElement): void {
  for (const item of Array.from(list.children)) {
    if (item.tagName !== "LI") continue;
    for (const child of Array.from(item.children)) {
      if (child.tagName !== "UL") continue;
      if (child.children.length === 0) child.remove();
      else stripEmptyLists(child as HTMLElement);
    }
  }
}

function runsToDom(runs: TextRun[]): HTMLElement[] {
  return groupRuns(runs).map((g) => (g.some((r) => r.listIndent !== undefined) ? buildListDom(g) : buildParagraphDom(g)));
}

// ---------------------------------------------------------------------------
// Browser line boxes: walk every character, group rects that overlap vertically
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  top: number;
  /** absolute baseline y — the reference both sides are compared on */
  baseline: number;
  /**
   * Distance to the next line's top (line height + any block gap), NOT the
   * inline box height: a character's client rect is the glyph box
   * (ascent+descent ≈ 19px at 14px), which is TALLER than the 17.5px line box
   * and would add a constant fake +1.5 to every case. The advance is what the
   * canvas actually accumulates, so it is what must match.
   */
  advance: number;
  left: number;
  width: number;
  /** canvas side only: a blank line, invisible to the browser walker */
  empty?: boolean;
}

function browserLines(editable: HTMLElement): Line[] {
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  interface Ch {
    ch: string;
    top: number;
    bottom: number;
    left: number;
    right: number;
    /** the inline box's own font metrics — needed to recover the baseline */
    size: number;
    ascent: number;
  }
  const measurer = createCanvasTextMeasurer();
  const fontCache = new Map<Element, { size: number; ascent: number }>();
  const fontOf = (el: Element): { size: number; ascent: number } => {
    const hit = fontCache.get(el);
    if (hit) return hit;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize) || 14;
    const met = measurer.metrics?.({
      fontSize: size,
      fontFamily: cs.fontFamily,
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      italic: cs.fontStyle === "italic",
    }) ?? { ascent: size * 0.8, descent: size * 0.2 };
    const out = { size, ascent: met.ascent };
    fontCache.set(el, out);
    return out;
  };

  const chars: Ch[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const data = (node as Text).data;
    const font = fontOf((node as Text).parentElement!);
    for (let i = 0; i < data.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.height === 0) continue; // collapsed whitespace at a wrap point
      chars.push({ ch: data[i], top: r.top, bottom: r.bottom, left: r.left, right: r.right, size: font.size, ascent: font.ascent });
    }
  }

  // Characters arrive in reading order. Vertical overlap is NOT a usable
  // signal: an inline box (ascent+descent ≈ 19px at 14px) is taller than the
  // 17.5px line box, so consecutive lines overlap. The reliable signal in LTR
  // text is the horizontal reset — x grows monotonically inside a line and
  // jumps back left at every wrap, in centered text too (a line's first glyph
  // always starts left of the previous line's last glyph).
  const lines: { chars: Ch[]; top: number; bottom: number }[] = [];
  let prev: Ch | null = null;
  for (const c of chars) {
    const cur = lines[lines.length - 1];
    if (cur && prev && c.left + 0.5 >= prev.left) {
      cur.chars.push(c);
      cur.top = Math.min(cur.top, c.top);
      cur.bottom = Math.max(cur.bottom, c.bottom);
    } else {
      lines.push({ chars: [c], top: c.top, bottom: c.bottom });
    }
    prev = c;
  }

  const box = editable.getBoundingClientRect();
  const cs = getComputedStyle(editable);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const originX = box.left + padLeft;
  const contentBottom = box.bottom - padBottom;

  return lines.map((l, i) => {
    // trailing/leading spaces do not count towards the visible extent
    let a = 0;
    let b = l.chars.length - 1;
    while (a <= b && /\s/.test(l.chars[a].ch)) a++;
    while (b >= a && /\s/.test(l.chars[b].ch)) b--;
    const vis = l.chars.slice(a, b + 1);
    const left = vis.length > 0 ? Math.min(...vis.map((c) => c.left)) : l.chars[0].left;
    const right = vis.length > 0 ? Math.max(...vis.map((c) => c.right)) : l.chars[0].right;
    // A character's client rect is its inline box: [baseline − ascent,
    // baseline + descent]. So the baseline is recoverable, and comparing
    // BASELINES is both exact and the thing that actually matters — glyph-box
    // tops sit at a different offset from the line box for every font size,
    // which showed as a phantom 1px on any line carrying a heading.
    const ref = l.chars.reduce((a, c) => (c.size > a.size ? c : a), l.chars[0]);
    const baseline = ref.top + ref.ascent;
    const next = lines[i + 1];
    const nextRef = next ? next.chars.reduce((a, c) => (c.size > a.size ? c : a), next.chars[0]) : null;
    return {
      text: l.chars.map((c) => c.ch).join(""),
      top: l.top,
      baseline,
      advance: nextRef ? nextRef.top + nextRef.ascent - baseline : contentBottom - l.top,
      left: left - originX,
      width: right - left,
    };
  });
}

// ---------------------------------------------------------------------------
// Canvas side: wrapRunLines + the cumulative geometry renderTextBitmap applies
// ---------------------------------------------------------------------------

function canvasLines(runs: TextRun[], maxW: number, style: Style): { lines: Line[]; totalH: number } {
  const measurer = createCanvasTextMeasurer();
  const base = style.fontSize ?? 14;
  const wrapped = wrapRunLines(runs, maxW, measurer, style);
  const out: Line[] = [];
  let y = 0;
  for (const l of wrapped) {
    const lh = l.height ?? base * LINE_HEIGHT_FACTOR;
    y += l.gapPx ?? 0;
    const text = l.segments.map((s) => s.text).join("");
    // mirrors renderer.drawText: list items are always left-aligned
    const indent = l.indent ?? 0;
    const isList = indent > 0 || !!l.bullet;
    const left = style.align === "left" || isList ? indent : (maxW - l.width) / 2;
    out.push({ text, top: y, baseline: y + (l.baseline ?? lh * 0.8), advance: lh, left, width: l.width, empty: l.segments.length === 0 });
    y += lh;
  }
  // A blank line has no characters, so the browser walker cannot see it — drop
  // it from the line-by-line comparison (totalH still covers it: if the canvas
  // and the editor disagreed about a blank line, the heights would diverge).
  const visible = out.filter((l) => !l.empty);
  // advance = distance to the next VISIBLE line's top, exactly like the
  // browser side (computing this before the filter compared a canvas advance
  // that stopped at the blank line against a browser advance that skipped it).
  for (let i = 0; i < visible.length - 1; i++) visible[i].advance = visible[i + 1].baseline - visible[i].baseline;
  return { lines: visible, totalH: y };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

/** Break-point comparison ignores the bullet glyph (a ::marker in the browser). */
function normText(s: string): string {
  return s.replace(/[•◦]/g, " ").replace(/\s+/g, " ").trim();
}

interface LineDiff {
  i: number;
  canvas: string;
  browser: string;
  sameText: boolean;
  dTop: number;
  dAdv: number;
  dLeft: number;
  dWidth: number;
}

interface CaseResult {
  name: string;
  what: string;
  boxW: number;
  wrapW: number;
  linesCanvas: number;
  linesBrowser: number;
  firstBreakMismatch: number | null;
  maxDTop: number;
  maxDLeft: number;
  maxDAdv: number;
  totalHCanvas: number;
  totalHBrowser: number;
  dTotalH: number;
  lines: LineDiff[];
  verdict: "OK" | "DRIFT" | "BREAKS";
}

function runCase(c: Case, host: HTMLElement): CaseResult {
  const style: Style = { fontSize: 14, padding: 10, align: "center", ...c.style } as Style;
  const boxW = c.boxW ?? 280;
  const pad = style.padding ?? 10;
  const wrapW = boxW - pad * 2 - TEXT_INSET;

  // --- DOM exactly as RichEditor builds it (minus the transform: scale) ---
  const inner = document.createElement("div");
  inner.className = "topic-rich-inner";
  Object.assign(inner.style, {
    width: `${boxW}px`,
    height: "auto",
    fontSize: `${style.fontSize ?? 14}px`,
    lineHeight: String(LINE_HEIGHT_FACTOR),
    textAlign: style.align === "left" ? "left" : "center",
    fontFamily: style.fontFamily ?? CANVAS_FONT,
  });
  inner.style.setProperty("--rnode-block-gap", `calc(${BLOCK_GAP_FACTOR} * ${LINE_HEIGHT_FACTOR}em)`);
  inner.style.setProperty("--rnode-bullet-w", `${BULLET_WIDTH_EM}em`);

  const editable = document.createElement("div");
  editable.className = "topic-rich-editable";
  Object.assign(editable.style, {
    paddingTop: `${pad + 2}px`,
    paddingBottom: `${pad + 2}px`,
    paddingLeft: `${pad - 2}px`,
    paddingRight: `${pad + TEXT_INSET - 2}px`,
    overflow: "visible",
  });
  for (const el of runsToDom(c.runs)) editable.appendChild(el);
  inner.appendChild(editable);
  host.appendChild(inner);

  // --- measure both sides ---
  const bLines = browserLines(editable);
  const { lines: cLines, totalH: totalHCanvas } = canvasLines(c.runs, wrapW, style);
  const eBox = editable.getBoundingClientRect();
  const eCs = getComputedStyle(editable);
  const totalHBrowser = eBox.height - (parseFloat(eCs.paddingTop) || 0) - (parseFloat(eCs.paddingBottom) || 0);

  const b0 = bLines.length > 0 ? bLines[0].baseline : 0;
  const c0 = cLines.length > 0 ? cLines[0].baseline : 0;
  const n = Math.max(bLines.length, cLines.length);
  const lines: LineDiff[] = [];
  let firstBreakMismatch: number | null = null;
  let maxDTop = 0;
  let maxDLeft = 0;
  let maxDAdv = 0;
  for (let i = 0; i < n; i++) {
    const cl = cLines[i];
    const bl = bLines[i];
    const sameText = !!cl && !!bl && normText(cl.text) === normText(bl.text);
    if (!sameText && firstBreakMismatch === null) firstBreakMismatch = i;
    const last = i === n - 1;
    // baseline drift, both sides measured from their own first baseline
    const dTop = cl && bl ? cl.baseline - c0 - (bl.baseline - b0) : NaN;
    // the last "advance" is not an inter-line distance on either side
    const dAdv = cl && bl && !last ? cl.advance - bl.advance : NaN;
    const dLeft = cl && bl ? cl.left - bl.left : NaN;
    const dWidth = cl && bl ? cl.width - bl.width : NaN;
    if (Number.isFinite(dTop)) maxDTop = Math.max(maxDTop, Math.abs(dTop));
    if (Number.isFinite(dLeft)) maxDLeft = Math.max(maxDLeft, Math.abs(dLeft));
    if (Number.isFinite(dAdv)) maxDAdv = Math.max(maxDAdv, Math.abs(dAdv));
    lines.push({
      i,
      canvas: cl ? cl.text : "—",
      browser: bl ? bl.text : "—",
      sameText,
      dTop: round(dTop),
      dAdv: round(dAdv),
      dLeft: round(dLeft),
      dWidth: round(dWidth),
    });
  }

  const dTotalH = totalHCanvas - totalHBrowser;
  const verdict =
    cLines.length !== bLines.length || firstBreakMismatch !== null
      ? "BREAKS"
      : maxDTop > EPS || maxDLeft > EPS || maxDAdv > EPS || Math.abs(dTotalH) > EPS
        ? "DRIFT"
        : "OK";

  return {
    name: c.name,
    what: c.what,
    boxW,
    wrapW,
    linesCanvas: cLines.length,
    linesBrowser: bLines.length,
    firstBreakMismatch,
    maxDTop: round(maxDTop),
    maxDLeft: round(maxDLeft),
    maxDAdv: round(maxDAdv),
    totalHCanvas: round(totalHCanvas),
    totalHBrowser: round(totalHBrowser),
    dTotalH: round(dTotalH),
    lines,
    verdict,
  };
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function render(results: CaseResult[]): void {
  const out = document.getElementById("parity-out")!;
  const bad = results.filter((r) => r.verdict !== "OK").length;
  const esc = (s: string): string => s.replace(/[<&]/g, (m) => (m === "<" ? "&lt;" : "&amp;"));
  out.innerHTML = `
    <h1 style="font:600 18px system-ui;margin:0 0 4px">Editor ↔ canvas parity</h1>
    <p style="font:13px system-ui;margin:0 0 16px;color:#555">
      ${results.length} cases · <b>${bad} diverging</b> ·
      BREAKS = different line count or different break points · DRIFT = same breaks, geometry off by &gt; ${EPS}px
    </p>
    ${results
      .map(
        (r) => `
      <section style="margin:0 0 20px;border:1px solid #ddd;border-radius:6px;overflow:hidden">
        <header style="padding:6px 10px;background:${r.verdict === "OK" ? "#e8f5e9" : r.verdict === "DRIFT" ? "#fff8e1" : "#ffebee"};font:600 13px system-ui">
          ${r.verdict} · ${r.name}
          <span style="font-weight:400;color:#666"> — ${esc(r.what)}</span>
        </header>
        <div style="padding:6px 10px;font:12px system-ui;color:#444">
          lines canvas/browser: <b>${r.linesCanvas}/${r.linesBrowser}</b> ·
          height canvas/browser: <b>${r.totalHCanvas}/${r.totalHBrowser}</b> (Δ ${r.dTotalH}) ·
          maxΔtop <b>${r.maxDTop}</b> · maxΔleft <b>${r.maxDLeft}</b> · maxΔadv <b>${r.maxDAdv}</b>
        </div>
        <table style="width:100%;border-collapse:collapse;font:11px/1.4 ui-monospace,monospace">
          <tr style="background:#fafafa"><th>#</th><th style="text-align:left">canvas</th><th style="text-align:left">browser</th><th>Δtop</th><th>Δadv</th><th>Δleft</th><th>Δw</th></tr>
          ${r.lines
            .map(
              (l) => `<tr style="background:${l.sameText ? "transparent" : "#ffebee"}">
              <td style="text-align:center;color:#999">${l.i}</td>
              <td>${esc(l.canvas.slice(0, 46))}</td>
              <td>${esc(l.browser.slice(0, 46))}</td>
              <td style="text-align:right;${Math.abs(l.dTop) > EPS ? "color:#c62828;font-weight:700" : ""}">${l.dTop}</td>
              <td style="text-align:right;${Math.abs(l.dAdv) > EPS ? "color:#c62828;font-weight:700" : ""}">${l.dAdv}</td>
              <td style="text-align:right;${Math.abs(l.dLeft) > EPS ? "color:#c62828;font-weight:700" : ""}">${l.dLeft}</td>
              <td style="text-align:right;color:#999">${l.dWidth}</td>
            </tr>`
            )
            .join("")}
        </table>
      </section>`
      )
      .join("")}`;
}

const stage = document.createElement("div");
// off-screen but really laid out (display:none would kill getClientRects)
Object.assign(stage.style, { position: "absolute", left: "-10000px", top: "0", visibility: "hidden" });
document.body.appendChild(stage);

const results = CASES.map((c) => runCase(c, stage));
render(results);
(window as unknown as { __parity: CaseResult[] }).__parity = results;
// debug handle: lets the console interrogate the measurement side directly
(window as unknown as { __measure: unknown }).__measure = {
  wrapRunLines,
  measureTopic,
  MAX_TOPIC_W,
  TEXT_INSET,
  measurer: createCanvasTextMeasurer(),
};
// eslint-disable-next-line no-console
console.log("[parity]", JSON.stringify(results.map(({ lines, ...r }) => r)));
