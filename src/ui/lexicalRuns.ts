/**
 * Bridge between the Lexical editor state (single overlay) and the store's
 * TextRun[] draft/model. Two directions:
 *  - setEditorRuns: seed the editor from runs (node title / type-to-edit);
 *  - editorStateToRuns: every keystroke converts the editor back to runs so
 *    the store can lay out the topic live and commit one op at the end.
 *
 * Bold/italic/underline map to Lexical TextNode format bits; color and
 * per-run font size live in the TextNode inline style (color: #hex;
 * font-size: Xpx), which Lexical carries through splits and serialization.
 *
 * Block structure survives the round trip so pasted content (Draw.io/Word/
 * web) keeps its spatial layout on the canvas:
 *  - paragraphs → runs flagged paraGap (extra vertical gap);
 *  - ListItemNode → first run flagged listIndent (renderer draws the bullet
 *    glyph and hangs continuation lines);
 *  - HeadingNode → runs with a larger fontSize.
 */
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from "lexical";
import { $isHeadingNode } from "@lexical/rich-text";
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode, type ListNode } from "@lexical/list";
import type { TextRun } from "../core/types";
import { normalizeRuns } from "../core/text";

// Lexical TextNode format bits (same values as the library's FORMAT_* exports).
const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_UNDERLINE = 4;

const COLOR_RE = /color:\s*(#[0-9a-fA-F]{3,8})\b/;
const FONT_SIZE_RE = /font-size:\s*(\d+(?:\.\d+)?)px/;
const MAX_INDENT = 8;

/** Heading level → font size in px (absolute, independent of node font size). */
const HEADING_SIZES: Record<string, number> = { h1: 26, h2: 21, h3: 18, h4: 16, h5: 15, h6: 14 };

export function textNodeToRun(n: TextNode, ctx: { headingSize?: number }): TextRun {
  const format = n.getFormat();
  const run: TextRun = { text: n.getTextContent() };
  if (format & FORMAT_BOLD) run.bold = true;
  if (format & FORMAT_ITALIC) run.italic = true;
  if (format & FORMAT_UNDERLINE) run.underline = true;
  const m = n.getStyle().match(COLOR_RE);
  if (m) run.color = m[1];
  if (ctx.headingSize) run.fontSize = ctx.headingSize;
  else {
    const fm = n.getStyle().match(FONT_SIZE_RE);
    if (fm) run.fontSize = Math.round(parseFloat(fm[1]));
  }
  return run;
}

function pushRun(runs: TextRun[], r: TextRun): void {
  if (r.text.length === 0) return;
  const last = runs[runs.length - 1];
  if (
    last &&
    (last.bold ?? false) === (r.bold ?? false) &&
    (last.italic ?? false) === (r.italic ?? false) &&
    (last.underline ?? false) === (r.underline ?? false) &&
    (last.color ?? null) === (r.color ?? null) &&
    (last.fontSize ?? null) === (r.fontSize ?? null) &&
    (last.paraGap ?? false) === (r.paraGap ?? false) &&
    (last.listIndent ?? null) === (r.listIndent ?? null)
  ) {
    last.text += r.text;
  } else {
    runs.push({ ...r });
  }
}

interface CollectCtx {
  headingSize?: number;
  listDepth: number;
}

/** Flatten a Lexical node tree (paragraphs, line breaks, lists, headings) into runs. */
function collectRuns(node: LexicalNode, runs: TextRun[], ctx: CollectCtx): void {
  if (node instanceof TextNode) {
    pushRun(runs, textNodeToRun(node, ctx));
    return;
  }
  if (node.getType() === "linebreak") {
    pushRun(runs, { text: "\n" });
    return;
  }
  if ($isListNode(node)) {
    const inner: TextRun[] = [];
    for (const child of (node as ElementNode).getChildren()) {
      collectRuns(child, inner, { ...ctx, listDepth: ctx.listDepth + 1 });
    }
    // The newline after the LAST item is redundant — the list block ends there.
    // Kept, every runs → editor → runs cycle appended one more, and a title
    // that had been edited twice grew a blank line the canvas drew and the
    // editor never showed.
    for (const r of trimBlockNewline(inner)) pushRun(runs, r);
    return;
  }
  if ($isListItemNode(node)) {
    // Structural nesting (ul > li > ul) and Lexical's own indent property are
    // two spellings of the SAME level, not two levels to add up: buildList
    // rebuilds nesting from listIndent, so summing them made the depth grow on
    // every round trip. Take whichever spelling the editor used.
    const indent = Math.min(MAX_INDENT, Math.max(ctx.listDepth, 1 + (node.getIndent() || 0)));
    const inner: TextRun[] = [];
    for (const child of (node as ElementNode).getChildren()) {
      if ($isListNode(child)) {
        // nested list starts on its own line. Recurse with ctx UNCHANGED: the
        // $isListNode branch above already counts the level, and incrementing
        // here too made every nesting level count twice (a level-2 item came
        // back as listIndent 4 and the canvas indented it twice as far as the
        // editor did).
        if (inner.length > 0) pushRun(inner, { text: "\n" });
        collectRuns(child, inner, ctx);
      } else {
        collectRuns(child, inner, { ...ctx, headingSize: undefined });
      }
    }
    // the item's first run carries the bullet indent marker
    if (inner.length > 0 && inner[0].listIndent === undefined) inner[0].listIndent = indent;
    for (const r of inner) pushRun(runs, r);
    pushRun(runs, { text: "\n" });
    return;
  }
  if ($isHeadingNode(node)) {
    const tag = node.getTag();
    const level = tag.startsWith("h") ? tag : `h${tag}`;
    for (const child of (node as ElementNode).getChildren()) {
      collectRuns(child, runs, { ...ctx, headingSize: HEADING_SIZES[level] ?? HEADING_SIZES.h2 });
    }
    return;
  }
  for (const child of (node as ElementNode).getChildren()) collectRuns(child, runs, ctx);
}

/** The whole editor state → runs (one topic title). */
export function editorStateToRuns(editorState: EditorState): TextRun[] {
  const runs: TextRun[] = [];
  editorState.read(() => {
    const root = $getRoot();
    const children = root.getChildren();
    // Collect each root child (paragraph / list / heading) separately so a
    // block boundary becomes a paragraph gap instead of a plain newline.
    const groups: TextRun[][] = [];
    for (const child of children) {
      const g: TextRun[] = [];
      collectRuns(child, g, { listDepth: 0 });
      groups.push(g);
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (i > 0 && g.length > 0 && g[0].text !== "\n") g[0].paraGap = true;
      for (const r of g) pushRun(runs, r);
    }
  });
  return normalizeRuns(runs);
}

// ---------------------------------------------------------------------------
// Reverse: runs → Lexical nodes (seeding the editor / inserting pasted runs)
// ---------------------------------------------------------------------------

function makeTextNode(text: string, run: TextRun): TextNode {
  const node = $createTextNode(text);
  let format = 0;
  if (run.bold) format |= FORMAT_BOLD;
  if (run.italic) format |= FORMAT_ITALIC;
  if (run.underline) format |= FORMAT_UNDERLINE;
  if (format) node.setFormat(format);
  const styles: string[] = [];
  if (run.color) styles.push(`color: ${run.color}`);
  if (run.fontSize) styles.push(`font-size: ${run.fontSize}px`);
  if (styles.length > 0) node.setStyle(styles.join("; "));
  return node;
}

/**
 * Drop the newline that merely CLOSES a block — the block boundary is already
 * the line break. Kept, it made Lexical emit a <br> plus its own "managed"
 * linebreak, i.e. a blank line the editor showed and the canvas did not draw
 * (wrapRunLines discards a trailing empty paragraph): a full extra line of
 * drift on every list item and every pasted block.
 */
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

/** Inline children for a block: \n → LineBreakNode, styles per run. */
function inlineChildren(runs: TextRun[]): LexicalNode[] {
  const out: LexicalNode[] = [];
  for (const run of runs) {
    const parts = run.text.split("\n");
    parts.forEach((seg, i) => {
      if (i > 0) out.push($createLineBreakNode());
      if (seg.length === 0) return;
      out.push(makeTextNode(seg, run));
    });
  }
  return out;
}

/** One paragraph of runs: \n → LineBreakNode, styles per run. */
function buildParagraph(runs: TextRun[]): LexicalNode {
  const p = $createParagraphNode();
  for (const child of inlineChildren(trimBlockNewline(runs))) p.append(child);
  return p;
}

/** Rebuild (nested) bullet lists from a group of listIndent runs. */
function buildList(group: TextRun[]): ListNode {
  const root = $createListNode("bullet");

  // Split the group into items. A run with listIndent starts an item; a "\n"
  // run is an item boundary only when followed by another listIndent run.
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

  const stack: { list: ListNode; indent: number }[] = [{ list: root, indent: 0 }];
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop();
    const li = $createListItemNode();
    // strip listIndent/paraGap so the item content renders as plain text
    const clean = item.runs.map((r) => ({ ...r, listIndent: undefined, paraGap: undefined }));
    // INLINE children, never a nested <p>: a block child inside <li> pushes the
    // bullet onto a line of its own (measured: a 17.5px item became 35px), so
    // every list item cost the canvas a full extra line of drift.
    for (const child of inlineChildren(trimBlockNewline(clean))) li.append(child);
    const childList = $createListNode("bullet");
    li.append(childList);
    stack[stack.length - 1].list.append(li);
    stack.push({ list: childList, indent: item.indent });
  }
  stripEmptyNestedLists(root);
  return root;
}

/**
 * Drop the placeholder sub-lists buildList appends to every item. They hang off
 * the ITEMS, not off the list, so the old version — which only looked at the
 * list's own children (all ListItemNodes) — never removed a single one and
 * every <li> shipped a dead empty <ul> the caret could fall into.
 */
function stripEmptyNestedLists(list: ListNode): void {
  for (const item of (list as ElementNode).getChildren()) {
    if (!$isListItemNode(item)) continue;
    for (const child of (item as ElementNode).getChildren()) {
      if (!$isListNode(child)) continue;
      if ((child as ElementNode).getChildren().length === 0) child.remove();
      else stripEmptyNestedLists(child as ListNode);
    }
  }
}

/** Runs → top-level nodes: paragraphs separated at paraGap, lists as lists. */
export function runsToParagraphNodes(runs: TextRun[]): LexicalNode[] {
  const groups: TextRun[][] = [];
  for (const run of normalizeRuns(runs)) {
    if (run.paraGap) groups.push([]);
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1].push({ ...run, paraGap: false });
  }
  if (groups.length === 0) groups.push([]);

  const out: LexicalNode[] = [];
  for (const group of groups) {
    if (group.some((r) => r.listIndent !== undefined)) out.push(buildList(group));
    else out.push(buildParagraph(group));
  }
  return out;
}

/** Seed the editor with runs: paragraphs/lists, caret at the end. */
export function setEditorRuns(editor: LexicalEditor, runs: TextRun[]): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const nodes = runsToParagraphNodes(runs);
    for (const n of nodes) root.append(n);
    const last = nodes[nodes.length - 1];
    if (last && "selectEnd" in last) (last as ElementNode).selectEnd();
  });
}
