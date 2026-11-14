import { describe, expect, it } from "vitest";
import { bendHandles, dragElbowSegment, elbowThrough, relationshipRoute, worldWaypoints } from "../src/layout/relationship";
import { rotatedBox } from "../src/render/renderer";

const a = { x: 0, y: 0, w: 100, h: 50 };
const b = { x: 300, y: 200, w: 100, h: 50 };
const origin = { x: 0, y: 0 };

const axisAligned = (pts: { x: number; y: number }[]): boolean =>
  pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 1e-6 || Math.abs(p.y - pts[i - 1].y) < 1e-6);

describe("relationship waypoints (draw.io bends)", () => {
  it("a straight line passes through every waypoint in order", () => {
    const route = relationshipRoute({ connector: "straight", waypoints: [{ x: 200, y: 25 }, { x: 200, y: 150 }] }, a, b, undefined, origin);
    expect(route.path.kind).toBe("poly");
    const pts = route.path.kind === "poly" ? route.path.pts : [];
    expect(pts.slice(1, -1)).toEqual([{ x: 200, y: 25 }, { x: 200, y: 150 }]);
    expect(pts[0].x).toBeCloseTo(100); // leaves a's right side, toward the first bend
  });

  it("a curved line goes through its waypoints too", () => {
    const route = relationshipRoute({ waypoints: [{ x: 200, y: -60 }] }, a, b, undefined, origin);
    const pts = route.path.kind === "poly" ? route.path.pts : [];
    expect(pts.some((p) => Math.hypot(p.x - 200, p.y + 60) < 1e-6)).toBe(true);
  });

  it("waypoints are relative to their origin, so they move with the canvas", () => {
    const rel = { connector: "straight" as const, waypoints: [{ x: 10, y: 20 }] };
    expect(worldWaypoints(rel, a, b, { x: 1000, y: 500 })).toEqual([{ x: 1010, y: 520 }]);
  });

  it("an elbow line through waypoints stays orthogonal", () => {
    const pts = elbowThrough({ x: 100, y: 25 }, { x: 1, y: 0 }, [{ x: 180, y: 120 }], { x: 300, y: 225 }, { x: -1, y: 0 });
    expect(axisAligned(pts)).toBe(true);
    // On the path (it may sit inside a straight leg rather than at a corner).
    const on = pts.some((p, i) => i > 0 && Math.min(p.x, pts[i - 1].x) <= 180 && Math.max(p.x, pts[i - 1].x) >= 180 && Math.min(p.y, pts[i - 1].y) <= 120 && Math.max(p.y, pts[i - 1].y) >= 120);
    expect(on).toBe(true);
  });

  it("sliding an elbow segment moves it and keeps the route orthogonal", () => {
    const rel = { connector: "elbow" as const, fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 } };
    const route = relationshipRoute(rel, a, b);
    const handles = bendHandles(rel, route, []);
    const seg = handles.find((h) => h.kind === "segment");
    expect(seg).toBeTruthy();
    const moved = dragElbowSegment(route, seg!.index, { x: 250, y: 0 }, a, b)!;
    const next = relationshipRoute({ ...rel, ...moved }, a, b, undefined, origin);
    const pts = next.path.kind === "poly" ? next.path.pts : [];
    expect(axisAligned(pts)).toBe(true);
    expect(pts.filter((p) => p.x === 250).length).toBe(2); // the vertical leg now runs at x = 250
    expect(moved.fromAnchor).toEqual({ x: 1, y: 0.5 });
  });

  it("a straight line offers a handle to pull out its first bend", () => {
    const rel = { connector: "straight" as const };
    const route = relationshipRoute(rel, a, b);
    expect(bendHandles(rel, route, []).map((h) => h.kind)).toEqual(["insert"]);
  });

  it("the label offset moves only the label", () => {
    const plain = relationshipRoute({ connector: "straight" }, a, b);
    const moved = relationshipRoute({ connector: "straight", labelOffset: { x: 5, y: -30 } }, a, b);
    expect(moved.path).toEqual(plain.path);
    expect(moved.mid).toEqual({ x: plain.mid.x + 5, y: plain.mid.y - 30 });
  });
});

describe("rotated items in a marquee", () => {
  it("a box turned 90 degrees covers its height across", () => {
    const r = rotatedBox({ x: 100, y: 350, w: 180, h: 30 }, 270);
    expect(r.w).toBeCloseTo(30);
    expect(r.h).toBeCloseTo(180);
    expect(r.x + r.w / 2).toBeCloseTo(190);
    expect(r.y + r.h / 2).toBeCloseTo(365);
  });
});
