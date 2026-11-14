// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FREEFORM_SHAPE_SIZES, FREEFORM_SHAPES } from "../src/core/freeform";
import { StoreContext } from "../src/editor/context";
import { EditorStore } from "../src/editor/store";
import { FreeformInsertMenu } from "../src/ui/FreeformInsertMenu";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  return { store, board };
}

describe("freeform double-click shapes", () => {
  it("a shape is centred on the point, sized, outlined, and opens the editor", () => {
    const { store, board } = setup();
    const at = { x: board.position.x + 300, y: board.position.y + 200 };
    const id = store.createFreeformItem(board.id, at.x, at.y, "", undefined, "diamond")!;
    const n = store.doc.requireNode(id);
    const size = FREEFORM_SHAPE_SIZES.diamond;
    expect(n.style).toMatchObject({ shape: "diamond", width: size.w, height: size.h, borderWidth: 1.5 });
    expect(n.style.freeformPosition).toEqual({ x: 300 - size.w / 2, y: 200 - size.h / 2 });
    expect(store.getSnapshot().editingId).toBe(id);
  });

  it("a container is a nested canvas centred on the point that holds what is dropped in it", () => {
    const { store, board } = setup();
    const id = store.createFreeformContainer(board.id, board.position.x + 300, board.position.y + 220)!;
    const c = store.doc.requireNode(id);
    expect(c.parentId).toBe(board.id);
    expect(c.style).toMatchObject({ freeform: true, container: { headerFill: "transparent" }, width: 260, height: 170 });
    expect(c.style.freeformPosition).toEqual({ x: 300 - 130, y: 220 - 85 });
    const item = store.createFreeformItem(id, c.position.x + 60, c.position.y + 80, "", undefined, "rect")!;
    expect(store.doc.requireNode(item).parentId).toBe(id);
  });

  it("plain text keeps the old behaviour: top-left at the point, no box", () => {
    const { store, board } = setup();
    const id = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 200)!;
    const n = store.doc.requireNode(id);
    expect(n.style).toMatchObject({ shape: "none", align: "left" });
    expect(n.style.width).toBeUndefined();
    expect(n.style.freeformPosition).toEqual({ x: 300, y: 200 });
  });

  it("the picker offers text and every base shape, and a click creates it in the canvas", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { store, board } = setup();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    const at = { parentId: board.id, world: { x: board.position.x + 200, y: board.position.y + 150 }, screen: { x: 40, y: 40 } };
    try {
      await act(async () => root.render(
        <StoreContext.Provider value={store}>
          <FreeformInsertMenu at={at} bounds={{ w: 800, h: 600 }} onClose={onClose} />
        </StoreContext.Provider>,
      ));
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".ff-insert-btn"));
      expect(buttons.map((b) => b.title)).toEqual(["Text", ...FREEFORM_SHAPES.map((s) => s.label), expect.stringMatching(/^Container/)]);
      expect(document.activeElement).toBe(buttons[0]); // Enter right away = text
      // Keys pressed in the picker must not reach the map's shortcuts (App
      // listens on window, bubble phase): Enter there would create a topic.
      const appShortcuts = vi.fn();
      window.addEventListener("keydown", appShortcuts);
      buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      window.removeEventListener("keydown", appShortcuts);
      expect(appShortcuts).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(buttons[1]);
      const before = board.childrenIds.length;
      await act(async () => buttons.find((b) => b.title === "Circle")!.click());
      expect(onClose).toHaveBeenCalled();
      expect(board.childrenIds.length).toBe(before + 1);
      expect(store.doc.requireNode(board.childrenIds.at(-1)!).style.shape).toBe("circle");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
