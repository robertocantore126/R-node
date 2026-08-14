/**
 * R-node — syntax highlighting for read-only code topics (T22).
 *
 * Pure, dependency-free and theme-agnostic: it turns source text into
 * `TextRun[]`, taking the colours as an argument instead of knowing any. The
 * document stores the SOURCE, never the colours — the same reason the layout is
 * derived data (I6). A snippet pasted from a dark editor would otherwise carry
 * that editor's palette into a light theme and stay unreadable forever.
 *
 * Two properties the tests pin, because everything else depends on them:
 *
 *  - **Lossless.** Concatenating the runs reproduces the source exactly, every
 *    space and newline included. `title` holds that source and I5 requires
 *    `title === runsToPlain(titleRuns)`, so a tokenizer that drops or reflows a
 *    character corrupts the document rather than merely mis-colouring it.
 *  - **Cheap on repeat.** The cache is keyed by identity through nested maps,
 *    never by a built string. Building a key from the source would repeat the
 *    exact mistake T6 exists to fix — the per-frame `JSON.stringify` — on
 *    inputs that are far bigger.
 *
 * The grammar is deliberately small: this is a spike, and a real highlighter
 * (Shiki, Prism) is a decision deferred until the feature earns it.
 */

import type { TextRun } from "./types";

export type CodeLang = "ts" | "js" | "cpp" | "text";

/** The colours a theme lends to code. Token kinds, not syntax categories. */
export interface CodePalette {
  /** Identity of this palette, so the cache can tell two themes apart. */
  id: string;
  plain: string;
  keyword: string;
  string: string;
  number: string;
  comment: string;
  fn: string;
  punct: string;
}

const KEYWORDS: Record<CodeLang, Set<string>> = {
  ts: new Set(["abstract","as","async","await","break","case","catch","class","const","continue","default","delete","do","else","enum","export","extends","false","finally","for","from","function","if","implements","import","in","instanceof","interface","let","new","null","of","private","protected","public","readonly","return","satisfies","static","super","switch","this","throw","true","try","type","typeof","undefined","var","void","while","yield"]),
  js: new Set(["async","await","break","case","catch","class","const","continue","default","delete","do","else","export","extends","false","finally","for","from","function","if","import","in","instanceof","let","new","null","of","return","static","super","switch","this","throw","true","try","typeof","undefined","var","void","while","yield"]),
  cpp: new Set(["auto","bool","break","case","catch","char","class","const","constexpr","continue","default","delete","do","double","else","enum","explicit","export","extern","false","float","for","friend","goto","if","include","inline","int","long","namespace","new","nullptr","operator","private","protected","public","return","short","signed","sizeof","static","struct","switch","template","this","throw","true","try","typedef","typename","union","unsigned","using","virtual","void","while"]),
  text: new Set<string>(),
};

const PUNCT = new Set([..."{}()[];,.:<>=+-*/%!&|^~?"]);

/** A run of `text` in the colour of `kind`, appended only when non-empty. */
function push(out: TextRun[], text: string, color: string): void {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.color === color) last.text += text; // merge, fewer runs to draw
  else out.push({ text, color });
}

function tokenizeUncached(source: string, lang: CodeLang, palette: CodePalette): TextRun[] {
  const out: TextRun[] = [];
  if (lang === "text") {
    push(out, source, palette.plain);
    return out;
  }
  const keywords = KEYWORDS[lang];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment — runs to the newline, which stays OUT of it so line
    // splitting downstream sees every \n as its own boundary.
    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      push(out, source.slice(i, j), palette.comment);
      i = j;
      continue;
    }
    // Block comment — unterminated runs to the end rather than throwing.
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push(out, source.slice(i, j), palette.comment);
      i = j;
      continue;
    }
    // Preprocessor line (#include, #define): C-like only.
    if (c === "#" && lang === "cpp") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      push(out, source.slice(i, j), palette.keyword);
      i = j;
      continue;
    }
    // String or char literal. An unclosed quote takes the rest of the LINE,
    // not the rest of the file: a stray apostrophe in a comment-free snippet
    // would otherwise paint everything below it as a string.
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== c && (c === "`" || source[j] !== "\n")) {
        if (source[j] === "\\") j++; // escaped char, whatever it is
        j++;
      }
      if (j < n && source[j] === c) j++;
      push(out, source.slice(i, j), palette.string);
      i = j;
      continue;
    }
    // Number: digits, with an optional fractional part and suffix letters.
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._]/.test(source[j])) j++;
      push(out, source.slice(i, j), palette.number);
      i = j;
      continue;
    }
    // Identifier or keyword. A name followed by "(" reads as a call.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      let k = j;
      while (k < n && (source[k] === " " || source[k] === "\t")) k++;
      const isCall = source[k] === "(";
      push(out, word, keywords.has(word) ? palette.keyword : isCall ? palette.fn : palette.plain);
      i = j;
      continue;
    }
    if (PUNCT.has(c)) {
      push(out, c, palette.punct);
      i++;
      continue;
    }
    // Whitespace and anything unrecognised: plain, and kept verbatim. This is
    // the branch that makes the pass lossless.
    push(out, c, palette.plain);
    i++;
  }
  return out;
}

/** lang → palette id → source → runs. Nested so no key is ever built. */
const cache = new Map<CodeLang, Map<string, Map<string, TextRun[]>>>();
const MAX_PER_PALETTE = 64;

export function tokenize(source: string, lang: CodeLang, palette: CodePalette): TextRun[] {
  let byPalette = cache.get(lang);
  if (!byPalette) {
    byPalette = new Map();
    cache.set(lang, byPalette);
  }
  let bySource = byPalette.get(palette.id);
  if (!bySource) {
    bySource = new Map();
    byPalette.set(palette.id, bySource);
  }
  const hit = bySource.get(source);
  if (hit) return hit;

  const runs = tokenizeUncached(source, lang, palette);
  if (bySource.size >= MAX_PER_PALETTE) {
    const oldest = bySource.keys().next().value;
    if (oldest !== undefined) bySource.delete(oldest);
  }
  bySource.set(source, runs);
  return runs;
}

/** Languages the spike knows, plus the passthrough. */
export function asCodeLang(lang: string | undefined): CodeLang {
  return lang === "ts" || lang === "js" || lang === "cpp" ? lang : "text";
}
