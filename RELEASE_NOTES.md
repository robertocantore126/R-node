# R-node 0.1.1 — gallery build

Build date: 2026-08-19 · Branch: `gallery-node` · Commit `ae4d313`

## What's new

**Gallery topics**

- Fill a topic with a grid of captioned pictures — five per row, wrapping.
- Drop images onto a gallery topic from your desktop **or from a web browser** — several at a time, as one undo step. The drag ghost previews exactly where they will land.
- Right-click any topic and choose **New gallery topic** to start one.
- Click a caption to select its cell and edit the caption text in the Inspector (text is pre-selected, so typing replaces it).
- Double-click no longer opens the text editor on a gallery topic — its body is pictures. The Inspector's title field says where to rename it.
- You can still export a single gallery topic as a PNG or JPEG image.

## Fixes

- **Open a document, and a title's formatting survives.** Headings, paragraph gaps and list indents used to be silently flattened the next time you saved. They are now kept through every open path (`.rnode.json`, `.rnode.zip`, and opening your own saved file).
- **Gallery grids stay the right height.** Changing the cell shape in the Inspector no longer leaves dead space or paints the grid over the title, and exported maps now match what you see on screen.
- **Image drags from a browser now work.** Cross-application drags arrive without a MIME type and used to be rejected; files with a known image extension are now accepted and still get the right format recorded (PNG keeps its alpha).

## For developers

- The dev server binds to IPv4 explicitly, so the Tauri desktop window and browser tabs always reach the same server.
- Tracer 2.0 (dev-only instrumentation): every capture now reports subsystem coverage, ui→cmd→state→persist→rust transitions, and state changes that never reached storage.

## Install

Run `R-node_0.1.1_x64-setup.exe` (NSIS installer) or install the MSI. The app is currently unsigned — Windows SmartScreen may warn; choose *More info → Run anyway*.

Full build and developer docs: see `README.md` in this package or the repository.
