/**
 * Operation system.
 *
 * Every meaningful edit is expressed as an Operation. Operations are:
 *  - self-contained (carry the data needed to apply AND to reverse);
 *  - idempotent / replayable (same starting state -> same result);
 *  - tagged with opId/actorId/timestamp so the same log can later feed the
 *    collaboration layer (CRDT/OT) unchanged.
 *
 * applyOp mutates the sheet in place. inverseOf returns the operation(s)
 * that exactly reverse it, which is what the History stack uses for undo.
 */
import type { MindNode, Position, Relationship, Sheet, StructureConfig, Style, TaskInfo } from "./types";
import { nowIso } from "./doc";

// ---------------------------------------------------------------------------
// Op definitions
// ---------------------------------------------------------------------------

export type Op =
  | { opId: string; actorId: string; ts: string; type: "createNode"; id: string; nodeType: MindNode["type"]; parentId: string | null; index: number; title: string; style?: Style; task?: TaskInfo | null; position?: { x: number; y: number; manual: boolean } }
  | { opId: string; actorId: string; ts: string; type: "restoreNode"; id: string; parentId: string | null; index: number; subtree: MindNode[]; removedRelationships: Relationship[] }
  | { opId: string; actorId: string; ts: string; type: "deleteNode"; id: string; parentId: string | null; index: number; subtree: MindNode[]; removedRelationships: Relationship[] }
  | { opId: string; actorId: string; ts: string; type: "setTitle"; id: string; title: string; prev: string }
  | { opId: string; actorId: string; ts: string; type: "setStyle"; id: string; style: Style; prev: Style }
  | { opId: string; actorId: string; ts: string; type: "setPosition"; id: string; x: number; y: number; manual: boolean; offsetX?: number; offsetY?: number; prev: Position }
  | { opId: string; actorId: string; ts: string; type: "setCollapsed"; id: string; collapsed: boolean; prev: boolean }
  | { opId: string; actorId: string; ts: string; type: "moveNode"; id: string; fromParentId: string | null; fromIndex: number; toParentId: string | null; toIndex: number }
  | { opId: string; actorId: string; ts: string; type: "sortSiblings"; parentId: string; order: string[]; prevOrder: string[] }
  | { opId: string; actorId: string; ts: string; type: "setTask"; id: string; task: TaskInfo | null; prev: TaskInfo | null }
  | { opId: string; actorId: string; ts: string; type: "setNotes"; id: string; notes: string; prev: string }
  | { opId: string; actorId: string; ts: string; type: "setSheetTitle"; title: string; prev: string }
  | { opId: string; actorId: string; ts: string; type: "setStructure"; config: StructureConfig; prev: StructureConfig }
  | { opId: string; actorId: string; ts: string; type: "createRelationship"; relationship: Relationship }
  | { opId: string; actorId: string; ts: string; type: "deleteRelationship"; id: string; relationship: Relationship };

export interface OpMeta {
  actorId?: string;
}

let seqCounter = 0;

/** Build an op with the standard envelope filled in. */
export function makeOp<T extends { type: Op["type"] }>(
  type: T["type"],
  payload: Omit<T, "type" | "opId" | "actorId" | "ts">,
  meta?: OpMeta
): Op {
  return { opId: `op_${Date.now().toString(36)}_${(seqCounter++).toString(36)}`, actorId: meta?.actorId ?? "local", ts: nowIso(), type, ...payload } as unknown as Op;
}

export function cloneNode(n: MindNode): MindNode {
  return {
    ...n,
    childrenIds: [...n.childrenIds],
    style: { ...n.style },
    labels: [...n.labels],
    markers: [...n.markers],
    task: n.task ? { ...n.task } : null,
    metadata: { ...n.metadata },
    position: { ...n.position },
  };
}

// ---------------------------------------------------------------------------
// applyOp
// ---------------------------------------------------------------------------

export function applyOp(sheet: Sheet, op: Op): void {
  const nodes = sheet.nodes;
  switch (op.type) {
    case "createNode": {
      const parent = op.parentId ? nodes[op.parentId] : undefined;
      const node: MindNode = {
        id: op.id,
        type: op.nodeType,
        parentId: op.parentId,
        childrenIds: [],
        title: op.title,
        position: op.position ?? { x: 0, y: 0, manual: false },
        style: op.style ?? {},
        collapsed: false,
        labels: [],
        markers: [],
        notes: "",
        task: op.task ?? null,
        metadata: { createdAt: nowIso(), updatedAt: nowIso() },
      };
      nodes[op.id] = node;
      if (parent) parent.childrenIds.splice(clampIndex(op.index, parent.childrenIds.length), 0, op.id);
      break;
    }
    case "restoreNode": {
      for (const n of op.subtree) nodes[n.id] = cloneNode(n);
      if (op.parentId) {
        const parent = nodes[op.parentId];
        if (parent) parent.childrenIds.splice(clampIndex(op.index, parent.childrenIds.length), 0, op.id);
      }
      for (const rel of op.removedRelationships) sheet.relationships.push(rel);
      break;
    }
    case "deleteNode": {
      for (const n of op.subtree) delete nodes[n.id];
      if (op.parentId) {
        const parent = nodes[op.parentId];
        if (parent) {
          const idx = parent.childrenIds.indexOf(op.id);
          if (idx >= 0) parent.childrenIds.splice(idx, 1);
        }
      }
      sheet.relationships = sheet.relationships.filter((r) => !op.removedRelationships.some((rr) => rr.id === r.id));
      break;
    }
    case "setTitle":
      nodes[op.id].title = op.title;
      break;
    case "setStyle":
      nodes[op.id].style = { ...op.style };
      break;
    case "setPosition":
      nodes[op.id].position = { x: op.x, y: op.y, manual: op.manual, offsetX: op.offsetX, offsetY: op.offsetY };
      break;
    case "setCollapsed":
      nodes[op.id].collapsed = op.collapsed;
      break;
    case "moveNode": {
      // fromIndex/toIndex are FINAL indices: toIndex is the position the node
      // will occupy in the destination array after removal. Commands compute
      // them by simulating removal first, so applyOp needs no adjustment.
      const fromParent = op.fromParentId ? nodes[op.fromParentId] : undefined;
      const toParent = op.toParentId ? nodes[op.toParentId] : undefined;
      if (!nodes[op.id]) break;
      if (fromParent) {
        const idx = fromParent.childrenIds.indexOf(op.id);
        if (idx < 0) break;
        fromParent.childrenIds.splice(idx, 1);
      } else if (nodes[op.id].parentId !== null) {
        break;
      }
      if (toParent) toParent.childrenIds.splice(clampIndex(op.toIndex, toParent.childrenIds.length), 0, op.id);
      nodes[op.id].parentId = op.toParentId;
      break;
    }
    case "sortSiblings": {
      const parent = nodes[op.parentId];
      if (!parent) break;
      parent.childrenIds = [...op.order];
      break;
    }
    case "setTask":
      nodes[op.id].task = op.task ? { ...op.task } : null;
      break;
    case "setNotes":
      nodes[op.id].notes = op.notes;
      break;
    case "setSheetTitle":
      sheet.title = op.title;
      break;
    case "setStructure":
      sheet.structure = { ...op.config };
      break;
    case "createRelationship":
      sheet.relationships.push({ ...op.relationship });
      break;
    case "deleteRelationship":
      sheet.relationships = sheet.relationships.filter((r) => r.id !== op.id);
      break;
  }
}

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len));
}

// ---------------------------------------------------------------------------
// inverseOf — self-contained reversals used by undo
// ---------------------------------------------------------------------------

export function inverseOf(op: Op, meta?: OpMeta): Op[] {
  const m = { actorId: meta?.actorId ?? "local" };
  switch (op.type) {
    case "createNode":
      return [makeOp<Op & { type: "deleteNode" }>("deleteNode", { id: op.id, parentId: op.parentId, index: op.index, subtree: [], removedRelationships: [] }, m)];
    case "deleteNode":
      return [makeOp<Op & { type: "restoreNode" }>("restoreNode", { id: op.id, parentId: op.parentId, index: op.index, subtree: op.subtree, removedRelationships: op.removedRelationships }, m)];
    case "restoreNode":
      return [makeOp<Op & { type: "deleteNode" }>("deleteNode", { id: op.id, parentId: op.parentId, index: op.index, subtree: op.subtree, removedRelationships: op.removedRelationships }, m)];
    case "setTitle":
      return [makeOp<Op & { type: "setTitle" }>("setTitle", { id: op.id, title: op.prev, prev: op.title }, m)];
    case "setStyle":
      return [makeOp<Op & { type: "setStyle" }>("setStyle", { id: op.id, style: op.prev, prev: op.style }, m)];
    case "setPosition":
      return [makeOp<Op & { type: "setPosition" }>("setPosition", {
        id: op.id,
        x: op.prev.x,
        y: op.prev.y,
        manual: op.prev.manual,
        offsetX: op.prev.offsetX,
        offsetY: op.prev.offsetY,
        prev: { x: op.x, y: op.y, manual: op.manual, offsetX: op.offsetX, offsetY: op.offsetY },
      }, m)];
    case "setCollapsed":
      return [makeOp<Op & { type: "setCollapsed" }>("setCollapsed", { id: op.id, collapsed: op.prev, prev: op.collapsed }, m)];
    case "moveNode":
      return [makeOp<Op & { type: "moveNode" }>("moveNode", { id: op.id, fromParentId: op.toParentId, fromIndex: op.toIndex, toParentId: op.fromParentId, toIndex: op.fromIndex }, m)];
    case "sortSiblings":
      return [makeOp<Op & { type: "sortSiblings" }>("sortSiblings", { parentId: op.parentId, order: op.prevOrder, prevOrder: op.order }, m)];
    case "setTask":
      return [makeOp<Op & { type: "setTask" }>("setTask", { id: op.id, task: op.prev, prev: op.task }, m)];
    case "setNotes":
      return [makeOp<Op & { type: "setNotes" }>("setNotes", { id: op.id, notes: op.prev, prev: op.notes }, m)];
    case "setSheetTitle":
      return [makeOp<Op & { type: "setSheetTitle" }>("setSheetTitle", { title: op.prev, prev: op.title }, m)];
    case "setStructure":
      return [makeOp<Op & { type: "setStructure" }>("setStructure", { config: op.prev, prev: op.config }, m)];
    case "createRelationship":
      return [makeOp<Op & { type: "deleteRelationship" }>("deleteRelationship", { id: op.relationship.id, relationship: op.relationship }, m)];
    case "deleteRelationship":
      return [makeOp<Op & { type: "createRelationship" }>("createRelationship", { relationship: op.relationship }, m)];
  }
}

/**
 * Apply an op and return its inverse ops (for the history stack).
 * createNode's inverse needs the actual node after creation, so it is
 * captured here with sheet access; every other op is self-contained.
 */
export function applyWithInverse(sheet: Sheet, op: Op): Op[] {
  applyOp(sheet, op);
  if (op.type === "createNode") {
    const node = sheet.nodes[op.id];
    const deleteOp = makeOp<Op & { type: "deleteNode" }>("deleteNode", {
      id: op.id,
      parentId: op.parentId,
      index: op.index,
      subtree: node ? [cloneNode(node)] : [],
      removedRelationships: [],
    }, { actorId: op.actorId });
    return [deleteOp];
  }
  return inverseOf(op, { actorId: op.actorId });
}
