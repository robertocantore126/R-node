# Freeform topic

Branch: `feat/freeform-topic`.

Right-click a topic and choose **New freeform topic**, immediately below **New code topic**. This creates a connected 720 x 480 canvas with a grid.

- Double-click an empty part of the canvas to create and edit a text item. The context menu also offers **Add text / node**. Use the usual Inspector to give an item a box/shape, colour and text formatting.
- Drag existing topics into the canvas. Their subtrees and relative geometry are preserved. Drag the items inside to reposition them.
- Drop plain text, image files or browser images into the canvas. Images become independent movable items. Existing image attachments can also be dragged into it.
- Paste text or images with the canvas selected. Shape-library drops are positioned at the pointer.
- Ordinary topics inside a freeform canvas have a transparent fill by default. Picking Fill in the Inspector or a context-menu colour gives text-only items a visible box; resetting the colour restores transparency. Explicitly chosen fills are preserved.
- Link internal topics using R-node's existing relationship command.
- Move the outer canvas to move its contents together. Resize using its lower-right handle or the Inspector's canvas width/height fields. Shrinking stops at the occupied content bounds. Adding or enlarging content grows the affected canvas and its enclosing canvases in the same undo step.
- Moving a topic already inside a canvas preserves its parent and connector. Left-edge resizing preserves the opposite edge and stops at the canvas margin.
- Deleting a selected image removes its image reference; its topic, notes, quizzes and other data remain available. Delete the topic explicitly when you want to remove all of it.
- Changes use the existing document operations and undo/redo. Local coordinates are serialized with the document. Canvas contents remain fixed through automatic layout and global reflow.

This is a native freeform diagram surface, not an embedded diagrams.net application. R-node's existing shape and relationship tools apply; draw.io file import and its complete toolbox are not included.

## Validation

Automated coverage includes the original freeform tests plus `tests/freeformHardening.test.ts`: the five pre-merge defects now have regressions requiring correct behavior, with additional coverage for nested canvas growth, subtree capture with negative offsets, and containment during resize. `tests/rnodeFile.test.ts` also writes and rereads an actual SQLite `.rnode` container, preserving local geometry, relationships, notes and image bytes.

Latest automated checks: `npm test` passed all 594 tests across 34 files, `npm run typecheck` passed, `npm run build` passed, `npm run check:map` passed, and `git diff --check` passed. The hit-test regression uses a simulated Canvas2D context and does not establish pixel fidelity or real pointer behavior.

Browser UI smoke and the real-browser parity harness are **not verified** in this session: the browser automation inventory returned no available browsers. Desktop/Tauri runtime is also untested. Existing general PDF limitations still apply; the new board surface is handled by Canvas/PNG, the HTML viewer and SVG.

Manual completion at `http://127.0.0.1:5173/` (start with `npm run dev`):

1. Create a freeform topic via right click; confirm the menu item is directly below Code topic.
2. Double-click twice at different positions, type text, commit, then drag each item.
3. Drag an existing topic and its subtree into the canvas. Move an internal descendant and confirm its parent stays the same. Undo and redo.
4. Drop two images, move/resize them, paste text, and drop a library shape.
5. Add a relationship between two internal items. Confirm the line is visible.
6. Resize internal topics from the left, shrink the canvas to its content limits, and grow nested content. Verify undo/redo, then save and reopen the document. Delete an image from a topic carrying notes/quiz and confirm those remain.
7. Open `/dev/parity.html` and require zero divergences before marking visual validation complete.
