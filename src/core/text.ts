/**
 * TextRun helpers — the bridge between the plain-string title (legacy and
 * derived consumers: search, export, outliner, tests) and the styled
 * titleRuns array (the rich-text source of truth).
 *
 * Invariant maintained by every writer: node.title === runsToPlain(node.titleRuns)
 * and titleRuns is normalized (no empty runs, adjacent runs with identical
 * formatting merged).
 */
import type { TextRun } from "./types";

export function runsToPlain(runs: TextRun[]): string {
  return runs.map((r) => r.text).join("");
}

export function plainToRuns(text: string): TextRun[] {
  return text.length > 0 ? [{ text }] : [];
}

/** Drop empty runs and merge adjacent runs that share the same formatting. */
export function normalizeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    if (!run || run.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && sameFormat(prev, run)) {
      prev.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

function sameFormat(a: TextRun, b: TextRun): boolean {
  return (
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.color ?? null) === (b.color ?? null) &&
    (a.fontSize ?? null) === (b.fontSize ?? null) &&
    (a.paraGap ?? false) === (b.paraGap ?? false) &&
    (a.listIndent ?? null) === (b.listIndent ?? null)
  );
}

export function runsEqual(a: TextRun[] | undefined, b: TextRun[] | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (ra.text !== rb.text || !sameFormat(ra, rb)) return false;
  }
  return true;
}

/** The styled runs of a node: explicit titleRuns or the whole title as one plain run. */
export function nodeRuns(title: string, titleRuns?: TextRun[]): TextRun[] {
  if (titleRuns && titleRuns.length > 0) return titleRuns;
  return plainToRuns(title);
}

export function isEmptyRuns(runs: TextRun[]): boolean {
  return runs.every((r) => r.text.trim().length === 0);
}

/**
 * Trim the plain text of a run sequence: leading whitespace of the first
 * run and trailing whitespace of the last run only — internal spacing
 * between runs is preserved.
 */
export function trimRuns(runs: TextRun[]): TextRun[] {
  const out = runs.map((r) => ({ ...r }));
  if (out.length === 0) return out;
  const first = out[0];
  const leading = first.text.match(/^\s*/)?.[0] ?? "";
  first.text = first.text.slice(leading.length);
  const last = out[out.length - 1];
  const trailing = last.text.match(/\s*$/)?.[0] ?? "";
  last.text = last.text.slice(0, last.text.length - trailing.length);
  return normalizeRuns(out);
}
