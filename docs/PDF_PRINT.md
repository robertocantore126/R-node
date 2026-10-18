# Whole-map PDF printing

The UI PDF command takes a snapshot after committing pending text edits, then
uses the vector writer through `editorMapToPdf`. Map text is real PDF text:
selectable, searchable and sharp at any zoom. Standard shapes, tree connectors,
group boundaries, global grid and freeform surfaces/grids are vector paths.
Freeform children keep their absolute positions and transparent fills; they do
not receive automatic tree connectors from their containing canvas. The canvas
title stays in its header rather than becoming a centred topic label.

The existing full-width A1 landscape pagination, vertical page bands and scale
cap are preserved. Extents, wrapping, line baselines and image positions use the
shared layout measurer; node and branch colours come from the renderer. The
editor canvas is never resized or repurposed. Collapsed branches stay collapsed,
and selection, hover and editing overlays are omitted.

Only attached pictures remain raster images. Export prefers original asset
bytes, falling back to the large/small levels when an original is unavailable.
JPEG passes through unchanged; PNG and other decoded formats use lossless RGB,
with an alpha mask where needed. No additional JPEG generation is introduced.
Unreadable assets fail the UI export rather than silently disappearing.

Font handling matches the initial vector exporter: PDF base-14 Helvetica faces
with advances measured from the editor font. This preserves vector sharpness
and layout, but does not embed the original font's exact glyph outlines.
Characters outside WinAnsi are transliterated or reported as unmappable. The
legacy vector limitations for code topics, custom artwork and summaries remain;
the export report records coverage/style gaps. `editorMapToRasterPdf` retains
the explicit 300 dpi shared-renderer utility, but is not the UI default.

Validation on 2026-10-18 used the user's local SQLite map read-only: 286 topics,
110 attachment records, 10 freeform topics and seven boundaries. The revised
vector PDF has three A1 pages and is approximately 2.1 MiB (the prior raster
version was 10.4 MiB). Text extraction recovered over 27,000 characters including
freeform text. The PDF contains font/text operators and asset image XObjects,
without whole-page raster tiles. Poppler renders of all pages and a freeform
closeup were visually checked. Native Canvas2D supplies font measurement for
this probe; browser/Tauri download interaction remains unverified.

Regressions cover vector freeform/header text, clipped grids, omitted internal
tree connectors, transparent fills, alpha borders, group paths, JPEG byte
preservation and lossless opaque PNG encoding. Existing pagination, rich-text,
image/mask and cross-reference tests remain in place.
