/**
 * R-node — runtime topology checker for a sheet (T1).
 *
 * `applyOp` mutates the node tree in place, without validation. A wrong
 * `parentId` is not an error at the moment it happens: it stays in memory, it
 * gets written to disk, and it resurfaces much later as an unexplained crash
 * far away from its cause. `validateSheet` turns that silent corruption into an
 * immediate failure that names the ids involved.
 *
 * Two rules this module follows on purpose:
 *  - It never repairs. A checker that fixes what it finds hides the very bug it
 *    exists to expose, and the document keeps drifting.
 *  - It is pure and allocation-light: the store calls it after every batch of
 *    ops outside production, so it runs constantly during development.
 */

import type { MindNode, Sheet } from "./types";

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}

/**
 * Throws `InvariantViolation` on the first broken invariant. Order matters:
 * references are checked before coherence so the coherence pass can walk the
 * graph without re-guarding every lookup, and the root is checked before both
 * because every traversal starts there.
 */
export function validateSheet(sheet: Sheet): void {
  const nodes = sheet.nodes;
  const all = Object.values(nodes);

  // --- Root -----------------------------------------------------------------
  const root: MindNode | undefined = nodes[sheet.rootNodeId];
  if (!root) {
    throw new InvariantViolation(`root '${sheet.rootNodeId}' is not in sheet.nodes`);
  }
  if (root.parentId !== null) {
    throw new InvariantViolation(`root '${root.id}' has parentId '${root.parentId}', expected null`);
  }

  // --- Resolvable references ------------------------------------------------
  for (const node of all) {
    for (const childId of node.childrenIds) {
      if (!nodes[childId]) {
        throw new InvariantViolation(`node '${node.id}' lists child '${childId}' which is not in sheet.nodes`);
      }
    }
    if (node.parentId !== null && !nodes[node.parentId]) {
      throw new InvariantViolation(`node '${node.id}' has parentId '${node.parentId}' which is not in sheet.nodes`);
    }
  }
  for (const rel of sheet.relationships) {
    if (!nodes[rel.fromId]) {
      throw new InvariantViolation(`relationship '${rel.id}' has fromId '${rel.fromId}' which is not in sheet.nodes`);
    }
    if (!nodes[rel.toId]) {
      throw new InvariantViolation(`relationship '${rel.id}' has toId '${rel.toId}' which is not in sheet.nodes`);
    }
  }

  // --- parent/children coherence, in both directions -------------------------
  for (const node of all) {
    for (const childId of node.childrenIds) {
      const child = nodes[childId];
      if (child.parentId !== node.id) {
        throw new InvariantViolation(
          `node '${childId}' appears in childrenIds of '${node.id}' but its parentId is '${child.parentId}'`,
        );
      }
    }
    if (node.parentId !== null) {
      const parent = nodes[node.parentId];
      let times = 0;
      for (const id of parent.childrenIds) if (id === node.id) times++;
      if (times !== 1) {
        throw new InvariantViolation(
          `node '${node.id}' has parentId '${parent.id}' but appears ${times} times in its childrenIds, expected exactly once`,
        );
      }
    }
  }

  // --- Cycles and orphans, from one walk ------------------------------------
  // Floating topics are unparented by design, so each one is a root of its own.
  // Their descendants are reachable only through them: walking from
  // `rootNodeId` alone would report a child dropped onto a floating topic as an
  // orphan, which is a legitimate document, not corruption.
  const reachable = new Set<string>();
  const walk = (startId: string): void => {
    const stack = [startId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (reachable.has(id)) {
        throw new InvariantViolation(`node '${id}' is reachable twice: the tree has a cycle or a shared child`);
      }
      reachable.add(id);
      for (const childId of nodes[id].childrenIds) stack.push(childId);
    }
  };

  walk(root.id);
  for (const node of all) {
    if (node.type === "floating" && !reachable.has(node.id)) walk(node.id);
  }

  // Whatever is still unreached is either a cycle hanging off nothing or a
  // plain orphan, and the two need different fixes. Coherence has already run,
  // so an unreachable node cannot have a reachable parent: walking up its
  // parents therefore either loops (cycle) or ends at null (orphan). Without
  // this split every cycle would be reported as an orphan, which sends you
  // looking in the wrong place.
  for (const node of all) {
    if (reachable.has(node.id)) continue;
    const seen = new Set<string>([node.id]);
    let cursor: string | null = node.parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new InvariantViolation(`node '${node.id}' sits on a parent cycle that closes through '${cursor}'`);
      }
      seen.add(cursor);
      cursor = nodes[cursor].parentId;
    }
    throw new InvariantViolation(`node '${node.id}' is not reachable from root '${root.id}' and is not floating`);
  }
}
