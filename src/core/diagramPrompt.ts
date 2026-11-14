/**
 * The prompt behind "Diagram from AI": only the OUTPUT rules, the format the
 * importer (core/drawio.ts) needs to read the answer, followed by the user's
 * material. Content, layout and style are left to the AI.
 */

export function diagramPrompt(material: string): string {
  return `OUTPUT
- Answer with ONE \`\`\`xml code block containing a single <mxGraphModel> (no <mxfile> wrapper, no compression), and nothing else after it.
- Start the <root> with <mxCell id="0"/> and <mxCell id="1" parent="0"/>.
- Every box: vertex="1", a unique id, value = its label, and <mxGeometry x y width height as="geometry"/>.
- Every arrow: edge="1", parent="1", and BOTH source and target set to ids of boxes that exist. Never leave an arrow end loose; never point an arrow at another arrow.
- Escape &, < and > inside labels (&amp; &lt; &gt;). For a line break inside a label use &lt;br&gt; together with html=1.

${material.trim() || "(describe here what the diagram should show, or paste your notes)"}
`;
}
