// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreContext } from "../src/editor/context";
import { EditorStore } from "../src/editor/store";
import { LongOps, SAVE_FLOW_TABLE, selectionFields, selectionTargetOf, type SelectionTarget } from "../src/editor/editorMachines";
import { inspectMachines, Machine, machineNames, registerInspectable } from "../src/editor/machine";
import { CANVAS_GESTURE_TABLE, createCanvasGestureMachine, gestureHoldsKeyboard, IDLE_GESTURE } from "../src/ui/canvasGesture";
import { WebSearchPanel } from "../src/ui/WebSearchPanel";
import * as webSearch from "../src/editor/webSearch";
import type { RnodeDocument } from "../src/core/types";

const adapter = (over: Partial<{ load: () => Promise<RnodeDocument[]>; save: (d: RnodeDocument[]) => Promise<void> }> = {}) => ({
  label: "test",
  load: async (): Promise<RnodeDocument[]> => [],
  save: async (): Promise<void> => {},
  ...over,
});

const newStore = (): EditorStore => new EditorStore(adapter());

/** A store whose portable-file step is replaced: `written` is what the picker did. */
function savingStore(written: boolean, save: () => Promise<void>): EditorStore {
  const store = new EditorStore(adapter({ save }));
  vi.spyOn(store as unknown as { writePortableRnode: () => Promise<boolean> }, "writePortableRnode").mockResolvedValue(written);
  return store;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

function topic(store: EditorStore): string {
  store.createChild();
  store.cancelEdit();
  const root = store.doc.node(store.sheet.rootNodeId)!;
  return root.childrenIds[root.childrenIds.length - 1];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Machine", () => {
  type Light = { kind: "off" } | { kind: "on"; level: number };
  const table = { off: ["on"], on: ["off"] } as const;

  it("moves along the table and tells subscribers", () => {
    const m = new Machine<Light>("light", { kind: "off" }, table);
    const seen: string[] = [];
    m.subscribe(() => seen.push(m.state.kind));
    m.to({ kind: "on", level: 3 }, "press");
    m.to({ kind: "off" }, "press");
    expect(seen).toEqual(["on", "off"]);
    expect(m.violations).toBe(0);
  });

  it("fails a test on an illegal move", () => {
    const m = new Machine<Light>("light", { kind: "off" }, table);
    expect(() => m.to({ kind: "off" }, "noop")).toThrow(/illegal move off -> off/);
  });

  it("records an illegal move for a user but keeps the session going", () => {
    const m = new Machine<Light>("light", { kind: "off" }, table, false);
    m.to({ kind: "off" }, "noop");
    expect(m.violations).toBe(1);
    expect(m.state.kind).toBe("off");
  });
});

describe("canvas gesture", () => {
  it("is star-shaped: every gesture starts from idle and returns to it", () => {
    const kinds = Object.keys(CANVAS_GESTURE_TABLE).filter((k) => k !== "idle");
    expect([...CANVAS_GESTURE_TABLE.idle].sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(CANVAS_GESTURE_TABLE[k as keyof typeof CANVAS_GESTURE_TABLE]).toEqual(["idle"]);
  });

  it("refuses to open a gesture on top of another", () => {
    const m = createCanvasGestureMachine();
    m.to({ kind: "pan", over: "canvas" }, "down");
    expect(() => m.to({ kind: "marquee", anchorX: 0, anchorY: 0, active: false }, "down")).toThrow(/illegal move/);
  });

  it("holds the keyboard only while something would be committed", () => {
    expect(gestureHoldsKeyboard(IDLE_GESTURE)).toBe(false);
    expect(gestureHoldsKeyboard({ kind: "pan", over: "overlay" })).toBe(false);
    expect(gestureHoldsKeyboard({ kind: "node-drag", nodeId: "a", grabOffsetX: 0, grabOffsetY: 0 })).toBe(true);
  });
});

describe("gesture rollback in the store", () => {
  it("cancelNodeDrag restores the position with no undo step", () => {
    const store = newStore();
    const id = topic(store);
    const before = { ...store.doc.node(id)!.position };
    const canUndo = store.getSnapshot().canUndo;
    store.beginNodeDrag(id);
    store.setNodeDragDraft(id, 999, 888);
    store.setDrop({ mode: "floating", nodeId: id });
    store.cancelNodeDrag();
    const now = store.doc.node(id)!.position;
    expect({ x: now.x, y: now.y, manual: now.manual }).toEqual({ x: before.x, y: before.y, manual: before.manual });
    expect(store.getSnapshot().drop).toBeNull();
    expect(store.getSnapshot().canUndo).toBe(canUndo);
  });

  it("cancelNodeDrag after a plain click does no layout work", () => {
    const store = newStore();
    const id = topic(store);
    store.beginNodeDrag(id);
    const rev = store.revision;
    store.cancelNodeDrag();
    expect(store.revision).toBe(rev);
  });

  it("cancelResize and cancelImageResize restore the style with no undo step", () => {
    const store = newStore();
    const id = topic(store);
    const width = store.doc.node(id)!.style.width;
    const canUndo = store.getSnapshot().canUndo;
    store.beginResize(id);
    store.setResizeDraft(id, 400);
    expect(store.doc.node(id)!.style.width).toBe(400);
    store.cancelResize();
    expect(store.doc.node(id)!.style.width).toBe(width);

    store.beginImageResize(id);
    store.setImageResizeDraft(id, 200);
    store.cancelImageResize();
    expect(store.doc.node(id)!.style.imageWidth).toBeUndefined();
    expect(store.getSnapshot().canUndo).toBe(canUndo);
  });
});

describe("long operations", () => {
  it("shows the newest, then returns to the one beneath", () => {
    const ops = new LongOps();
    ops.begin("save", "Saving", true);
    ops.begin("export", "Exporting", false);
    expect(ops.current?.label).toBe("Exporting");
    ops.end("export");
    expect(ops.current?.label).toBe("Saving");
    ops.end("save");
    expect(ops.current).toBeNull();
  });

  it("cancels only the operation on screen", () => {
    const ops = new LongOps();
    const save = ops.begin("save", "Saving", true);
    const exp = ops.begin("export", "Exporting", true);
    ops.cancelCurrent();
    expect(exp.aborted).toBe(true);
    expect(save.aborted).toBe(false);
  });

  it("an export started during a save does not abort it or clear its bar", () => {
    const store = newStore();
    const internals = store as unknown as { beginLongOp(l: string, c: boolean): AbortSignal; endLongOp(): void };
    const signal = internals.beginLongOp("Saving document…", true);
    store.beginExport("Building SVG…");
    expect(signal.aborted).toBe(false);
    expect(store.getSnapshot().op?.label).toBe("Building SVG…");
    store.endExport();
    expect(store.getSnapshot().op?.label).toBe("Saving document…");
    internals.endLongOp();
    expect(store.getSnapshot().op).toBeNull();
  });
});

describe("save flow", () => {
  it("only allows saving <-> idle", () => {
    expect(SAVE_FLOW_TABLE).toEqual({ idle: ["saving"], saving: ["idle"] });
  });

  it("re-runs once for a request made during a save", async () => {
    const hold = gate();
    const save = vi.fn(() => hold.wait);
    const store = savingStore(true, save);
    const running = store.saveNow();
    await store.saveNow();
    await store.saveNow();
    hold.open();
    await running;
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });

  it("does not ask again when the user dismissed the file picker", async () => {
    const hold = gate();
    const save = vi.fn(() => hold.wait);
    const store = savingStore(false, save);
    const running = store.saveNow();
    await store.saveNow(); // queued
    hold.open();
    await running;
    await new Promise((r) => setTimeout(r, 0));
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("selection target", () => {
  const cases: SelectionTarget[] = [
    { kind: "none" },
    { kind: "nodes", ids: ["a", "b"] },
    { kind: "nodes", ids: ["a"], cell: { nodeId: "a", index: 2 } },
    { kind: "image", nodeId: "a", slot: "left" },
    { kind: "relationship", id: "r" },
    { kind: "group", id: "g" },
    { kind: "summary", id: "s" },
  ];

  it("round-trips through the published fields", () => {
    for (const t of cases) expect(selectionTargetOf(selectionFields(t))).toEqual(t);
  });

  it("starting to edit a topic deselects a relationship", () => {
    const store = newStore();
    const a = topic(store);
    store.selectRelationship("some-rel");
    store.startEdit(a);
    expect(store.getSnapshot().relSel).toBeNull();
    expect(store.getSnapshot().selection).toEqual([a]);
  });

  it("switching documents forgets everything named in the old one", () => {
    const store = newStore();
    const a = topic(store);
    const first = store.getSnapshot().activeDocId;
    store.beginRelationship(a);
    store.selectImage(a, "top");
    const doc = { ...JSON.parse(JSON.stringify(store.doc.doc)), documentId: "other" } as RnodeDocument;
    store.importDocumentFromJson(JSON.stringify(doc));
    expect(store.getSnapshot().activeDocId).not.toBe(first);
    expect(store.getSnapshot().relFrom).toBeNull();
    expect(store.getSnapshot().imageSel).toBeNull();
    expect(store.getSnapshot().imageSlot).toBeNull();
  });
});

describe("boot", () => {
  it("always resolves and leaves a usable map when init throws", async () => {
    const store = newStore();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "init").mockRejectedValue(new Error("boom"));
    await expect(store.boot()).resolves.toBeUndefined();
    expect(store.doc.node(store.sheet.rootNodeId)).toBeTruthy();
    expect(store.getSnapshot().message).toContain("boom");
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("web search panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const type = async (value: string): Promise<void> => {
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("ignores a search that was still in flight when the box was cleared", async () => {
    vi.useFakeTimers();
    let finish: (items: webSearch.WebItem[]) => void = () => {};
    const search = vi.spyOn(webSearch, "searchWeb").mockImplementation(
      () => new Promise((r) => { finish = r; })
    );
    root = createRoot(container);
    await act(async () => {
      root.render(
        <StoreContext.Provider value={newStore()}>
          <WebSearchPanel />
        </StoreContext.Provider>
      );
    });
    await type("abbey road");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(search).toHaveBeenCalledTimes(1);
    await type("");
    await act(async () => {
      finish([{ title: "STALE RESULT" } as unknown as webSearch.WebItem]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.textContent).not.toContain("STALE RESULT");
  });
});

describe("catalog", () => {
  it("documents every registered machine and exposes its state", () => {
    newStore();
    registerInspectable(createCanvasGestureMachine());
    const catalog = readFileSync(resolve(__dirname, "../docs/STATE_MACHINES.md"), "utf8");
    expect(machineNames()).toEqual(["canvasGesture", "interaction", "longOps", "saveFlow"]);
    for (const name of machineNames()) expect(catalog, `${name} missing from docs/STATE_MACHINES.md`).toContain(`\`${name}\``);
    const live = inspectMachines();
    expect(live.saveFlow).toEqual({ kind: "idle" });
    expect(live.canvasGesture).toEqual({ kind: "idle" });
  });
});
