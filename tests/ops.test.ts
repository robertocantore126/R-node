import { describe, expect, it } from "vitest";
import { DocumentModel, uid } from "../src/core/doc";
import { applyOp, applyWithInverse, makeOp, type Op } from "../src/core/ops";
import { History } from "../src/core/history";
import type { Group, MindNode, Relationship, RnodeDocument, Summary } from "../src/core/types";

function freshDoc(): { doc: RnodeDocument; model: DocumentModel; root: MindNode } {
  const model = new DocumentModel(DocumentModel.blank("Test"));
  return { doc: model.doc, model, root: model.rootNode };
}

function child(model: DocumentModel, parentId: string, title: string): string {
  const id = uid("n");
  const parent = model.node(parentId)!;
  applyOp(model.sheet, makeOp<Op & { type: "createNode" }>("createNode", { id, nodeType: "subtopic", parentId, index: parent.childrenIds.length, title }));
  return id;
}

function exec(model: DocumentModel, history: History, ops: Op[]): void {
  const inverses: Op[][] = [];
  for (const op of ops) inverses.push(applyWithInverse(model.sheet, op));
  history.push(ops, inverses);
}

function undo(model: DocumentModel, history: History): void {
  const ops = history.undo();
  if (ops) for (const op of ops) applyWithInverse(model.sheet, op);
}

function redo(model: DocumentModel, history: History): void {
  const ops = history.redo();
  if (ops) for (const op of ops) applyWithInverse(model.sheet, op);
}

describe("relationship / group / summary ops", () => {
  it("setRelationship applies, undoes and redoes", () => {
    const { model, root } = freshDoc();
    const history = new History();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    const rel: Relationship = { id: "rel1", fromId: a, toId: b, label: "links" };
    exec(model, history, [makeOp<Op & { type: "createRelationship" }>("createRelationship", { relationship: rel })]);
    const patch: Relationship = { id: "rel1", fromId: a, toId: b, label: "renamed", bidirectional: true };
    exec(model, history, [makeOp<Op & { type: "setRelationship" }>("setRelationship", { id: "rel1", relationship: patch, prev: rel })]);
    expect(model.sheet.relationships[0].label).toBe("renamed");
    expect(model.sheet.relationships[0].bidirectional).toBe(true);
    undo(model, history);
    expect(model.sheet.relationships[0].label).toBe("links");
    expect(model.sheet.relationships[0].bidirectional).toBeUndefined();
    redo(model, history);
    expect(model.sheet.relationships[0].label).toBe("renamed");
  });

  it("createGroup/deleteGroup/setGroup round-trip through undo", () => {
    const { model, root } = freshDoc();
    const history = new History();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    const g: Group = { id: "g1", memberIds: [a, b], label: "group" };
    exec(model, history, [makeOp<Op & { type: "createGroup" }>("createGroup", { group: g })]);
    expect(model.sheet.boundaries).toHaveLength(1);
    expect(model.sheet.boundaries[0].memberIds).toEqual([a, b]);
    exec(model, history, [makeOp<Op & { type: "setGroup" }>("setGroup", { id: "g1", group: { ...g, label: "x" }, prev: g })]);
    expect(model.sheet.boundaries[0].label).toBe("x");
    undo(model, history);
    expect(model.sheet.boundaries[0].label).toBe("group");
    undo(model, history);
    expect(model.sheet.boundaries).toHaveLength(0);
    redo(model, history);
    redo(model, history);
    expect(model.sheet.boundaries).toHaveLength(1);
  });

  it("createSummary/deleteSummary round-trip through undo", () => {
    const { model, root } = freshDoc();
    const history = new History();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    const sum: Summary = { id: "s1", memberIds: [a, b], label: "Summary" };
    exec(model, history, [makeOp<Op & { type: "createSummary" }>("createSummary", { summary: sum })]);
    expect(model.sheet.summaries).toHaveLength(1);
    exec(model, history, [makeOp<Op & { type: "deleteSummary" }>("deleteSummary", { id: "s1", summary: sum })]);
    expect(model.sheet.summaries).toHaveLength(0);
    undo(model, history);
    expect(model.sheet.summaries).toHaveLength(1);
  });

  it("setAttachments removes orphan cards and restores them exactly on undo", () => {
    const { model } = freshDoc();
    const history = new History();
    const card = { id: "c1", mime: "image/png", w: 10, h: 10, bytes: 3, name: "x.png" };
    const before = [{ ...card }];
    exec(model, history, [makeOp<Op & { type: "setAttachments" }>("setAttachments", { attachments: [], prev: before })]);
    expect(model.sheet.attachments).toHaveLength(0);
    undo(model, history);
    expect(model.sheet.attachments).toEqual(before);
    redo(model, history);
    expect(model.sheet.attachments).toHaveLength(0);
  });
});

describe("create + delete", () => {
  it("creates a child and links it to the parent", () => {
    const { model, root } = freshDoc();
    const id = child(model, root.id, "Hello");
    const node = model.node(id)!;
    expect(node.parentId).toBe(root.id);
    expect(root.childrenIds).toContain(id);
    expect(node.title).toBe("Hello");
  });

  it("undo restores the exact previous tree", () => {
    const { model, root } = freshDoc();
    const history = new History();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    exec(model, history, [makeOp<Op & { type: "deleteNode" }>("deleteNode", { id: a, parentId: root.id, index: root.childrenIds.indexOf(a), subtree: [model.node(a)!], removedRelationships: [] })]);
    expect(root.childrenIds).toEqual([b]);
    const undo = history.undo()!;
    for (const op of undo) applyWithInverse(model.sheet, op);
    expect(root.childrenIds).toEqual([a, b]);
    expect(model.node(a)!.title).toBe("A");
    // redo
    const redo = history.redo()!;
    for (const op of redo) applyWithInverse(model.sheet, op);
    expect(root.childrenIds).toEqual([b]);
  });

  it("deleting a branch removes descendants and restores them on undo", () => {
    const { model, root } = freshDoc();
    const main = child(model, root.id, "Main");
    const sub1 = child(model, main, "Sub1");
    const sub2 = child(model, main, "Sub2");
    const history = new History();
    const subtree = model.subtreeIds(main).map((id) => model.node(id)!);
    exec(model, history, [makeOp<Op & { type: "deleteNode" }>("deleteNode", { id: main, parentId: root.id, index: 0, subtree, removedRelationships: [] })]);
    expect(model.node(main)).toBeUndefined();
    expect(model.node(sub1)).toBeUndefined();
    expect(model.node(sub2)).toBeUndefined();
    expect(root.childrenIds).toHaveLength(0);
    for (const op of history.undo()!) applyWithInverse(model.sheet, op);
    expect(model.node(main)!.childrenIds).toEqual([sub1, sub2]);
    expect(model.node(sub1)!.parentId).toBe(main);
    expect(root.childrenIds).toEqual([main]);
  });

  it("protects nothing structurally: central topic can still host edits", () => {
    const { model, root } = freshDoc();
    const id = child(model, root.id, "X");
    expect(model.depth(id)).toBe(1);
  });
});

describe("moveNode", () => {
  it("reparents a node and undoes cleanly", () => {
    const { model, root } = freshDoc();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    const history = new History();
    exec(model, history, [makeOp<Op & { type: "moveNode" }>("moveNode", { id: a, fromParentId: root.id, fromIndex: 0, toParentId: b, toIndex: 0 })]);
    expect(model.node(a)!.parentId).toBe(b);
    expect(root.childrenIds).toEqual([b]);
    expect(model.node(b)!.childrenIds).toEqual([a]);
    for (const op of history.undo()!) applyWithInverse(model.sheet, op);
    expect(model.node(a)!.parentId).toBe(root.id);
    expect(root.childrenIds).toEqual([a, b]);
  });

  it("reorders siblings with final-index semantics", () => {
    const { model, root } = freshDoc();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    const c = child(model, root.id, "C");
    // move C before B: desired final index 1 (after removing C from [A,B,C])
    applyOp(model.sheet, makeOp<Op & { type: "moveNode" }>("moveNode", { id: c, fromParentId: root.id, fromIndex: 2, toParentId: root.id, toIndex: 1 }));
    expect(root.childrenIds).toEqual([a, c, b]);
  });

  it("promote = move under grandparent after parent", () => {
    const { model, root } = freshDoc();
    const main = child(model, root.id, "Main");
    const sub = child(model, main, "Sub");
    const idx = model.node(main)!.childrenIds.indexOf(sub);
    const grandIdx = root.childrenIds.indexOf(main);
    applyOp(model.sheet, makeOp<Op & { type: "moveNode" }>("moveNode", { id: sub, fromParentId: main, fromIndex: idx, toParentId: root.id, toIndex: grandIdx + 1 }));
    expect(model.node(sub)!.parentId).toBe(root.id);
    expect(root.childrenIds).toEqual([main, sub]);
  });

  it("moves a floating topic into the tree and undoes back to floating", () => {
    const { model, root } = freshDoc();
    const floating = uid("n");
    applyOp(model.sheet, makeOp<Op & { type: "createNode" }>("createNode", {
      id: floating,
      nodeType: "floating",
      parentId: null,
      index: 0,
      title: "Free",
      position: { x: 100, y: 200, manual: true },
    }));
    const history = new History();
    exec(model, history, [makeOp<Op & { type: "moveNode" }>("moveNode", {
      id: floating,
      fromParentId: null,
      fromIndex: 0,
      toParentId: root.id,
      toIndex: 0,
    })]);

    expect(model.node(floating)!.parentId).toBe(root.id);
    for (const op of history.undo()!) applyWithInverse(model.sheet, op);
    expect(model.node(floating)!.parentId).toBeNull();
  });
});

describe("history batching", () => {
  it("a two-op batch undoes as a single step", () => {
    const { model, root } = freshDoc();
    const history = new History();
    const wrapId = uid("n");
    const kidId = uid("n");
    exec(model, history, [
      makeOp<Op & { type: "createNode" }>("createNode", { id: wrapId, nodeType: "main", parentId: root.id, index: 0, title: "Wrap" }),
      makeOp<Op & { type: "createNode" }>("createNode", { id: kidId, nodeType: "subtopic", parentId: wrapId, index: 0, title: "Kid" }),
    ]);
    expect(history.canUndo).toBe(true);
    expect(model.node(wrapId)!.childrenIds).toHaveLength(1);
    const undo = history.undo()!;
    for (const op of undo) applyWithInverse(model.sheet, op);
    expect(model.node(wrapId)).toBeUndefined();
    expect(model.node(kidId)).toBeUndefined();
    expect(history.canRedo).toBe(true);
    const redo = history.redo()!;
    for (const op of redo) applyWithInverse(model.sheet, op);
    expect(model.node(wrapId)).toBeDefined();
    expect(root.childrenIds).toContain(wrapId);
  });

  it("preserves child order when duplicating a subtree", () => {
    const { model, root } = freshDoc();
    const parent = child(model, root.id, "Parent");
    child(model, parent, "First");
    child(model, parent, "Second");
    child(model, parent, "Third");
    const source = model.subtreeIds(parent).map((id) => model.node(id)!).filter(Boolean);
    const store = {
      remapOps(source: MindNode[], parentId: string, index: number, rootType: string) {
        const idMap = new Map<string, string>();
        const ops: Op[] = [];
        const srcRoot = source.find((n) => !source.some((o) => o.childrenIds.includes(n.id)));
        if (!srcRoot) return ops;
        const newRoot = uid("n");
        idMap.set(srcRoot.id, newRoot);
        ops.push(
          makeOp<Op & { type: "createNode" }>("createNode", {
            id: newRoot,
            nodeType: rootType as any,
            parentId,
            index,
            title: srcRoot.title,
            style: srcRoot.style,
            task: srcRoot.task,
          })
        );
        const queue: MindNode[] = [srcRoot];
        while (queue.length > 0) {
          const src = queue.shift()!;
          for (const cid of src.childrenIds) {
            const c = source.find((node) => node.id === cid);
            if (!c) continue;
            const newId = uid("n");
            idMap.set(cid, newId);
            ops.push(
              makeOp<Op & { type: "createNode" }>("createNode", {
                id: newId,
                nodeType: "subtopic",
                parentId: idMap.get(src.id)!,
                index: src.childrenIds.indexOf(cid),
                title: c.title,
                style: c.style,
                task: c.task,
              })
            );
            queue.push(c);
          }
        }
        return ops;
      },
    };
    const ops = store.remapOps(source, root.id, root.childrenIds.length, "main");
    for (const op of ops) applyOp(model.sheet, op);
    const duplicated = root.childrenIds[root.childrenIds.length - 1];
    const newParent = model.node(duplicated)!;
    expect(newParent.childrenIds).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expect(model.node(newParent.childrenIds[0])!.title).toBe("First");
    expect(model.node(newParent.childrenIds[1])!.title).toBe("Second");
    expect(model.node(newParent.childrenIds[2])!.title).toBe("Third");
  });
});

describe("relationships", () => {
  it("create/delete relationship round-trips", () => {
    const { model, root } = freshDoc();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    const rel = { id: uid("rel"), fromId: a, toId: b };
    const history = new History();
    exec(model, history, [makeOp<Op & { type: "createRelationship" }>("createRelationship", { relationship: rel })]);
    expect(model.sheet.relationships).toHaveLength(1);
    for (const op of history.undo()!) applyWithInverse(model.sheet, op);
    expect(model.sheet.relationships).toHaveLength(0);
    for (const op of history.redo()!) applyWithInverse(model.sheet, op);
    expect(model.sheet.relationships).toHaveLength(1);
  });

  it("deleting a topic removes relationships touching it", () => {
    const { model, root } = freshDoc();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    model.sheet.relationships.push({ id: uid("rel"), fromId: a, toId: b });
    const history = new History();
    const removed = model.sheet.relationships.filter((r) => r.fromId === a || r.toId === a);
    exec(model, history, [makeOp<Op & { type: "deleteNode" }>("deleteNode", { id: a, parentId: root.id, index: 0, subtree: [model.node(a)!], removedRelationships: removed })]);
    expect(model.sheet.relationships).toHaveLength(0);
    for (const op of history.undo()!) applyWithInverse(model.sheet, op);
    expect(model.sheet.relationships).toHaveLength(1);
  });
});

describe("styles & tasks", () => {
  it("setNodeImage applies, undoes and redoes — carrying only the id", () => {
    const { model, root } = freshDoc();
    const history = new History();
    expect(root.style.image).toBeUndefined();

    // attach
    exec(model, history, [makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId: root.id, imageId: "sha-abc", prevImageId: null })]);
    expect(model.node(root.id)!.style.image).toBe("sha-abc");
    expect(JSON.stringify(model.node(root.id)!.style)).toContain("sha-abc"); // only the id, never bytes

    undo(model, history);
    expect(model.node(root.id)!.style.image).toBeUndefined();

    redo(model, history);
    expect(model.node(root.id)!.style.image).toBe("sha-abc");

    // replace + remove round-trip
    exec(model, history, [makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId: root.id, imageId: "sha-other", prevImageId: "sha-abc" })]);
    expect(model.node(root.id)!.style.image).toBe("sha-other");
    undo(model, history);
    expect(model.node(root.id)!.style.image).toBe("sha-abc");
    exec(model, history, [makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId: root.id, imageId: null, prevImageId: "sha-abc" })]);
    expect(model.node(root.id)!.style.image).toBeUndefined();
    undo(model, history);
    expect(model.node(root.id)!.style.image).toBe("sha-abc");
  });

  it("setStyle undo restores previous style", () => {
    const { model, root } = freshDoc();
    const history = new History();
    const originalFill = root.style.fill;
    exec(model, history, [makeOp<Op & { type: "setStyle" }>("setStyle", { id: root.id, style: { fill: "#ff0000" }, prev: root.style })]);
    expect(model.rootNode.style.fill).toBe("#ff0000");
    for (const op of history.undo()!) applyWithInverse(model.sheet, op);
    expect(model.rootNode.style.fill).toBe(originalFill);
  });

  it("task progress roll-up is derivable from descendants", () => {
    const { model, root } = freshDoc();
    const a = child(model, root.id, "A");
    const b = child(model, root.id, "B");
    model.node(a)!.task = { status: "completed", priority: "high", progress: 100 };
    model.node(b)!.task = { status: "in-progress", priority: "medium", progress: 50 };
    const kids = [a, b].map((id) => model.node(id)!).filter((n) => n.task);
    const avg = Math.round(kids.reduce((s, n) => s + (n.task?.progress ?? 0), 0) / kids.length);
    expect(avg).toBe(75);
  });
});

describe("schema", () => {
  it("round-trips through JSON without losing structure", () => {
    const model = new DocumentModel(DocumentModel.sample());
    const json = JSON.stringify(model.doc);
    const restored = new DocumentModel(JSON.parse(json) as RnodeDocument);
    expect(restored.doc.sheets[0].rootNodeId).toBe(model.doc.sheets[0].rootNodeId);
    expect(Object.keys(restored.doc.sheets[0].nodes).length).toBe(Object.keys(model.doc.sheets[0].nodes).length);
    expect(restored.doc.schemaVersion).toBe("0.1.0");
  });
});
