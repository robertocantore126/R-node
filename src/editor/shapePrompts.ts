/**
 * The prompts the shape library hands to an LLM (T23 / T24).
 *
 * They live in code, not in a doc, because the panel's "copy prompt" button
 * serves them: one definition means the button and the documentation cannot
 * drift apart. Both end by demanding JSON and nothing else — the paste box
 * parses what comes back, and a sentence of preamble is a parse error.
 *
 * They differ on colour, and the difference is the point. A STRUCTURE stores
 * none: its topics inherit the host map's palette, because a colour saved from
 * a dark editor would stay unreadable on a light theme forever. A SHAPE stores
 * its own, because those colours contrast with each other inside the drawing —
 * a yellow moon is yellow on either theme.
 *
 * Neither asks about the label. A shape is a BACKGROUND: the topic's text lays
 * out across it exactly as it would on a rectangular topic, and is painted on
 * top. Two earlier attempts confined the text to the drawing's interior — an
 * LLM-supplied box, then a derived one — and both wrapped a normal title into a
 * one-word column.
 */

/** A single topic drawn as artwork. Fixed size, editable label. */
export const SHAPE_NODE_PROMPT = `Generate an R-node SHAPE NODE as JSON. Reply with the JSON object only — no prose, no markdown fence.

Shape: <describe it here, e.g. "a crescent moon", "a shield", "a gear">

Format:
{
  "kind": "shape",
  "name": "short name",
  "width": 220,
  "height": 220,
  "parts": [
    { "d": "M… Z", "fill": "#rrggbb" }
  ]
}

Rules:
- Every "d" is SVG path data in a NORMALISED box: x and y run 0..1, origin top-left. It is scaled to the node's real size, so never use pixels.
- Use only the commands M, L, H, V, C, S, Q, T, A, Z. Close every subpath with Z. No transforms, no styling attributes, no <svg> wrapper.
- Parts are painted in order, first to last: put the silhouette first and the details on top of it.
- "fill" is a hex colour, OR one of the theme tokens "accent", "surface", "text", "muted" if you want that part to follow the map's palette instead of a fixed colour. A part may also carry "stroke" and "strokeWidth" (in the same 0..1 units), and "rule": "evenodd" when a subpath is meant to cut a hole.
- Colours are part of the drawing here, unlike text colour: a yellow moon should be yellow on a light map and on a dark one. Choose colours that read on BOTH a white and a near-black background — avoid pure white or pure black for the silhouette.
- Keep it to at most 12 parts. This is an icon, not a traced photograph.
- Later parts must stay INSIDE the silhouette drawn by the first one, or they will spill over the edge: the canvas does not clip them.
- Do NOT describe where the label goes. The drawing is a background: R-node lays the topic's text over it, wrapped across the whole node, exactly as on a rectangular topic. Draw the shape and nothing else.
- Prefer ONE closed path over clever fill rules. A crescent is a single outline — an outer arc out and an inner arc back — not a disc with a bite taken by "evenodd". Fill rules are for real holes, like a ring.
- "width" and "height" are the node's fixed size in world units. Keep the aspect ratio of the drawing. 220 is a good default.

Worked example — a two-colour shield:
{
  "kind": "shape",
  "name": "Shield",
  "width": 200,
  "height": 220,
  "parts": [
    { "d": "M0.50,0.02 L0.95,0.18 L0.95,0.55 C0.95,0.80 0.75,0.94 0.50,0.98 C0.25,0.94 0.05,0.80 0.05,0.55 L0.05,0.18 Z", "fill": "#8c2f39" },
    { "d": "M0.50,0.14 L0.84,0.26 L0.84,0.54 C0.84,0.72 0.68,0.83 0.50,0.87 C0.32,0.83 0.16,0.72 0.16,0.54 L0.16,0.26 Z", "fill": "#e8c37a" }
  ]
}`;

/** A prefabricated subgraph: N native topics plus the edges between them. */
export const STRUCTURE_NODE_PROMPT = `Generate an R-node STRUCTURE as JSON. Reply with the JSON object only — no prose, no markdown fence.

Structure: <describe it here, e.g. "the Kabbalah Tree of Life, 10 nodes and 22 paths">

Format:
{
  "app": "r-node",
  "payload": {
    "rootId": "n1",
    "nodes": [
      {
        "id": "n1",
        "type": "subtopic",
        "parentId": null,
        "childrenIds": ["n2"],
        "title": "Label",
        "position": { "x": 0, "y": 0, "manual": true },
        "style": {},
        "collapsed": false,
        "labels": [], "markers": [], "notes": "", "task": null,
        "metadata": { "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
      }
    ],
    "relationships": [
      { "id": "r1", "fromId": "n1", "toId": "n2" }
    ]
  }
}

Rules — the first four are checked, and a structure that breaks any of them is rejected:
- Every id in a "childrenIds" and every "fromId"/"toId" must be the id of a node in this payload.
- "parentId" and "childrenIds" must agree in BOTH directions: if B is in A's childrenIds then B's parentId is A, and exactly once.
- The node named by "rootId" has "parentId": null. Every other node must be reachable from it by following childrenIds.
- No cycles.
- "position" is in world units, relative to the root at (0,0). x grows right, y grows DOWN. "manual" is always true: the geometry you draw is kept exactly.
- Put the SHAPE of the structure in the coordinates and the connections in "relationships". The parent/child tree only has to be a valid tree — it does not have to match the drawing.
- Relationships are drawn as STRAIGHT segments between the two boxes. Place the coordinates so that a straight line between two connected nodes does not pass through a third one.
- "style" stays empty. No colours, no custom shapes, no images: a structure uses the map's palette and its base shapes, and images are refused outright.
- Space the nodes at least 160 units apart so the boxes do not overlap.

Worked example — a 3-cycle:
{
  "app": "r-node",
  "payload": {
    "rootId": "n1",
    "nodes": [
      { "id": "n1", "type": "subtopic", "parentId": null, "childrenIds": ["n2","n3"], "title": "A", "position": { "x": 0, "y": -100, "manual": true }, "style": {}, "collapsed": false, "labels": [], "markers": [], "notes": "", "task": null, "metadata": { "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } },
      { "id": "n2", "type": "subtopic", "parentId": "n1", "childrenIds": [], "title": "B", "position": { "x": -160, "y": 100, "manual": true }, "style": {}, "collapsed": false, "labels": [], "markers": [], "notes": "", "task": null, "metadata": { "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } },
      { "id": "n3", "type": "subtopic", "parentId": "n1", "childrenIds": [], "title": "C", "position": { "x": 160, "y": 100, "manual": true }, "style": {}, "collapsed": false, "labels": [], "markers": [], "notes": "", "task": null, "metadata": { "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } }
    ],
    "relationships": [
      { "id": "r1", "fromId": "n1", "toId": "n2" },
      { "id": "r2", "fromId": "n2", "toId": "n3" },
      { "id": "r3", "fromId": "n3", "toId": "n1" }
    ]
  }
}`;
