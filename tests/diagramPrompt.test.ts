// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DIAGRAM_KINDS, DIAGRAM_PROMPT_EXAMPLE, diagramPrompt, type DiagramKind } from "../src/core/diagramPrompt";
import { parseDrawio, parseStyle, shapeFor } from "../src/core/drawio";
import { EditorStore } from "../src/editor/store";

describe("diagram prompt", () => {
  it("carries the material and the kind's instructions", () => {
    const p = diagramPrompt("  Web shop on AWS: CloudFront, ALB, EC2, RDS  ", "architecture");
    expect(p).toContain(DIAGRAM_KINDS.architecture);
    expect(p.trimEnd().endsWith("Web shop on AWS: CloudFront, ALB, EC2, RDS")).toBe(true);
    for (const k of Object.keys(DIAGRAM_KINDS) as DiagramKind[]) expect(diagramPrompt("x", k)).toContain(DIAGRAM_KINDS[k]);
    expect(diagramPrompt("")).toContain("(describe here");
  });

  it("its own example imports with nothing lost: a lane holding two boxes, two solid/dashed arrows", async () => {
    const d = (await parseDrawio("```xml\n" + DIAGRAM_PROMPT_EXAMPLE + "\n```"))!;
    expect(d.skippedEdges).toBe(0);
    const by = Object.fromEntries(d.vertices.map((v) => [v.id, v]));
    expect(by.lane).toMatchObject({ container: true, headerFill: "#dae8fc" });
    expect(by.api).toMatchObject({ parent: "lane", shape: "rounded" });
    expect(by.db).toMatchObject({ parent: "lane", shape: "cylinder" });
    expect(by.user).toMatchObject({ shape: "ellipse" });
    expect(d.edges.map((e) => e.lineStyle)).toEqual(["solid", "dashed"]);
  });

  it("every shape style it teaches maps onto the R-node shape it promises", () => {
    const p = diagramPrompt("x");
    const taught: [string, string][] = [
      ["rounded=1;whiteSpace=wrap;html=1;", "rounded"],
      ["rounded=1;arcSize=50;whiteSpace=wrap;html=1;", "capsule"],
      ["rhombus;whiteSpace=wrap;html=1;", "diamond"],
      ["shape=cylinder3;whiteSpace=wrap;html=1;", "cylinder"],
      ["shape=document;whiteSpace=wrap;html=1;", "document"],
      ["shape=parallelogram;whiteSpace=wrap;html=1;", "parallelogram"],
      ["shape=process;whiteSpace=wrap;html=1;", "process"],
      ["ellipse;whiteSpace=wrap;html=1;", "ellipse"],
      ["shape=note;whiteSpace=wrap;html=1;", "note"],
    ];
    for (const [style, shape] of taught) {
      expect(p).toContain(style);
      const s = parseStyle(style);
      const first = style.split(";")[0];
      const kind = s.shape ?? (first.includes("=") ? "" : first);
      expect([style, shapeFor(kind, s)]).toEqual([style, shape]);
    }
  });

  it("an answer pasted in the window imports into the canvas; text without a diagram is refused", async () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(await store.importDiagramText("Sorry, I cannot draw that.", board.id)).toBe(false);
    expect(board.childrenIds).toHaveLength(0);
    expect(await store.importDiagramText("Sure!\n```xml\n" + DIAGRAM_PROMPT_EXAMPLE + "\n```", board.id)).toBe(true);
    expect(board.childrenIds).toHaveLength(2); // the lane and the user; the lane holds the other two
    expect(await store.importDiagramText("<mxGraphModel><root><mxCell id='0'></root></mxGraphModel>", board.id)).toBe(false);
  });
});
