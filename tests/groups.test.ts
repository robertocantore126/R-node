import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import { EditorStore } from "../src/editor/store";
import { DocumentModel } from "../src/core/doc";
import { validateSheet } from "../src/core/validate";
import { sheetToSvg } from "../src/export/svg";
import { groupBoxes, wavePoints, type Box } from "../src/layout/groups";
import { applyLayout } from "../src/layout/mindmap";
import { GROUP_LABEL_H, GROUP_PAD, HEURISTIC_MEASURER, measureNode } from "../src/layout/measure";
import type { Group, MindNode, Sheet } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

/**
 * Group boundaries: the box holds exactly the grouped topics, nested groups
 * sit inside their parents, the layout makes room so boxes do not run into
 * their neighbours, and only the line or the title tab selects a group.
 */

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() {} };

function makeSheet(structureType: "mindmap" | "logic" = "logic"): { sheet: Sheet; add: (parentId: string, title: string) => string } {
  const model = new DocumentModel(DocumentModel.blank("g"));
  const sheet = model.sheet;
  sheet.structure.structureType = structureType;
  let seq = 0;
  const add = (parentId: string, title: string): string => {
    const id = `n${++seq}`;
    sheet.nodes[id] = {
      id, type: "subtopic", parentId, childrenIds: [], title,
      position: { x: 0, y: 0, manual: false },
      style: { fontSize: 14 }, collapsed: false, labels: [], markers: [], notes: "", task: null,
      metadata: { createdAt: "", updatedAt: "" },
    } as unknown as MindNode;
    sheet.nodes[parentId].childrenIds.push(id);
    return id;
  };
  return { sheet, add };
}

/** Placed boxes straight from the layout, the way the renderer sees them. */
function placedOf(sheet: Sheet): Map<string, Box> {
  applyLayout(sheet, true, HEURISTIC_MEASURER);
  const out = new Map<string, Box>();
  for (const n of Object.values(sheet.nodes)) {
    const { w, h } = measureNode(n, HEURISTIC_MEASURER);
    out.set(n.id, { x: n.position.x, y: n.position.y, w, h });
  }
  return out;
}

const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function make2dCtx(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(_t, p) {
      if (p === "measureText") return (text: string) => ({ width: text.length * 7 });
      return () => {};
    },
    set(_t, p, v) { target[p] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}
function makeRenderer(): Renderer {
  const ctx = make2dCtx();
  const canvas = { width: 800, height: 600, getContext: () => ctx } as unknown as HTMLCanvasElement;
  vi.stubGlobal("document", { createElement: () => canvas });
  return new Renderer(canvas);
}
afterEach(() => vi.unstubAllGlobals());

describe("a group encloses exactly the topics that were grouped", () => {
  it("the members are inside the box, their children are not", () => {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "A");
    const a1 = add(a, "A child one");
    const a2 = add(a, "A child two");
    sheet.boundaries.push({ id: "g", memberIds: [a] });
    const placed = placedOf(sheet);
    const box = groupBoxes(sheet, placed).get("g")!.box;
    expect(inside(placed.get(a)!, box)).toBe(true);
    for (const id of [a1, a2]) expect(overlaps(placed.get(id)!, box)).toBe(false);
  });

  it("a nested group's box, tab included, sits inside its parent's with room to spare", () => {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "A");
    const b = add(sheet.rootNodeId, "B");
    add(a, "A child");
    sheet.boundaries.push({ id: "outer", memberIds: [a, b] }, { id: "inner", memberIds: [a], label: "Inner" });
    const geo = groupBoxes(sheet, placedOf(sheet));
    const outer = geo.get("outer")!.box;
    const inner = geo.get("inner")!.occupied;
    expect(inside(inner, outer)).toBe(true);
    expect(inner.y - outer.y).toBeGreaterThanOrEqual(GROUP_PAD - 0.01);
  });
});

describe("G5: the layout makes room for a group", () => {
  for (const structure of ["logic", "mindmap"] as const) {
    it(`${structure}: the box of a titled group clears the neighbouring branches`, () => {
      const { sheet, add } = makeSheet(structure);
      const ids = ["One", "Two", "Three", "Four"].map((t) => add(sheet.rootNodeId, t));
      for (const id of ids) add(id, `${id} child`);
      // the middle two, titled, so the tab needs room too
      const g: Group = { id: "g", memberIds: [ids[1], ids[2]], label: "Middle" };
      sheet.boundaries.push(g);
      const placed = placedOf(sheet);
      const { occupied, covered } = groupBoxes(sheet, placed).get("g")!;
      for (const [id, box] of placed) {
        if (covered.has(id) || id === sheet.rootNodeId) continue;
        expect(overlaps(box, occupied), `${sheet.nodes[id].title} overlaps the group`).toBe(false);
      }
    });
  }

  it("without the reservation the same box WOULD overlap (the test can fail)", () => {
    const { sheet, add } = makeSheet("logic");
    // Subtopics, not main topics: the root's wider sibling gap would hide it.
    const parent = add(sheet.rootNodeId, "Parent");
    const ids = ["One", "Two", "Three"].map((t) => add(parent, t));
    const placed = placedOf(sheet); // laid out with no group
    sheet.boundaries.push({ id: "g", memberIds: [ids[1]], label: "Two" });
    const { occupied } = groupBoxes(sheet, placed).get("g")!;
    expect(overlaps(placed.get(ids[0])!, occupied) || overlaps(placed.get(ids[2])!, occupied)).toBe(true);
  });

  it("a group of cousins opens room in each parent's column", () => {
    const { sheet, add } = makeSheet("logic");
    const a = add(sheet.rootNodeId, "A");
    const b = add(sheet.rootNodeId, "B");
    const [a1, a2] = [add(a, "a1"), add(a, "a2")];
    const [b1, b2] = [add(b, "b1"), add(b, "b2")];
    const gap = (p: Map<string, Box>, top: string, bottom: string): number => p.get(bottom)!.y - (p.get(top)!.y + p.get(top)!.h);
    const plain = placedOf(sheet);
    sheet.boundaries.push({ id: "g", memberIds: [a2, b1] });
    const grouped = placedOf(sheet);
    // a2 is the run's first in A's column, b1 the last in B's
    expect(gap(grouped, a1, a2) - gap(plain, a1, a2)).toBeCloseTo(GROUP_PAD, 5);
    expect(gap(grouped, b1, b2) - gap(plain, b1, b2)).toBeCloseTo(GROUP_PAD, 5);
  });

  it("mindmap: a group across main branches keeps them on one side of the root", () => {
    const { sheet, add } = makeSheet("mindmap");
    const mains = ["One", "Two", "Three", "Four"].map((t) => add(sheet.rootNodeId, t));
    const kids = mains.map((m) => add(m, `${m} child`));
    sheet.boundaries.push({ id: "g", memberIds: [kids[1], kids[2]] });
    const placed = placedOf(sheet);
    const rootX = placed.get(sheet.rootNodeId)!.x;
    const side = (id: string) => Math.sign(placed.get(id)!.x - rootX);
    expect(side(mains[1])).toBe(side(mains[2]));
  });

  it(`the top room is the pad plus half the tab (${GROUP_PAD} + ${GROUP_LABEL_H / 2})`, () => {
    const { sheet, add } = makeSheet("logic");
    const ids = ["One", "Two"].map((t) => add(sheet.rootNodeId, t));
    const plain = placedOf(sheet);
    const gap0 = plain.get(ids[1])!.y - (plain.get(ids[0])!.y + plain.get(ids[0])!.h);
    sheet.boundaries.push({ id: "g", memberIds: [ids[1]], label: "T" });
    const grouped = placedOf(sheet);
    const gap1 = grouped.get(ids[1])!.y - (grouped.get(ids[0])!.y + grouped.get(ids[0])!.h);
    expect(gap1 - gap0).toBeCloseTo(GROUP_PAD + GROUP_LABEL_H / 2, 5);
  });
});

describe("G4: only the line or the tab selects a group", () => {
  function scene() {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "A");
    const b = add(sheet.rootNodeId, "B");
    add(a, "A child");
    sheet.boundaries.push({ id: "outer", memberIds: [a, b], label: "Outer" }, { id: "inner", memberIds: [a] });
    const placed = placedOf(sheet);
    const geo = groupBoxes(sheet, placed);
    const state = { sheet, camera: { x: 0, y: 0, scale: 1 }, selection: new Set<string>(), editingId: null, hoverId: null, drop: null, themeName: "light" as const, viewW: 800, viewH: 600 };
    return { state, geo };
  }

  it("the interior is not a hit — a marquee can start inside a group", () => {
    const { state, geo } = scene();
    const o = geo.get("outer")!.box;
    const i = geo.get("inner")!.box;
    // between the inner box's bottom and the outer box's bottom: inside outer, on no line
    const y = (i.y + i.h + o.y + o.h) / 2;
    const r = makeRenderer();
    expect(r.hitTestGroup(state, o.x + o.w / 2, y)).toBeNull();
    // With includeInterior: true (right-click context menu), the interior hits
    // and picks the innermost group when nested.
    expect(r.hitTestGroup(state, o.x + o.w / 2, y, { includeInterior: true })).toBe("outer");
    expect(r.hitTestGroup(state, i.x + i.w / 2, i.y + i.h / 2, { includeInterior: true })).toBe("inner");
  });

  it("the line is a hit, and on shared ground the smaller (nested) group wins", () => {
    const { state, geo } = scene();
    const o = geo.get("outer")!.box;
    const i = geo.get("inner")!.box;
    const r = makeRenderer();
    expect(r.hitTestGroup(state, o.x + o.w / 2, o.y + o.h)).toBe("outer");
    expect(r.hitTestGroup(state, i.x + i.w / 2, i.y)).toBe("inner");
  });

  it("the title tab is a hit", () => {
    const { state, geo } = scene();
    const o = geo.get("outer")!.box;
    const r = makeRenderer();
    expect(r.hitTestGroup(state, o.x + 20, o.y - GROUP_LABEL_H / 2 + 2)).toBe("outer");
    expect(r.hitTestGroupTab(state, o.x + 20, o.y - GROUP_LABEL_H / 2 + 2)).toBe("outer");
    expect(r.hitTestGroupTab(state, o.x + o.w / 2, o.y + o.h)).toBeNull();
    expect(r.hitTestGroupTab(state, o.x + o.w / 2, o.y + o.h / 2)).toBeNull();
  });

  it("groupTabWorldRect returns a tab rect both with and without a label", () => {
    const { state } = scene();
    const r = makeRenderer();
    expect(r.groupTabWorldRect(state, "outer")).toBeTruthy();
    expect(r.groupTabWorldRect(state, "inner")).toBeTruthy();
  });
});

describe("titles", () => {
  it("the old 'group' placeholder is dropped on open; a real title survives", () => {
    const store = new EditorStore(memoryAdapter);
    const doc = store.doc.doc;
    const sheet = doc.sheets[0];
    const main = Object.values(sheet.nodes).find((n) => n.parentId === sheet.rootNodeId)!;
    sheet.boundaries = [
      { id: "old", memberIds: [main.id], label: "group" },
      { id: "named", memberIds: [main.id], label: "Ideas" },
    ];
    store.importDocumentFromJson(JSON.stringify(doc));
    expect(store.sheet.boundaries.find((g) => g.id === "old")!.label).toBeUndefined();
    expect(store.sheet.boundaries.find((g) => g.id === "named")!.label).toBe("Ideas");
  });

  it("newly created groups start with a default 'Group' title", () => {
    const store = new EditorStore(memoryAdapter);
    const id = store.createChildOf(store.sheet.rootNodeId)!;
    store.select(id);
    store.createGroupFromSelection();
    expect(store.sheet.boundaries[0].label).toBe("Group");
  });
});

describe("group auto-adoption when placing or dropping content inside", () => {
  function setupFreeformWithGroup() {
    const store = new EditorStore(memoryAdapter);
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const a = store.createFreeformItem(board.id, board.position.x + 200, board.position.y + 180, "", undefined, "rect")!;
    const b = store.createFreeformItem(board.id, board.position.x + 420, board.position.y + 180, "", undefined, "rect")!;
    store.cancelEdit?.();
    store.selectMany([a, b]);
    store.createGroupFromSelection();
    const grp = store.sheet.boundaries[0];
    const boxBefore = groupBoxes(store.sheet, placedOf(store.sheet)).get(grp.id)!.box;
    return { store, board, a, b, grpId: grp.id, boxBefore };
  }

  it("adopts an outside item moved into the group and expands the box (one undo step)", () => {
    const { store, board, grpId, boxBefore } = setupFreeformWithGroup();
    store.sheet.attachments.push({ id: "img1", mime: "image/png", w: 400, h: 300, bytes: 1 });
    // Image placed completely outside to the left of the group
    const outsider = store.createFreeformItem(board.id, board.position.x + 20, board.position.y + 180, "", "img1")!;
    expect(store.sheet.boundaries[0].memberIds).not.toContain(outsider);

    // Drag the image so it partly overlaps the left interior of the group
    store.moveIntoFreeform(outsider, board.id, boxBefore.x - 40, boxBefore.y + 10);
    expect(store.sheet.boundaries[0].memberIds).toContain(outsider);
    const boxAfter = groupBoxes(store.sheet, placedOf(store.sheet)).get(grpId)!.box;
    expect(boxAfter.x).toBeLessThan(boxBefore.x);
    expect(boxAfter.w).toBeGreaterThan(boxBefore.w);

    // Single undo reverts both move and group membership
    store.undo();
    expect(store.sheet.boundaries[0].memberIds).not.toContain(outsider);
  });

  it("does not adopt an item moved completely outside the group", () => {
    const { store, board, boxBefore } = setupFreeformWithGroup();
    const outsider = store.createFreeformItem(board.id, board.position.x + 20, board.position.y + 420, "", undefined, "rect")!;
    store.cancelEdit?.();
    store.moveIntoFreeform(outsider, board.id, boxBefore.x - 200, boxBefore.y + 300);
    expect(store.sheet.boundaries[0].memberIds).not.toContain(outsider);
  });

  it("adopts items created directly inside a group or dragged via multi-select commitGroupDrag", () => {
    const { store, board, grpId, boxBefore } = setupFreeformWithGroup();
    // Create a shape inside the group's box
    const created = store.createFreeformItem(board.id, boxBefore.x + boxBefore.w / 2, boxBefore.y + boxBefore.h / 2, "", undefined, "rect")!;
    store.cancelEdit?.();
    expect(store.sheet.boundaries[0].memberIds).toContain(created);

    // Multi-item drag from outside into the group
    const out1 = store.createFreeformItem(board.id, board.position.x + 20, board.position.y + 420, "", undefined, "rect")!;
    const out2 = store.createFreeformItem(board.id, board.position.x + 20, board.position.y + 500, "", undefined, "rect")!;
    store.cancelEdit?.();
    const gOut1 = store.itemGeometry(out1)!;
    store.selectMany([out1, out2]);
    store.beginGroupDrag([out1, out2]);
    const dx = (boxBefore.x + boxBefore.w - 80) - (board.position.x + gOut1.x);
    const dy = (boxBefore.y + boxBefore.h - 40) - (board.position.y + gOut1.y);
    store.commitGroupDrag(dx, dy);
    expect(store.sheet.boundaries[0].memberIds).toContain(out1);
    const boxAfter = groupBoxes(store.sheet, placedOf(store.sheet)).get(grpId)!.box;
    expect(boxAfter.h).toBeGreaterThan(boxBefore.h);
  });

  it("dragging a group from its title moves all enclosed freeform members together in one undo step", () => {
    const { store, a, b, grpId, boxBefore } = setupFreeformWithGroup();
    const ga0 = store.itemGeometry(a)!;
    const gb0 = store.itemGeometry(b)!;

    expect(store.beginBoundaryDrag(grpId)).toBe(true);
    store.setBoundaryDragDraft(70, 50);
    expect(store.itemGeometry(a)).toMatchObject({ x: ga0.x + 70, y: ga0.y + 50 });
    expect(store.itemGeometry(b)).toMatchObject({ x: gb0.x + 70, y: gb0.y + 50 });
    store.cancelBoundaryDrag();
    expect(store.itemGeometry(a)).toMatchObject({ x: ga0.x, y: ga0.y });

    expect(store.beginBoundaryDrag(grpId)).toBe(true);
    store.setBoundaryDragDraft(80, 40);
    store.commitBoundaryDrag(80, 40);
    expect(store.itemGeometry(a)).toMatchObject({ x: ga0.x + 80, y: ga0.y + 40 });
    expect(store.itemGeometry(b)).toMatchObject({ x: gb0.x + 80, y: gb0.y + 40 });
    const boxAfter = groupBoxes(store.sheet, placedOf(store.sheet)).get(grpId)!.box;
    expect(boxAfter.x).toBe(boxBefore.x + 80);
    expect(boxAfter.y).toBe(boxBefore.y + 40);

    store.undo();
    (store as unknown as { settleLayoutNow(): void }).settleLayoutNow();
    expect(store.itemGeometry(a)).toMatchObject({ x: ga0.x, y: ga0.y });
    expect(store.itemGeometry(b)).toMatchObject({ x: gb0.x, y: gb0.y });
  });

  it("dragging a group of floating/root-child mindmap topics moves them together in one undo step", () => {
    const store = new EditorStore(memoryAdapter);
    const m1 = store.createChildOf(store.sheet.rootNodeId)!;
    const m2 = store.createChildOf(store.sheet.rootNodeId)!;
    store.selectMany([m1, m2]);
    store.createGroupFromSelection();
    const grpId = store.sheet.boundaries[0].id;
    const p1 = { ...store.doc.requireNode(m1).position };
    const p2 = { ...store.doc.requireNode(m2).position };

    expect(store.beginBoundaryDrag(grpId)).toBe(true);
    store.setBoundaryDragDraft(60, -30);
    store.commitBoundaryDrag(60, -30);
    expect(store.doc.requireNode(m1).position).toMatchObject({ x: p1.x + 60, y: p1.y - 30, manual: true });
    expect(store.doc.requireNode(m2).position).toMatchObject({ x: p2.x + 60, y: p2.y - 30, manual: true });

    store.undo();
    expect(store.doc.requireNode(m1).position).toMatchObject({ x: p1.x, y: p1.y });
    expect(store.doc.requireNode(m2).position).toMatchObject({ x: p2.x, y: p2.y });
  });
});

describe("arrows targeting or starting from a group", () => {
  it("resolves endpoints, hit-testing, connect handles, SVG export, reconnect, and deletion cleanup", async () => {
    const store = new EditorStore(memoryAdapter);
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const a = store.createFreeformItem(board.id, board.position.x + 200, board.position.y + 180, "", undefined, "rect")!;
    const b = store.createFreeformItem(board.id, board.position.x + 420, board.position.y + 180, "", undefined, "rect")!;
    const outside = store.createFreeformItem(board.id, board.position.x + 20, board.position.y + 420, "", undefined, "rect")!;
    store.cancelEdit?.();
    store.selectMany([a, b]);
    store.createGroupFromSelection();
    const grpId = store.sheet.boundaries[0].id;

    // Arrow from outside item -> group
    const relId = store.createRelationship(outside, grpId, { endArrow: "triangle" })!;
    expect(relId).toBeTruthy();
    expect(() => validateSheet(store.sheet)).not.toThrow();

    const state = {
      sheet: store.sheet,
      camera: { x: 0, y: 0, scale: 1 },
      selection: new Set<string>(),
      editingId: null,
      hoverId: null,
      drop: null,
      groupSel: grpId,
      themeName: "light" as const,
      viewW: 1200,
      viewH: 900,
    };
    const r = makeRenderer();
    const grpBox = r.relEndWorldRect(state, grpId)!;
    expect(grpBox).toBeTruthy();
    const ends = r.relationshipEnds(state, relId)!;
    expect(ends).toBeTruthy();
    // End tip lands on the group's boundary box
    expect(ends.to.x).toBeGreaterThanOrEqual(grpBox.x - 1);
    expect(ends.to.x).toBeLessThanOrEqual(grpBox.x + grpBox.w + 1);
    expect(ends.to.y).toBeGreaterThanOrEqual(grpBox.y - 1);
    expect(ends.to.y).toBeLessThanOrEqual(grpBox.y + grpBox.h + 1);

    // Hit-test along the line midpoint
    const midX = (ends.from.x + ends.to.x) / 2;
    const midY = (ends.from.y + ends.to.y) / 2;
    expect(r.hitTestRelationship(state, midX, midY)).toBe(relId);

    // Connect handle on selected freeform group (right edge)
    const handlePt = { x: grpBox.x + grpBox.w + 14, y: grpBox.y + grpBox.h / 2 };
    expect(r.hitTestConnectHandle(state, handlePt.x, handlePt.y)?.id).toBe(grpId);

    // SVG export includes the arrow to the group
    const svgOut = await sheetToSvg(store.sheet, {
      measurer: HEURISTIC_MEASURER,
      background: "#ffffff",
      colorOf: () => ({ fill: "#ffffff", text: "#111111" }),
      linkColorOf: () => "#666666",
    });
    expect(svgOut.report.coverage.relationships.emitted).toBe(1);

    // Reconnect from group onto `a`, then undo back to group
    store.reconnectRelationship(relId, "to", a, undefined);
    expect(store.sheet.relationships[0].toId).toBe(a);
    store.undo();
    expect(store.sheet.relationships[0].toId).toBe(grpId);

    // Deleting the group deletes its arrows in one undoable batch
    store.deleteGroup(grpId);
    expect(store.sheet.boundaries).toHaveLength(0);
    expect(store.sheet.relationships).toHaveLength(0);
    expect(() => validateSheet(store.sheet)).not.toThrow();

    store.undo();
    expect(store.sheet.boundaries).toHaveLength(1);
    expect(store.sheet.relationships).toHaveLength(1);

    // Deleting all member nodes also drops the group and its arrows cleanly
    store.deleteNodes([a, b]);
    expect(store.sheet.boundaries).toHaveLength(0);
    expect(store.sheet.relationships).toHaveLength(0);
    expect(() => validateSheet(store.sheet)).not.toThrow();
    store.undo();
    expect(store.sheet.boundaries).toHaveLength(1);
    expect(store.sheet.relationships).toHaveLength(1);
  });
});

describe("wave outline", () => {
  it("closes on itself and stays within amp of the box", () => {
    const b = { x: 10, y: 20, w: 200, h: 90 };
    const pts = wavePoints(b, 3, 18);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(b.x - 3.0001);
      expect(p.x).toBeLessThanOrEqual(b.x + b.w + 3.0001);
      expect(p.y).toBeGreaterThanOrEqual(b.y - 3.0001);
      expect(p.y).toBeLessThanOrEqual(b.y + b.h + 3.0001);
    }
    expect(pts[0]).toEqual({ x: b.x, y: b.y });
  });
});
