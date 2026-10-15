import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractQuizJson, normalizeQuiz, parseQuiz } from "../src/core/quiz";
import { makeOp, type Op } from "../src/core/ops";
import { plainToRuns } from "../src/core/text";
import { quizClipText } from "../src/editor/quizPrompts";
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

const questions = (count: number, word = "Q"): { q: string; answers: string[]; correct: number }[] =>
  Array.from({ length: count }, (_, k) => ({ q: `${word}${k + 1}`, answers: ["a", "b", "c", "d"], correct: 0 }));

const validPayload = {
  app: "r-node",
  kind: "quiz",
  name: "AZ-900 — architettura core",
  questions: [
    { q: "Cos'è Azure Arc?", answers: ["A", "B", "C", "D"], correct: 2, explain: "Ponti ibridi." },
    { q: "Regione?", answers: ["1", "2", "3", "4"], correct: 0 },
  ],
};

function setTitle(store: EditorStore, id: string, title: string): void {
  const n = store.doc.requireNode(id);
  store.execOps([
    makeOp<Op & { type: "setTitle" }>("setTitle", {
      id,
      title,
      prev: n.title,
      titleRuns: plainToRuns(title),
      prevRuns: n.titleRuns,
    }),
  ]);
}

/** A main topic under the root; returns its id. */
function addTopic(store: EditorStore): string {
  const root = store.doc.node(store.sheet.rootNodeId)!;
  store.select(root.id);
  store.createChild();
  return root.childrenIds[root.childrenIds.length - 1];
}

/** Attach one quiz to a topic; returns its id. */
function attachQuiz(store: EditorStore, topicId: string, questionCount: number, word = "Q"): string {
  store.attachQuiz(topicId, { questions: questions(questionCount, word) });
  const list = store.doc.node(topicId)!.style.quizzes!;
  return list[list.length - 1].id;
}

afterEach(() => vi.unstubAllGlobals());

describe("quiz payload — normalizeQuiz", () => {
  it("accepts a well-shaped payload and trims the name", () => {
    const seed = normalizeQuiz({ ...validPayload, name: "  Spaced  " })!;
    expect(seed).not.toBeNull();
    expect(seed.name).toBe("Spaced");
    expect(seed.questions).toHaveLength(2);
    expect(seed.questions[0].correct).toBe(2);
    expect(seed.questions[0].explain).toBe("Ponti ibridi.");
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

  it("finds the JSON inside a ```json fence or surrounding prose", () => {
    const fenced = "```json\n" + JSON.stringify(validPayload) + "\n```";
    expect(parseQuiz(fenced)).not.toBeNull();
    const chatty = `Sure! Here it is:\n${JSON.stringify(validPayload)}\nLet me know!`;
    expect(parseQuiz(chatty)).not.toBeNull();
    expect(extractQuizJson(fenced).startsWith("{")).toBe(true);
  });
});

describe("quiz payload — attach on paste", () => {
  it("appends the pasted quiz to the selected topic and is one undoable step", async () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    setTitle(store, topic, "Azure");
    store.select(topic);

    // A fenced payload must still work — otherwise it would be typed into the
    // topic as raw JSON and become searchable.
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "```json\n" + JSON.stringify(validPayload) + "\n```" } });
    await store.paste();
    vi.unstubAllGlobals();

    expect(store.doc.node(topic)!.style.quizzes).toHaveLength(1);
    expect(store.doc.node(topic)!.style.quizzes![0].questions).toHaveLength(2);
    expect(store.getSnapshot().editingId).toBeNull();

    store.undo();
    expect(store.doc.node(topic)!.style.quizzes).toBeUndefined();
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
  });

  it("never exposes quiz text to the map search (Ctrl+F)", () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    attachQuiz(store, topic, 1, "unicorn");

    store.setSearch("unicorn");

    expect(store.getSnapshot().searchResults).not.toContain(topic);
    expect(store.getSnapshot().searchResults).toHaveLength(0);
  });
});

describe("copy as quiz prompt", () => {
  it("composes the branch outline and the prompt, and writes them to the clipboard", async () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.doc.node(store.sheet.rootNodeId)!;
    store.select(root.id);
    store.createChild();
    const branch = root.childrenIds[root.childrenIds.length - 1];
    setTitle(store, branch, "Alpha");
    store.select(branch);
    store.createChild();
    const leaf = store.doc.requireNode(branch).childrenIds[0];
    setTitle(store, leaf, "Alpha One");

    const writes: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void writes.push(t) } });
    await store.copyQuizPrompt(branch);
    vi.unstubAllGlobals();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Alpha");
    expect(writes[0]).toContain("Alpha One");
    expect(writes[0]).toContain('"kind": "quiz"');
    expect(writes[0]).toContain('"correct"');
  });

  it("quizClipText emits the prompt alone when there is no outline", () => {
    const text = quizClipText("   ");
    expect(text).toContain('"kind": "quiz"');
    expect(text.startsWith("Create a multiple-choice quiz")).toBe(true);
  });
});

describe("quiz strip — multiple quizzes, window and score", () => {
  it("adds one quiz per '+' click, appended to the topic's strip", async () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);

    vi.stubGlobal("navigator", { clipboard: { readText: async () => JSON.stringify(validPayload) } });
    await store.addQuizFromClipboard(topic);
    await store.addQuizFromClipboard(topic);
    vi.unstubAllGlobals();

    expect(store.doc.node(topic)!.style.quizzes).toHaveLength(2);
    // Distinct ids, so the squares can be keyed and opened individually.
    const [a, b] = store.doc.node(topic)!.style.quizzes!;
    expect(a.id).not.toBe(b.id);
  });

  it("refuses a '+' when the clipboard is not a quiz, without writing anything", async () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);

    vi.stubGlobal("navigator", { clipboard: { readText: async () => "just some text" } });
    await store.addQuizFromClipboard(topic);
    vi.unstubAllGlobals();

    expect(store.doc.node(topic)!.style.quizzes).toBeUndefined();
  });

  it("opens / closes a specific quiz by id", () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    const first = attachQuiz(store, topic, 1);
    const second = attachQuiz(store, topic, 1);

    store.openQuiz(topic, "missing");
    expect(store.getSnapshot().quizOpen).toBeNull();

    store.openQuiz(topic, second);
    expect(store.getSnapshot().quizOpen).toEqual({ nodeId: topic, quizId: second });

    store.closeQuiz();
    expect(store.getSnapshot().quizOpen).toBeNull();
    expect(first).not.toBe(second);
  });

  it("records last / best / attempts on the addressed quiz, and undo reverts one run", () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    const quizId = attachQuiz(store, topic, 3);
    const scoreOf = (): unknown => store.doc.node(topic)!.style.quizzes![0].score;

    store.submitQuizScore(topic, quizId, 2);
    expect(scoreOf()).toEqual({ last: 2, best: 2, attempts: 1 });

    store.submitQuizScore(topic, quizId, 1);
    expect(scoreOf()).toEqual({ last: 1, best: 2, attempts: 2 });

    store.submitQuizScore(topic, quizId, 3);
    expect(scoreOf()).toEqual({ last: 3, best: 3, attempts: 3 });

    store.undo();
    expect(scoreOf()).toEqual({ last: 1, best: 2, attempts: 2 });
  });

  it("clamps a score above the question count", () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    const quizId = attachQuiz(store, topic, 2);
    store.submitQuizScore(topic, quizId, 99);
    expect(store.doc.node(topic)!.style.quizzes![0].score).toEqual({ last: 2, best: 2, attempts: 1 });
  });
});
