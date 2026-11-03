import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EditorStore } from "../src/editor/store";
import { sheetToSvg } from "../src/export/svg";
import { applyLayout } from "../src/layout/mindmap";
import { bezierEnterRect, bezierExitRect, bezierSlice, CHART_MAX_SIDE, chartGrowDelta, HEURISTIC_MEASURER, segmentExitRect, type Bezier3 } from "../src/layout/measure";
import { anchorAt, elbowPoints, headShape, relationshipRoute, relHeads, routeDistance } from "../src/layout/relationship";
import type { StorageAdapter } from "../src/persist/storage";

const A = { x: 0, y: 0, w: 100, h: 40 };
const B = { x: 300, y: 200, w: 120, h: 60 };

describe("relationship route", () => {
  it("draws an unanchored curve exactly as before (centre to centre, cut at the borders)", () => {
    const ac = { x: 50, y: 20 };
    const bc = { x: 360, y: 230 };
    const curve: Bezier3 = { p0: ac, p1: { x: ac.x + (bc.x - ac.x) * 0.35, y: ac.y }, p2: { x: bc.x - (bc.x - ac.x) * 0.35, y: bc.y }, p3: bc };
    const old = bezierSlice(curve, bezierExitRect(curve, A.x, A.y, A.w, A.h), bezierEnterRect(curve, B.x, B.y, B.w, B.h));
    const r = relationshipRoute({}, A, B);
    expect(r.path).toEqual({ kind: "curve", b: old });
    expect(r.mid).toEqual({ x: (ac.x + bc.x) / 2, y: (ac.y + bc.y) / 2 });
  });

  it("draws an unanchored straight line exactly as before", () => {
    const r = relationshipRoute({ connector: "straight" }, A, B);
    expect(r.path).toEqual({ kind: "poly", pts: [segmentExitRect(A, B), segmentExitRect(B, A)] });
  });

  it("pins anchored ends to the chosen border points and leaves square to the side", () => {
    const r = relationshipRoute({ fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 } }, A, B);
    expect(r.start.tip).toEqual({ x: 100, y: 20 });
    expect(r.end.tip).toEqual({ x: 300, y: 230 });
    if (r.path.kind !== "curve") throw new Error("curve expected");
    // Control points push out along each side's normal: right, then left.
    expect(r.path.b.p1.y).toBe(20);
    expect(r.path.b.p1.x).toBeGreaterThan(100);
    expect(r.path.b.p2.y).toBe(230);
    expect(r.path.b.p2.x).toBeLessThan(300);
  });

  it("routes elbows orthogonally between the sides the centre line crosses", () => {
    const r = relationshipRoute({ connector: "elbow" }, A, B);
    if (r.path.kind !== "poly") throw new Error("poly expected");
    const pts = r.path.pts;
    for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
    // B lies further down than across, measured in each box's own size:
    // out of A's bottom, into B's top.
    expect(pts[0]).toEqual({ x: 50, y: 40 });
    expect(pts[pts.length - 1]).toEqual({ x: 360, y: 200 });
    // The head's direction is the last segment: vertical, down into B.
    expect(r.end.from.x).toBe(360);
    expect(r.end.from.y).toBeLessThan(200);
  });

  it("drops the bends of an elbow whose ends already line up", () => {
    expect(elbowPoints({ x: 0, y: 5 }, { x: 1, y: 0 }, { x: 200, y: 5 }, { x: -1, y: 0 })).toEqual([{ x: 0, y: 5 }, { x: 200, y: 5 }]);
  });

  it("hit tests the drawn route, not the old centre curve", () => {
    const rel = { connector: "elbow" as const };
    const r = relationshipRoute(rel, A, B);
    if (r.path.kind !== "poly") throw new Error("poly expected");
    const bend = r.path.pts[2];
    expect(routeDistance(r, bend)).toBeLessThan(0.001);
  });
});

describe("anchors and heads", () => {
  it("floats in the middle of a box and snaps to quarter marks on its border", () => {
    expect(anchorAt(B, { x: 360, y: 230 }, 8)).toBeUndefined();
    expect(anchorAt(B, { x: 302, y: 216 }, 8)).toEqual({ x: 0, y: 0.25 });
    expect(anchorAt(B, { x: 391, y: 259 }, 0.5)).toEqual({ x: 91 / 120, y: 1 });
  });

  it("reads older documents' bidirectional flag as two triangles", () => {
    expect(relHeads({ bidirectional: true })).toEqual({ start: "triangle", end: "triangle" });
    expect(relHeads({})).toEqual({ start: "none", end: "triangle" });
    expect(relHeads({ bidirectional: true, startArrow: "none", endArrow: "diamond" })).toEqual({ start: "none", end: "diamond" });
  });

  it("puts every head's tip on the line's end", () => {
    for (const h of ["triangle", "open", "diamond"] as const) {
      const s = headShape(h, { x: 0, y: 0 }, { x: 50, y: 0 }, 9);
      if (!s || s.kind !== "poly") throw new Error(h);
      expect(s.pts.some((p) => p.x === 50 && p.y === 0)).toBe(true);
    }
    const c = headShape("circle", { x: 0, y: 0 }, { x: 50, y: 0 }, 10);
    if (!c || c.kind !== "circle") throw new Error("circle");
    expect(c.c.x + c.r).toBeCloseTo(50);
    expect(headShape("none", { x: 0, y: 0 }, { x: 1, y: 0 }, 9)).toBeNull();
  });
});

describe("chart grow slider", () => {
  it("takes the next column at half a pitch and never leaves 1..max", () => {
    expect(chartGrowDelta(0, 100, 3)).toBe(0);
    expect(chartGrowDelta(49, 100, 3)).toBe(0);
    expect(chartGrowDelta(51, 100, 3)).toBe(1);
    expect(chartGrowDelta(260, 100, 3)).toBe(3);
    expect(chartGrowDelta(-160, 100, 3)).toBe(-2);
    expect(chartGrowDelta(-900, 100, 3)).toBe(-2);
    expect(chartGrowDelta(1e6, 100, 3)).toBe(CHART_MAX_SIDE - 3);
  });
});

const adapter: StorageAdapter = { label: "test", async load() { return []; }, async save() {} };

describe("arrows in the store", () => {
  function setup() {
    const store = new EditorStore(adapter);
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const a = store.createFreeformItem(board.id, board.position.x + 40, board.position.y + 80, "A")!;
    const b = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 80, "B")!;
    const c = store.createFreeformItem(board.id, board.position.x + 300, board.position.y + 260, "C")!;
    return { store, a, b, c };
  }

  it("creates anchored arrows, allows a second one between the same pair, and undoes each", () => {
    const { store, a, b } = setup();
    const id = store.createRelationship(a, b, { fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 }, connector: "straight", lineStyle: "solid" })!;
    expect(store.sheet.relationships.find((r) => r.id === id)).toMatchObject({ fromId: a, toId: b, fromAnchor: { x: 1, y: 0.5 } });
    const back = store.createRelationship(b, a, { connector: "straight" });
    expect(back).not.toBeNull();
    expect(store.sheet.relationships).toHaveLength(2);
    // The plain Link… command keeps its duplicate guard.
    expect(store.createRelationship(a, b)).toBeNull();
    store.undo();
    store.undo();
    expect(store.sheet.relationships).toHaveLength(0);
  });

  it("moves one end onto another topic in one undoable step", () => {
    const { store, a, b, c } = setup();
    const id = store.createRelationship(a, b, { toAnchor: { x: 0, y: 0.5 } })!;
    store.reconnectRelationship(id, "to", c, { x: 0.5, y: 0 });
    expect(store.sheet.relationships[0]).toMatchObject({ fromId: a, toId: c, toAnchor: { x: 0.5, y: 0 } });
    store.reconnectRelationship(id, "to", a, undefined); // onto its own source: refused
    expect(store.sheet.relationships[0].toId).toBe(c);
    store.undo();
    expect(store.sheet.relationships[0]).toMatchObject({ toId: b, toAnchor: { x: 0, y: 0.5 } });
  });

  it("exports the anchored route and its heads to SVG", async () => {
    const { store, a, b } = setup();
    store.createRelationship(a, b, { connector: "elbow", startArrow: "circle", endArrow: "open", width: 3, lineStyle: "solid" });
    applyLayout(store.sheet, false, HEURISTIC_MEASURER);
    const { svg } = await sheetToSvg(store.sheet, {
      measurer: HEURISTIC_MEASURER,
      colorOf: () => ({ fill: "#ffffff", text: "#000000" }),
      linkColorOf: () => "#888888",
      background: null,
    });
    expect(svg).toMatch(/<path d="M[^"]*L[^"]*" fill="none" stroke="[^"]+" stroke-width="3"/);
    expect(svg).toContain("<circle");
    expect(svg).toMatch(/<polyline points="[^"]+" fill="none"/);
  });
});
