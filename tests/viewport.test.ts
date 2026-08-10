import { describe, expect, it } from "vitest";
import { screenToWorld, worldToScreen, zoomAt } from "../src/render/viewport";

describe("viewport", () => {
  it("keeps the world point under the cursor fixed while zooming", () => {
    const before = { x: 0, y: 0, scale: 1 };
    const sx = 800;
    const sy = 250;
    const world = screenToWorld(before, 1000, 800, sx, sy);
    const after = zoomAt(before, 1000, 800, sx, sy, 2);

    expect(worldToScreen(after, 1000, 800, world.x, world.y).x).toBeCloseTo(sx, 8);
    expect(worldToScreen(after, 1000, 800, world.x, world.y).y).toBeCloseTo(sy, 8);
  });

  it("still anchors correctly when zoom is clamped", () => {
    const before = { x: 100, y: -40, scale: 4 };
    const sx = 100;
    const sy = 700;
    const world = screenToWorld(before, 1000, 800, sx, sy);
    const after = zoomAt(before, 1000, 800, sx, sy, 2);

    expect(after.scale).toBe(4);
    expect(worldToScreen(after, 1000, 800, world.x, world.y).x).toBeCloseTo(sx, 8);
    expect(worldToScreen(after, 1000, 800, world.x, world.y).y).toBeCloseTo(sy, 8);
  });
});
