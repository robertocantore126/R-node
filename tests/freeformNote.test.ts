import { describe, expect, it } from "vitest";
import { freeformNote, openChartNote } from "../src/core/chartNotes";
import { studyBranchIds, studyOutline } from "../src/core/studyOutline";
import { EditorStore } from "../src/editor/store";

function storeWithCanvas(): { store: EditorStore; canvas: string } {
  const store = new EditorStore({ label: "test", load: async () => [], save: async () => {} });
  store.createFreeformTopic();
  store.cancelEdit();
  const canvas = Object.values(store.sheet.nodes).find((n) => n.style.freeform)!.id;
  return { store, canvas };
}

/** Add a note, type its text, and finish editing with the canvas selected. */
function withNote(store: EditorStore, canvas: string, text: string): string {
  const id = store.addCanvasNote(canvas)!;
  store.setEditingDraft(text);
  store.commitEdit();
  store.select(canvas);
  return id;
}

const open = (store: EditorStore): string | null => openChartNote(store.sheet, store.getSnapshot());

describe("freeform canvas note", () => {
  it("is added once and opens for typing", () => {
    const { store, canvas } = storeWithCanvas();
    const id = store.addCanvasNote(canvas)!;
    expect(store.getSnapshot().editingId).toBe(id);
    expect(freeformNote(store.sheet, canvas)?.id).toBe(id);
    store.commitEdit();
    expect(store.addCanvasNote(canvas)).toBe(id);
  });

  it("refuses a topic that is not a canvas", () => {
    const { store } = storeWithCanvas();
    expect(store.addCanvasNote(store.sheet.rootNodeId)).toBeNull();
  });

  it("is not opened by clicking the canvas, only by Show notes", () => {
    const { store, canvas } = storeWithCanvas();
    const id = withNote(store, canvas, "Mitosis has four phases");
    store.toggleCanvasNote(canvas); // the note was left shown by adding it
    expect(open(store)).toBeNull();
    store.select(canvas);
    expect(open(store)).toBeNull();
    store.toggleCanvasNote(canvas);
    expect(open(store)).toBe(id);
    store.select(store.sheet.rootNodeId);
    expect(open(store)).toBe(id);
  });

  it("hides even while the note itself is selected", () => {
    const { store, canvas } = storeWithCanvas();
    const id = withNote(store, canvas, "x");
    store.select(id);
    store.toggleCanvasNote(canvas);
    expect(open(store)).toBeNull();
    expect(store.getSnapshot().selection).toEqual([canvas]);
  });

  it("is placed beside the canvas and follows it", async () => {
    const { store, canvas } = storeWithCanvas();
    const id = withNote(store, canvas, "x");
    const c = store.doc.node(canvas)!;
    const n = store.doc.node(id)!;
    expect(n.position.x).toBeGreaterThan(c.position.x + 700);
    expect(n.position.y).toBe(c.position.y);
  });

  it("goes with its canvas, and comes back with one undo", () => {
    const { store, canvas } = storeWithCanvas();
    const id = withNote(store, canvas, "x");
    store.deleteNodes([canvas]);
    expect(store.doc.node(id)).toBeUndefined();
    store.undo();
    expect(freeformNote(store.sheet, canvas)?.id).toBe(id);
  });

  it("Remove note leaves the canvas and undoes as one step", () => {
    const { store, canvas } = storeWithCanvas();
    const id = withNote(store, canvas, "x");
    store.removeCanvasNote(canvas);
    expect(store.doc.node(id)).toBeUndefined();
    expect(store.doc.node(canvas)).toBeTruthy();
    expect(store.getSnapshot().shownCanvasNote).toBeNull();
    store.undo();
    expect(freeformNote(store.sheet, canvas)?.id).toBe(id);
  });

  it("is not claimed by a copy of the canvas", () => {
    const { store, canvas } = storeWithCanvas();
    withNote(store, canvas, "x");
    const copy = structuredClone(store.doc.node(canvas)!);
    copy.id = "copy";
    store.sheet.nodes.copy = copy;
    expect(freeformNote(store.sheet, "copy")).toBeNull();
  });

  it("reaches a quiz as text a question can cite", () => {
    const { store, canvas } = storeWithCanvas();
    const id = withNote(store, canvas, "Mitosis has four phases");
    expect(studyBranchIds(store.sheet, canvas).has(id)).toBe(true);
    expect(studyOutline(store.sheet, [canvas], "quiz")).toContain(`[topic ${JSON.stringify(id)}] "Mitosis has four phases"`);
  });

  it("does not come back as a new child in an AI expansion", () => {
    const { store, canvas } = storeWithCanvas();
    withNote(store, canvas, "Mitosis has four phases");
    const outline = studyOutline(store.sheet, [canvas], "ai");
    expect(outline).toContain("(chart note) Mitosis has four phases");
  });

  it("is forgotten when switching documents", () => {
    const { store, canvas } = storeWithCanvas();
    withNote(store, canvas, "x");
    expect(store.getSnapshot().shownCanvasNote).toBe(canvas);
    const doc = { ...JSON.parse(JSON.stringify(store.doc.doc)), documentId: "other" };
    store.importDocumentFromJson(JSON.stringify(doc));
    expect(store.getSnapshot().shownCanvasNote).toBeNull();
  });
});

describe("pen and eraser rail", () => {
  it("picks a tool, swaps tools, and puts the tool down", () => {
    const { store } = storeWithCanvas();
    store.pickInkTool("pen");
    expect(store.getSnapshot()).toMatchObject({ mode: "ink", ink: { tool: "pen" } });
    store.pickInkTool("eraser");
    expect(store.getSnapshot()).toMatchObject({ mode: "ink", ink: { tool: "eraser" } });
    store.pickInkTool("eraser");
    expect(store.getSnapshot().mode).toBe("select");
  });
});
