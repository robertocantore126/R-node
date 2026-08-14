import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import { THEMES, lighten } from "../src/render/theme";
import type { MindNode, Sheet } from "../src/core/types";
import { EditorStore } from "../src/editor/store";
import { DocumentModel } from "../src/core/doc";
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

// ---------------------------------------------------------------------------
// Canvas scaffolding — the Renderer constructor wants a real 2d context and a
// document.createElement for its text measurer (same harness as renderer.test).
// ---------------------------------------------------------------------------

const DIMS = { w: 800, h: 600 };

function makeNode(id: string, type: MindNode["type"], parentId: string | null): MindNode {
  return {
    id,
    type,
    parentId,
    childrenIds: [],
    title: id,
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function make2dCtx(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(_t, p) {
      if (p === "measureText") return (text: string) => ({ width: text.length * 8 });
      return () => {};
    },
    set(_t, p, v) {
      target[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function makeFakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    get width() {
      return DIMS.w;
    },
    set width(_v: number) {},
    get height() {
      return DIMS.h;
    },
    set height(_v: number) {},
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

function makeRenderer(): Renderer {
  const ctx = make2dCtx();
  vi.stubGlobal("document", { createElement: () => makeFakeCanvas(ctx) });
  return new Renderer(makeFakeCanvas(ctx));
}

/** root → two main branches, each with a child (depth 2) and a grandchild (depth 3). */
function makeSheet(): Sheet {
  const root = makeNode("root", "central", null);
  const a = makeNode("a", "main", "root");
  const a1 = makeNode("a1", "subtopic", "a");
  const a1x = makeNode("a1x", "subtopic", "a1");
  const b = makeNode("b", "main", "root");
  const b1 = makeNode("b1", "subtopic", "b");
  const b1x = makeNode("b1x", "subtopic", "b1");
  root.childrenIds = ["a", "b"];
  a.childrenIds = ["a1"];
  a1.childrenIds = ["a1x"];
  b.childrenIds = ["b1"];
  b1.childrenIds = ["b1x"];
  return {
    sheetId: "s",
    title: "t",
    structure: {
      structureType: "mindmap",
      orientation: "horizontal",
      spacing: 180,
      branchSpacing: 14,
      padding: 18,
      compactMode: false,
      autoBalance: true,
      freePositioningBranches: false,
      allowManualPositioning: true,
      connectorStyle: "curved",
    },
    rootNodeId: "root",
    nodes: { root, a, a1, a1x, b, b1, b1x },
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
  } as unknown as Sheet;
}

function stateOf(sheet: Sheet) {
  return {
    sheet,
    camera: { x: 0, y: 0, scale: 1 },
    selection: new Set<string>(),
    editingId: null,
    hoverId: null,
    drop: null,
    themeName: "light" as const,
    viewW: 800,
    viewH: 600,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("depth decides the default fill (resolveFill)", () => {
  it("root, main, child and grandchild each get their own level", () => {
    const r = makeRenderer();
    const s = stateOf(makeSheet());
    expect(r.nodeColors(s, "root")!.fill).toBe(THEMES.light.rootFill);
    expect(r.nodeColors(s, "a")!.fill).toBe(THEMES.light.branch[0]);
    expect(r.nodeColors(s, "b")!.fill).toBe(THEMES.light.branch[1]);
    expect(r.nodeColors(s, "a1")!.fill).toBe(THEMES.light.branchSoft[0]);
    expect(r.nodeColors(s, "b1")!.fill).toBe(THEMES.light.branchSoft[1]);
    expect(r.nodeColors(s, "a1x")!.fill).toBe(THEMES.light.deepFill);
    expect(r.nodeColors(s, "b1x")!.fill).toBe(THEMES.light.deepFill);
  });

  it("an explicit style.fill wins over the depth default at every depth", () => {
    const sheet = makeSheet();
    sheet.nodes.a.style.fill = "#123456"; // main
    sheet.nodes.a1.style.fill = "#234567"; // depth 2
    sheet.nodes.a1x.style.fill = "#345678"; // depth 3
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "a")!.fill).toBe("#123456");
    expect(r.nodeColors(s, "a1")!.fill).toBe("#234567");
    expect(r.nodeColors(s, "a1x")!.fill).toBe("#345678");
  });

  it("a walk that never reaches the root (missing parent, cycle) reads as depth 3+", () => {
    const sheet = makeSheet();
    sheet.nodes.a1x.parentId = "nowhere"; // parent does not exist
    sheet.nodes.orphan = makeNode("orphan", "subtopic", null); // floating: no parent
    sheet.nodes.cycle = makeNode("cycle", "subtopic", "cycle"); // self-parent
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "a1x")!.fill).toBe(THEMES.light.deepFill);
    expect(r.nodeColors(s, "orphan")!.fill).toBe(THEMES.light.deepFill);
    expect(r.nodeColors(s, "cycle")!.fill).toBe(THEMES.light.deepFill);
  });
});

describe("one hue per branch", () => {
  it("nodes in the same branch share one branchIndex across depths", () => {
    const sheet = makeSheet();
    const r = makeRenderer();
    const inner = r as unknown as { branchIndex: (n: MindNode, sheet: Sheet) => number };
    expect(inner.branchIndex(sheet.nodes.a, sheet)).toBe(0);
    expect(inner.branchIndex(sheet.nodes.a1, sheet)).toBe(0);
    expect(inner.branchIndex(sheet.nodes.a1x, sheet)).toBe(0);
    expect(inner.branchIndex(sheet.nodes.b, sheet)).toBe(1);
    expect(inner.branchIndex(sheet.nodes.b1, sheet)).toBe(1);
    expect(inner.branchIndex(sheet.nodes.b1x, sheet)).toBe(1);
    // The fills line up with the same index: vivid vs soft, same hue.
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "a")!.fill).toBe(THEMES.light.branch[0]);
    expect(r.nodeColors(s, "a1")!.fill).toBe(THEMES.light.branchSoft[0]);
    expect(r.nodeColors(s, "b")!.fill).toBe(THEMES.light.branch[1]);
    expect(r.nodeColors(s, "b1")!.fill).toBe(THEMES.light.branchSoft[1]);
  });
});

describe("inheritance by fixed ladder: denso → schiarito → white", () => {
  it("a coloured root is worn by the main topics (denso), lightened for their children, white from the grandchildren down", () => {
    const sheet = makeSheet();
    sheet.nodes.root.style.fill = "#ff8800";
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "root")!.fill).toBe("#ff8800"); // own choice
    expect(r.nodeColors(s, "a")!.fill).toBe("#ff8800"); // main: denso, same hue
    expect(r.nodeColors(s, "b")!.fill).toBe("#ff8800"); // sibling branches share it
    expect(r.nodeColors(s, "a1")!.fill).toBe(lighten("#ff8800", 0.3)); // figli: schiarito
    expect(r.nodeColors(s, "b1")!.fill).toBe(lighten("#ff8800", 0.3));
    expect(r.nodeColors(s, "a1x")!.fill).toBe(THEMES.light.deepFill); // nipoti: bianchi
    expect(r.nodeColors(s, "b1x")!.fill).toBe(THEMES.light.deepFill);
  });

  it("a coloured main topic tints its children one step; grandchildren go white; sibling branches keep the palette", () => {
    const sheet = makeSheet();
    sheet.nodes.a.style.fill = "#123456"; // main topic of branch a
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "a1")!.fill).toBe(lighten("#123456", 0.3));
    expect(r.nodeColors(s, "a1x")!.fill).toBe(THEMES.light.deepFill); // no tint of a distant ancestor
    // Branch b never touches the coloured node: the depth rule stays.
    expect(r.nodeColors(s, "b")!.fill).toBe(THEMES.light.branch[1]);
    expect(r.nodeColors(s, "b1")!.fill).toBe(THEMES.light.branchSoft[1]);
    expect(r.nodeColors(s, "b1x")!.fill).toBe(THEMES.light.deepFill);
  });

  it("an explicit fill still wins over inheritance", () => {
    const sheet = makeSheet();
    sheet.nodes.root.style.fill = "#ff8800";
    sheet.nodes.a.style.fill = "#009900"; // main topic painted by hand
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "a")!.fill).toBe("#009900");
    // Below the hand-painted main the children follow green, not orange.
    expect(r.nodeColors(s, "a1")!.fill).toBe(lighten("#009900", 0.3));
  });

  it("non-hex colours pass through instead of being mis-mixed", () => {
    const sheet = makeSheet();
    sheet.nodes.a.style.fill = "rebeccapurple"; // named colour
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(lighten("rebeccapurple", 0.3)).toBe("rebeccapurple");
    expect(r.nodeColors(s, "a1")!.fill).toBe("rebeccapurple");
  });

  it("a broken parent walk reads as depth 3+ and stays white", () => {
    const sheet = makeSheet();
    sheet.nodes.root.style.fill = "#ff8800";
    sheet.nodes.a1x.parentId = "nowhere";
    const r = makeRenderer();
    const s = stateOf(sheet);
    expect(r.nodeColors(s, "a1x")!.fill).toBe(THEMES.light.deepFill);
  });
});

describe("no more stamped fills — the renderer decides colours", () => {
  it("newly created topics carry no style.fill, so inheritance can apply", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.nodes[store.sheet.rootNodeId]!;
    store.select(root.id);
    store.createChild(); // main topic under the root
    const main = store.sheet.nodes[root.childrenIds[0]]!;
    expect(main.style.fill).toBeUndefined();
    store.select(main.id);
    store.createChild(); // subtopic under the main
    const sub = store.sheet.nodes[main.childrenIds[0]]!;
    expect(sub.style.fill).toBeUndefined();
  });

  it("legacy stamped fills (vivid main, soft child) are dropped on load", async () => {
    const doc = DocumentModel.blank("legacy");
    const sheet = doc.sheets[0];
    const root = sheet.nodes[sheet.rootNodeId]!;
    const main = DocumentModel.makeNode("main", root.id, "main");
    const sub = DocumentModel.makeNode("subtopic", main.id, "sub");
    sheet.nodes[main.id] = main;
    sheet.nodes[sub.id] = sub;
    root.childrenIds = [main.id];
    main.childrenIds = [sub.id];
    // The old normalizer wrote exactly these two stamps.
    main.style.fill = THEMES.light.branch[0];
    sub.style.fill = THEMES.light.branchSoft[0];
    const stored: StorageAdapter = {
      label: "legacy",
      async load() {
        return [doc];
      },
      async save() { /* no-op */ },
    };
    const store = new EditorStore(stored);
    await store.init();
    expect(store.sheet.nodes[main.id].style.fill).toBeUndefined();
    expect(store.sheet.nodes[sub.id].style.fill).toBeUndefined();
  });

  it("a colour the user actually picked is not mistaken for a stamp", async () => {
    const doc = DocumentModel.blank("legacy");
    const sheet = doc.sheets[0];
    const root = sheet.nodes[sheet.rootNodeId]!;
    const main = DocumentModel.makeNode("main", root.id, "main");
    const sub = DocumentModel.makeNode("subtopic", main.id, "sub");
    sheet.nodes[main.id] = main;
    sheet.nodes[sub.id] = sub;
    root.childrenIds = [main.id];
    main.childrenIds = [sub.id];
    main.style.fill = "#abcdef"; // user choice — never a palette default
    sub.style.fill = "#123456";
    const stored: StorageAdapter = {
      label: "legacy",
      async load() {
        return [doc];
      },
      async save() { /* no-op */ },
    };
    const store = new EditorStore(stored);
    await store.init();
    expect(store.sheet.nodes[main.id].style.fill).toBe("#abcdef");
    expect(store.sheet.nodes[sub.id].style.fill).toBe("#123456");
  });
});

describe("setBranchColor", () => {
  it("paints the whole subtree and ONE undo reverts all of it", () => {
    const store = new EditorStore(memoryAdapter);
    const sheet = store.sheet;
    const root = sheet.nodes[sheet.rootNodeId]!;
    const main = sheet.nodes[root.childrenIds[0]]!;
    const child = sheet.nodes[main.childrenIds[0]]!;
    // A grandchild so the subtree spans several depths.
    const grand = DocumentModel.makeNode("subtopic", child.id, "grand");
    sheet.nodes[grand.id] = grand;
    child.childrenIds.push(grand.id);

    // Distinct pre-existing fills make the revert observable.
    const original: Record<string, string | undefined> = {
      [main.id]: "#111111",
      [child.id]: "#222222",
      [grand.id]: undefined,
    };
    for (const [id, fill] of Object.entries(original)) {
      const n = sheet.nodes[id];
      if (fill === undefined) delete n.style.fill;
      else n.style.fill = fill;
    }

    store.setBranchColor(main.id, "#abcdef");

    for (const id of [main.id, child.id, grand.id]) {
      expect(sheet.nodes[id].style.fill).toBe("#abcdef");
    }
    // Nodes outside the subtree are untouched.
    const otherMain = sheet.nodes[root.childrenIds[1]]!;
    expect(otherMain.style.fill).not.toBe("#abcdef");
    expect(otherMain.childrenIds.some((cid) => sheet.nodes[cid].style.fill === "#abcdef")).toBe(false);

    // ONE undo reverts the whole subtree, not a topic at a time.
    store.undo();
    expect(sheet.nodes[main.id].style.fill).toBe("#111111");
    expect(sheet.nodes[child.id].style.fill).toBe("#222222");
    expect(sheet.nodes[grand.id].style.fill).toBeUndefined();
  });

  it("no-ops on an unknown id", () => {
    const store = new EditorStore(memoryAdapter);
    const before = JSON.stringify(store.sheet);
    store.setBranchColor("does-not-exist", "#abcdef");
    expect(JSON.stringify(store.sheet)).toBe(before);
    // Nothing was pushed to history: undo has nothing to pop.
    expect(store.undo()).toBeUndefined();
  });
});
