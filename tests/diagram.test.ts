import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { makeOp, type Op } from "../src/core/ops";
import { createCanvasTextMeasurer, measureNode } from "../src/layout/measure";
import { waypointOrigin } from "../src/layout/relationship";
import type { StorageAdapter } from "../src/persist/storage";
import { DIAGRAM_SHAPES, DIAGRAM_SHAPE_LABELS, diagramShapePath } from "../src/core/diagramShapes";
import { FREEFORM_SHAPES, FREEFORM_SHAPE_SIZES } from "../src/core/freeform";
import { shapeFor } from "../src/core/drawio";

const memoryAdapter: StorageAdapter = { label: "test", async load() { return []; }, async save() { /* no-op */ } };
const measurer = createCanvasTextMeasurer();

function newDiagram(): { store: EditorStore; page: string; first: string } {
  const store = new EditorStore(memoryAdapter);
  store.newDocument("diagram");
  const page = store.sheet.rootNodeId;
  return { store, page, first: store.sheet.nodes[page].childrenIds[0] };
}

/** World rectangles of every shape on the page. */
function shapeRects(store: EditorStore, page: string): { id: string; x: number; y: number; w: number; h: number }[] {
  const p = store.sheet.nodes[page];
  return p.childrenIds.map((id) => {
    const n = store.sheet.nodes[id];
    const at = n.style.freeformPosition!;
    const { w, h } = measureNode(n, measurer);
    return { id, x: p.position.x + at.x, y: p.position.y + at.y, w, h };
  });
}

function overlaps(store: EditorStore, page: string): string[] {
  const rs = shapeRects(store, page);
  const out: string[] = [];
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id}/${b.id}`);
    }
  }
  return out;
}

/** The arrow's bends in world space, as the renderer computes them. */
function worldBends(store: EditorStore, relId: string): { x: number; y: number }[] {
  const rel = store.sheet.relationships.find((r) => r.id === relId)!;
  const placed = Object.values(store.sheet.nodes).map((node) => ({ node, x: node.position.x, y: node.position.y }));
  const o = waypointOrigin(store.sheet, placed, rel)!;
  return (rel.waypoints ?? []).map((p) => ({ x: o.x + p.x, y: o.y + p.y }));
}

describe("diagram Tab tree layout", () => {
  it("a branch that grows pushes its siblings' branches apart", () => {
    const { store, page, first } = newDiagram();
    const b = store.diagramTab(first)!;
    const c = store.diagramTab(first)!;
    for (let i = 0; i < 4; i++) store.diagramTab(b);
    for (let i = 0; i < 4; i++) store.diagramTab(c);
    expect(overlaps(store, page)).toEqual([]);
  });

  it("stays clear three levels deep, Tab in any order", () => {
    const { store, page, first } = newDiagram();
    const kids = [store.diagramTab(first)!, store.diagramTab(first)!, store.diagramTab(first)!];
    const grand = kids.map((k) => [store.diagramTab(k)!, store.diagramTab(k)!]);
    for (let i = 0; i < 3; i++) store.diagramTab(grand[1][0]);
    for (let i = 0; i < 3; i++) store.diagramTab(grand[0][1]);
    for (let i = 0; i < 3; i++) store.diagramTab(grand[2][0]);
    expect(overlaps(store, page)).toEqual([]);
  });

  it("deleting a child closes the gap: its siblings centre on the parent again, one undo step", () => {
    const { store, first } = newDiagram();
    const kids = [store.diagramTab(first)!, store.diagramTab(first)!, store.diagramTab(first)!];
    const at = (id: string) => store.sheet.nodes[id].style.freeformPosition!;
    const before = kids.map((k) => ({ ...at(k) }));
    const centre = (ids: string[]): number => {
      const ys = ids.map((k) => at(k).y);
      return (Math.min(...ys) + Math.max(...ys) + 60) / 2;
    };
    const parentCentre = at(first).y + 30;
    store.deleteNodes([kids[1]]);
    expect(at(kids[2]).y - at(kids[0]).y).toBe(60 + 30); // packed, no gap
    expect(centre([kids[0], kids[2]])).toBe(parentCentre);
    store.undo();
    expect(kids.map((k) => at(k))).toEqual(before);
  });

  it("deleting a Tab arrow takes its shape out of the column, and the rest closes up", () => {
    const { store, first } = newDiagram();
    const kids = [store.diagramTab(first)!, store.diagramTab(first)!, store.diagramTab(first)!];
    const arrow = store.sheet.relationships.find((r) => r.toId === kids[1])!;
    store.execOps([makeOp<Op & { type: "deleteRelationship" }>("deleteRelationship", { id: arrow.id, relationship: arrow })]);
    const y = (id: string) => store.sheet.nodes[id].style.freeformPosition!.y;
    expect(y(kids[2]) - y(kids[0])).toBe(90);
  });

  it("Tab is one undo step", () => {
    const { store, page, first } = newDiagram();
    const b = store.diagramTab(first)!;
    store.diagramTab(b);
    // What the document stores (not `position` of shapes, which the layout
    // derives and refreshes on its own schedule).
    const saved = (): string => JSON.stringify({
      kids: store.sheet.nodes[page].childrenIds,
      at: store.sheet.nodes[page].childrenIds.map((id) => store.sheet.nodes[id].style.freeformPosition),
      rels: store.sheet.relationships,
      page: store.sheet.nodes[page].style,
    });
    const before = saved();
    store.diagramTab(first);
    expect(store.sheet.nodes[page].childrenIds.length).toBe(4);
    store.undo();
    expect(saved()).toBe(before);
  });
});

describe("special topics in a diagram", () => {
  it("chart, gallery, code and canvas made under a shape land on the page with a Tab arrow", () => {
    const { store, page, first } = newDiagram();
    store.createChartTopic(first);
    store.createGalleryTopic(first);
    store.createCodeTopic(first);
    store.createFreeformTopic(first);
    const kids = store.sheet.nodes[page].childrenIds.slice(1);
    expect(kids.length).toBe(4);
    for (const id of kids) {
      expect(store.sheet.nodes[id].parentId).toBe(page);
      expect(store.sheet.relationships.some((r) => r.tree && r.fromId === first && r.toId === id)).toBe(true);
    }
    expect(overlaps(store, page)).toEqual([]);
  });

  it("a shape that grows (gallery pictures, a resize) pushes its tree apart; a move does not", () => {
    const { store, page, first } = newDiagram();
    const b = store.diagramTab(first)!;
    const c = store.diagramTab(first)!;
    const nb = store.sheet.nodes[b];
    store.execOps([makeOp<Op & { type: "setStyle" }>("setStyle", { id: b, style: { ...nb.style, height: 400 }, prev: nb.style })]);
    expect(overlaps(store, page)).toEqual([]);
    // Moving c by hand (it gets pinned) is not undone by any relayout.
    const nc = store.sheet.nodes[c];
    const moved = { x: nc.style.freeformPosition!.x + 300, y: nc.style.freeformPosition!.y };
    store.execOps([makeOp<Op & { type: "setStyle" }>("setStyle", { id: c, style: { ...nc.style, freeformPosition: moved, diagramPinned: true }, prev: nc.style })]);
    expect(store.sheet.nodes[c].style.freeformPosition).toEqual(moved);
  });

  it("Tab under a canvas, chart or code block makes a plain shape, not a copy of it", () => {
    const { store, page, first } = newDiagram();
    store.createFreeformTopic(first);
    store.createChartTopic(first);
    store.createCodeTopic(first);
    const nodes = store.sheet.nodes;
    for (const special of store.sheet.nodes[page].childrenIds.slice(1)) {
      const child = nodes[store.diagramTab(special)!];
      expect(child.style.shape).toBe("rounded");
      expect([child.style.width, child.style.height]).toEqual([120, 60]);
      expect(child.style.freeform || child.style.gallery || child.style.code).toBeFalsy();
    }
  });

});

describe("diagram shapes", () => {
  it("every outline is closed, finite and inside its box, at any size", () => {
    for (const shape of DIAGRAM_SHAPES) {
      for (const [w, h] of [[120, 60], [40, 200], [300, 30], [8, 8]]) {
        const { outline, detail } = diagramShapePath(shape, 10, 20, w, h);
        expect(outline[0][0], shape).toBe("M");
        expect(outline.at(-1)![0], shape).toBe("Z");
        for (const c of [...outline, ...detail]) {
          const nums = c.slice(1) as number[];
          for (let i = 0; i < nums.length; i += 2) {
            expect(Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1]), shape).toBe(true);
            // Bezier handles of the round shapes may poke out by a hair.
            expect(nums[i], `${shape} x`).toBeGreaterThanOrEqual(10 - 0.5);
            expect(nums[i], `${shape} x`).toBeLessThanOrEqual(10 + w + 0.5);
            expect(nums[i + 1], `${shape} y`).toBeGreaterThanOrEqual(20 - h * 0.11);
            expect(nums[i + 1], `${shape} y`).toBeLessThanOrEqual(20 + h + h * 0.11);
          }
        }
      }
    }
  });

  it("every diagram shape is in the shape bar with a starting size and a label", () => {
    const bar = new Set(FREEFORM_SHAPES.map((s) => s.shape));
    for (const shape of DIAGRAM_SHAPES) {
      expect(bar.has(shape), shape).toBe(true);
      expect(FREEFORM_SHAPE_SIZES[shape], shape).toBeTruthy();
      expect(DIAGRAM_SHAPE_LABELS[shape], shape).toBeTruthy();
    }
  });

  it("draw.io stencils land on the new outlines", () => {
    expect(shapeFor("mxgraph.flowchart.delay", {})).toBe("delay");
    expect(shapeFor("mxgraph.flowchart.multi-Document", {})).toBe("multiDocument");
    expect(shapeFor("mxgraph.flowchart.off-page_reference", {})).toBe("offPage");
    expect(shapeFor("mxgraph.basic.star", {})).toBe("star");
    expect(shapeFor("cube", {})).toBe("cube");
    expect(shapeFor("cloud", {})).toBe("cloud");
  });
});

describe("diagram page growth keeps arrow bends in place", () => {
  it("bends do not move when the page grows left/up and back", () => {
    const { store, first } = newDiagram();
    const b = store.diagramTab(first)!;
    const rel = store.sheet.relationships.find((r) => r.toId === b)!;
    store.execOps([makeOp<Op & { type: "setRelationship" }>("setRelationship", {
      id: rel.id, relationship: { ...rel, waypoints: [{ x: 400, y: 300 }] }, prev: rel,
    })]);
    const start = worldBends(store, rel.id);

    // Move the first shape off the first page, up and to the left: the page
    // gains a column and a row, its corner moves by a whole page.
    const n = store.sheet.nodes[first];
    store.execOps([makeOp<Op & { type: "setStyle" }>("setStyle", {
      id: first, style: { ...n.style, freeformPosition: { x: -300, y: -200 } }, prev: n.style,
    })]);
    expect(store.sheet.nodes[store.sheet.rootNodeId].position.x).toBe(-827);
    expect(worldBends(store, rel.id)).toEqual(start);

    // Back onto the first page: the page shrinks again.
    const m = store.sheet.nodes[first];
    store.execOps([makeOp<Op & { type: "setStyle" }>("setStyle", {
      id: first, style: { ...m.style, freeformPosition: { x: 827 + 120, y: 1169 + 120 } }, prev: m.style,
    })]);
    expect(store.sheet.nodes[store.sheet.rootNodeId].position).toMatchObject({ x: 0, y: 0 });
    expect(worldBends(store, rel.id)).toEqual(start);

    store.undo();
    expect(worldBends(store, rel.id)).toEqual(start);
    store.undo();
    expect(worldBends(store, rel.id)).toEqual(start);
  });
});
