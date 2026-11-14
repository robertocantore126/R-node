// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { relationshipRoute, routeObstacles, type Pt, type Rect } from "../src/layout/relationship";
import { parseDrawio } from "../src/core/drawio";
import { EditorStore } from "../src/editor/store";
import { HEURISTIC_MEASURER, imageResolver, measureNode } from "../src/layout/measure";

/** Does any leg of the polyline pass through the inside of r? */
function crosses(pts: Pt[], r: Rect): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (let t = 0; t <= 1; t += 0.02) {
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
      if (x > r.x + 2 && x < r.x + r.w - 2 && y > r.y + 2 && y < r.y + r.h - 2) return true;
    }
  }
  return false;
}
const ptsOf = (route: ReturnType<typeof relationshipRoute>): Pt[] => (route.path.kind === "poly" ? route.path.pts : []);

describe("elbow arrows route around boxes", () => {
  const a = { x: 0, y: 0, w: 100, h: 60 }, b = { x: 400, y: 0, w: 100, h: 60 };
  const wall = { x: 200, y: -40, w: 80, h: 140 };

  it("without obstacles, the old route (straight across)", () => {
    const pts = ptsOf(relationshipRoute({ connector: "elbow" }, a, b));
    expect(crosses(pts, wall)).toBe(true);
  });

  it("with a box in the way, the route goes around it and stays orthogonal", () => {
    const pts = ptsOf(relationshipRoute({ connector: "elbow" }, a, b, [wall]));
    expect(crosses(pts, wall)).toBe(false);
    for (let i = 1; i < pts.length; i++) {
      const horizontal = Math.abs(pts[i].y - pts[i - 1].y) < 1e-6, vertical = Math.abs(pts[i].x - pts[i - 1].x) < 1e-6;
      expect(horizontal || vertical).toBe(true);
    }
    expect(crosses(pts, a) || crosses(pts, b)).toBe(false);
  });

  it("a pinned end keeps its side", () => {
    const pts = ptsOf(relationshipRoute({ connector: "elbow", fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 } }, a, b, [wall]));
    expect(pts[0]).toEqual({ x: 100, y: 30 });
    expect(pts.at(-1)).toEqual({ x: 400, y: 30 });
    expect(crosses(pts, wall)).toBe(false);
  });

  it("the user's AWS diagram: no elbow arrow crosses a box", async () => {
    const { readFileSync } = await import("node:fs");
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    store.importDrawio(board.id, (await parseDrawio(readFileSync("tests/fixtures/drawio-aws-truncated.xml", "utf8")))!);
    const resolve = imageResolver(store.sheet);
    const placed = Object.values(store.sheet.nodes).map((node) => ({ node, x: node.position.x, y: node.position.y, ...measureNode(node, HEURISTIC_MEASURER, resolve) }));
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    const rels = store.sheet.relationships.filter((r) => r.connector === "elbow");
    expect(rels.length).toBe(13);
    let crossings = 0;
    for (const rel of rels) {
      const obstacles = routeObstacles(store.sheet, placed, rel);
      const pts = ptsOf(relationshipRoute(rel, byId.get(rel.fromId)!, byId.get(rel.toId)!, obstacles));
      for (const r of obstacles) if (crosses(pts, r)) crossings++;
    }
    expect(crossings).toBe(0);
  });
});
