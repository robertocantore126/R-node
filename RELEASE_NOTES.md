# R-node 0.2.0

Everything since 0.1.1. Maps saved with earlier versions open as before.

## What's new

**Freeform topics**

- A free canvas inside the map: double-click to add text or a shape, drop in topics and images, and draw arrows between items.
- Write by hand with a pen or the mouse, using the pen and eraser buttons at the top left of the map. The stroke width is set in pixels, and a Wacom eraser end works too.
- Right-click a canvas to attach a note, shown only through **Show notes**.

**Charts and galleries**

- Chart topics: a fixed board of titled image slots that grows with sliders.
- Notes on chart boxes, with their own subtopics and images.
- Web search panel for album, film and book pictures.

**Study**

- Quizzes and flashcard decks attached to a topic, with resume, scores, review arrows and Find in map.
- Prompts copied for an LLM now carry notes, captions, chart notes, arrows and groups.

**Map and editing**

- In-map search with Ctrl+F.
- draw.io-style arrows with anchors, reconnectable ends, line styles and heads.
- Topic outlines, and group boxes with their own titles and styles.
- Quick topic size controls and an AI expand round trip.
- Dark and vanilla themes.
- AVIF and SVG images.
- Phone-sized PDF export, with vector text and images in every PDF.
- Basic phone support in the web version.

## Fixes

- Closing R-node with unsaved changes now asks first, and each open map tracks its own unsaved state.
- A change made while a save is running stays marked as unsaved.
- Starting an export no longer cancels a save in progress.
- A drag or pan can no longer stay stuck to the pointer, and Escape now cancels a drag.
- Headings, paragraph gaps and list indents survive opening a document.
- Large maps pan and zoom much more smoothly.
- A failure during startup shows a sample map and the reason instead of a blank window.

## Install

- `R-node_0.2.0_x64-setup.exe`: installer (NSIS).
- `R-node_0.2.0_x64_en-US.msi`: installer (MSI).
- `r-node.exe`: portable, runs without installing.

The app is unsigned, so Windows SmartScreen may warn. Choose *More info → Run anyway*.
