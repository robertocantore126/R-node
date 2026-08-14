import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listShapes, prepareShape, removeShape, saveShape, ShapeRejected } from "../src/editor/shapeLibrary";
import { runsToPlain } from "../src/core/text";
import { validateSheet } from "../src/core/validate";
import { EditorStore } from "../src/editor/store";
import type { MindNode, Relationship, Style, TextRun } from "../src/core/types";

function node(id: string, over: Partial<MindNode> = {}): MindNode {
  return {
    id,
    type: "subtopic",
    parentId: null,
    childrenIds: [],
    title: id.toUpperCase(),
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ...over,
  };
}

/** root a → children b, c, with an edge b→c: the 3-cycle of the prompt. */
function triangle(over: { nodes?: Partial<Record<"a" | "b" | "c", Partial<MindNode>>>; rels?: Relationship[] } = {}) {
  const a = node("a", { childrenIds: ["b", "c"], ...over.nodes?.a });
  const b = node("b", { parentId: "a", ...over.nodes?.b });
  const c = node("c", { parentId: "a", ...over.nodes?.c });
  return {
    app: "r-node",
    payload: {
      rootId: "a",
      nodes: [a, b, c],
      relationships: over.rels ?? [{ id: "r1", fromId: "b", toId: "c" }],
    },
  };
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
});
afterEach(() => store.clear());

describe("prepareShape — what a template may carry", () => {
  it("accepts the shape of payload copySelection writes", () => {
    const out = prepareShape(triangle());
    expect(out.nodes).toHaveLength(3);
    expect(out.relationships).toHaveLength(1);
  });

  it("strips fill, stroke and textColor, keeping the form", () => {
    // A stored colour eventually lands on a theme where it cannot be read.
    const style: Style = { fill: "#ff0000", stroke: "#00ff00", textColor: "#0000ff", shape: "hexagon", fontSize: 22, width: 200 };
    const out = prepareShape(triangle({ nodes: { b: { style } } }));
    const b = out.nodes.find((n) => n.id === "b")!;
    expect(b.style.fill).toBeUndefined();
    expect(b.style.stroke).toBeUndefined();
    expect(b.style.textColor).toBeUndefined();
    expect(b.style.shape).toBe("hexagon");
    expect(b.style.fontSize).toBe(22);
    expect(b.style.width).toBe(200);
  });

  it("strips the colour of every RUN, not only of the node", () => {
    // The easy one to miss: emphasis colour lives on the run. Leaving it would
    // defeat the whole rule while the node's own style looked clean.
    const titleRuns: TextRun[] = [{ text: "rosso ", color: "#ff0000" }, { text: "e nero", bold: true }];
    const out = prepareShape(triangle({ nodes: { b: { title: "rosso e nero", titleRuns } } }));
    const b = out.nodes.find((n) => n.id === "b")!;
    expect(b.titleRuns!.every((r) => r.color === undefined)).toBe(true);
    expect(b.titleRuns![1].bold).toBe(true); // emphasis survives, only colour goes
  });

  it("leaves the text itself untouched, so I5 still holds", () => {
    const titleRuns: TextRun[] = [{ text: "abc", color: "#123456" }, { text: "def" }];
    const out = prepareShape(triangle({ nodes: { b: { title: "abcdef", titleRuns } } }));
    const b = out.nodes.find((n) => n.id === "b")!;
    expect(runsToPlain(b.titleRuns!)).toBe(b.title);
  });

  it("forces the geometry rigid on every node", () => {
    const out = prepareShape(triangle());
    expect(out.nodes.every((n) => n.position.manual === true)).toBe(true);
  });

  it("keeps the titles — the reason for saving a shape at all", () => {
    const out = prepareShape(triangle({ nodes: { b: { title: "Chokhmah" } } }));
    expect(out.nodes.find((n) => n.id === "b")!.title).toBe("Chokhmah");
  });

  it("drops a map's state: task, labels, markers, collapsed", () => {
    const out = prepareShape(
      triangle({ nodes: { b: { task: { status: "in-progress", priority: "high", progress: 40 }, labels: ["x"], markers: ["m"], collapsed: true, notes: "tenuto" } } }),
    );
    const b = out.nodes.find((n) => n.id === "b")!;
    expect(b.task).toBeNull();
    expect(b.labels).toEqual([]);
    expect(b.markers).toEqual([]);
    expect(b.collapsed).toBe(false);
    expect(b.notes).toBe("tenuto"); // notes is content, it stays
  });

  it("makes every relationship a straight segment and drops its colour", () => {
    const out = prepareShape(triangle({ rels: [{ id: "r1", fromId: "b", toId: "c", color: "#abcdef" }] }));
    expect(out.relationships[0].connector).toBe("straight");
    expect(out.relationships[0].color).toBeUndefined();
  });

  it("detaches the root, which still points at its parent in the map it came from", () => {
    const out = prepareShape(triangle({ nodes: { a: { parentId: "somewhere-else" } } }));
    expect(out.nodes.find((n) => n.id === "a")!.parentId).toBeNull();
  });

  it("drops a custom silhouette: a structure uses base shapes only", () => {
    const out = prepareShape(triangle({ nodes: { b: { style: { shape: "moon" as never } } } }));
    expect(out.nodes.find((n) => n.id === "b")!.style.shape).toBeUndefined();
  });
});

describe("prepareShape — refusals", () => {
  const rejects = (input: unknown, needle: string): void => {
    expect(() => prepareShape(input as object)).toThrow(ShapeRejected);
    expect(() => prepareShape(input as object)).toThrow(needle);
  };

  it("refuses an image, naming the topic", () => {
    // The bytes live in a per-document AssetStore keyed by SHA-256: the
    // template would carry the reference without them and draw a hole.
    rejects(triangle({ nodes: { b: { title: "Foto", style: { imageLeft: "sha-1" } } } }), "Foto");
  });

  it("refuses a parentId that resolves to nothing", () => {
    rejects(triangle({ nodes: { b: { parentId: "ghost" } } }), "inconsistent");
  });

  it("refuses a node unreachable from the root", () => {
    rejects(triangle({ nodes: { a: { childrenIds: ["b"] }, c: { parentId: null } } }), "inconsistent");
  });

  it("refuses text that is not JSON, an alien payload, and an empty one", () => {
    rejects("{not json", "valid JSON");
    rejects({ app: "drawio", payload: {} }, "R-node payload");
    rejects({ app: "r-node", payload: { rootId: "a", nodes: [] } }, "non-empty");
  });

  it("refuses a root that is not among the topics", () => {
    rejects({ app: "r-node", payload: { rootId: "zzz", nodes: [node("a")], relationships: [] } }, "not among the topics");
  });

  it("refuses a template larger than the cap", () => {
    const many = Array.from({ length: 201 }, (_, i) => node(`n${i}`));
    rejects({ app: "r-node", payload: { rootId: "n0", nodes: many, relationships: [] } }, "Too large");
  });

  it("drops an edge whose endpoint is not in the payload instead of storing it", () => {
    const out = prepareShape(triangle({ rels: [{ id: "r1", fromId: "b", toId: "elsewhere" }] }));
    expect(out.relationships).toHaveLength(0);
  });
});

describe("insertShape", () => {
  const adapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };

  function freshStore(): EditorStore {
    return new EditorStore(adapter as never);
  }

  it("inserts every topic and edge in ONE history entry", () => {
    // One gesture, one undo. Several batches would need N presses of Ctrl+Z to
    // undo a single drop, which is never what anyone means.
    const store = freshStore();
    const root = store.sheet.rootNodeId;
    const before = Object.keys(store.sheet.nodes).length;
    const t = saveShape("Triangolo", triangle());

    store.insertShape(t, root);
    expect(Object.keys(store.sheet.nodes).length).toBe(before + 3);
    expect(store.sheet.relationships).toHaveLength(1);

    store.undo();
    expect(Object.keys(store.sheet.nodes).length).toBe(before);
    expect(store.sheet.relationships).toHaveLength(0);
  });

  it("keeps the geometry, translated, and marked manual so the layout leaves it alone", () => {
    const store = freshStore();
    const t = saveShape("Triangolo", triangle({ nodes: { b: { position: { x: -160, y: 100, manual: false } }, c: { position: { x: 160, y: 100, manual: false } } } }));
    store.insertShape(t, store.sheet.rootNodeId);

    const inserted = Object.values(store.sheet.nodes).filter((n) => ["A", "B", "C"].includes(n.title));
    expect(inserted).toHaveLength(3);
    expect(inserted.every((n) => n.position.manual === true)).toBe(true);
    const a = inserted.find((n) => n.title === "A")!;
    const b = inserted.find((n) => n.title === "B")!;
    const c = inserted.find((n) => n.title === "C")!;
    // Relative shape preserved: B and C sit 320 apart and 100 below A.
    expect(c.position.x - b.position.x).toBeCloseTo(320, 5);
    expect(b.position.y - a.position.y).toBeCloseTo(100, 5);
  });

  it("recreates the edges as straight segments between the NEW ids", () => {
    const store = freshStore();
    const t = saveShape("Triangolo", triangle());
    store.insertShape(t, store.sheet.rootNodeId);

    const rel = store.sheet.relationships[0];
    expect(rel.connector).toBe("straight");
    expect(store.sheet.nodes[rel.fromId]).toBeDefined();
    expect(store.sheet.nodes[rel.toId]).toBeDefined();
    // Remapped, not reused: the template's own ids must not leak into the map.
    expect(rel.fromId).not.toBe("b");
    expect(rel.toId).not.toBe("c");
  });
});

describe("the library", () => {
  it("saves, lists and removes", () => {
    expect(listShapes()).toEqual([]);
    const t = saveShape("Ciclo a 3", triangle());
    expect(listShapes()).toHaveLength(1);
    expect(listShapes()[0].name).toBe("Ciclo a 3");
    removeShape(t.id);
    expect(listShapes()).toEqual([]);
  });

  it("refuses a nameless shape and stores nothing when the payload is bad", () => {
    expect(() => saveShape("  ", triangle())).toThrow(ShapeRejected);
    expect(() => saveShape("Rotta", { app: "r-node", payload: { rootId: "a", nodes: [] } })).toThrow(ShapeRejected);
    expect(listShapes()).toEqual([]);
  });

  it("gives two shapes of the same name distinct ids", () => {
    const a = saveShape("Ciclo", triangle());
    const b = saveShape("Ciclo", triangle());
    expect(a.id).not.toBe(b.id);
    expect(listShapes()).toHaveLength(2);
  });

  it("reads a corrupt store as an empty library rather than breaking the panel", () => {
    store.set("r-node.shape-library", "{{{ not json");
    expect(listShapes()).toEqual([]);
  });
});

describe("shape nodes (T24)", () => {
  const SHIELD = {
    kind: "shape",
    name: "Shield",
    width: 200,
    height: 220,
    parts: [
      { d: "M0.50,0.02 L0.95,0.18 L0.95,0.55 C0.95,0.80 0.75,0.94 0.50,0.98 C0.25,0.94 0.05,0.80 0.05,0.55 L0.05,0.18 Z", fill: "#8c2f39" },
      { d: "M0.50,0.14 L0.84,0.26 L0.84,0.54 C0.84,0.72 0.68,0.83 0.50,0.87 C0.32,0.83 0.16,0.72 0.16,0.54 L0.16,0.26 Z", fill: "#e8c37a" },
    ],
  };

  it("becomes a one-topic template with a FIXED size", () => {
    // Fixed size is the decision the whole feature rests on: with width and
    // height both set, measureTopicUncached short-circuits and the outline
    // never negotiates with a growing label.
    const out = prepareShape(SHIELD);
    expect(out.nodes).toHaveLength(1);
    const n = out.nodes[0];
    expect(n.style.width).toBe(200);
    expect(n.style.height).toBe(220);
    expect(n.style.shape).toBe("custom");
    expect(n.style.shapeParts).toHaveLength(2);
  });

  it("KEEPS the colours, unlike every other template", () => {
    // The reversal, and its reason: these colours contrast with each other
    // inside the drawing, not with anything the theme owns.
    const out = prepareShape(SHIELD);
    expect(out.nodes[0].style.shapeParts![0].fill).toBe("#8c2f39");
    expect(out.nodes[0].style.shapeParts![1].fill).toBe("#e8c37a");
  });

  it("refuses more than 12 parts, junk path data and an unknown paint", () => {
    const many = { ...SHIELD, parts: Array.from({ length: 13 }, () => SHIELD.parts[0]) };
    expect(() => prepareShape(many)).toThrow(/Too many parts/);
    expect(() => prepareShape({ ...SHIELD, parts: [{ d: "M0,0 L1,1 <script>" }] })).toThrow(/not SVG path data/);
    expect(() => prepareShape({ ...SHIELD, parts: [{ d: "M0,0 L1,1 Z", fill: "rebeccapurple" }] })).toThrow(/neither a #hex/);
    expect(() => prepareShape({ ...SHIELD, parts: [{ d: "M0,0 L1,NaN Z" }] })).toThrow(/not a number/);
  });

  it("accepts a theme token as a paint, so a shape can follow the palette", () => {
    const out = prepareShape({ ...SHIELD, parts: [{ ...SHIELD.parts[0], fill: "accent" }] });
    expect(out.nodes[0].style.shapeParts![0].fill).toBe("accent");
  });
});


describe("a structure keeps its shape when a topic is written into", () => {
  const adapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };

  it("freezes each topic's box at insert, so a long title cannot move its centre", () => {
    // `position` is a top-left corner: a topic that grows extends right and
    // down, its CENTRE leaves the ring, and the eye reads that as the pentagon
    // collapsing. Nothing moved it — the box changed shape around a fixed
    // corner. A frozen box cannot.
    const store = new EditorStore(adapter as never);
    const t = saveShape("Triangolo", triangle());
    store.insertShape(t, store.sheet.rootNodeId);

    const inserted = Object.values(store.sheet.nodes).filter((n) => ["A", "B", "C"].includes(n.title));
    expect(inserted).toHaveLength(3);
    expect(inserted.every((n) => (n.style.width ?? 0) > 0 && (n.style.height ?? 0) > 0)).toBe(true);

    const target = inserted.find((n) => n.title === "B")!;
    const before = { w: target.style.width!, h: target.style.height!, x: target.position.x, y: target.position.y };

    store.startEdit(target.id);
    store.setEditingDraft("una didascalia molto piu lunga di prima, abbastanza da allargare una scatola libera di crescere");
    store.commitEdit();

    const after = store.doc.node(target.id)!;
    expect(after.title.length).toBeGreaterThan(40); // the text really landed
    expect(after.style.width).toBe(before.w);
    expect(after.style.height).toBe(before.h);
    expect(after.position.x).toBe(before.x);
    expect(after.position.y).toBe(before.y);
  });

  it("leaves a topic that already carries an explicit size alone", () => {
    const store = new EditorStore(adapter as never);
    const t = saveShape("Fissa", triangle({ nodes: { b: { style: { width: 321, height: 123 } } } }));
    store.insertShape(t, store.sheet.rootNodeId);
    const b = Object.values(store.sheet.nodes).find((n) => n.title === "B")!;
    expect(b.style.width).toBe(321);
    expect(b.style.height).toBe(123);
  });
});

describe("deleting a special node cannot corrupt the map", () => {
  const adapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };
  const dangling = (store: EditorStore): string[] =>
    store.sheet.relationships
      .filter((r) => !store.sheet.nodes[r.fromId] || !store.sheet.nodes[r.toId])
      .map((r) => r.id);

  it("takes the edges with it instead of leaving them pointing at nothing", () => {
    // The one way a delete could corrupt a document: an edge left aimed at an
    // id that is gone. validateSheet already refuses that, and it runs after
    // every op outside production, so this would surface as a named throw at
    // the moment of the delete — never as a puzzle weeks later.
    const store = new EditorStore(adapter as never);
    const t = saveShape("Triangolo", triangle());
    store.insertShape(t, store.sheet.rootNodeId);
    expect(store.sheet.relationships).toHaveLength(1);

    const b = Object.values(store.sheet.nodes).find((n) => n.title === "B")!;
    store.deleteNodes([b.id]);

    expect(dangling(store)).toEqual([]);
    expect(() => validateSheet(store.sheet)).not.toThrow();
  });

  it("puts the whole structure back on one undo, edges included", () => {
    const store = new EditorStore(adapter as never);
    const t = saveShape("Triangolo", triangle());
    store.insertShape(t, store.sheet.rootNodeId);
    const a = Object.values(store.sheet.nodes).find((n) => n.title === "A")!;

    store.deleteNodes([a.id]); // the root of the shape: takes B and C with it
    expect(Object.values(store.sheet.nodes).filter((n) => ["A", "B", "C"].includes(n.title))).toHaveLength(0);
    expect(dangling(store)).toEqual([]);

    store.undo();
    expect(Object.values(store.sheet.nodes).filter((n) => ["A", "B", "C"].includes(n.title))).toHaveLength(3);
    expect(store.sheet.relationships).toHaveLength(1);
    expect(dangling(store)).toEqual([]);
    expect(() => validateSheet(store.sheet)).not.toThrow();
  });

  it("leaves nothing behind outside the document — no orphaned asset, ever", () => {
    // A code topic keeps its source in `title` and a shape keeps its artwork in
    // `style`. Neither reaches into the AssetStore, and a template carrying an
    // image is refused at the door, so a deleted special node can never leave
    // bytes stranded the way a deleted image node can.
    const store = new EditorStore(adapter as never);
    const shape = saveShape("Scudo", {
      kind: "shape", name: "Scudo", width: 200, height: 200,
      parts: [{ d: "M0.1,0.1 L0.9,0.1 L0.9,0.9 L0.1,0.9 Z", fill: "#8c2f39" }],
    });
    store.insertShape(shape, store.sheet.rootNodeId);
    const node = Object.values(store.sheet.nodes).find((n) => n.style.shape === "custom")!;
    expect(node.style.shapeParts).toHaveLength(1);
    expect(store.sheet.attachments).toHaveLength(0);

    store.deleteNodes([node.id]);
    expect(store.sheet.attachments).toHaveLength(0);
    expect(() => validateSheet(store.sheet)).not.toThrow();
  });

  it("survives the template being deleted from the library afterwards", () => {
    // Inserted shapes are stamps, not instances: nothing links a topic back to
    // the template it came from, so emptying the library cannot reach them.
    const store = new EditorStore(adapter as never);
    const t = saveShape("Triangolo", triangle());
    store.insertShape(t, store.sheet.rootNodeId);
    removeShape(t.id);
    expect(listShapes()).toEqual([]);
    expect(Object.values(store.sheet.nodes).filter((n) => ["A", "B", "C"].includes(n.title))).toHaveLength(3);
    expect(() => validateSheet(store.sheet)).not.toThrow();
  });
});
