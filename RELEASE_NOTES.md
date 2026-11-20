# R-node 0.3.0

Diagrams, free transform and maps with thousands of pictures. Maps saved with earlier versions open as before.

## Diagrams in freeform canvases

- "Diagram from AI": copy a prompt, paste the draw.io XML answer, and it becomes a diagram inside a canvas. Pasting draw.io XML works too, and a diagram that was cut off is recovered.
- Flowchart shapes, including an actor figure with its name underneath, and rotation.
- Containers (nested canvases) and frames: boxes drawn behind their items, with the label at the top or bottom.
- Marquee and group drag inside canvases. Canvases and items resize from any corner, and the Inspector has exact X/Y/W/H. The arrow keys nudge the selection.
- Snap to a 10 px grid (hold Alt to place freely), align, distribute, and bring to front or send to back.
- Elbow arrows route around boxes. Any arrow can take bends and a draggable label, and draw.io bend points are imported.
- A Colours section in the Inspector.

## Free transform

- Text and shapes in a canvas get Photoshop-style handles: scale, stretch and rotate. Scaled text keeps its line breaks and stays sharp at any zoom.
- Pictures in a canvas are bare: the box is the image. They can be scaled, stretched and rotated, and an image pasted on a canvas item becomes a new picture.
- Inspector: font family, weight, bold/italic/underline/strike, alignment, rotation and stretch.
- PDF and SVG exports match the screen.

## Look

- A new Matte theme and a background colour picker that updates the map as you choose.
- The light theme is grey, and you can pick either a dot grid or a line grid.
- Text above 100% zoom is drawn as vectors, so it is never blurry.

## Pictures

- Maps with thousands of pictures stay responsive. Pictures load at the size they are shown, nearby sizes fill in while they load, and on-screen pictures are never dropped.
- Pictures shown larger than 1024 px are drawn from the original, so they stay sharp.
- Importing many pictures shows progress and can be cancelled.
- Rotated phone photos (EXIF) import the right way up.

## Web version

- Only the open map is held in memory. The others wait in browser storage (IndexedDB) and load when opened. Maps from earlier versions are moved over automatically, and the old copy is kept as a backup.

## Install

- `R-node_0.3.0_x64-setup.exe`: installer (NSIS).
- `R-node_0.3.0_x64_en-US.msi`: installer (MSI).
- `r-node.exe`: portable, runs without installing.

The app is unsigned, so Windows SmartScreen may warn. Choose *More info → Run anyway*.
