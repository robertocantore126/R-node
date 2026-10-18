# Whole-map PDF printing

The UI PDF command uses `editorPdf.ts` and a dedicated instance of the editor's
Canvas2D `Renderer`. It preserves the map geometry, theme, grid, freeform
surfaces, rich text, images and collapsed branches. It commits pending text
editing before taking a document snapshot. Selection, hover, search and drag
overlays are omitted.

Pagination stays full-width, with vertical A1 landscape pages and the existing
margin and scale cap. The map is sampled at 300 dpi into sequential tiles of at
most 2048 x 2048 pixels, then stored as lossless RGB images in the PDF. Grid
phase and world coordinates continue across tiles and pages. CSS-pixel strokes
and arrowheads retain their physical width at print resolution. The editor
canvas is never resized or repurposed. Fonts and visible image decodes are
awaited; missing or undecodable images stop export with an error rather than
silently producing placeholders. The temporary renderer is disposed afterward.

Tradeoffs: map text is rasterized, so it is not selectable/searchable in a PDF
reader, and extreme enlargement eventually reveals pixels. Files can be larger
than the legacy vector export. Compressed output is retained in memory until
download; tiling bounds the working raster, not total document memory. The old
vector writer remains for its existing low-level callers and tests.

Validation on 2026-10-18 used the user's local SQLite map read-only: 286 topics,
110 attachment records, 10 freeform topics. The production renderer, run with
native Canvas2D and Segoe UI fonts, produced three A1 pages at 300 dpi using 60
tiles (approximately 10.4 MiB). All three pages were rendered with Poppler and
visually inspected, along with a freeform closeup. This establishes native
Canvas output, not browser/Tauri UI parity. Browser automation was unavailable;
the real-browser parity harness and desktop download interaction remain unrun.

Regression tests cover world-coordinate continuity, pagination, lossless image
streams, PDF cross-reference offsets, invalid dimensions, renderer failures,
offscreen content, collapsed branches and suppression of transient editor
overlays. For manual UI verification, export a map with an open freeform and
compare its text, image positions, fills, grid and connectors at high zoom in a
PDF reader. Repeat with dark theme and a collapsed branch.
