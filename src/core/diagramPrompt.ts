/**
 * The prompt behind "Diagram from AI": it asks any assistant for draw.io XML
 * restricted to what R-node's importer (core/drawio.ts) actually draws, so the
 * answer pastes into a freeform canvas without silent losses. Every shape,
 * style key and arrow head named here has a mapping there; the test in
 * tests/diagramPrompt.test.ts parses the prompt's own example to keep the two
 * in step.
 */
import { DIAGRAM_PALETTE } from "./paint";

export const DIAGRAM_KINDS = {
  auto: "Pick the diagram type that explains the material best.",
  flowchart: "A flowchart: start/end capsules, process boxes, decision diamonds with labelled yes/no exits, flowing top to bottom.",
  architecture:
    "A system / cloud architecture diagram: group components in containers (e.g. cloud, region, VPC, subnet, cluster) using swimlane containers, label every box with the service name and its role, and draw the request/data flows as labelled arrows. Use cylinders for databases and storage.",
  process: "A process with swimlanes: one lane per actor or team (a pool of lanes), steps as boxes inside the lanes, hand-offs as arrows between lanes, flowing left to right.",
  concept: "A concept map: key ideas as boxes, relationships as arrows whose labels are verbs (\"causes\", \"is part of\", \"depends on\").",
  hierarchy: "A hierarchy / tree: the main idea at the top, levels below it, arrows from parent to child.",
  sequence: "A timeline or sequence: steps left to right in order, with short notes under the important ones.",
  comparison: "A comparison: one container per option, the same rows of properties inside each, side by side.",
} as const;
export type DiagramKind = keyof typeof DIAGRAM_KINDS;

/** A minimal example in exactly the dialect the importer reads. */
export const DIAGRAM_PROMPT_EXAMPLE = `<mxGraphModel>
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="lane" value="Backend" style="swimlane;startSize=30;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="200" y="40" width="360" height="200" as="geometry" />
    </mxCell>
    <mxCell id="api" value="API server" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6c8ebf;" vertex="1" parent="lane">
      <mxGeometry x="30" y="70" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="db" value="Orders DB" style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="lane">
      <mxGeometry x="230" y="60" width="80" height="90" as="geometry" />
    </mxCell>
    <mxCell id="user" value="User" style="ellipse;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
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

export function diagramPrompt(material: string, kind: DiagramKind = "auto"): string {
  const palette = DIAGRAM_PALETTE.filter((p) => p.name !== "Dark")
    .map((p) => `${p.name.toLowerCase()}: fillColor=${p.fill};strokeColor=${p.stroke}`)
    .join("\n  ");
  return `You are drawing a diagram for a visual note-taking app that imports draw.io XML.

GOAL
${DIAGRAM_KINDS[kind]}
Make it explain the material below clearly: someone should understand the main structure in 10 seconds.

OUTPUT
- Answer with ONE \`\`\`xml code block containing a single <mxGraphModel> (no <mxfile> wrapper, no compression), and nothing else after it.
- Start the <root> with <mxCell id="0"/> and <mxCell id="1" parent="0"/>.
- Every box: vertex="1", a unique id, value = its label, and <mxGeometry x y width height as="geometry"/>.
- Every arrow: edge="1", parent="1", and BOTH source and target set to ids of boxes that exist. Never leave an arrow end loose; never point an arrow at another arrow.
- Escape &, < and > inside labels (&amp; &lt; &gt;). For a line break inside a label use &lt;br&gt; together with html=1.

SHAPES (use only these styles; anything else becomes a plain rectangle)
- process / component / step: rounded=1;whiteSpace=wrap;html=1;   (or plain rectangle: whiteSpace=wrap;html=1;)
- start / end: rounded=1;arcSize=50;whiteSpace=wrap;html=1;
- decision: rhombus;whiteSpace=wrap;html=1;
- database / storage / queue: shape=cylinder3;whiteSpace=wrap;html=1;
- document / report / file: shape=document;whiteSpace=wrap;html=1;
- input / output data: shape=parallelogram;whiteSpace=wrap;html=1;
- predefined process / subroutine: shape=process;whiteSpace=wrap;html=1;
- person / actor / external system: ellipse;whiteSpace=wrap;html=1;
- note / comment: shape=note;whiteSpace=wrap;html=1;
- other: hexagon / triangle / cloud as the first style token
- free text with no box: text;html=1;align=left;
- container (group, swimlane, region, layer, team): swimlane;startSize=30;  Boxes inside it use parent="<container id>" and coordinates RELATIVE to the container's top-left, with y >= 40 so they sit below its title band. Containers may hold containers (a pool of lanes). Do not use style "group".
- Do not use icon stencils (mxgraph.aws4.*, mxgraph.azure.*, images): write the service name in a normal box instead and colour it by category.

COLOURS (fill + matching outline; dark text is the default)
  ${palette}
Use colour to mean something (one colour per layer, team or kind of thing) and keep to 3-4 colours. On a swimlane, fillColor colours its title band. fontColor sets text colour; fillOpacity=50 a lighter fill; dashed=1 a dashed outline; fontStyle=1 bold.

ARROWS
- endArrow=block (filled), open, none, diamond or oval; startArrow the same for the other end.
- dashed=1 for optional / async / indirect flows. edgeStyle=orthogonalEdgeStyle for right-angle routing. strokeColor and strokeWidth=2 to stand out.
- Put the arrow's label in its value: short verbs or data names ("sends order", "HTTPS", "yes", "no").

LAYOUT
- Coordinates on a 10px grid. Typical box 120x60 (database 80x90, decision 120x80). At least 40px between boxes, more where arrows carry labels.
- One main direction (top to bottom, or left to right), aligned rows and columns, no overlapping boxes, arrows crossing as little as possible.
- Labels short: 1-6 words per box. Put longer explanations in a note or text box next to the thing they explain, not inside it.
- Cover the material's important points; leave out filler. Up to about 40 boxes; if the material is bigger, show the main structure and group details inside containers.

EXAMPLE of the exact format:
\`\`\`xml
${DIAGRAM_PROMPT_EXAMPLE}
\`\`\`

MATERIAL
${material.trim() || "(describe here what the diagram should show, or paste your notes)"}
`;
}
