import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flashcardCounts, flashcardRunOrder, normalizeFlashcards, parseFlashcards } from "../src/core/flashcards";
import { parseQuiz } from "../src/core/quiz";
import { flashcardsClipText, FLASHCARDS_PROMPT } from "../src/editor/flashcardPrompts";
import { EditorStore } from "../src/editor/store";
import type { FlashcardDeck } from "../src/core/types";
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

const deckPayload = {
  app: "r-node",
  kind: "flashcards",
  name: "  Git basics ",
  cards: [
    { topic: "Branching", term: "git switch -c", definition: "Creates a branch and moves to it." },
    { term: "git stash", definition: "Shelves uncommitted changes." },
    { topic: "Remote", term: "git fetch", definition: "Downloads without merging.", rating: "green" },
  ],
};

const quizPayload = {
  app: "r-node",
  kind: "quiz",
  questions: [{ q: "Q?", answers: ["a", "b", "c", "d"], correct: 1 }],
};

function addTopic(store: EditorStore): string {
  const root = store.doc.node(store.sheet.rootNodeId)!;
  store.select(root.id);
  store.createChild();
  return root.childrenIds[root.childrenIds.length - 1];
}

async function pasteText(store: EditorStore, text: string): Promise<void> {
  vi.stubGlobal("navigator", { clipboard: { readText: async () => text } });
  await store.paste();
  vi.unstubAllGlobals();
}

afterEach(() => vi.unstubAllGlobals());

describe("flashcard payload", () => {
  it("accepts a well-shaped deck, trims fields and never takes ratings from the payload", () => {
    const seed = normalizeFlashcards(deckPayload)!;
    expect(seed.name).toBe("Git basics");
    expect(seed.cards).toHaveLength(3);
    expect(seed.cards[0]).toEqual({ topic: "Branching", term: "git switch -c", definition: "Creates a branch and moves to it." });
    expect(seed.cards[1].topic).toBeUndefined();
    expect(seed.cards[2].rating).toBeUndefined();
  });

  it("rejects the whole deck when one card lacks a term or definition", () => {
    expect(normalizeFlashcards({ ...deckPayload, cards: [...deckPayload.cards, { term: "x", definition: " " }] })).toBeNull();
    expect(normalizeFlashcards({ ...deckPayload, cards: [{ definition: "only back" }] })).toBeNull();
    expect(normalizeFlashcards({ ...deckPayload, cards: [] })).toBeNull();
    expect(normalizeFlashcards({ ...deckPayload, kind: "quiz" })).toBeNull();
    expect(normalizeFlashcards({ ...deckPayload, app: "other" })).toBeNull();
  });

  it("tells a quiz from a deck by kind, in both directions", () => {
    expect(parseFlashcards(JSON.stringify(quizPayload))).toBeNull();
    expect(parseQuiz(JSON.stringify(deckPayload))).toBeNull();
    expect(parseFlashcards("Here you go:\n```json\n" + JSON.stringify(deckPayload) + "\n```")).not.toBeNull();
  });

  it("the prompt's own format example is a valid deck", () => {
    const example = FLASHCARDS_PROMPT.slice(FLASHCARDS_PROMPT.indexOf("{"), FLASHCARDS_PROMPT.lastIndexOf("}") + 1);
    expect(parseFlashcards(example)).not.toBeNull();
    expect(flashcardsClipText("  ")).toBe(FLASHCARDS_PROMPT);
    expect(flashcardsClipText("A\n  B")).toBe(`A\n  B\n\n---\n\n${FLASHCARDS_PROMPT}`);
  });
});

describe("flashcard run order", () => {
  const deck: FlashcardDeck = {
    id: "d",
    cards: [
      { term: "a", definition: "1", rating: "green" },
      { term: "b", definition: "2" },
      { term: "c", definition: "3", rating: "red" },
      { term: "d", definition: "4", rating: "yellow" },
      { term: "e", definition: "5", rating: "red" },
    ],
  };

  it("keeps deck order, or puts red first, then unrated, yellow, green", () => {
    expect(flashcardRunOrder(deck, false)).toEqual([0, 1, 2, 3, 4]);
    expect(flashcardRunOrder(deck, true)).toEqual([2, 4, 1, 3, 0]);
  });

  it("counts each rating", () => {
    expect(flashcardCounts(deck)).toEqual({ red: 2, yellow: 1, green: 1, none: 1 });
  });
});

describe("flashcards in the store", () => {
  it("Ctrl+V routes a deck to the flashcard strip and a quiz to the quiz strip", async () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    store.select(topic);

    await pasteText(store, "```json\n" + JSON.stringify(deckPayload) + "\n```");
    await pasteText(store, JSON.stringify(quizPayload));

    const style = store.doc.node(topic)!.style;
    expect(style.flashcards).toHaveLength(1);
    expect(style.flashcards![0].cards).toHaveLength(3);
    expect(style.quizzes).toHaveLength(1);
    expect(store.getSnapshot().editingId).toBeNull();

    store.undo();
    store.undo();
    expect(store.doc.node(topic)!.style.flashcards).toBeUndefined();
  });

  it("either '+' accepts either payload", async () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    vi.stubGlobal("navigator", { clipboard: { readText: async () => JSON.stringify(deckPayload) } });
    await store.addQuizFromClipboard(topic);
    vi.unstubAllGlobals();
    expect(store.doc.node(topic)!.style.flashcards).toHaveLength(1);
    expect(store.doc.node(topic)!.style.quizzes).toBeUndefined();
  });

  it("rates a card, undoes it, and deletes a deck", () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    store.attachFlashcards(topic, normalizeFlashcards(deckPayload)!);
    const deckId = store.doc.node(topic)!.style.flashcards![0].id;

    store.openFlashcards(topic, deckId);
    expect(store.getSnapshot().flashcardsOpen).toEqual({ nodeId: topic, deckId });

    store.rateFlashcard(topic, deckId, 1, "yellow");
    expect(store.doc.node(topic)!.style.flashcards![0].cards[1].rating).toBe("yellow");
    store.undo();
    expect(store.doc.node(topic)!.style.flashcards![0].cards[1].rating).toBeUndefined();

    store.removeFlashcards(topic, deckId);
    expect(store.doc.node(topic)!.style.flashcards).toBeUndefined();
    expect(store.getSnapshot().flashcardsOpen).toBeNull();
  });

  it("copies the plain branch outline with the flashcards prompt", async () => {
    const store = new EditorStore(memoryAdapter);
    const topic = addTopic(store);
    const writes: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void writes.push(t) } });
    await store.copyFlashcardsPrompt(topic);
    vi.unstubAllGlobals();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"kind": "flashcards"');
    expect(writes[0]).not.toContain("[topic ");
  });
});
