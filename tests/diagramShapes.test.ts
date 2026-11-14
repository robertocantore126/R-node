import { describe, expect, it } from "vitest";
import { DIAGRAM_SHAPES, diagramShapePath, pdfPathOps, svgPathData, tracePath, type PathCmd } from "../src/core/diagramShapes";
import { DocumentModel } from "../src/core/doc";
import type { MindNode } from "../src/core/types";
import { sheetToSvg } from "../src/export/svg";
import { HEURISTIC_MEASURER } from "../src/layout/measure";
import { applyLayout } from "../src/layout/mindmap";

const points = (cmds: PathCmd[]): number[][] =>
  cmds.flatMap((c) => (c[0] === "Z" ? [] : c[0] === "C" ? [[c[5], c[6]]] : [[c[1], c[2]]]));

describe("diagram shape paths", () => {
  it("every outline is closed, and every point lies on or inside its box", () => {
    for (const shape of DIAGRAM_SHAPES) {
      for (const [w, h] of [[120, 60], [40, 90], [16, 16]]) {
        const { outline, detail } = diagramShapePath(shape, 10, 20, w, h);
        expect(outline[0][0], shape).toBe("M");
        expect(outline.at(-1)![0], shape).toBe("Z");
        for (const [x, y] of points([...outline, ...detail])) {
          expect(x, `${shape} ${w}x${h}`).toBeGreaterThanOrEqual(10 - 1e-9);
          expect(x, `${shape} ${w}x${h}`).toBeLessThanOrEqual(10 + w + 1e-9);
          expect(y, `${shape} ${w}x${h}`).toBeGreaterThanOrEqual(20 - 1e-9);
          expect(y, `${shape} ${w}x${h}`).toBeLessThanOrEqual(20 + h + 1e-9);
        }
      }
    }
  });

  it("the three painters replay the same commands", () => {
    const { outline } = diagramShapePath("cylinder", 0, 0, 60, 80);
    const calls: string[] = [];
    tracePath(
      { moveTo: () => calls.push("M"), lineTo: () => calls.push("L"), bezierCurveTo: () => calls.push("C"), closePath: () => calls.push("Z") },
      outline,
    );
    expect(calls.join("")).toBe(outline.map((c) => c[0]).join(""));
    expect(svgPathData(outline, String).split(/(?=[MLCZ])/).map((s) => s[0]).join("")).toBe(calls.join(""));
    const ops = pdfPathOps(outline, (x) => x, (y) => -y, String).split("\n").map((l) => l.trim().split(" ").at(-1));
    expect(ops.join("")).toBe(calls.join("").replace(/M/g, "m").replace(/L/g, "l").replace(/C/g, "c").replace(/Z/g, "h"));
  });
});

describe("diagram shapes in SVG export", () => {
  it("draws the outline as a path and the detail as unfilled linework", async () => {
    const model = new DocumentModel(DocumentModel.blank("m"));
    const sheet = model.sheet;
    const id = "db";
    sheet.nodes[id] = {
      id, type: "subtopic", parentId: sheet.rootNodeId, childrenIds: [], title: "DB",
      position: { x: 0, y: 0, manual: false },
      style: { shape: "cylinder", width: 60, height: 80, stroke: "#336699", borderWidth: 1.5 },
      collapsed: false, labels: [], markers: [], notes: "", task: null, metadata: { createdAt: "", updatedAt: "" },
    } as unknown as MindNode;
    sheet.nodes[sheet.rootNodeId].childrenIds.push(id);
    applyLayout(sheet, false, HEURISTIC_MEASURER);
    const out = await sheetToSvg(sheet, {
      measurer: HEURISTIC_MEASURER,
      colorOf: () => ({ fill: "#ffffff", text: "#000000" }),
      linkColorOf: () => "#888888",
      background: null,
      borderOf: (nid: string) => (nid === id ? { color: "#336699", width: 1.5, dash: [], cap: "butt", double: false } : null),
    });
    const paths = out.svg.match(/<path d="M[^"]*C[^"]*"[^>]*>/g) ?? [];
    expect(paths.some((p) => p.includes('stroke="#336699"') && p.includes("Z"))).toBe(true);
    expect(paths.some((p) => p.includes('fill="none"') && p.includes('stroke="#336699"') && !p.includes("Z"))).toBe(true);
  });
});
