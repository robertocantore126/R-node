/**
 * Paste sanitizer — turns clipboard HTML from Word, Google Docs, Draw.io and
 * the web into the subset R-node understands, then into TextRun[].
 *
 * Two known pitfalls are handled explicitly:
 *  1. Word/Google Docs express emphasis as CSS on <span> (font-weight: 700,
 *     font-style: italic), NOT as <b>/<i>. We read the computed inline styles
 *     BEFORE stripping them and wrap the content in <strong>/<em>.
 *  2. Word exports lists as paragraphs with mso-list markers and margin-left
 *     indentation instead of <ul>/<li>. We detect those markers and rebuild
 *     real (possibly nested) <ul><li> before the generic cleanup.
 *
 * Colors survive as <span data-rnode-color="#hex">, read back by htmlToRuns.
 * Everything else (scripts, images, hrefs, junk styles, layout CSS) is dropped.
 */
import type { TextRun } from "../core/types";
import { normalizeRuns } from "../core/text";

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function cssColor(cssColor: string | null): string | null {
  if (!cssColor) return null;
  const t = cssColor.trim();
  if (COLOR_RE.test(t)) return t.toLowerCase();
  const m = t.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
  if (m) {
    const hex = (v: string): string => Math.max(0, Math.min(255, parseInt(v, 10))).toString(16).padStart(2, "0");
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return null;
}

function boldWeight(w: string | null): boolean {
  if (!w) return false;
  const t = w.trim();
  const n = parseInt(t, 10);
  return t === "bold" || t === "bolder" || (Number.isFinite(n) && n >= 600);
}

interface Ctx {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  fontSize?: number;
}

/** Heading level → font size in px (kept as-is so pasted structure survives). */
const HEADING_SIZES: Record<string, number> = { h1: 26, h2: 21, h3: 18, h4: 16, h5: 15, h6: 14 };

const DROP_TAGS = new Set([
  "script", "style", "iframe", "noscript", "link", "meta", "title", "template", "svg", "img", "video", "audio", "object", "embed", "form", "input", "button", "select", "textarea",
]);

const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "li"]);

// ---------------------------------------------------------------------------
// Word list normalization: mso-list markers / MsoListParagraph + margin-left
// → real (nested) <ul><li>. Runs before the generic cleanup.
// ---------------------------------------------------------------------------

function isWordListMarker(el: Element): boolean {
  const cls = el.getAttribute("class") ?? "";
  if (cls.includes("MsoListParagraph") || cls.includes("MsoList")) return true;
  if (el.hasAttribute("mso-list")) return true;
  const st = el.getAttribute("style") ?? "";
  return st.includes("mso-list");
}

function liIndent(el: Element): number {
  const st = (el as HTMLElement).style;
  const mso = el.getAttribute("mso-list");
  if (mso) {
    const lvl = mso.match(/level(\d+)/i);
    if (lvl) return Math.min(8, Math.max(1, parseInt(lvl[1], 10)));
  }
  const ml = st.marginLeft;
  if (ml) {
    const n = parseFloat(ml);
    if (Number.isFinite(n)) return Math.min(8, Math.max(1, Math.ceil(n / 36)));
  }
  return 1;
}

function normalizeWordLists(doc: Document): void {
  const body = doc.body;
  const markers = Array.from(body.querySelectorAll("*")).filter(isWordListMarker);
  if (markers.length === 0) return;

  // Replace every marker with a plain <li> carrying its indent as data.
  const items: { li: HTMLElement; indent: number }[] = [];
  for (const m of markers) {
    const li = doc.createElement("li");
    li.setAttribute("data-rnode-indent", String(liIndent(m)));
    while (m.firstChild) li.appendChild(m.firstChild);
    m.replaceWith(li);
    items.push({ li, indent: liIndent(m) });
  }

  // Group consecutive items into (nested) <ul>.
  let start = 0;
  while (start < items.length) {
    let end = start + 1;
    while (end < items.length && items[end].li.previousSibling === items[end - 1].li) end++;
    const group = items.slice(start, end);
    start = end;
    if (group.length === 0) continue;

    const rootUl = doc.createElement("ul");
    // Insert the list BEFORE the first item's current position (the items are
    // still in the body at this point) — replacing the first item instead
    // would be invalid once the items move inside the list we just created.
    group[0].li.parentNode?.insertBefore(rootUl, group[0].li);
    // stack of {ul, indent}
    const stack: { ul: HTMLElement; indent: number }[] = [{ ul: rootUl, indent: 0 }];
    for (const { li, indent } of group) {
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const cur = stack[stack.length - 1];
      cur.ul.appendChild(li);
      const childUl = doc.createElement("ul");
      li.appendChild(childUl);
      stack.push({ ul: childUl, indent });
    }
    // remove dangling empty <ul> containers (recursively)
    const dropEmptyUl = (el: HTMLElement): void => {
      for (const child of Array.from(el.children)) {
        if (child.tagName === "UL" && child.childElementCount === 0) child.remove();
        else dropEmptyUl(child as HTMLElement);
      }
    };
    dropEmptyUl(rootUl);
  }
}

// ---------------------------------------------------------------------------
// Generic cleanup
// ---------------------------------------------------------------------------

function applyInline(el: HTMLElement, ctx: Ctx): Ctx {
  const s = el.style;
  const next: Ctx = { ...ctx };
  if (boldWeight(s.fontWeight)) next.bold = true;
  if (s.fontStyle === "italic") next.italic = true;
  if (s.textDecorationLine?.includes("underline") || s.textDecoration?.includes("underline")) next.underline = true;
  // sanitizeHtml() re-emits colors as <span data-rnode-color="#hex"> — read
  // that marker here so htmlToRuns() keeps them (style is stripped by then).
  const marker = el.getAttribute("data-rnode-color");
  if (marker && COLOR_RE.test(marker)) next.color = marker.toLowerCase();
  else {
    const c = cssColor(s.color);
    if (c) next.color = c;
  }
  return next;
}

function tagCtx(tag: string, ctx: Ctx): Ctx {
  const next = { ...ctx };
  if (tag === "b" || tag === "strong") next.bold = true;
  if (tag === "i" || tag === "em") next.italic = true;
  if (tag === "u" || tag === "ins") next.underline = true;
  return next;
}

/** Wrap a text node per the accumulated context (strong/em/color). */
function wrapText(doc: Document, text: string, ctx: Ctx): Node {
  let node: Node = doc.createTextNode(text);
  const wrap = (content: Node, tag: string): Node => {
    const el = doc.createElement(tag);
    el.appendChild(content);
    return el;
  };
  if (ctx.color) {
    const span = doc.createElement("span");
    span.setAttribute("data-rnode-color", ctx.color);
    span.appendChild(node);
    node = span;
  }
  if (ctx.italic) node = wrap(node, "em");
  if (ctx.bold) node = wrap(node, "strong");
  if (ctx.underline) {
    const u = doc.createElement("u");
    u.appendChild(node);
    node = u;
  }
  return node;
}

function buildClean(doc: Document, el: Element, ctx: Ctx, out: Node[]): void {
  const tag = el.tagName.toLowerCase();
  if (DROP_TAGS.has(tag)) return;

  if (tag === "br") {
    out.push(doc.createElement("br"));
    return;
  }

  const ownCtx = applyInline(el as HTMLElement, tagCtx(tag, ctx));

  // Inline formatting elements: keep text runs only.
  if (["span", "strong", "b", "em", "i", "u", "ins", "a", "font", "small", "sub", "sup", "code", "mark", "s", "strike", "del"].includes(tag)) {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out.push(wrapText(doc, child.textContent ?? "", ownCtx));
      else if (child.nodeType === Node.ELEMENT_NODE) buildClean(doc, child as Element, ownCtx, out);
    }
    return;
  }

  // A bare <li> emits its inner content only — its parent list provides the
  // wrapper. (Appending an <li> inside an <li> is a DOM HierarchyRequestError.)
  if (tag === "li") {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out.push(wrapText(doc, child.textContent ?? "", ownCtx));
      else if (child.nodeType === Node.ELEMENT_NODE) buildClean(doc, child as Element, ownCtx, out);
    }
    return;
  }

  // Block elements / lists. Headings keep their tag so the heading level
  // (and therefore its larger font size) survives the sanitization.
  if (BLOCK_TAGS.has(tag)) {
    const block = doc.createElement(tag === "div" ? "p" : tag);
    if (tag === "ul" || tag === "ol") {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && child.nodeName.toLowerCase() === "li") {
          const li = doc.createElement("li");
          const itemOut: Node[] = [];
          buildClean(doc, child as Element, ownCtx, itemOut);
          for (const n of itemOut) li.appendChild(n);
          block.appendChild(li);
        } else if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "") {
          // stray text inside a list -> treat as an item
          const li = doc.createElement("li");
          li.appendChild(wrapText(doc, child.textContent ?? "", ownCtx));
          block.appendChild(li);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          buildClean(doc, child as Element, ownCtx, [block]);
        }
      }
      out.push(block);
      return;
    }
    const inner: Node[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) inner.push(wrapText(doc, child.textContent ?? "", ownCtx));
      else if (child.nodeType === Node.ELEMENT_NODE) buildClean(doc, child as Element, ownCtx, inner);
    }
    for (const n of inner) block.appendChild(n);
    // Merge adjacent empty blocks and drop fully-empty paragraphs.
    if (block.textContent?.trim() !== "" || block.childNodes.length === 0) out.push(block);
    return;
  }

  // Unknown element: recurse into children.
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out.push(wrapText(doc, child.textContent ?? "", ownCtx));
    else if (child.nodeType === Node.ELEMENT_NODE) buildClean(doc, child as Element, ownCtx, out);
  }
}

/** Sanitize clipboard HTML into clean semantic HTML (strong/em/u, ul/ol/li, p, br, data-rnode-color spans). */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  normalizeWordLists(doc);
  const out: Node[] = [];
  buildClean(doc, doc.body, { bold: false, italic: false, underline: false }, out);
  const container = doc.createElement("div");
  for (const n of out) container.appendChild(n);
  return container.innerHTML;
}

// ---------------------------------------------------------------------------
// Clean HTML → TextRun[]  (also used directly by the Lexical paste plugin)
// ---------------------------------------------------------------------------

export function htmlToRuns(html: string): TextRun[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const runs: TextRun[] = [];

  const walkInline = (el: Element, ctx: Ctx, out: TextRun[]): void => {
    const own = applyInline(el as HTMLElement, tagCtx(el.tagName.toLowerCase(), ctx));
    const tag = el.tagName.toLowerCase();
    // headings carry their own (larger) font size
    if (!own.fontSize && /^h[1-6]$/.test(tag)) own.fontSize = HEADING_SIZES[tag];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) pushInto(out, child.textContent ?? "", own);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element;
        const t = c.tagName.toLowerCase();
        if (t === "br") pushInto(out, "\n", own);
        else if (t === "ul" || t === "ol" || t === "li") {
          /* block containers handled by walkList/walkBlocks */
        } else walkInline(c, own, out);
      }
    }
  };

  // Collect one block's runs, then walk the body merging blocks with a
  // paragraph gap (line break + extra spacing) between them.
  const walkBlock = (el: Element): TextRun[] => {
    const out: TextRun[] = [];
    const tag = el.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol" || tag === "li") walkList(el, 0, out);
    else walkInline(el, { bold: false, italic: false, underline: false }, out);
    return out;
  };

  const walkBlocks = (parent: Element): void => {
    let first = true;
    const children = Array.from(parent.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.textContent ?? "").trim() !== "") {
          if (!first) {
            pushInto(runs, "\n", { bold: false, italic: false, underline: false });
            first = false;
          }
          pushInto(runs, child.textContent ?? "", { bold: false, italic: false, underline: false });
          first = false;
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const block = walkBlock(child as Element);
      if (block.length === 0) continue;
      if (!first && block[0].text !== "\n") block[0].paraGap = true;
      if (!first) pushInto(runs, "\n", { bold: false, italic: false, underline: false });
      for (const r of block) runs.push(r);
      first = false;
    }
  };

  const walkList = (liOrUl: Element, depth: number, out: TextRun[]): void => {
    const walkItems = (el: Element, d: number, out: TextRun[]): void => {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const c = child as Element;
        const tag = c.tagName.toLowerCase();
        if (tag === "li") {
          const itemRuns: TextRun[] = [];
          walkInline(c, { bold: false, italic: false, underline: false }, itemRuns);
          // nested lists inside the item start on their own line
          for (const nested of Array.from(c.childNodes)) {
            if (nested.nodeType === Node.ELEMENT_NODE && ["ul", "ol"].includes((nested as Element).tagName.toLowerCase())) {
              if (itemRuns.length > 0) pushInto(itemRuns, "\n", { bold: false, italic: false, underline: false });
              walkItems(nested as Element, d + 1, itemRuns);
            }
          }
          // the item's first run carries the bullet depth marker
          if (itemRuns.length > 0 && itemRuns[0].listIndent === undefined) itemRuns[0].listIndent = Math.min(8, d + 1);
          for (const r of itemRuns) out.push(r);
          pushInto(out, "\n", { bold: false, italic: false, underline: false });
        } else if (tag === "ul" || tag === "ol") {
          walkItems(c, d, out);
        }
      }
    };
    walkItems(liOrUl, depth, out);
  };

  walkBlocks(doc.body);
  return normalizeRuns(runs);
}

function pushInto(out: TextRun[], text: string, ctx: Ctx): void {
  if (text.length === 0) return;
  const run: TextRun = { text };
  if (ctx.bold) run.bold = true;
  if (ctx.italic) run.italic = true;
  if (ctx.underline) run.underline = true;
  if (ctx.color) run.color = ctx.color;
  if (ctx.fontSize) run.fontSize = ctx.fontSize;
  out.push(run);
}
