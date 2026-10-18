# Freeform topic

Branch: `feat/freeform-topic`.

Right-click a topic and choose **New freeform topic**, immediately below **New code topic**. This creates a connected 720 x 480 canvas with a grid.

- Double-click an empty part of the canvas to create and edit a text item. The context menu also offers **Add text / node**. Use the usual Inspector to give an item a box/shape, colour and text formatting.
- Drag existing topics into the canvas. Their subtrees and relative geometry are preserved. Drag the items inside to reposition them.
- Drop plain text, image files or browser images into the canvas. Images become independent movable items. Existing image attachments can also be dragged into it.
- Paste text or images with the canvas selected. Shape-library drops are positioned at the pointer.
- Link internal topics using R-node's existing relationship command.
- Move the outer canvas to move its contents together. Resize using its lower-right handle or the Inspector's canvas width/height fields.
- Changes use the existing document operations and undo/redo. Local coordinates are serialized with the document. Canvas contents remain fixed through automatic layout and global reflow.

This is a native freeform diagram surface, not an embedded diagrams.net application. R-node's existing shape and relationship tools apply; draw.io file import and its complete toolbox are not included.

## Validation

Automated coverage in `tests/freeform.test.ts`: creation undo/redo, local coordinates after moving/reflow, subtree transfer undo/redo, live drag undo, JSON round trip, deletion undo, two-dimensional resize undo, image transfer undo, nested canvases/freeform sheet layout, cycle prevention, SVG foreground/background order. Final automated checks: `npm test` passed all 576 tests across 32 files, `npm run typecheck` passed, `npm run build` passed, `npm run check:map` passed, and `git diff --check` passed. The development server responded HTTP 200 at `http://127.0.0.1:5173/`.

Browser UI smoke and the real-browser parity harness are **not verified** in this session: the browser automation inventory returned no available browsers. Desktop/Tauri runtime is also untested. Existing general PDF limitations still apply; the new board surface is handled by Canvas/PNG, the HTML viewer and SVG.

Manual completion at `http://127.0.0.1:5173/` (start with `npm run dev`):

1. Create a freeform topic via right click; confirm the menu item is directly below Code topic.
2. Double-click twice at different positions, type text, commit, then drag each item.
3. Drag an existing topic and its subtree into the canvas. Undo and redo.
4. Drop two images, move/resize them, paste text, and drop a library shape.
5. Add a relationship between two internal items. Confirm the line is visible.
6. Move and resize the canvas, undo/redo, save and reopen the document.
7. Open `/dev/parity.html` and require zero divergences before marking visual validation complete.
