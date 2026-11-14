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
    // Holders first: the VPC's contents come after every top-level box.
    expect(Object.keys(by)).toEqual(["vpc", "user", "note", "ec2", "db"]);
    expect(by.ec2.parent).toBe("vpc");
    expect(by.user.parent).toBeUndefined();
    // A swimlane: its fillColor is the header, its body is see-through.
    expect(by.vpc).toMatchObject({ headerFill: "#f5f5f5", fill: "transparent", shape: "rect" });
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
    expect(e1).toMatchObject({ source: "user", target: "ec2", label: "HTTPS", connector: "elbow", lineStyle: "solid", endArrow: "triangle", startArrow: "none", fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 } });
    expect(e2).toMatchObject({ label: "SQL", lineStyle: "dashed", endArrow: "open", startArrow: "circle", color: "#82b366", width: 2, connector: "straight" });
  });

  it("reads draw.io's compressed clipboard format", async () => {
    const model = extractDrawioXml(AI_ANSWER)!.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/)![0];
    const text = `<mxfile><diagram id="x" name="P">${await compressed(model)}</diagram></mxfile>`;
    const d = (await parseDrawio(text))!;
    expect(d.vertices.map((v) => v.id)).toEqual(["vpc", "user", "note", "ec2", "db"]);
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
    // Top level: VPC, User, note. EC2 and RDS live INSIDE the VPC container.
    const [vpc, user] = board.childrenIds.map((id) => store.doc.requireNode(id));
    expect(board.childrenIds).toHaveLength(3);
    expect(vpc.style).toMatchObject({ freeform: true, container: { headerFill: "#f5f5f5" }, width: 400 });
    // The leftmost box (User, x=20) lands at the padding; the topmost (VPC, y=100) under the title band.
    expect(user.style.freeformPosition!.x).toBe(FREEFORM_PADDING);
    expect(vpc.style.freeformPosition!.y).toBe(FREEFORM_HEADER + FREEFORM_PADDING);
    const [ec2, db] = vpc.childrenIds.map((id) => store.doc.requireNode(id));
    expect(ec2).toMatchObject({ title: "EC2\nweb" });
    expect(ec2.style).toMatchObject({ width: 120, height: 60, fill: "#dae8fc", stroke: "#6c8ebf", fontWeight: 700 });
    // Relative to the VPC, kept as drawn: 60px down clears the 36px title band.
    expect(ec2.style.freeformPosition).toEqual({ x: 40, y: 60 });
    expect(db.style.freeformPosition).toEqual({ x: 240, y: 60 });
    expect(vpc.style.height).toBe(300);
    const ids = new Set([...board.childrenIds, ...vpc.childrenIds]);
    const rels = store.sheet.relationships.filter((r) => ids.has(r.fromId));
    expect(rels.map((r) => r.label)).toEqual(["HTTPS", "SQL"]);
    expect(store.getSnapshot().selection).toHaveLength(3);
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
    const canvas = Object.values(store.sheet.nodes).find((n) => n.style.freeform && !n.style.container)!;
    expect(canvas.parentId).toBe(root);
    expect(canvas.childrenIds).toHaveLength(3);
  });

  it("nested lanes: children under a short swimlane header move down and the lane grows", async () => {
    const { store, board } = setup();
    const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="pool" value="Pool" style="swimlane;startSize=20;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="300" height="200" as="geometry"/></mxCell>
      <mxCell id="lane" value="Lane" style="swimlane;startSize=20;fillColor=#fff2cc;" vertex="1" parent="pool"><mxGeometry x="0" y="20" width="300" height="180" as="geometry"/></mxCell>
      <mxCell id="t" value="Task" style="rounded=1;" vertex="1" parent="lane"><mxGeometry x="20" y="25" width="100" height="40" as="geometry"/></mxCell>
      <mxCell id="g" value="" style="group" vertex="1" parent="lane"><mxGeometry x="150" y="30" width="100" height="100" as="geometry"/></mxCell>
      <mxCell id="u" value="In a group" style="" vertex="1" parent="g"><mxGeometry x="0" y="10" width="100" height="40" as="geometry"/></mxCell>
      </root></mxGraphModel>`;
    store.importDrawio(board.id, (await parseDrawio(xml))!);
    const pool = store.doc.requireNode(board.childrenIds[0]);
    const lane = store.doc.requireNode(pool.childrenIds[0]);
    expect(pool.childrenIds).toHaveLength(1);
    // Lane at y=20 inside the pool: under the 36px band, so it moves down by 22.
    // The lane itself grows by 17 (its task at y=25 moves to 42), so the pool
    // ends at the lane's bottom, flush: 42 + 180 + 17.
    expect(lane.style.freeformPosition).toEqual({ x: 0, y: 42 });
    expect(lane.style.height).toBe(197);
    expect(pool.style.height).toBe(239);
    // The task (y=25) and the grouped box (group y=30 + 10) sit in the lane; the group itself is gone.
    const inLane = lane.childrenIds.map((id) => store.doc.requireNode(id));
    expect(inLane.map((n) => n.title)).toEqual(["Task", "In a group"]);
    expect(inLane.map((n) => n.style.freeformPosition)).toEqual([{ x: 20, y: 42 }, { x: 150, y: 57 }]);
    expect(lane.style.container).toEqual({ headerFill: "#fff2cc" });
    // The canvas can grow, never shrink, past what the import holds.
    expect(store.doc.requireNode(lane.id).style.height!).toBeGreaterThanOrEqual(197);
  });
});

describe("a diagram that was cut off", () => {
  it("imports everything up to the last complete cell (the user's AWS answer, missing </root></mxGraphModel>)", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("tests/fixtures/drawio-aws-truncated.xml", "utf8");
    expect(text).not.toContain("</mxGraphModel>");
    const d = (await parseDrawio(text))!;
    expect(d).not.toBeNull();
    expect(d.truncated).toBe(true);
    expect(d.vertices).toHaveLength(22);
    expect(d.edges).toHaveLength(13);
  });

  it("a cell cut in half is dropped, the ones before it kept", async () => {
    const text = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="A" style="" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="b" value="B" style="" vertex="1" parent="1"><mxGeometry x="200" y="0" wid`;
    const d = (await parseDrawio(text))!;
    expect(d.vertices.map((v) => v.id)).toEqual(["a"]);
    expect(d.truncated).toBe(true);
  });

  it("a complete diagram is not marked as cut off", async () => {
    const d = (await parseDrawio(AI_ANSWER))!;
    expect(d.truncated).toBeUndefined();
  });
});

describe("frames drawn behind other boxes", () => {
  it("a box that encloses others becomes their container, nested by size (the user's AWS answer)", async () => {
    const { readFileSync } = await import("node:fs");
    const d = (await parseDrawio(readFileSync("tests/fixtures/drawio-aws-truncated.xml", "utf8")))!;
    const by = Object.fromEntries(d.vertices.map((v) => [v.id, v]));
    expect(by.aws_cloud).toMatchObject({ container: true, align: "left" });
    expect(by.aws_cloud.parent).toBeUndefined();
    expect(by.vpc_box).toMatchObject({ container: true, parent: "aws_cloud", dashed: true });
    expect(by.public_subnet).toMatchObject({ container: true, parent: "vpc_box" });
    expect(by.alb.parent).toBe("public_subnet");
    expect(by.ec2_ecs.parent).toBe("private_app_subnet");
    expect(by.rds.parent).toBe("private_db_subnet");
    expect(by.cloudfront.parent).toBe("aws_cloud");
    expect(by.cloudwatch.parent).toBe("aws_cloud");
    // Outside every frame, and boxes that hold nothing stay boxes.
    expect(by.users.parent).toBeUndefined();
    expect(by.route53.container).toBe(false);
  });

  it("imports into nested canvases with each box where it was drawn", async () => {
    const { readFileSync } = await import("node:fs");
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    store.importDrawio(board.id, (await parseDrawio(readFileSync("tests/fixtures/drawio-aws-truncated.xml", "utf8")))!);
    const find = (title: string) => Object.values(store.sheet.nodes).find((n) => n.title.startsWith(title))!;
    const cloud = find("AWS Cloud"), vpc = find("Amazon VPC"), pub = find("Public Subnet"), alb = find("Application Load");
    expect(cloud.parentId).toBe(board.id);
    expect(vpc.parentId).toBe(cloud.id);
    expect(pub.parentId).toBe(vpc.id);
    expect(alb.parentId).toBe(pub.id);
    expect(cloud.style).toMatchObject({ freeform: true, align: "left", textColor: "#232f3e" });
    // ALB at (395,310), Public Subnet at (370,250): 25 right, 60 down, clear of the band.
    expect(alb.style.freeformPosition).toEqual({ x: 25, y: 60 });
  });
});
