// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoreContext } from "../src/editor/context";
import { EditorStore } from "../src/editor/store";
import { FlashcardWindow } from "../src/ui/FlashcardWindow";
import { QuizWindow } from "../src/ui/QuizWindow";
import { validFlashcardProgress, validQuizProgress } from "../src/ui/studyProgress";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // Node's own (broken) localStorage shadows jsdom's here, as in shapeLibrary.test.ts.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
    clear: () => saved.clear(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const newStore = () => new EditorStore({ label: "test", async load() { return []; }, async save() {} });
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  expect(button, `button ${text}`).toBeTruthy();
  await act(async () => button!.click());
};
/** Mount a window fresh, as App does on every open (it is keyed by id). */
const mount = async (store: EditorStore, el: JSX.Element) => {
  await act(async () => root?.unmount());
  root = createRoot(container);
  await act(async () => root.render(<StoreContext.Provider value={store}>{el}</StoreContext.Provider>));
};

it("a flashcard run resumes on the same card after closing, and ↺ goes back to card 1", async () => {
  const store = newStore();
  const owner = store.sheet.rootNodeId;
  store.attachFlashcards(owner, { cards: ["a", "b", "c"].map((t) => ({ term: t, definition: t + "!" })) });
  const deckId = store.doc.requireNode(owner).style.flashcards![0].id;

  store.openFlashcards(owner, deckId);
  await mount(store, <FlashcardWindow />);
  await click("›");
  await click("›");
  expect(container.textContent).toContain("Card 3 / 3");
  store.closeFlashcards();

  store.openFlashcards(owner, deckId);
  await mount(store, <FlashcardWindow />);
  expect(container.textContent).toContain("Card 3 / 3");
  await click("↺ Card 1");
  expect(container.textContent).toContain("Card 1 / 3");
  expect(container.textContent).not.toContain("↺ Card 1");
});

it("a quiz resumes on the same question with its answers, and a finished run starts over", async () => {
  const store = newStore();
  const owner = store.sheet.rootNodeId;
  const q = (n: string) => ({ q: n, answers: ["w", "x", "y", "z"], correct: 0 });
  store.attachQuiz(owner, { questions: [q("Q1"), q("Q2")] });
  const quizId = store.doc.requireNode(owner).style.quizzes![0].id;

  store.openQuiz(owner, quizId);
  await mount(store, <QuizWindow />);
  await click("x");
  await click("Next");
  store.closeQuiz();

  store.openQuiz(owner, quizId);
  await mount(store, <QuizWindow />);
  expect(container.textContent).toContain("Question 2 / 2");
  await click("w");
  await click("See result");
  // The resumed run kept its first (wrong) answer.
  expect(store.doc.requireNode(owner).style.quizzes![0].lastAnswers).toEqual([1, 0]);
  store.closeQuiz();

  store.openQuiz(owner, quizId);
  await mount(store, <QuizWindow />);
  expect(container.textContent).toContain("Question 1 / 2");
});

it("ignores saved progress that no longer fits", () => {
  expect(validFlashcardProgress({ order: [0, 1], pos: 1 }, 3)).toBeNull();
  expect(validFlashcardProgress({ order: [0, 0, 1], pos: 0 }, 3)).toBeNull();
  expect(validFlashcardProgress({ order: [2, 0, 1], pos: 2, byCriticality: true }, 3)).toEqual({ order: [2, 0, 1], pos: 2, byCriticality: true });
  expect(validQuizProgress({ index: 5, results: [] }, 3)).toBeNull();
  expect(validQuizProgress({ index: 1, results: [0] }, 3)).toEqual({ index: 1, results: [0] });
  expect(validQuizProgress({ index: 1, results: [0, 7] }, 3)).toBeNull();
});
