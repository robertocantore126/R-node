// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extractDrawioXml, looksLikeDrawio, parseDrawio, shapeFor } from "../src/core/drawio";
import { measureNode } from "../src/layout/measure";
import { FREEFORM_HEADER, FREEFORM_PADDING } from "../src/core/freeform";
import { EditorStore } from "../src/editor/store";

/** The shape of answer an assistant gives: prose, a fence, html labels, a container. */
const AI_ANSWER = `Here is your diagram:

\`\`\`xml
<mxfile host="app.diagrams.net">
  <diagram name="Page-1" id="p1">
    <mxGraphModel dx="1000" dy="600" grid="1">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="vpc" value="VPC" style="swimlane;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
          <mxGeometry x="200" y="100" width="400" height="300" as="geometry" />
        </mxCell>
        <mxCell id="ec2" value="EC2&lt;br&gt;&lt;b&gt;web&lt;/b&gt;" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;" vertex="1" parent="vpc">
          <mxGeometry x="40" y="60" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="db" value="RDS" style="shape=cylinder3;whiteSpace=wrap;html=1;" vertex="1" parent="vpc">
          <mxGeometry x="240" y="60" width="60" height="80" as="geometry" />
        </mxCell>
        <mxCell id="user" value="User" style="ellipse;whiteSpace=wrap;html=1;dashed=1;" vertex="1" parent="1">
          <mxGeometry x="20" y="120" width="80" height="80" as="geometry" />
        </mxCell>
        <mxCell id="note" value="Reads go to the replica" style="text;html=1;fontColor=#990000;" vertex="1" parent="1">
          <mxGeometry x="220" y="420" width="200" height="30" as="geometry" />
        </mxCell>
        <mxCell id="e1" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="user" target="ec2">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="e2" style="dashed=1;endArrow=open;startArrow=oval;strokeColor=#82b366;strokeWidth=2;" edge="1" parent="1" source="ec2" target="db">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="e2l" value="SQL" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e2">
          <mxGeometry x="-0.1" relative="1" as="geometry"><mxPoint as="offset" /></mxGeometry>
        </mxCell>
        <mxCell id="e3" style="endArrow=classic;" edge="1" parent="1" source="db">
          <mxGeometry relative="1" as="geometry"><mxPoint x="700" y="200" as="targetPoint" /></mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
\`\`\`

Let me know if you want changes.`;

async function compressed(xml: string): Promise<string> {
  const bytes = new TextEncoder().encode(encodeURIComponent(xml));
  const reader = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }).pipeThrough(new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
  }
  return btoa(String.fromCharCode(...parts));
}

describe("draw.io reader", () => {
  it("finds the diagram inside an assistant's answer", () => {
    expect(looksLikeDrawio(AI_ANSWER)).toBe(true);
    expect(looksLikeDrawio("just some <b>text</b>")).toBe(false);
    const xml = extractDrawioXml(AI_ANSWER)!;
    expect(xml.startsWith("<mxfile")).toBe(true);
    expect(xml.endsWith("</mxfile>")).toBe(true);
  });

  it("reads boxes with absolute geometry, labels, colours and shapes", async () => {
    const d = (await parseDrawio(AI_ANSWER))!;
    const by = Object.fromEntries(d.vertices.map((v) => [v.id, v]));
    expect(Object.keys(by)).toEqual(["vpc", "ec2", "db", "user", "note"]);
    expect(by.ec2).toMatchObject({ x: 240, y: 160, w: 120, h: 60, label: "EC2\nweb", shape: "rounded", fill: "#dae8fc", stroke: "#6c8ebf", bold: true });
    expect(by.db).toMatchObject({ x: 440, y: 160, kind: "cylinder3", shape: "cylinder" });
    expect(by.vpc).toMatchObject({ container: true, kind: "swimlane" });
    expect(by.user).toMatchObject({ shape: "ellipse", dashed: true });
    expect(by.note).toMatchObject({ text: true, shape: "none", textColor: "#990000" });
  });

  it("reads arrows: style, heads, anchors, labels from child cells; loose ones are skipped", async () => {
    const d = (await parseDrawio(AI_ANSWER))!;
    expect(d.skippedEdges).toBe(1);
    const [e1, e2] = d.edges;
    expect(e1).toMatchObject({ source: "user", target: "ec2", label: "HTTPS", connector: "elbow", endArrow: "triangle", startArrow: "none", fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 } });
    expect(e2).toMatchObject({ label: "SQL", lineStyle: "dashed", endArrow: "open", startArrow: "circle", color: "#82b366", width: 2, connector: "straight" });
  });

  it("reads draw.io's compressed clipboard format", async () => {
    const model = extractDrawioXml(AI_ANSWER)!.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/)![0];
    const text = `<mxfile><diagram id="x" name="P">${await compressed(model)}</diagram></mxfile>`;
    const d = (await parseDrawio(text))!;
    expect(d.vertices.map((v) => v.id)).toEqual(["vpc", "ec2", "db", "user", "note"]);
    expect(d.edges).toHaveLength(2);
  });

  it("maps draw.io and flowchart-stencil names onto R-node outlines", () => {
    const cases: [string, string][] = [
      ["ellipse", "ellipse"], ["rhombus", "diamond"], ["mxgraph.flowchart.decision", "diamond"],
      ["cylinder3", "cylinder"], ["mxgraph.flowchart.database", "cylinder"], ["document", "document"],
      ["parallelogram", "parallelogram"], ["mxgraph.flowchart.data", "parallelogram"], ["triangle", "triangle"],
      ["process", "process"], ["mxgraph.flowchart.predefined_process", "process"], ["note", "note"],
      ["mxgraph.flowchart.terminator", "capsule"], ["somethingUnknown", "rect"],
    ];
    for (const [kind, shape] of cases) expect([kind, shapeFor(kind, {})]).toEqual([kind, shape]);
    expect(shapeFor("", { rounded: "1" })).toBe("rounded");
    expect(shapeFor("", { rounded: "1", arcSize: "50" })).toBe("capsule");
  });

  it("returns null for broken XML", async () => {
    expect(await parseDrawio("<mxGraphModel><root><mxCell id='0'></root></mxGraphModel>")).toBeNull();
  });
});

describe("draw.io import into a canvas", () => {
  function setup() {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    return { store, board };
  }

  it("creates items and arrows in one undo step, top-left in the canvas",async () => {
    const { store, board } = setup();
    const before = Object.keys(store.sheet.nodes).length;
    const d = (await parseDrawio(AI_ANSWER))!;
    expect(store.importDrawio(board.id, d)).toEqual({ shapes: 5, arrows: 2 });
    const items = board.childrenIds.map((id) => store.doc.requireNode(id));
    expect(items).toHaveLength(5);
    // The leftmost box (User, x=20) lands at the padding; the topmost (VPC, y=100) under the title band.
    expect(items[3].style.freeformPosition!.x).toBe(FREEFORM_PADDING);
    expect(items[0].style.freeformPosition!.y).toBe(FREEFORM_HEADER + FREEFORM_PADDING);
    expect(items[1]).toMatchObject({ title: "EC2\nweb" });
    expect(items[1].style).toMatchObject({ width: 120, height: 60, fill: "#dae8fc", stroke: "#6c8ebf", fontWeight: 700 });
    const rels = store.sheet.relationships.filter((r) => board.childrenIds.includes(r.fromId));
    expect(rels.map((r) => r.label)).toEqual(["HTTPS", "SQL"]);
    expect(store.getSnapshot().selection).toHaveLength(5);
    store.undo();
    expect(Object.keys(store.sheet.nodes).length).toBe(before);
    expect(store.sheet.relationships.some((r) => r.label === "HTTPS")).toBe(false);
  });

  it("imported boxes keep draw.io's size, even small ones and diamonds", async () => {
    const { store, board } = setup();
    const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="db" style="shape=cylinder3;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="40" height="60" as="geometry"/></mxCell>
      <mxCell id="b" value="?" style="rhombus;" vertex="1" parent="1"><mxGeometry x="100" y="0" width="100" height="80" as="geometry"/></mxCell>
      <mxCell id="c" value="h" style="shape=hexagon;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="120" height="70" as="geometry"/></mxCell>
      </root></mxGraphModel>`;
    store.importDrawio(board.id, (await parseDrawio(xml))!);
    const sizes = board.childrenIds.map((id) => measureNode(store.doc.requireNode(id)));
    expect(sizes.map((s) => [s.w, s.h])).toEqual([[40, 60], [100, 80], [120, 70]]);
  });

  it("a second import goes below what the canvas already holds", async () => {
    const { store, board } = setup();
    const d = (await parseDrawio(AI_ANSWER))!;
    store.importDrawio(board.id, d);
    const firstBottom = Math.max(...board.childrenIds.map((id) => store.doc.requireNode(id).style.freeformPosition!.y));
    store.importDrawio(board.id, d);
    const second = board.childrenIds.slice(5).map((id) => store.doc.requireNode(id).style.freeformPosition!.y);
    expect(Math.min(...second)).toBeGreaterThan(firstBottom);
  });

  it("pasting the answer on an ordinary topic makes a canvas under it", async () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    const root = store.sheet.rootNodeId;
    store.select(root);
    await store.paste(root, AI_ANSWER);
    const canvas = Object.values(store.sheet.nodes).find((n) => n.style.freeform)!;
    expect(canvas.parentId).toBe(root);
    expect(canvas.childrenIds).toHaveLength(5);
  });
});
