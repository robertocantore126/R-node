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
import type { AttachmentInfo, Group, ImageSlot, MindNode, Position, Relationship, Sheet, StructureConfig, Style, Summary, TaskInfo, TextRun } from "./types";
import { nowIso } from "./doc";

// ---------------------------------------------------------------------------
// Op definitions
// ---------------------------------------------------------------------------

/** Style field that holds the attachment id for a given image slot. */
export function slotKey(slot: ImageSlot): "image" | "imageBottom" | "imageLeft" | "imageRight" {
  return slot === "top" ? "image" : slot === "bottom" ? "imageBottom" : slot === "left" ? "imageLeft" : "imageRight";
}

/** All attachment ids currently referenced by a node's image slots. */
export function nodeImageIds(n: MindNode): string[] {
  const out: string[] = [];
  for (const slot of ["top", "bottom", "left", "right"] as const) {
    const id = n.style[slotKey(slot)];
    if (id) out.push(id);
  }
  return out;
}

export type Op =
  | { opId: string; actorId: string; ts: string; type: "createNode"; id: string; nodeType: MindNode["type"]; parentId: string | null; index: number; title: string; titleRuns?: TextRun[]; style?: Style; task?: TaskInfo | null; position?: { x: number; y: number; manual: boolean } }
  | { opId: string; actorId: string; ts: string; type: "restoreNode"; id: string; parentId: string | null; index: number; subtree: MindNode[]; removedRelationships: Relationship[] }
  | { opId: string; actorId: string; ts: string; type: "deleteNode"; id: string; parentId: string | null; index: number; subtree: MindNode[]; removedRelationships: Relationship[] }
  | { opId: string; actorId: string; ts: string; type: "setTitle"; id: string; title: string; prev: string; titleRuns?: TextRun[]; prevRuns?: TextRun[] }
  | { opId: string; actorId: string; ts: string; type: "setStyle"; id: string; style: Style; prev: Style }
  | { opId: string; actorId: string; ts: string; type: "setNodeImage"; nodeId: string; imageId: string | null; prevImageId: string | null; position?: ImageSlot }
  | { opId: string; actorId: string; ts: string; type: "setPosition"; id: string; x: number; y: number; manual: boolean; offsetX?: number; offsetY?: number; prev: Position }
  | { opId: string; actorId: string; ts: string; type: "setCollapsed"; id: string; collapsed: boolean; prev: boolean }
  | { opId: string; actorId: string; ts: string; type: "moveNode"; id: string; fromParentId: string | null; fromIndex: number; toParentId: string | null; toIndex: number }
  | { opId: string; actorId: string; ts: string; type: "sortSiblings"; parentId: string; order: string[]; prevOrder: string[] }
  | { opId: string; actorId: string; ts: string; type: "setTask"; id: string; task: TaskInfo | null; prev: TaskInfo | null }
  | { opId: string; actorId: string; ts: string; type: "setNotes"; id: string; notes: string; prev: string }
  | { opId: string; actorId: string; ts: string; type: "setSheetTitle"; title: string; prev: string }
  | { opId: string; actorId: string; ts: string; type: "setStructure"; config: StructureConfig; prev: StructureConfig }
  | { opId: string; actorId: string; ts: string; type: "createRelationship"; relationship: Relationship }
  | { opId: string; actorId: string; ts: string; type: "deleteRelationship"; id: string; relationship: Relationship }
  | { opId: string; actorId: string; ts: string; type: "setRelationship"; id: string; relationship: Relationship; prev: Relationship }
  | { opId: string; actorId: string; ts: string; type: "createGroup"; group: Group }
  | { opId: string; actorId: string; ts: string; type: "deleteGroup"; id: string; group: Group }
  | { opId: string; actorId: string; ts: string; type: "setGroup"; id: string; group: Group; prev: Group }
  | { opId: string; actorId: string; ts: string; type: "createSummary"; summary: Summary }
  | { opId: string; actorId: string; ts: string; type: "deleteSummary"; id: string; summary: Summary }
  | { opId: string; actorId: string; ts: string; type: "setSummary"; id: string; summary: Summary; prev: Summary }
  | { opId: string; actorId: string; ts: string; type: "setAttachments"; attachments: AttachmentInfo[]; prev: AttachmentInfo[] };

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
    titleRuns: n.titleRuns ? n.titleRuns.map((r) => ({ ...r })) : undefined,
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
        titleRuns: op.titleRuns ? op.titleRuns.map((r) => ({ ...r })) : undefined,
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
    case "setTitle": {
      const node = nodes[op.id];
      node.title = op.title;
      if (op.titleRuns) node.titleRuns = op.titleRuns.map((r) => ({ ...r }));
      else delete node.titleRuns;
      break;
    }
    case "setStyle":
      nodes[op.id].style = { ...op.style };
      break;
    case "setNodeImage": {
      const node = nodes[op.nodeId];
      if (!node) break;
      // The op carries ONLY the id — never image bytes (ADR-001 §12). The
      // position defaults to "top" so ops written before the side slots
      // existed (and saved documents containing them) still apply.
      const slot = op.position ?? "top";
      const key = slotKey(slot);
      const style = { ...node.style };
      if (op.imageId) style[key] = op.imageId;
      else delete style[key];
      node.style = style;
      break;
    }
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
    case "setRelationship": {
      const idx = sheet.relationships.findIndex((r) => r.id === op.id);
      if (idx >= 0) sheet.relationships[idx] = { ...op.relationship };
      break;
    }
    case "createGroup":
      sheet.boundaries.push({ ...op.group, memberIds: [...op.group.memberIds] });
      break;
    case "deleteGroup":
      sheet.boundaries = sheet.boundaries.filter((g) => g.id !== op.id);
      break;
    case "setGroup": {
      const idx = sheet.boundaries.findIndex((g) => g.id === op.id);
      if (idx >= 0) sheet.boundaries[idx] = { ...op.group, memberIds: [...op.group.memberIds] };
      break;
    }
    case "createSummary":
      sheet.summaries.push({ ...op.summary, memberIds: [...op.summary.memberIds] });
      break;
    case "deleteSummary":
      sheet.summaries = sheet.summaries.filter((s) => s.id !== op.id);
      break;
    case "setSummary": {
      const idx = sheet.summaries.findIndex((s) => s.id === op.id);
      if (idx >= 0) sheet.summaries[idx] = { ...op.summary, memberIds: [...op.summary.memberIds] };
      break;
    }
    case "setAttachments":
      // Whole-list replacement: the ONLY writer of this op is the orphan GC,
      // which removes the unreferenced cards in one undoable step. The op
      // carries the full previous list (`prev`), so undo restores the cards
      // exactly — the images they point to, however, are gone (the blob
      // deletion is not undoable); the GC confirmation says so explicitly.
      sheet.attachments = op.attachments.map((a) => ({ ...a }));
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
      return [makeOp<Op & { type: "setTitle" }>("setTitle", { id: op.id, title: op.prev, prev: op.title, titleRuns: op.prevRuns, prevRuns: op.titleRuns }, m)];
    case "setStyle":
      return [makeOp<Op & { type: "setStyle" }>("setStyle", { id: op.id, style: op.prev, prev: op.style }, m)];
    case "setNodeImage":
      return [makeOp<Op & { type: "setNodeImage" }>("setNodeImage", { nodeId: op.nodeId, imageId: op.prevImageId, prevImageId: op.imageId, position: op.position }, m)];
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
    case "setRelationship":
      return [makeOp<Op & { type: "setRelationship" }>("setRelationship", { id: op.id, relationship: op.prev, prev: op.relationship }, m)];
    case "createGroup":
      return [makeOp<Op & { type: "deleteGroup" }>("deleteGroup", { id: op.group.id, group: op.group }, m)];
    case "deleteGroup":
      return [makeOp<Op & { type: "createGroup" }>("createGroup", { group: op.group }, m)];
    case "setGroup":
      return [makeOp<Op & { type: "setGroup" }>("setGroup", { id: op.id, group: op.prev, prev: op.group }, m)];
    case "createSummary":
      return [makeOp<Op & { type: "deleteSummary" }>("deleteSummary", { id: op.summary.id, summary: op.summary }, m)];
    case "deleteSummary":
      return [makeOp<Op & { type: "createSummary" }>("createSummary", { summary: op.summary }, m)];
    case "setSummary":
      return [makeOp<Op & { type: "setSummary" }>("setSummary", { id: op.id, summary: op.prev, prev: op.summary }, m)];
    case "setAttachments":
      return [makeOp<Op & { type: "setAttachments" }>("setAttachments", { attachments: op.prev, prev: op.attachments }, m)];
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
