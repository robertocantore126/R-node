// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { diagramPrompt } from "../src/core/diagramPrompt";
import { parseDrawio } from "../src/core/drawio";
import { EditorStore } from "../src/editor/store";

/** An answer in the dialect the importer reads: a lane holding two boxes, a box outside, two arrows. */
const EXAMPLE = `<mxGraphModel>
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="lane" value="Backend" style="swimlane;startSize=30;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="200" y="40" width="360" height="200" as="geometry" />
    </mxCell>
    <mxCell id="api" value="API server" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="lane">
      <mxGeometry x="30" y="70" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="db" value="Orders DB" style="shape=cylinder3;whiteSpace=wrap;html=1;" vertex="1" parent="lane">
      <mxGeometry x="230" y="60" width="80" height="90" as="geometry" />
    </mxCell>
    <mxCell id="user" value="User" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="20" y="130" width="100" height="60" as="geometry" />
    </mxCell>
    <mxCell id="e1" value="HTTPS" style="endArrow=block;html=1;" edge="1" parent="1" source="user" target="api">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
    <mxCell id="e2" value="SQL" style="endArrow=block;dashed=1;html=1;" edge="1" parent="1" source="api" target="db">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>`;

describe("diagram prompt", () => {
  it("is only the OUTPUT rules, then the material", () => {
    const p = diagramPrompt("  Web shop on AWS: CloudFront, ALB, EC2, RDS  ");
    expect(p.startsWith("OUTPUT\n")).toBe(true);
    for (const gone of ["GOAL", "SHAPES", "COLOURS", "ARROWS", "LAYOUT", "EXAMPLE"]) expect(p).not.toMatch(new RegExp(`^${gone}`, "m"));
    expect(p).toContain("<mxGraphModel>");
    expect(p).toContain("BOTH source and target");
    expect(p.trimEnd().endsWith("Web shop on AWS: CloudFront, ALB, EC2, RDS")).toBe(true);
    expect(diagramPrompt("")).toContain("(describe here");
  });

  it("an answer in that format imports with nothing lost: a lane holding two boxes, two solid/dashed arrows", async () => {
    const d = (await parseDrawio("```xml\n" + EXAMPLE + "\n```"))!;
    expect(d.skippedEdges).toBe(0);
    const by = Object.fromEntries(d.vertices.map((v) => [v.id, v]));
    expect(by.lane).toMatchObject({ container: true, headerFill: "#dae8fc" });
    expect(by.api).toMatchObject({ parent: "lane", shape: "rounded" });
    expect(by.db).toMatchObject({ parent: "lane", shape: "cylinder" });
    expect(by.user).toMatchObject({ shape: "ellipse" });
    expect(d.edges.map((e) => e.lineStyle)).toEqual(["solid", "dashed"]);
  });

  it("an answer pasted in the window imports into the canvas; text without a diagram is refused", async () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    expect(await store.importDiagramText("Sorry, I cannot draw that.", board.id)).toBe(false);
    expect(board.childrenIds).toHaveLength(0);
    expect(await store.importDiagramText("Sure!\n```xml\n" + EXAMPLE + "\n```", board.id)).toBe(true);
    expect(board.childrenIds).toHaveLength(2); // the lane and the user; the lane holds the other two
    expect(await store.importDiagramText("<mxGraphModel><root><mxCell id='0'></root></mxGraphModel>", board.id)).toBe(false);
  });
});
