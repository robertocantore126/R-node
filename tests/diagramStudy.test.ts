import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { studyBranchIds, studyOutline, studyRoots } from "../src/core/studyOutline";
import { createCanvasTextMeasurer, measureNode } from "../src/layout/measure";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };
const measurer = createCanvasTextMeasurer();

/** A diagram: A with Tab children B and C, B with Tab child D. Titled. */
function tree(): { store: EditorStore; page: string; A: string; B: string; C: string; D: string } {
  const store = new EditorStore(memoryAdapter);
  store.newDocument("diagram");
  const page = store.sheet.rootNodeId;
  const A = store.sheet.nodes[page].childrenIds[0];
  const B = store.diagramTab(A)!;
  const C = store.diagramTab(A)!;
  const D = store.diagramTab(B)!;
  for (const [id, t] of [[A, "Etica"], [B, "Kant"], [C, "Aristotele"], [D, "Imperativo categorico"]] as const) {
    store.execOps([{ opId: `t-${id}`, actorId: "t", ts: "", type: "setTitle", id, title: t, prev: "", titleRuns: [{ text: t }], prevRuns: [{ text: "" }] }]);
  }
  return { store, page, A, B, C, D };
}

function overlaps(store: EditorStore, page: string): number {
  const p = store.sheet.nodes[page];
  const rs = p.childrenIds.map((id) => {
    const n = store.sheet.nodes[id], at = n.style.freeformPosition!, s = measureNode(n, measurer);
    return { x: p.position.x + at.x, y: p.position.y + at.y, w: s.w, h: s.h };
  });
  let k = 0;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) k++;
  }
  return k;
}

describe("diagram: deleting a shape takes its Tab tree", () => {
  it("deleting B deletes D with it; one undo brings both back with their arrows", () => {
    const { store, B, D } = tree();
    const rels = store.sheet.relationships.length;
    store.deleteNodes([B]);
    expect(store.sheet.nodes[B]).toBeUndefined();
    expect(store.sheet.nodes[D]).toBeUndefined();
    expect(store.sheet.relationships.length).toBe(rels - 2);
    store.undo();
    expect(store.sheet.nodes[B]).toBeTruthy();
    expect(store.sheet.nodes[D]).toBeTruthy();
    expect(store.sheet.relationships.length).toBe(rels);
  });
});

describe("diagram: dragging a shape onto another re-parents it", () => {
  it("D dragged onto A becomes A's child (grandparent), and the trees close up", () => {
    const { store, page, A, B, D } = tree();
    expect(store.diagramReparent(D, A)).toBe(true);
    const parents = store.sheet.relationships.filter((r) => r.tree && r.toId === D).map((r) => r.fromId);
    expect(parents).toEqual([A]);
    expect(store.diagramDescendants(B)).toEqual([]);
    expect(overlaps(store, page)).toBe(0);
    store.undo();
    expect(store.sheet.relationships.filter((r) => r.tree && r.toId === D).map((r) => r.fromId)).toEqual([B]);
  });

  it("a shape takes its own Tab children along to a cousin", () => {
    const { store, B, C, D } = tree();
    expect(store.diagramReparent(B, C)).toBe(true);
    expect(store.diagramDescendants(C)).toEqual([B, D]);
  });

  it("never onto itself, its own descendant, or its current parent", () => {
    const { store, A, B, D } = tree();
    expect(store.canDiagramReparent(B, B)).toBe(false);
    expect(store.canDiagramReparent(B, D)).toBe(false);
    expect(store.canDiagramReparent(A, D)).toBe(false);
    expect(store.canDiagramReparent(B, A)).toBe(false);
  });

  it("a hand-moved (pinned) shape joins its new parent's column", () => {
    const { store, A, D } = tree();
    const n = store.sheet.nodes[D];
    store.execOps([{ opId: "pin", actorId: "t", ts: "", type: "setStyle", id: D, style: { ...n.style, diagramPinned: true, freeformPosition: { x: 700, y: 700 } }, prev: n.style }]);
    store.diagramReparent(D, A);
    expect(store.sheet.nodes[D].style.diagramPinned).toBeUndefined();
    expect(store.sheet.nodes[D].style.freeformPosition).not.toEqual({ x: 700, y: 700 });
  });
});

describe("study outline (quiz / flashcards JSON source) in a diagram", () => {
  it("Tab children are nested topics of their shape, not arrow lines", () => {
    const { store, A, B, C, D } = tree();
    const out = studyOutline(store.sheet, [A], "quiz").split("\n");
    expect(out).toEqual([
      `[topic "${A}"] "Etica"`,
      `  [topic "${B}"] "Kant"`,
      `    [topic "${D}"] "Imperativo categorico"`,
      `  [topic "${C}"] "Aristotele"`,
    ]);
    // Every one of them may be cited by a quiz question.
    expect([...studyBranchIds(store.sheet, A)].sort()).toEqual([A, B, C, D].sort());
  });

  it("the plain outline (flashcards) nests the same way", () => {
    const { store, A } = tree();
    expect(studyOutline(store.sheet, [A], "plain")).toBe("Etica\n  Kant\n    Imperativo categorico\n  Aristotele");
  });

  it("a hand-drawn arrow between shapes is still written as an arrow", () => {
    const { store, C, D } = tree();
    store.createRelationship(C, D, { label: "critica" } as never);
    const rel = store.sheet.relationships.find((r) => !r.tree)!;
    store.setRelationship(rel.id, { label: "critica" });
    expect(studyOutline(store.sheet, [C], "quiz")).toContain(`[arrow to topic "${D}"] "critica"`);
  });

  it("group and link members inside another member's tree are written once", () => {
    const { store, A, B, D, C } = tree();
    expect(studyRoots(store.sheet, [D, A, B])).toEqual([A]);
    expect(studyRoots(store.sheet, [D, C])).toEqual([D, C]);
  });
});

describe("study outline: groups and links", () => {
  it("a link is written as [link], a group as [group]", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.rootNodeId;
    store.select(root); store.createChild(); store.select(root); store.createChild();
    const kids = store.sheet.nodes[root].childrenIds.slice(-2);
    store.select(kids[0]); store.select(kids[1], { additive: true });
    store.createLinkFromSelection();
    store.select(kids[0]); store.select(kids[1], { additive: true });
    store.createGroupFromSelection();
    const out = studyOutline(store.sheet, [root], "quiz");
    expect(out).toMatch(/\[link\] "Link — /);
    expect(out).toMatch(/\[group\] "Group — /);
    expect(studyOutline(store.sheet, [root], "plain")).toMatch(/\(link\) Link — /);
  });
});

describe("pasted study JSON lands where it belongs", () => {
  const quiz = JSON.stringify({ app: "r-node", kind: "quiz", questions: [{ q: "Chi?", answers: ["a", "b", "c", "d"], correct: 1 }] });
  const deck = JSON.stringify({ app: "r-node", kind: "flashcards", cards: [{ topic: "t", term: "Kant", definition: "Filosofo" }] });

  it("on a diagram shape: quiz to its quizzes, deck to its flashcards, title untouched", async () => {
    const { store, B } = tree();
    store.select(B);
    await store.paste(B, quiz);
    await store.paste(B, deck);
    const n = store.sheet.nodes[B];
    expect(n.style.quizzes?.length).toBe(1);
    expect(n.style.flashcards?.length).toBe(1);
    expect(n.title).toBe("Kant");
    expect(store.getSnapshot().editingId).toBe(null);
  });

  it("with a link selected: to the link, not to its topics", async () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.rootNodeId;
    store.select(root); store.createChild();
    const kid = store.sheet.nodes[root].childrenIds.at(-1)!;
    store.select(kid);
    store.createLinkFromSelection();
    const link = store.sheet.boundaries.at(-1)!;
    (store as unknown as { state: { groupSel: string | null } }).state.groupSel = link.id;
    await store.paste(null, quiz);
    await store.paste(null, deck);
    const g = store.sheet.boundaries.find((x) => x.id === link.id)!;
    expect(g.quizzes?.length).toBe(1);
    expect(g.flashcards?.length).toBe(1);
    expect(store.sheet.nodes[kid].style.quizzes).toBeUndefined();
  });
});
