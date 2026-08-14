import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DocumentModel, uid } from "../src/core/doc";
import { applyOp, makeOp, type Op } from "../src/core/ops";
import { InvariantViolation, validateSheet } from "../src/core/validate";
import { EditorStore } from "../src/editor/store";
import type { Sheet } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() { return []; },
  async save() { /* no-op */ },
};

function addChild(sheet: Sheet, parentId: string, title: string): string {
  const id = uid("n");
  const parent = sheet.nodes[parentId];
  applyOp(sheet, makeOp<Op & { type: "createNode" }>("createNode", { id, nodeType: "subtopic", parentId, index: parent.childrenIds.length, title }));
  return id;
}

/** root → a → b, built through the op system so the fixture itself is valid. */
function tree(): { sheet: Sheet; rootId: string; a: string; b: string } {
  const model = new DocumentModel(DocumentModel.blank("T"));
  const sheet = model.sheet;
  const rootId = sheet.rootNodeId;
  const a = addChild(sheet, rootId, "A");
  const b = addChild(sheet, a, "B");
  return { sheet, rootId, a, b };
}

describe("validateSheet — the sheet a valid document produces", () => {
  it("accepts a tree built through the op system", () => {
    const { sheet } = tree();
    expect(() => validateSheet(sheet)).not.toThrow();
  });

  it("accepts a floating topic AND its children, which no walk from the root reaches", () => {
    // Floating topics are unparented by design. If the reachability check
    // started only at rootNodeId, a child dropped onto a floating topic would
    // be reported as corruption in a perfectly legal document.
    const { sheet } = tree();
    const f = uid("n");
    applyOp(sheet, makeOp<Op & { type: "createNode" }>("createNode", { id: f, nodeType: "floating", parentId: null, index: 0, title: "F", position: { x: 10, y: 20, manual: true } }));
    addChild(sheet, f, "under the floating one");
    expect(() => validateSheet(sheet)).not.toThrow();
  });
});

describe("validateSheet — root", () => {
  it("rejects a rootNodeId that resolves to nothing", () => {
    const { sheet } = tree();
    sheet.rootNodeId = "ghost";
    expect(() => validateSheet(sheet)).toThrow(InvariantViolation);
    expect(() => validateSheet(sheet)).toThrow("root 'ghost' is not in sheet.nodes");
  });

  it("rejects a root that has a parent", () => {
    const { sheet, rootId, a } = tree();
    sheet.nodes[rootId].parentId = a;
    expect(() => validateSheet(sheet)).toThrow("expected null");
  });
});

describe("validateSheet — resolvable references", () => {
  it("rejects a childrenIds entry that resolves to nothing", () => {
    const { sheet, a } = tree();
    sheet.nodes[a].childrenIds.push("ghost");
    expect(() => validateSheet(sheet)).toThrow("lists child 'ghost' which is not in sheet.nodes");
  });

  it("rejects a parentId that resolves to nothing", () => {
    const { sheet, a, b } = tree();
    sheet.nodes[a].childrenIds = [];
    sheet.nodes[b].parentId = "ghost";
    expect(() => validateSheet(sheet)).toThrow("has parentId 'ghost' which is not in sheet.nodes");
  });

  it("rejects a relationship endpoint that resolves to nothing", () => {
    const { sheet, a } = tree();
    sheet.relationships.push({ id: "r1", fromId: a, toId: "ghost" });
    expect(() => validateSheet(sheet)).toThrow("relationship 'r1' has toId 'ghost'");
  });
});

describe("validateSheet — parent/children coherence", () => {
  it("rejects a child whose parentId points at a different node, naming all three ids", () => {
    const { sheet, rootId, a, b } = tree();
    sheet.nodes[b].parentId = rootId; // still listed by a
    // The message has to carry the ids: this is the error that shows up hours
    // after the op that caused it, with no other context available.
    expect(() => validateSheet(sheet)).toThrow(`node '${b}' appears in childrenIds of '${a}' but its parentId is '${rootId}'`);
  });

  it("rejects a node its own parent does not list", () => {
    const { sheet, a } = tree();
    sheet.nodes[a].childrenIds = []; // b still claims a as its parent
    expect(() => validateSheet(sheet)).toThrow("appears 0 times in its childrenIds, expected exactly once");
  });

  it("rejects a child listed twice by the same parent", () => {
    const { sheet, a, b } = tree();
    sheet.nodes[a].childrenIds.push(b);
    expect(() => validateSheet(sheet)).toThrow("appears 2 times in its childrenIds, expected exactly once");
  });
});

describe("validateSheet — cycles and orphans", () => {
  it("rejects a node that hangs off nothing", () => {
    const { sheet, rootId, a } = tree();
    sheet.nodes[rootId].childrenIds = sheet.nodes[rootId].childrenIds.filter((id) => id !== a);
    sheet.nodes[a].parentId = null;
    expect(() => validateSheet(sheet)).toThrow(`node '${a}' is not reachable from root '${rootId}' and is not floating`);
  });

  it("names a cycle as a cycle instead of calling its nodes orphans", () => {
    // a and b point at each other. Note this is fully COHERENT — every
    // parentId matches a childrenIds entry — which is why the coherence pass
    // cannot catch it and a dedicated check has to.
    const { sheet, rootId, a, b } = tree();
    sheet.nodes[rootId].childrenIds = [];
    sheet.nodes[a].parentId = b;
    sheet.nodes[a].childrenIds = [b];
    sheet.nodes[b].parentId = a;
    sheet.nodes[b].childrenIds = [a];
    expect(() => validateSheet(sheet)).toThrow(InvariantViolation);
    expect(() => validateSheet(sheet)).toThrow("sits on a parent cycle that closes through");
  });
});

describe("EditorStore keeps the sheet valid", () => {
  function childOfRoot(store: EditorStore, exclude: Set<string>): string {
    const kids = store.doc.node(store.sheet.rootNodeId)!.childrenIds;
    return kids.find((id) => !exclude.has(id))!;
  }

  it("stays valid through create → move → delete → undo → redo", () => {
    const store = new EditorStore(memoryAdapter);
    const rootId = store.sheet.rootNodeId;

    const before = new Set(store.doc.node(rootId)!.childrenIds);
    store.select(rootId);
    store.createChild();
    const a = childOfRoot(store, before);

    const beforeB = new Set(store.doc.node(rootId)!.childrenIds);
    store.select(rootId);
    store.createChild();
    const b = childOfRoot(store, beforeB);

    // Move: b becomes a child of a.
    store.dropAt(b, a, "child", 240, 130);
    expect(store.doc.node(b)!.parentId).toBe(a);
    validateSheet(store.sheet);

    store.deleteNodes([a]);
    expect(store.doc.node(a)).toBeUndefined();
    validateSheet(store.sheet);

    store.undo();
    expect(store.doc.node(a)).toBeDefined();
    validateSheet(store.sheet);

    store.redo();
    validateSheet(store.sheet);
  });

  it("fails on the next batch when something corrupts the tree behind the op system", () => {
    // The whole point of T1: a bad parentId written outside the op system is
    // silent today. It has to become an immediate, named failure instead of a
    // crash somewhere else an hour later.
    const store = new EditorStore(memoryAdapter);
    const rootId = store.sheet.rootNodeId;
    const before = new Set(store.doc.node(rootId)!.childrenIds);
    store.select(rootId);
    store.createChild();
    const a = childOfRoot(store, before);

    store.sheet.nodes[a].parentId = "ghost";

    store.select(rootId);
    expect(() => store.createChild()).toThrow(InvariantViolation);
  });
});
