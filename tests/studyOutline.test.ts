import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { quizBranchIds, quizTopicOutline } from "../src/core/quiz";
import { studyOutline } from "../src/core/studyOutline";
import { EditorStore } from "../src/editor/store";

/** A branch with every kind of text the study copies must carry. */
function build() {
  const store = new EditorStore({ label: "t", async load() { return []; }, async save() {} });
  const root = store.sheet.rootNodeId;
  const T = (id: string, t: string) => { store.startEdit(id); store.setEditingDraft(t); store.commitEdit(); };
  const topic = store.createChildOf(root)!; T(topic, "AWS storage");
  const n = store.doc.requireNode(topic);
  n.notes = "TOPIC_NOTE line one\nTOPIC_NOTE line two";
  n.labels = ["LABEL_X"];
  store.createFreeformTopic(topic);
  const board = store.getSnapshot().selection[0];
  const a = store.createFreeformItem(board, undefined, undefined, "FREEFORM_ITEM_A")!;
  const b = store.createFreeformItem(board, undefined, undefined, "FREEFORM_ITEM_B")!;
  store.doc.requireNode(a).notes = "ITEM_NOTE";
  store.sheet.relationships.push({ id: "r1", fromId: a, toId: b, label: "ARROW_LABEL" } as never);
  store.sheet.boundaries.push({ id: "g1", memberIds: [a, b], label: "GROUP_LABEL" } as never);
  store.createChartTopic(topic);
  const chart = store.doc.requireNode(topic).childrenIds.at(-1)!;
  T(chart, "CHART_TITLE");
  store.setGalleryCaption(chart, 0, "CELL_CAPTION");
  const slot = store.addChartNote(chart, 0)!;
  T(slot, "CHART_NOTE_TITLE");
  store.doc.requireNode(slot).notes = "CHART_NOTE_NOTES";
  const sub = store.createChildOf(slot)!; T(sub, "CHART_NOTE_SUBTOPIC");
  return { store, topic, a, b, chart, slot, sub };
}

const ALL = ["AWS storage", "TOPIC_NOTE line one", "TOPIC_NOTE line two", "LABEL_X", "FREEFORM_ITEM_A", "FREEFORM_ITEM_B", "ITEM_NOTE",
  "ARROW_LABEL", "GROUP_LABEL", "CHART_TITLE", "CELL_CAPTION", "CHART_NOTE_TITLE", "CHART_NOTE_NOTES", "CHART_NOTE_SUBTOPIC"];

describe("study outline (quiz / flashcards / AI expand)", () => {
  it("carries every kind of text in all three modes", () => {
    const { store, topic } = build();
    for (const mode of ["quiz", "plain", "ai"] as const) {
      const out = studyOutline(store.sheet, [topic], mode);
      for (const m of ALL) expect(out, `${mode} misses ${m}`).toContain(m);
    }
  });

  it("quiz: chart notes are citable topics, annotations are tagged lines", () => {
    const { store, topic, a, b, slot, sub } = build();
    const out = quizTopicOutline(store.sheet, topic);
    expect(out).toContain(`[topic "${slot}"] "CHART_NOTE_TITLE"`);
    expect(out).toContain(`[topic "${sub}"] "CHART_NOTE_SUBTOPIC"`);
    expect(out).toContain(`[arrow to topic "${b}"] "ARROW_LABEL"`);
    expect(out).toMatch(/\[note\] "TOPIC_NOTE line one\\nTOPIC_NOTE line two"/);
    expect(out).toContain(`[cell 1] "CELL_CAPTION"`);
    // A question citing a chart note counts as inside the branch.
    const allowed = quizBranchIds(store.sheet, topic);
    expect(allowed.has(slot) && allowed.has(sub) && allowed.has(a)).toBe(true);
  });

  it("AI expand: chart notes are annotation lines, never topic lines", () => {
    const { store, topic } = build();
    const lines = studyOutline(store.sheet, [topic], "ai").split("\n").map((l) => l.trim());
    expect(lines).toContain("(chart note) CHART_NOTE_TITLE");
    expect(lines).toContain("(chart note) CHART_NOTE_SUBTOPIC");
    expect(lines).not.toContain("CHART_NOTE_TITLE");
    expect(lines).toContain("(arrow → FREEFORM_ITEM_B) ARROW_LABEL");
  });

  it("images stay out: no asset ids or picture markers without captions", () => {
    const { store, topic, chart } = build();
    store.doc.requireNode(chart).style.gallery!.items[1].id = "sha-of-some-picture";
    for (const mode of ["quiz", "plain", "ai"] as const) {
      const out = studyOutline(store.sheet, [topic], mode);
      expect(out).not.toContain("sha-of-some-picture");
      expect(out).not.toMatch(/cell 2/);
    }
  });
});
