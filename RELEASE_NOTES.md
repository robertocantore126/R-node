# R-node 0.4.0

A diagram workspace, XMind's look, and maps that stay fast at any zoom. Maps saved with earlier versions open as before.

## Diagrams

- **Diagram** is a document type of its own, chosen at New (and the one the app starts on). Shapes live on draw.io-style pages that grow with the drawing.
- 23 flowchart shapes, including actor, containers, frames, callout, cloud, cube, star and arrows. Containers and frames draw behind their items, with the label at the top or bottom.
- **Tab grows a tree**: children are rectangles, grandchildren and deeper are plain text. Drag a shape onto another to make it that shape's child, and deleting a shape deletes the tree it grew.
- Elbow arrows route around boxes. Any arrow can take bends and a draggable label, and draw.io bend points are imported.
- "Diagram from AI" and pasting draw.io XML still turn an answer into a diagram; a diagram that was cut off is recovered.
- Snap to a 10 px grid (hold Alt to place freely), align, distribute, and bring to front or send to back. Marquee and group drag, resize from any corner, exact X/Y/W/H in the Inspector, and arrow keys nudge the selection.
- **Links**: an invisible group next to Group, shown only while one of its topics (or the link) is selected, or with the eye toggle on. It takes no layout room and is not exported.
- Pictures dropped or pasted on a shape go into it: fixed-size shapes scale the picture to fit, and an empty shape grows to hold it.

## Look

- A new **XMind theme** and the Xmind variable font; main topics and subtopics are 16 px / 500.
- A **Fog** theme, plus background patterns and a colour wheel beside the map.
- Faster zoom: bigger steps and wheel zoom that follows the scroll distance; the page itself never zooms.
- Vector text from 50% zoom, an opaque canvas so text gets subpixel antialiasing, tapered branches and steady tree shadows.
- New Matte logo, rounded framed UI chrome, and quiz/flashcard badges. Matte with a dot grid is the default.

## Study

- Group menu: **Copy as quiz prompt** and **Copy as flashcards prompt** for the topics a group encloses.
- In a diagram, Tab children are nested under their shape in study prompts; Tab arrows are not repeated, and links are tagged `[link]`.

## Performance

- Far-zoom diagrams: arrow routes are cached with a spatial obstacle index, elbows are simple polylines, and level-of-detail skips tiny text and arrowheads and paints tiny pictures as cached average-colour rectangles.
- Diagram checks and edits are incremental, and the scene bitmap is reused while zooming in.
- Web `.rnode` files are read and written in a single SQLite transaction, and gallery imports are batched as they decode.

## Fixes

- Long pasted text gets a reading width instead of a narrow tower.
- Fixed-size boxes grow to fit their text.
- Diagram PDF and SVG exports draw the page itself, not a canvas box with a "Freeform" label.
- Deleting topics closes quiz or flashcard windows whose topic or group is gone; undo does not bring them back.
- A diagram palette drag is dropped on pointer cancel or window blur, and group menus close when their group is deleted.
- Arrow bends stay put when a page grows left or up, and a Tab tree is laid out again when its shape's text, size or children change.

## Install

- `R-node_0.4.0_x64-setup.exe`: installer (NSIS).
- `R-node_0.4.0_x64_en-US.msi`: installer (MSI).
- `r-node.exe`: portable, runs without installing.

The app is unsigned, so Windows SmartScreen may warn. Choose *More info → Run anyway*.
