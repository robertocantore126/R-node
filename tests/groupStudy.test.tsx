// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quizMistakeNodeIds } from "../src/core/quiz";
import { StoreContext } from "../src/editor/context";
import { EditorStore } from "../src/editor/store";
import { FlashcardWindow } from "../src/ui/FlashcardWindow";
import { GroupContextMenu } from "../src/ui/GroupContextMenu";
import { QuizWindow } from "../src/ui/QuizWindow";

let container: HTMLDivElement;
let root: Root | null = null;

function setTitle(store: EditorStore, id: string, text: string): void {
  store.startEdit(id);
  store.setEditingDraft(text);
  store.commitEdit();
}

function setupGroupStore() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  const rootId = store.sheet.rootNodeId;
  const a = store.createChildOf(rootId)!;
  const aChild = store.createChildOf(a)!;
  const b = store.createChildOf(rootId)!;
  setTitle(store, a, "Networking");
  setTitle(store, aChild, "DNS");
  setTitle(store, b, "Storage");
  store.selectMany([a, b]);
  store.createGroupFromSelection();
  const group = store.sheet.boundaries[0];
  return { store, groupId: group.id, a, aChild, b };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
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
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderUi(store: EditorStore, el: JSX.Element): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = createRoot(container);
  await act(async () => root!.render(<StoreContext.Provider value={store}>{el}</StoreContext.Provider>));
}

async function clickButton(text: string): Promise<void> {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  expect(btn, `button ${text}`).toBeTruthy();
  await act(async () => btn!.click());
}

describe("group quizzes and flashcards", () => {
  it("attaches quizzes and flashcards via clipboard or paste when group is selected, and supports undo/redo", async () => {
    const { store, groupId } = setupGroupStore();
    const quizJson = JSON.stringify({
      app: "r-node",
      kind: "quiz",
      name: "Group Quiz",
      questions: [{ q: "Q1?", answers: ["A", "B", "C", "D"], correct: 0 }],
    });
    const cardsJson = JSON.stringify({
      app: "r-node",
      kind: "flashcards",
      name: "Group Deck",
      cards: [{ term: "DNS", definition: "Resolves names" }],
    });

    vi.stubGlobal("navigator", { clipboard: { readText: async () => quizJson, writeText: async () => {} } });
    await store.addGroupQuizFromClipboard(groupId);
    expect(store.sheet.boundaries[0].quizzes?.length).toBe(1);
    expect(store.sheet.boundaries[0].quizzes![0].name).toBe("Group Quiz");

    store.selectGroup(groupId);
    await store.paste(null, cardsJson);
    expect(store.sheet.boundaries[0].flashcards?.length).toBe(1);
    expect(store.sheet.boundaries[0].flashcards![0].name).toBe("Group Deck");

    store.undo();
    expect(store.sheet.boundaries[0].flashcards).toBeUndefined();
    store.redo();
    expect(store.sheet.boundaries[0].flashcards?.length).toBe(1);

    const quizId = store.sheet.boundaries[0].quizzes![0].id;
    store.openGroupQuiz(groupId, quizId);
    expect(store.getSnapshot().quizOpen).toEqual({ groupId, quizId });
    store.removeGroupQuiz(groupId, quizId);
    expect(store.getSnapshot().quizOpen).toBeNull();
    expect(store.sheet.boundaries[0].quizzes).toBeUndefined();
  });

  it("plays a group quiz in QuizWindow, records score, and highlights missed topics on the map", async () => {
    const { store, groupId, a, aChild, b } = setupGroupStore();
    store.attachGroupQuiz(groupId, {
      name: "Unit check",
      questions: [
        { q: "What resolves names?", answers: ["DNS", "FTP", "SSH", "TLS"], correct: 0, sourceNodeIds: [aChild] },
        { q: "General question?", answers: ["Yes", "No", "Maybe", "Never"], correct: 0 },
      ],
    });
    const quizId = store.sheet.boundaries[0].quizzes![0].id;
    store.openGroupQuiz(groupId, quizId);

    await renderUi(store, <QuizWindow />);
    expect(container.textContent).toContain("Unit check");
    await clickButton("FTP");
    await clickButton("Next");
    await clickButton("Yes");
    await clickButton("See result");

    const saved = store.sheet.boundaries[0].quizzes![0];
    expect(saved.score).toEqual({ last: 1, best: 1, attempts: 1 });
    expect(saved.lastAnswers).toEqual([1, 0]);

    await clickButton("Show mistakes on map");
    expect(store.getSnapshot().quizOpen).toBeNull();
    expect(store.sheet.boundaries[0].showQuizMistakes).toBe(true);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([aChild]));

    // Unlinked mistake falls back to all group members.
    store.submitGroupQuizScore(groupId, quizId, [0, 1]);
    expect(quizMistakeNodeIds(store.sheet)).toEqual(new Set([a, b]));

    store.setGroupQuizMistakesVisible(groupId, false);
    expect(quizMistakeNodeIds(store.sheet).size).toBe(0);
  });

  it("plays and rates a group flashcard deck in FlashcardWindow", async () => {
    const { store, groupId } = setupGroupStore();
    store.attachGroupFlashcards(groupId, {
      name: "Group Cards",
      cards: [
        { term: "DNS", definition: "Domain Name System" },
        { term: "SSD", definition: "Solid State Drive" },
      ],
    });
    const deckId = store.sheet.boundaries[0].flashcards![0].id;
    store.openGroupFlashcards(groupId, deckId);

    await renderUi(store, <FlashcardWindow />);
    expect(container.textContent).toContain("Group Cards");
    expect(container.textContent).toContain("DNS");
    await clickButton("Flip");
    expect(container.textContent).toContain("Domain Name System");
    await clickButton("Don't know");

    expect(store.sheet.boundaries[0].flashcards![0].cards[0].rating).toBe("red");
    store.undo();
    expect(store.sheet.boundaries[0].flashcards![0].cards[0].rating).toBeUndefined();
  });

  it("renders GroupContextMenu strips, toggles mistakes, and deletes decks/quizzes without closing prematurely", async () => {
    const { store, groupId } = setupGroupStore();
    store.attachGroupQuiz(groupId, {
      name: "GQuiz",
      questions: [{ q: "Q?", answers: ["A", "B", "C", "D"], correct: 0 }],
    });
    store.submitGroupQuizScore(groupId, store.sheet.boundaries[0].quizzes![0].id, [1]);
    store.attachGroupFlashcards(groupId, {
      name: "GDeck",
      cards: [{ term: "T", definition: "D" }],
    });
    const onClose = vi.fn();
    const onRename = vi.fn();

    await renderUi(store, <GroupContextMenu menu={{ groupId, x: 10, y: 10 }} onClose={onClose} onRename={onRename} />);
    expect(container.textContent).toContain("Rename group");
    expect(container.textContent).toContain("0%");
    expect(container.textContent).toContain("Copy as quiz prompt");
    expect(container.textContent).toContain("Copy as flashcards prompt");

    const review = container.querySelector<HTMLButtonElement>('button[aria-label="Show quiz mistakes on map"]')!;
    await act(async () => review.click());
    expect(store.sheet.boundaries[0].showQuizMistakes).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    const delQuiz = container.querySelector<HTMLButtonElement>('button[aria-label="Delete GQuiz"]')!;
    await act(async () => delQuiz.click());
    expect(store.sheet.boundaries[0].quizzes).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();

    const delDeck = container.querySelector<HTMLButtonElement>('button[aria-label="Delete GDeck"]')!;
    await act(async () => delDeck.click());
    expect(store.sheet.boundaries[0].flashcards).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
  });
});
