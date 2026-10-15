import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeQuiz, parseQuiz } from "../src/core/quiz";
import { EditorStore } from "../src/editor/store";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() {
    return [];
  },
  async save() {
    /* no-op */
  },
};

const validPayload = {
  app: "r-node",
  kind: "quiz",
  name: "AZ-900 — architettura core",
  questions: [
    { q: "Cos'è Azure Arc?", answers: ["A", "B", "C", "D"], correct: 2, explain: "Ponti ibridi." },
    { q: "Regione?", answers: ["1", "2", "3", "4"], correct: 0 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("quiz payload — normalizeQuiz", () => {
  it("accepts a well-shaped payload and trims the name", () => {
    const quiz = normalizeQuiz({ ...validPayload, name: "  Spaced  " })!;
    expect(quiz).not.toBeNull();
    expect(quiz.name).toBe("Spaced");
    expect(quiz.questions).toHaveLength(2);
    expect(quiz.questions[0].correct).toBe(2);
    expect(quiz.questions[0].explain).toBe("Ponti ibridi.");
  });

  it("rejects anything that is not a quiz payload", () => {
    expect(normalizeQuiz(null)).toBeNull();
    expect(normalizeQuiz({ app: "r-node", payload: {} })).toBeNull();
    expect(normalizeQuiz({ app: "other", kind: "quiz", questions: validPayload.questions })).toBeNull();
    expect(normalizeQuiz({ app: "r-node", kind: "quiz", questions: [] })).toBeNull();
    expect(parseQuiz("not json")).toBeNull();
  });

  it("rejects a question with the wrong answer count or a bad correct index", () => {
    const base = { app: "r-node", kind: "quiz" };
    expect(normalizeQuiz({ ...base, questions: [{ q: "?", answers: ["a", "b", "c"], correct: 0 }] })).toBeNull();
    expect(normalizeQuiz({ ...base, questions: [{ q: "?", answers: ["a", "b", "c", "d"], correct: 4 }] })).toBeNull();
    expect(normalizeQuiz({ ...base, questions: [{ q: "?", answers: ["a", "b", "c", "d"], correct: -1 }] })).toBeNull();
    expect(normalizeQuiz({ ...base, questions: [{ q: "", answers: ["a", "b", "c", "d"], correct: 0 }] })).toBeNull();
    expect(normalizeQuiz({ ...base, questions: [{ q: "?", answers: ["a", "b", "", "d"], correct: 0 }] })).toBeNull();
  });
});

describe("quiz payload — attach on paste", () => {
  it("attaches the pasted quiz to the selected topic and is one undoable step", async () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.doc.node(store.sheet.rootNodeId)!;
    store.select(root.id);
    store.createChild();
    const topic = store.doc.requireNode(root.childrenIds[root.childrenIds.length - 1]);
    store.select(topic.id);

    vi.stubGlobal("navigator", { clipboard: { readText: async () => JSON.stringify(validPayload) } });
    await store.paste();
    vi.unstubAllGlobals();

    const attached = store.doc.node(topic.id)!.style.quiz;
    expect(attached?.questions).toHaveLength(2);
    // The topic is NOT turned into an editor and the raw JSON is not typed in.
    expect(store.getSnapshot().editingId).toBeNull();

    store.undo();
    expect(store.doc.node(topic.id)!.style.quiz).toBeUndefined();
  });

  it("refuses a quiz payload with no topic selected instead of typing raw JSON", async () => {
    const store = new EditorStore(memoryAdapter);
    store.clearSelection();

    vi.stubGlobal("navigator", { clipboard: { readText: async () => JSON.stringify(validPayload) } });
    await store.paste();
    vi.unstubAllGlobals();

    const s = store.getSnapshot();
    expect(s.editingId).toBeNull();
    expect(s.pendingInsert).toBeNull();
    expect(store.doc.node(store.sheet.rootNodeId)!.style.quiz).toBeUndefined();
  });
});
