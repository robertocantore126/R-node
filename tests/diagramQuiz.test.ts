import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { QUIZ_PROMPT } from "../src/editor/quizPrompts";

const adapter = { label: "t", async load() { return []; }, async save() { /* no-op */ } };

/** A diagram shape A with Tab children B and C, B with Tab child D.
 *  A group covers A+B, a link covers C+D, and an arrow B→C carries a label. */
function tree() {
  const store = new EditorStore(adapter);
  store.newDocument("diagram");
  const page = store.sheet.rootNodeId;
  const A = store.sheet.nodes[page].childrenIds[0];
  const B = store.diagramTab(A)!;
  const C = store.diagramTab(A)!;
  const D = store.diagramTab(B)!;
  for (const [id, title, note] of [
    [A, "ROOT-TITLE", "ROOT-NOTE"],
    [B, "CHILD-TITLE", "CHILD-NOTE"],
    [C, "SIBLING-TITLE", "SIBLING-NOTE"],
    [D, "GRANDCHILD-TITLE", "GRANDCHILD-NOTE"],
  ] as const) {
    const n = store.doc.requireNode(id);
    store.execOps([{ opId: `t-${id}`, actorId: "t", ts: "", type: "setTitle", id, title, prev: n.title,
      titleRuns: [{ text: title }], prevRuns: [{ text: n.title }] }]);
    n.notes = note;
  }
  store.select(A); store.select(B, { additive: true });
  store.createGroupFromSelection();
  store.select(C); store.select(D, { additive: true });
  store.createLinkFromSelection();
  store.execOps([{ opId: "arrow-BC", actorId: "t", ts: "", type: "createRelationship",
    relationship: { id: "rel-BC", fromId: B, toId: C, label: "ARROW-LABEL" } }]);
  return { store, A, B, C, D };
}

async function clipboardOf(store: EditorStore, nodeId: string): Promise<string> {
  const writes: string[] = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { writes.push(t); } } });
  await store.copyQuizPrompt(nodeId);
  vi.unstubAllGlobals();
  expect(writes).toHaveLength(1);
  return writes[0];
}

describe("copy as quiz on a diagram shape", () => {
  it("carries every Tab descendant's title and notes, plus groups, links and arrows", async () => {
    const { store, A } = tree();
    const out = await clipboardOf(store, A);
    for (const text of ["ROOT-TITLE", "CHILD-TITLE", "SIBLING-TITLE", "GRANDCHILD-TITLE",
      "ROOT-NOTE", "CHILD-NOTE", "SIBLING-NOTE", "GRANDCHILD-NOTE", "ARROW-LABEL"]) {
      expect(out, `missing ${text}`).toContain(text);
    }
    expect(out).toContain("[group]");
    expect(out).toContain("[link]");
    expect(out).toContain(QUIZ_PROMPT.slice(0, 60));
    // Indentation reflects the Tab tree: grandchild deeper than its parent.
    const line = (t: string) => out.split("\n").find((l) => l.includes(t)) ?? "";
    expect(line("GRANDCHILD-TITLE").indexOf('"GRANDCHILD-TITLE"'))
      .toBeGreaterThan(line("CHILD-TITLE").indexOf('"CHILD-TITLE"'));
  });

  it("copying a middle node carries its own subtree, not its parent or siblings", async () => {
    const { store, B } = tree();
    const out = await clipboardOf(store, B);
    expect(out).toContain("CHILD-TITLE");
    expect(out).toContain("CHILD-NOTE");
    expect(out).toContain("GRANDCHILD-TITLE");
    expect(out).toContain("GRANDCHILD-NOTE");
    expect(out).not.toContain('"ROOT-TITLE"');
    expect(out).not.toContain('"SIBLING-TITLE"');
  });
});
