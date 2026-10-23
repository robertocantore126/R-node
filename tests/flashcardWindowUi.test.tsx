// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StoreContext } from "../src/editor/context";
import { EditorStore } from "../src/editor/store";
import { FlashcardWindow } from "../src/ui/FlashcardWindow";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("flips a card, rates it, and reruns red cards first", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  const owner = store.sheet.rootNodeId;
  store.attachFlashcards(owner, { name: "Deck", cards: [
    { topic: "T", term: "alpha", definition: "first letter" },
    { term: "beta", definition: "second letter" },
  ] });
  const deckId = store.doc.requireNode(owner).style.flashcards![0].id;
  store.openFlashcards(owner, deckId);
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
    expect(button, `button ${text}`).toBeTruthy();
    await act(async () => button!.click());
  };
  const cards = () => store.doc.requireNode(owner).style.flashcards![0].cards;
  try {
    await act(async () => root.render(<StoreContext.Provider value={store}><FlashcardWindow /></StoreContext.Provider>));
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("first letter");
    await click("Flip");
    expect(container.textContent).toContain("first letter");

    await click("Know it");
    expect(cards()[0].rating).toBe("green");
    expect(container.textContent).toContain("beta");
    await click("Don't know");
    expect(cards()[1].rating).toBe("red");
    expect(container.textContent).toContain("1 / 2");

    // Criticality restarts the run with the red card first.
    await click("In order");
    expect(container.textContent).toContain("Card 1 / 2");
    expect(container.textContent).toContain("beta");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "3" })));
    expect(cards()[1].rating).toBe("green");
    expect(container.textContent).toContain("alpha");

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(store.getSnapshot().flashcardsOpen).toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
