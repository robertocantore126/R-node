import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import { EditorStore } from "../src/editor/store";
import { DocumentModel } from "../src/core/doc";
import { groupBoxes, wavePoints, type Box } from "../src/layout/groups";
import { applyLayout } from "../src/layout/mindmap";
import { GROUP_LABEL_H, GROUP_PAD, HEURISTIC_MEASURER, measureNode } from "../src/layout/measure";
import type { Group, MindNode, Sheet } from "../src/core/types";
import type { StorageAdapter } from "../src/persist/storage";

/**
 * Group boundaries, XMind-style (G1–G5): the box holds each member's whole
 * branch, nested groups sit inside their parents, the layout makes room for
 * the box, and only the line or the title tab selects it.
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

describe("G1: a group encloses its members' whole branches", () => {
  it("the children of a grouped topic are inside the box", () => {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "A");
    const a1 = add(a, "A child one");
    const a2 = add(a, "A child two");
    sheet.boundaries.push({ id: "g", memberIds: [a] });
    const placed = placedOf(sheet);
    const box = groupBoxes(sheet, placed).get("g")!.box;
    for (const id of [a, a1, a2]) expect(inside(placed.get(id)!, box)).toBe(true);
  });

  it("a collapsed branch shrinks the box: hidden children are not placed", () => {
    const { sheet, add } = makeSheet();
    const a = add(sheet.rootNodeId, "A");
    const a1 = add(a, "child");
    sheet.boundaries.push({ id: "g", memberIds: [a] });
    const placed = placedOf(sheet);
    const open = groupBoxes(sheet, placed).get("g")!.box;
    placed.delete(a1);
    const shut = groupBoxes(sheet, placed).get("g")!.box;
    expect(shut.w).toBeLessThan(open.w);
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
    const ids = ["One", "Two", "Three"].map((t) => add(sheet.rootNodeId, t));
    const placed = placedOf(sheet); // laid out with no group
    sheet.boundaries.push({ id: "g", memberIds: [ids[1]], label: "Two" });
    const { occupied } = groupBoxes(sheet, placed).get("g")!;
    expect(overlaps(placed.get(ids[0])!, occupied) || overlaps(placed.get(ids[2])!, occupied)).toBe(true);
  });

  it("a legacy group across branches still draws but reserves nothing", () => {
    const { sheet, add } = makeSheet("logic");
    const a = add(sheet.rootNodeId, "A");
    const b = add(sheet.rootNodeId, "B");
    const a1 = add(a, "A child");
    const before = placedOf(sheet);
    sheet.boundaries.push({ id: "g", memberIds: [a1, b] });
    const after = placedOf(sheet);
    expect(after.get(b)).toEqual(before.get(b));
    expect(groupBoxes(sheet, after).get("g")).toBeDefined();
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
    expect(makeRenderer().hitTestGroup(state, o.x + o.w / 2, y)).toBeNull();
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
    expect(makeRenderer().hitTestGroup(state, o.x + 20, o.y - GROUP_LABEL_H / 2 + 2)).toBe("outer");
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
