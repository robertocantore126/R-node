// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { colorAlpha, parseColor, toHex, withAlpha } from "../src/core/paint";
import { EditorStore } from "../src/editor/store";

describe("paint helpers", () => {
  it("parses every stored form", () => {
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#dae8fc")).toEqual({ r: 218, g: 232, b: 252, a: 1 });
    expect(parseColor("#dae8fc80")!.a).toBeCloseTo(0.502, 2);
    expect(parseColor("rgba(10, 20, 30, 0.4)")).toEqual({ r: 10, g: 20, b: 30, a: 0.4 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("transparent")!.a).toBe(0);
    expect(parseColor("teal")).toBeNull();
  });

  it("round-trips a colour through an alpha, writing rgba() only when needed", () => {
    expect(withAlpha("#dae8fc", 0.5)).toBe("rgba(218, 232, 252, 0.5)");
    expect(withAlpha("rgba(218, 232, 252, 0.5)", 1)).toBe("#dae8fc");
    expect(colorAlpha(withAlpha("#ff0000", 0.25))).toBe(0.25);
    expect(toHex("rgba(218, 232, 252, 0.5)")).toBe("#dae8fc");
    expect(toHex("transparent")).toBeNull();
    expect(toHex(undefined)).toBeNull();
  });
});

describe("selection restyle", () => {
  function setup() {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const a = store.createFreeformItem(board.id, board.position.x + 100, board.position.y + 100, "", undefined, "rect")!;
    const b = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 100, "", undefined, "rect")!;
    const c = store.createFreeformContainer(board.id, board.position.x + 300, board.position.y + 300)!;
    return { store, a, b, c };
  }

  it("styles every selected topic in one undo step, and undefined clears a field", () => {
    const { store, a, b } = setup();
    store.setSelectionStyle({ fill: "#dae8fc", stroke: "#6c8ebf", textColor: "#1a1a1a" }, [a, b]);
    expect(store.doc.requireNode(a).style).toMatchObject({ fill: "#dae8fc", stroke: "#6c8ebf", textColor: "#1a1a1a" });
    expect(store.doc.requireNode(b).style.fill).toBe("#dae8fc");
    store.setSelectionStyle({ fill: undefined }, [a]);
    expect("fill" in store.doc.requireNode(a).style).toBe(false);
    store.undo();
    expect(store.doc.requireNode(a).style.fill).toBe("#dae8fc");
    store.undo();
    expect(store.doc.requireNode(a).style.fill).toBeUndefined();
    expect(store.doc.requireNode(b).style.fill).toBeUndefined();
  });

  it("a per-topic patch paints a container's header and a box's body", () => {
    const { store, a, c } = setup();
    store.setSelectionStyle((n) => (n.style.container ? { container: { ...n.style.container, headerFill: "#d5e8d4" } } : { fill: "#d5e8d4" }), [a, c]);
    expect(store.doc.requireNode(c).style.container).toEqual({ headerFill: "#d5e8d4" });
    expect(store.doc.requireNode(c).style.fill).toBe("transparent");
    expect(store.doc.requireNode(a).style.fill).toBe("#d5e8d4");
  });
});
