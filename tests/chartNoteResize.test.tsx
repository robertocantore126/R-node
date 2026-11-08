// @vitest-environment jsdom
/**
 * A chart slot's note is a normal topic, and its width lives in the same
 * `Style.width` field as any other topic's. The chart's Inspector repeats the
 * width slider for the slot's note so it can be resized from the box it
 * belongs to — the note is only drawn while that box is selected, and by the
 * time it is being edited it is a Lexical overlay that swallows the canvas
 * handles.
 */
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { StoreContext } from "../src/editor/context";
import { Inspector } from "../src/ui/Inspector";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function seeded(): { store: EditorStore; chartId: string; noteId: string } {
  const store = new EditorStore(memoryAdapter);
  store.createChartTopic(store.sheet.rootNodeId);
  const chart = Object.values(store.sheet.nodes).find((n) => n.style.gallery?.chart)!;
  const noteId = store.addChartNote(chart.id, 0)!;
  store.commitEdit();
  store.selectGalleryCell(chart.id, 0);
  return { store, chartId: chart.id, noteId };
}

function mount(store: EditorStore): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <StoreContext.Provider value={store}>
        <Inspector />
      </StoreContext.Provider>,
    );
  });
  return container;
}

it("offers the box note's width slider on the chart and writes the note's own style", () => {
  const { store, noteId } = seeded();
  const container = mount(store);

  const field = [...container.querySelectorAll<HTMLElement>(".field")]
    .find((f) => f.querySelector("span")?.textContent === "Note width");
  expect(field).toBeTruthy();

  const range = field!.querySelector<HTMLInputElement>('input[type="range"]')!;
  expect(range.value).toBe("280");
  expect(store.doc.node(noteId)!.style.width).toBeUndefined();

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(range, "420");
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(store.doc.node(noteId)!.style.width).toBe(420);

  act(() => {
    field!.querySelector<HTMLButtonElement>("button")!.click();
  });
  expect(store.doc.node(noteId)!.style.width).toBeUndefined();
});
