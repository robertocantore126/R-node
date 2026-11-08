/**
 * The outline a branch is copied as for an LLM — quiz, flashcards, AI expand.
 *
 * It used to be the topic TITLES of the tree and nothing else, so an LLM never
 * saw a topic's notes, a chart's captions or slot notes (floating topics,
 * outside the tree), arrow labels, labels, or group/summary titles: the
 * questions were built from labels alone. Everything textual is here now;
 * images are the one thing left out.
 *
 * Topic lines stay as they were (indentation = tree). Everything else is an
 * ANNOTATION line one level under the topic it belongs to, marked so the
 * prompt can say what it is:
 *   quiz  — `[note] "…"`, `[cell 2] "…"`, `[arrow to topic "id"] "…"` (JSON
 *           strings, like the topic lines, so text cannot impersonate a tag);
 *   plain — `(note) …`, `(cell 2) …`, `(arrow → Target) …`.
 * A chart slot's note is a real topic (it has an id a quiz question can cite)
 * nested under its cell — except in "ai" mode, where the answer is merged
 * back into the tree by text and a note there would come back as a new
 * child of the chart: there it is annotation lines too.
 */
import { runsToPlain, nodeRuns } from "./text";
import { chartSlotNote, freeformNote } from "./chartNotes";
import type { MindNode, Sheet } from "./types";

export type OutlineMode = "quiz" | "plain" | "ai";

const titleOf = (n: MindNode): string => runsToPlain(nodeRuns(n.title, n.titleRuns));

/**
 * Every topic a branch's outline can show as a TOPIC: the subtree plus, for
 * each chart in it, the slot notes and their subtrees. The quiz uses it for
 * which `sourceNodeIds` a question may point at.
 */
export function studyBranchIds(sheet: Sheet, rootId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = sheet.nodes[id];
    if (!n || seen.has(id)) continue;
    seen.add(id);
    stack.push(...n.childrenIds.slice().reverse());
    const g = n.style.gallery;
    if (g?.chart) g.items.forEach((_, i) => { const note = chartSlotNote(sheet, n.id, i); if (note) stack.push(note.id); });
    const canvasNote = freeformNote(sheet, n.id);
    if (canvasNote) stack.push(canvasNote.id);
  }
  return seen;
}

export function studyOutline(sheet: Sheet, rootIds: string[], mode: OutlineMode): string {
  const quiz = mode === "quiz";
  const lines: string[] = [];
  const ind = (d: number): string => "  ".repeat(d);
  const q = (s: string): string => JSON.stringify(s);

  // What the outline covers, in outline order: arrows to topics outside it,
  // and groups/summaries, are written once, on their first member inside it.
  const inside = new Map<string, number>();
  for (const r of rootIds) for (const id of studyBranchIds(sheet, r)) if (!inside.has(id)) inside.set(id, inside.size);
  const firstMember = (members: string[]): string | null => {
    let best: string | null = null;
    for (const id of members) if (inside.has(id) && (best === null || inside.get(id)! < inside.get(best)!)) best = id;
    return best;
  };

  const note = (d: number, tag: string, text: string): void => {
    const t = text.trim();
    if (!t) return;
    if (quiz) lines.push(`${ind(d)}[${tag}] ${q(t)}`);
    else for (const line of t.split(/\r?\n/)) if (line.trim()) lines.push(`${ind(d)}(${tag}) ${line.trim()}`);
  };

  const seen = new Set<string>();
  const extras = (n: MindNode, d: number): void => {
    note(d, "note", n.notes ?? "");
    if (n.labels?.length) note(d, "labels", n.labels.join(", "));
    for (const rel of sheet.relationships) {
      const label = (rel.label ?? "").trim();
      if (rel.fromId === n.id) {
        const to = sheet.nodes[rel.toId];
        if (!to) continue;
        if (quiz) lines.push(`${ind(d)}[arrow to topic ${q(to.id)}] ${q(label)}`);
        else lines.push(`${ind(d)}(arrow → ${titleOf(to) || "untitled"})${label ? " " + label : ""}`);
      } else if (rel.toId === n.id && !inside.has(rel.fromId)) {
        const from = sheet.nodes[rel.fromId];
        if (!from) continue;
        if (quiz) lines.push(`${ind(d)}[arrow from outside: ${q(titleOf(from))}] ${q(label)}`);
        else lines.push(`${ind(d)}(arrow from ${titleOf(from) || "untitled"})${label ? " " + label : ""}`);
      }
    }
    const span = (kind: string, members: string[], label: string | undefined): void => {
      if (firstMember(members) !== n.id) return;
      const names = members.filter((id) => inside.has(id)).map((id) => titleOf(sheet.nodes[id]) || "untitled");
      const text = `${(label ?? "").trim() || "untitled"} — ${names.join(", ")}`;
      note(d, kind, text);
    };
    for (const g of sheet.boundaries ?? []) span("group", g.memberIds, g.label);
    for (const s of sheet.summaries ?? []) span("summary", s.memberIds, s.label);
    const g = n.style.gallery;
    if (g) g.items.forEach((item, i) => {
      const tag = `${g.chart ? "cell" : "picture"} ${i + 1}`;
      note(d, tag, item.caption ?? "");
      const slot = g.chart ? chartSlotNote(sheet, n.id, i) : null;
      if (!slot) return;
      if (!(item.caption ?? "").trim()) note(d, tag, "(no caption)");
      if (mode === "ai") chartNoteAsText(slot, d + 1);
      else topic(slot.id, d + 1);
    });
    // Handwriting is not text, so a canvas reaches a quiz through its note.
    const canvasNote = freeformNote(sheet, n.id);
    if (canvasNote) {
      if (mode === "ai") chartNoteAsText(canvasNote, d);
      else topic(canvasNote.id, d);
    }
  };

  const chartNoteAsText = (n: MindNode, d: number): void => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    note(d, "chart note", titleOf(n));
    note(d + 1, "note", n.notes ?? "");
    for (const c of n.childrenIds) { const k = sheet.nodes[c]; if (k) chartNoteAsText(k, d + 1); }
  };

  const topic = (id: string, d: number): void => {
    const n = sheet.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    lines.push(quiz ? `${ind(d)}[topic ${q(id)}] ${q(titleOf(n))}` : `${ind(d)}${titleOf(n)}`);
    extras(n, d + 1);
    for (const c of n.childrenIds) topic(c, d + 1);
  };

  for (const r of rootIds) topic(r, 0);
  return lines.join("\n");
}
