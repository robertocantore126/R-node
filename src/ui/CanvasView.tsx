import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { useStore } from "../editor/context";
import { viewSize } from "../editor/view";
import { setExportPngHandler, setExportSvgHandler, setExportPdfHandler, setExportHtmlHandler } from "../editor/exportBridge";
import { Renderer, type RenderState } from "../render/renderer";
import { THEMES } from "../render/theme";
import { sheetToSvg } from "../export/svg";
import { sheetToHtmlViewer } from "../export/htmlViewer";
import { sheetToPdf } from "../dev/pdfProbe";
import { computeLevelDims, LEVEL_LONG_SIDE } from "../editor/imageImport";
import { getAssetStore } from "../persist/assets";
import { screenToWorld, worldToScreen } from "../render/viewport";
import { isShiftHeld, showCanvasHelp } from "./help";
import { imageResolver, measureNode } from "../layout/mindmap";
import { createCanvasTextMeasurer, MAX_IMAGE_W, MIN_TOPIC_W } from "../layout/measure";
import { isDescendantOf } from "../core/tree";
import { slotKey } from "../core/ops";
import { nearestImageSide } from "./imageDrop";
import type { ImageSlot, MindNode, Sheet } from "../core/types";
import { RichEditor } from "./RichEditor";
import { installTrace, trace } from "../dev/trace";
import { fetchImageAsFile, firstImageFile, firstUriFromList } from "../editor/externalImage";

/**
 * Accept OS file drags (Explorer) and browser image-URL drags (text/uri-list);
 * anything else (text, links) is left to the browser default.
 */
function acceptsExternalDrop(dt: DataTransfer): boolean {
  const types = [...dt.types];
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Coalesce paints to one per displayed frame.
 *
 * This used to call fn() synchronously on every store notification. Measured
 * on a 3024-node map: TWO full repaints per wheel event at the same
 * millisecond — the store subscription paints, then React re-renders and an
 * effect paints again — and neither was aligned to the display refresh. Each
 * paint was only ~6ms, well inside the 16.7ms budget, but several of them can
 * land in one frame while a fast wheel outruns the screen, which is exactly
 * how stutter is produced out of individually fast frames.
 *
 * rAF fixes both at once: repeated notifications inside a frame collapse into
 * a single paint, and it happens when the compositor is about to present.
 *
 * The caveat that kept this out before is real — rAF never fires while the
 * webview is not compositing (minimised window, hidden tab), which would
 * freeze the map — so a timer falls back to painting directly.
 */
let paintRaf: number | null = null;
let paintFallback: ReturnType<typeof setTimeout> | null = null;
let paintPending: (() => void) | null = null;

function schedulePaint(fn: () => void): void {
  paintPending = fn;
  if (paintRaf !== null) return; // already queued for this frame
  const run = (): void => {
    paintRaf = null;
    if (paintFallback !== null) {
      clearTimeout(paintFallback);
      paintFallback = null;
    }
    const pending = paintPending;
    paintPending = null;
    pending?.();
  };
  paintRaf = requestAnimationFrame(run);
  paintFallback = setTimeout(() => {
    if (paintRaf === null) return;
    cancelAnimationFrame(paintRaf);
    run();
  }, 100);
}

interface DragState {
  dragging: string | null;
  moved: boolean;
  panning: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  resizing: string | null;
  resizeSide: "left" | "right" | null;
  resizeStartWorldX: number;
  resizeStartWidth: number;
  resizeStartX: number;
  /** Image resize (T14): dragging the image corner handle. */
  imgResizing: string | null;
  imgResizeStartWorldX: number;
  imgResizeStartWidth: number;
  /** Image move: dragging a selected image onto another node. */
  imgDragging: string | null;
  /** The slot the grabbed image lives in (removed from on drop). */
  imgSlot: ImageSlot;
  /** The side the drop will target ("top" while not over a node). */
  imgDropSlot: ImageSlot;
  /** Marquee selection: anchor of the box drag (screen coords, null = inactive). */
  marqueeStartX: number | null;
  marqueeStartY: number | null;
  marqueeActive: boolean;
}

/** Extra box width some shapes add beyond the text width (mirrors measure.ts). */
function shapeWidthAllowance(n: MindNode): number {
  const shape = n.style.shape ?? "rounded";
  const fs = n.style.fontSize ?? 14;
  return shape === "diamond" ? fs : shape === "hexagon" ? 14 : 0;
}

const overlayMeasurer = createCanvasTextMeasurer();

/** `imageResolver` memoized on the sheet it was built from. */
let lastResolverSheet: Sheet | null = null;
let lastResolver: ReturnType<typeof imageResolver> | null = null;
function overlayImageResolver(sheet: Sheet): ReturnType<typeof imageResolver> {
  if (lastResolverSheet !== sheet || !lastResolver) {
    lastResolverSheet = sheet;
    lastResolver = imageResolver(sheet);
  }
  return lastResolver;
}

export function CanvasView(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sizeRef = useRef({ w: viewSize.w, h: viewSize.h, left: 0, top: 0 });
  const dragRef = useRef<DragState>({
    dragging: null,
    moved: false,
    panning: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    grabOffsetX: 0,
    grabOffsetY: 0,
    resizing: null,
    resizeSide: null,
    resizeStartWorldX: 0,
    resizeStartWidth: 0,
    resizeStartX: 0,
    imgResizing: null,
    imgResizeStartWorldX: 0,
    imgResizeStartWidth: 0,
    imgDragging: null,
    imgSlot: "top",
    imgDropSlot: "top",
    marqueeStartX: null,
    marqueeStartY: null,
    marqueeActive: false,
  });
  // Right/middle-drag pan started over the Lexical overlay (the overlay is a
  // sibling of the canvas, so the canvas pointer handlers never see it).
  const overlayPanRef = useRef<{ pointerId: number } | null>(null);
  // True when an overlay pan actually moved (so a right-drag doesn't leave a
  // browser context menu behind; a plain right-click keeps the native menu).
  const panMovedRef = useRef(false);
  const [, force] = useState(0);
  const [panning, setPanning] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [resizeHover, setResizeHover] = useState(false);
  const [imgResizeHover, setImgResizeHover] = useState(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Ghost preview of an image being dragged to another node (internal
  // reassignment): world coords of the cursor + the image to draw. Read by
  // paint/currentRenderState on every frame; the renderer draws the cached
  // bitmap semi-transparent until the drop lands.
  // True once the user has touched the canvas (pointer/wheel/click): the
  // startup auto-fit must NOT override a view the user has already started
  // to use — otherwise the fit fires right after a click and the camera
  // "jumps" under the cursor.
  const interactedRef = useRef(false);
  const ghostRef = useRef<{ imageId: string; x: number; y: number; nodeId: string; side?: ImageSlot } | null>(null);
  // Marquee preview: ids of the topics inside the drag box, live-updated on
  // every move so the canvas can paint the "will be selected" rings (the
  // box itself is a DOM div; the rings need canvas repaints).
  const marqueeSelRef = useRef<Set<string> | null>(null);
  // External drag (Explorer / browser): DOM ghost that follows the cursor.
  // `src` is either an objectURL (revoke on cleanup) or the image URL from
  // text/uri-list. Resolved once per drag, positioned via the el ref (no
  // React re-render on every dragover).
  const extGhostRef = useRef<{ src: string; revoke: boolean } | null>(null);
  const extGhostElRef = useRef<HTMLImageElement | null>(null);
  // Side of the target node the external drag is hovering (for the snapped
  // ghost preview and the drop). null = not over a node.
  const extDropSideRef = useRef<ImageSlot | null>(null);
  const [extGhostSrc, setExtGhostSrc] = useState<string | null>(null);

  const paint = useCallback(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) return;
    const { w, h } = sizeRef.current;
    const s = store.getSnapshot();
    const rs: RenderState = {
      sheet: store.sheet,
      rev: store.revision, // shares the placement with the hit tests of this turn
      camera: s.camera,
      selection: new Set(s.selection),
      editingId: s.editingId,
      hoverId: s.hoverId,
      drop: s.drop,
      themeName: s.theme,
      viewW: w,
      viewH: h,
      relSel: s.relSel,
      groupSel: s.groupSel,
      summarySel: s.summarySel,
      imageSel: s.imageSel,
      imageSlot: s.imageSlot,
      ghostImage: ghostRef.current,
      marqueeSel: marqueeSelRef.current,
    };
    renderer.render(rs);
  }, [store]);

  const schedule = useCallback(() => {
    schedulePaint(paint);
  }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Image decodes finish asynchronously; the repaint callback brings them
    // on screen without waiting for the next user gesture.
    const renderer = new Renderer(canvas, { onRepaint: schedule });
    rendererRef.current = renderer;

    let firstResize = true;
    const ro = new ResizeObserver(() => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      const old = sizeRef.current;
      const nw = rect.width;
      const nh = rect.height;
      // Keep the map visually anchored to the WINDOW when the canvas area
      // resizes (Inspector/panel toggle, sidebar toggle, window resize). The
      // canvas can grow or shrink on EITHER side — right panel on the right,
      // sidebar on the left — so the displacement of the canvas CENTER is
      // what must be compensated, not the width delta alone. The old width-
      // only compensation panned the wrong way when the sidebar toggled
      // (the map jumped by the full sidebar width). The first observation is
      // skipped (sizeRef still holds the 1200x800 default).
      if (!firstResize && old.w > 0 && old.h > 0 && nw > 0 && nh > 0) {
        const dCx = rect.left - old.left + (nw - old.w) / 2;
        const dCy = rect.top - old.top + (nh - old.h) / 2;
        if (dCx !== 0 || dCy !== 0) store.panBy(-dCx, -dCy);
      }
      firstResize = false;
      sizeRef.current = { w: nw, h: nh, left: rect.left, top: rect.top };
      viewSize.w = nw;
      viewSize.h = nh;
      renderer.resize(canvas, nw, nh);
      schedule();
    });
    ro.observe(canvas.parentElement!);
    renderer.resize(canvas, sizeRef.current.w, sizeRef.current.h);
    schedule();
    // fit the map into view once layout settles after mount — but only if
    // the user hasn't already interacted with the canvas (a click/pan/zoom
    // before the timer fires must not be overridden by the startup fit).
    const fitTimer = setTimeout(() => {
      if (interactedRef.current) return;
      store.fitView(sizeRef.current.w, sizeRef.current.h);
    }, 150);

    setExportPngHandler(() => {
      const s = store.getSnapshot();
      const rs: RenderState = {
        sheet: store.sheet,
        rev: store.revision,
        camera: s.camera,
        selection: new Set(),
        editingId: null,
        hoverId: null,
        drop: null,
        themeName: s.theme,
        viewW: sizeRef.current.w,
        viewH: sizeRef.current.h,
      };
      const out = renderer.exportPng(rs, false);
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${store.doc.doc.title.replace(/[^\w-]+/g, "_")}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "image/png");
      store.toast("Exported as PNG");
    });

    setExportSvgHandler(async () => {
      const s = store.getSnapshot();
      const rs: RenderState = {
        sheet: store.sheet,
        rev: store.revision,
        camera: s.camera,
        selection: new Set(),
        editingId: null,
        hoverId: null,
        drop: null,
        themeName: s.theme,
        viewW: sizeRef.current.w,
        viewH: sizeRef.current.h,
      };
      store.beginExport("Building SVG…");
      try {
        const out = await sheetToSvg(store.sheet, {
          measurer: createCanvasTextMeasurer(),
          colorOf: (id) => renderer.nodeColors(rs, id),
          linkColorOf: (id) => renderer.branchColorOf(rs, id),
          relColorOf: (relId) => renderer.relationshipColorOf(rs, relId),
          background: THEMES[s.theme].background,
          // The `small` level (256px), not `large` (1024px).
          //
          // An image is drawn at MAX_IMAGE_W = 240 units at most, so 256px is
          // the size it is actually shown at and 1024 was a sixteen-fold
          // oversample in pixels. Measured on a real export: 300 pictures at
          // `large` produced a 110MB file of which 103MB — 94% — was base64.
          // Zoom far in and an image goes soft; that is the honest trade for a
          // file that opens.
          imageDataUri: async (assetId) => {
            const meta = await getAssetStore().meta(assetId);
            const blob = await getAssetStore().get(assetId, "small");
            if (!blob) return null;
            const buf = new Uint8Array(await blob.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) {
              bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            }
            return `data:${meta?.mime ?? "image/png"};base64,${btoa(bin)}`;
          },
        });
        const blob = new Blob([out.svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${store.doc.doc.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "map"}.svg`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        // The size is in the toast because on a picture-heavy map the images
        // ARE the file, and that is invisible until someone tries to open it.
        const mb = (n: number): string => (n / 1048576).toFixed(1);
        const imgPart = out.images > 0 ? `, ${out.images} images (${mb(out.imageBytes)}MB of ${mb(out.bytes)}MB)` : "";
        store.toast(
          `Exported SVG — ${out.nodes} topics${imgPart}` +
            (out.imagesMissing > 0 ? ` — ${out.imagesMissing} unreadable` : "")
        );
      } catch (e) {
        store.toast(`SVG export failed — ${String(e)}`);
      } finally {
        store.endExport();
      }
    });

    setExportHtmlHandler(async () => {
      const s = store.getSnapshot();
      store.beginExport("Building viewer…");
      try {
        const out = await sheetToHtmlViewer(store.sheet, {
          title: store.doc.doc.title,
          theme: s.theme,
          background: THEMES[s.theme].background,
          // `small` (256px), not `large` (1024px). Choosing `large` for the
          // sharpness it allows when zoomed deep in cost 103MB of a 109MB
          // export — 94% of the file, the same proportion and the same mistake
          // the SVG export had made one commit earlier. An image is drawn at
          // 240 units at most, so 256 is its size at 1:1; zoom far past that
          // and it softens, which is the trade for a file that opens.
          imageDataUri: async (assetId) => {
            const meta = await getAssetStore().meta(assetId);
            const blob = await getAssetStore().get(assetId, "small");
            if (!blob) return null;
            const buf = new Uint8Array(await blob.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return `data:${meta?.mime ?? "image/png"};base64,${btoa(bin)}`;
          },
        });
        const blob = new Blob([out.html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${store.doc.doc.title.replace(/[\/:*?"<>|]+/g, " ").trim() || "map"}.html`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const mb = (n: number): string => (n / 1048576).toFixed(1);
        store.toast(
          `Viewer — ${out.nodes} topics, ${out.images} images, ${mb(out.bytes)}MB` +
            (out.imagesMissing > 0 ? ` — ${out.imagesMissing} unreadable` : "")
        );
      } catch (e) {
        store.toast(`Viewer export failed — ${String(e)}`);
      } finally {
        store.endExport();
      }
    });

    setExportPdfHandler(async () => {
      const s = store.getSnapshot();
      const rs: RenderState = {
        sheet: store.sheet,
        rev: store.revision,
        camera: s.camera,
        selection: new Set(),
        editingId: null,
        hoverId: null,
        drop: null,
        themeName: s.theme,
        viewW: sizeRef.current.w,
        viewH: sizeRef.current.h,
      };
      store.beginExport("Building PDF…");
      try {
        const out = await sheetToPdf(store.sheet, {
          measurer: createCanvasTextMeasurer(),
          colorOf: (id) => renderer.nodeColors(rs, id),
          linkColorOf: (id) => renderer.branchColorOf(rs, id),
          // JPEG only: those bytes go into the file untouched (DCTDecode).
          // A PNG would need its IDAT unpacked and re-encoded, which is more
          // than an experiment should carry.
          jpegBytes: async (assetId) => {
            const store2 = getAssetStore();
            const meta = await store2.meta(assetId);
            if (!meta || meta.mime !== "image/jpeg") return null;
            const blob = await store2.get(assetId, "small");
            if (!blob) return null;
            const dims = computeLevelDims(meta.w, meta.h, LEVEL_LONG_SIDE.small);
            return { bytes: new Uint8Array(await blob.arrayBuffer()), w: dims.w, h: dims.h };
          },
        });
        const url = URL.createObjectURL(out.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${store.doc.doc.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "map"}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        store.toast(
          `PDF — ${out.nodes} topics, ${out.images} images, ${out.ops.toLocaleString()} ops, ` +
            `${(out.bytes / 1048576).toFixed(1)}MB, page ${Math.round(out.pageW)}×${Math.round(out.pageH)}`
        );
      } catch (e) {
        store.toast(`PDF export failed — ${String(e)}`);
      } finally {
        store.endExport();
      }
    });

    const unsub = store.subscribe(schedule);
    const uninstallTrace = installTrace();

    // wheel must be non-passive to preventDefault
    const onWheel = (e: WheelEvent): void => {
      // ALWAYS swallow the event, whatever we then decide to do with it.
      // While editing, the pointer sits over the Lexical overlay — a sibling
      // div, not the canvas — so a listener bound to the canvas never saw the
      // event at all: the browser handled it instead and ctrl+wheel zoomed the
      // whole page. Hence binding to the wrapper, which contains both.
      // Wheel is NOT blocked while editing: the overlay's position is derived
      // from the store camera on every render (see editStyle below), so a
      // pan/zoom here keeps the overlay glued to the node.
      e.preventDefault();
      interactedRef.current = true;
      const { w, h } = sizeRef.current;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const zoom = e.ctrlKey || e.metaKey;
      if (zoom) {
        // Wheel-up zooms in (deltaY < 0). Flipped alongside pan so ctrl+scroll
        // stays coherent for users with inverted/natural-scroll deltas.
        trace.applied("wheel:zoom", { deltaY: Math.round(e.deltaY) });
        store.zoomAt(sx, sy, e.deltaY < 0 ? 1.12 : 1 / 1.12, w, h);
      } else {
        // Scroll down → map content moves up (document-style pan). The sign is
        // flipped from the raw delta so the direction matches the OS-scroll
        // convention instead of appearing inverted.
        trace.applied("wheel:pan", { deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
        store.panBy(-e.deltaX, -e.deltaY);
      }
    };
    const wheelTarget = canvas.parentElement ?? canvas;
    wheelTarget.addEventListener("wheel", onWheel as EventListener, { passive: false });

    return () => {
      clearTimeout(fitTimer);
      ro.disconnect();
      unsub();
      wheelTarget.removeEventListener("wheel", onWheel as EventListener);
      uninstallTrace();
      setExportPngHandler(null);
      setExportSvgHandler(null);
      setExportPdfHandler(null);
      setExportHtmlHandler(null);
      clearExternalGhost(); // revoke a pending objectURL on unmount
    };
  }, [store, schedule]);

  // re-paint when state changes (camera, selection, edits, layout…)
  useEffect(() => {
    schedule();
    force((n) => n + 1);
  }, [state, schedule]);

  // Ctrl+V of an image copied as a FILE. The keydown path reads the async
  // clipboard, which does not expose file copies at all (they arrive as an
  // item with no mime type), so the picture is only reachable here, on the
  // event's DataTransfer — the same place the drag & drop path reads it from.
  // Both paths may fire for one keystroke; the second is a no-op because the
  // asset id is the hash of the bytes.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (store.getSnapshot().editingId) return; // the overlay owns its own paste
      const file = e.clipboardData ? firstImageFile(e.clipboardData.files) : null;
      if (!file) return;
      e.preventDefault();
      void store.pasteImageFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [store]);

  // -------------------------------------------------------------------------
  // Pointer handling
  // -------------------------------------------------------------------------

  const localPoint = (e: RPointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Shift-inspection on the canvas: hit-test what is under the cursor and
  // show the "what is this?" tooltip (phase 1 — overlay only, no actions).
  const showCanvasInspection = (e: RPointerEvent, x: number, y: number): void => {
    const s = store.getSnapshot();
    const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
    const rs = currentRenderState();
    const renderer = rendererRef.current!;
    const hit = renderer.hitTest(rs, world.x, world.y);
    const n = hit ? store.doc.node(hit) : undefined;
    if (n) {
      const kids = n.childrenIds.length;
      const att = n.style.image ? store.sheet.attachments.find((a) => a.id === n.style.image) : undefined;
      const parts = [`type ${n.type}`, `${kids} child${kids === 1 ? "" : "ren"}`];
      if (att) parts.push(`image ${att.w}×${att.h}`);
      if (n.collapsed) parts.push("collapsed");
      showCanvasHelp({
        title: n.title || "(empty topic)",
        body: parts.join(" · "),
        x: e.clientX,
        y: e.clientY,
        anchor: "cursor",
      });
      return;
    }
    const relId = renderer.hitTestRelationship(rs, world.x, world.y);
    if (relId) {
      const rel = store.sheet.relationships.find((r) => r.id === relId);
      showCanvasHelp({
        title: "Relationship",
        body: rel?.label ? `label: ${rel.label}` : `${rel?.fromId.slice(0, 6)}… → ${rel?.toId.slice(0, 6)}…`,
        x: e.clientX,
        y: e.clientY,
        anchor: "cursor",
      });
      return;
    }
    const grpId = renderer.hitTestGroup(rs, world.x, world.y);
    if (grpId) {
      const g = store.sheet.boundaries.find((gr) => gr.id === grpId);
      showCanvasHelp({
        title: "Group",
        body: g?.label ?? `${g?.memberIds.length ?? 0} members`,
        x: e.clientX,
        y: e.clientY,
        anchor: "cursor",
      });
      return;
    }
    const sumId = renderer.hitTestSummary(rs, world.x, world.y);
    if (sumId) {
      const sm = store.sheet.summaries.find((sr) => sr.id === sumId);
      showCanvasHelp({
        title: "Summary",
        body: sm?.label ?? `${sm?.memberIds.length ?? 0} topics`, 
        x: e.clientX,
        y: e.clientY,
        anchor: "cursor",
      });
      return;
    }
    showCanvasHelp(null);
  };

  const onPointerDown = (e: RPointerEvent): void => {
    interactedRef.current = true;
    // Best-effort: capture keeps move/up events coming if the pointer leaves
    // the element mid-gesture. Untrusted/synthetic events have no active
    // pointer and throw here — never let that kill the handler.
    try {
      canvasRef.current!.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable (e.g. synthetic event) */
    }
    const s = store.getSnapshot();
    const { x, y } = localPoint(e);
    const drag = dragRef.current;
    drag.startX = x;
    drag.startY = y;
    drag.lastX = x;
    drag.lastY = y;
    drag.moved = false;
    ghostRef.current = null; // no stale ghost between gestures
    marqueeSelRef.current = null; // no stale marquee preview between gestures

    // Panning is right-drag (or middle-drag / pan mode): left-click never
    // pans, it only selects or drags topics. Works while editing too — over
    // the canvas here, over the Lexical overlay via the wrapper handlers
    // (onWrapPointerDown), which capture the pointer because the overlay is a
    // sibling of the canvas and its events never reach this handler.
    if (e.button === 2 || e.button === 1 || s.mode === "pan") {
      drag.panning = true;
      drag.dragging = null;
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    drag.panning = false;

    const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
    const renderer = rendererRef.current!;
    const rs = currentRenderState();

    // Image resize (T14): grab the corner handle on the node's image. Same
    // precedence as the width handle — before the body hit test.
    const imgResizeHit = s.relFrom ? null : renderer.hitTestImageResize(rs, world.x, world.y);
    if (imgResizeHit) {
      const n = store.doc.node(imgResizeHit)!;
      const att = n.style.image ? store.sheet.attachments.find((a) => a.id === n.style.image) : undefined;
      drag.imgResizing = imgResizeHit;
      drag.imgResizeStartWorldX = world.x;
      // imageWidth may be unset — resolve the natural width like the renderer.
      drag.imgResizeStartWidth = n.style.imageWidth ?? (att ? Math.min(att.w, MAX_IMAGE_W) : 0);
      store.beginImageResize(imgResizeHit);
      store.select(imgResizeHit, { additive: false });
      setResizing(true);
      setResizeHover(false);
      return;
    }

    // Xmind-style width resize: grab the handle on the selected node's edge.
    // Checked BEFORE the body hit test so the handle wins on the edge line
    // (skipped while a relationship target is being picked).
    const resizeHit = s.relFrom ? null : renderer.hitTestResize(rs, world.x, world.y);
    if (resizeHit) {
      const rect = renderer.nodeWorldRect(rs, resizeHit.id)!;
      const n = store.doc.node(resizeHit.id)!;
      drag.resizing = resizeHit.id;
      drag.resizeSide = resizeHit.side;
      drag.resizeStartWorldX = world.x;
      drag.resizeStartWidth = n.style.width ?? Math.max(MIN_TOPIC_W, rect.w - shapeWidthAllowance(n));
      drag.resizeStartX = rect.x;
      store.beginResize(resizeHit.id);
      store.select(resizeHit.id, { additive: false });
      setResizing(true);
      setResizeHover(false);
      return;
    }

    // Image body hit (before the node body hit test): the image inside a
    // node is a selectable target of its own — a click selects it, a drag
    // moves it onto another node. Skipped while picking a relationship
    // target, like the resize handles. The exact SLOT is remembered so the
    // move removes the right one and the ring marks the right one.
    const imgHit = s.relFrom ? null : renderer.hitTestImageSlot(rs, world.x, world.y);
    if (imgHit) {
      drag.grabOffsetX = world.x - imgHit.rect.x;
      drag.grabOffsetY = world.y - imgHit.rect.y;
      drag.imgSlot = imgHit.slot;
      store.selectImage(imgHit.nodeId, imgHit.slot);
      drag.imgDragging = imgHit.nodeId;
      drag.dragging = null;
      drag.marqueeStartX = null;
      return;
    }

    const hit = renderer.hitTest(rs, world.x, world.y);

    if (s.relFrom) {
      if (hit) {
        store.createRelationship(s.relFrom, hit);
        store.clearRelFrom();
      } else {
        store.clearRelFrom();
      }
      return;
    }

    if (hit) {
      const rect = renderer.nodeWorldRect(rs, hit);
      drag.grabOffsetX = rect ? world.x - rect.x : 0;
      drag.grabOffsetY = rect ? world.y - rect.y : 0;
      store.select(hit, { additive: e.shiftKey || e.ctrlKey || e.metaKey });
      drag.dragging = hit;
      // Capture the pre-drag position: the final op's `prev` must be this,
      // so undo restores the exact pre-drag state (see commitNodeDrag).
      store.beginNodeDrag(hit);
      drag.marqueeStartX = null;
    } else {
      // Overlay objects first: a relationship line, a group box, a summary
      // brace/label — then, on plain empty canvas, begin a marquee box.
      const relId = renderer.hitTestRelationship(rs, world.x, world.y);
      if (relId) {
        store.selectRelationship(relId);
        drag.marqueeStartX = null;
        return;
      }
      const grpId = renderer.hitTestGroup(rs, world.x, world.y);
      if (grpId) {
        store.selectGroup(grpId);
        drag.marqueeStartX = null;
        return;
      }
      const sumId = renderer.hitTestSummary(rs, world.x, world.y);
      if (sumId) {
        store.selectSummary(sumId);
        drag.marqueeStartX = null;
        return;
      }
      // A plain click on empty canvas clears the selection; with Shift held
      // the current selection is kept so the marquee can extend it.
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) store.clearSelection();
      drag.marqueeStartX = x;
      drag.marqueeStartY = y;
      drag.marqueeActive = false;
    }
  };

  const onPointerMove = (e: RPointerEvent): void => {
    const s0 = store.getSnapshot();
    const drag = dragRef.current;
    const { x, y } = localPoint(e);
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;

    // Shift-inspection: while Shift is held, hovering the canvas shows what
    // is under the cursor. Skipped during active gestures (drag/resize/pan/
    // marquee) so the tooltip never fights a real interaction.
    if (isShiftHeld() && !drag.dragging && !drag.resizing && !drag.imgResizing && !drag.marqueeActive) {
      showCanvasInspection(e, x, y);
    }

    if (drag.imgResizing) {
      const s = store.getSnapshot();
      const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
      const dx = world.x - drag.imgResizeStartWorldX;
      store.setImageResizeDraft(drag.imgResizing, drag.imgResizeStartWidth + dx);
      drag.moved = true;
      return;
    }
    if (drag.resizing) {
      const s = store.getSnapshot();
      const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
      const dx = world.x - drag.resizeStartWorldX;
      if (drag.resizeSide === "left") {
        // Right edge stays anchored; the left edge (position.x) follows the cursor.
        store.setResizeDraft(drag.resizing, drag.resizeStartWidth - dx, {
          anchorRight: true,
          x: drag.resizeStartX + dx,
        });
      } else {
        store.setResizeDraft(drag.resizing, drag.resizeStartWidth + dx);
      }
      drag.moved = true;
      return;
    }
    if (drag.panning) {
      store.panBy(dx, dy);
      return;
    }
    // Marquee: activate once the pointer moves 4px from the anchor, then
    // track the box in screen coords (the overlay div is positioned in
    // canvas-wrap space, same as localPoint).
    const mx0 = drag.marqueeStartX, my0 = drag.marqueeStartY;
    if (mx0 !== null && my0 !== null && !drag.marqueeActive) {
      if (Math.hypot(x - mx0, y - my0) >= 4) {
        drag.marqueeActive = true;
        drag.dragging = null;
        setMarquee({
          x: mx0,
          y: my0,
          w: Math.abs(x - mx0),
          h: Math.abs(y - my0),
        });
      }
    }
    if (drag.marqueeActive && mx0 !== null && my0 !== null) {
      setMarquee({
        x: Math.min(mx0, x),
        y: Math.min(my0, y),
        w: Math.abs(x - mx0),
        h: Math.abs(y - my0),
      });
      // Live preview of what the release will select: same geometry as the
      // commit path (world rect corners -> nodesInRect), repainted now so
      // the purple rings follow the box instead of appearing on release.
      const s = store.getSnapshot();
      const w0 = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, mx0, my0);
      const w1 = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
      const ids = rendererRef.current!.nodesInRect(currentRenderState(), w0.x, w0.y, w1.x, w1.y);
      marqueeSelRef.current = ids.length > 0 ? new Set(ids) : null;
      schedule();
      return;
    }
    // Image move: the dragged image highlights the node under the pointer as
    // its new home (the "child" drop indicator); the source node is never a
    // target. Threshold before feedback, same as node dragging. The ghost
    // preview follows the cursor (set BEFORE setDrop — the store change
    // repaints synchronously and must already see it).
    if (drag.imgDragging) {
      if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 4) return;
      drag.moved = true;
      const s = store.getSnapshot();
      const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
      const rs = currentRenderState();
      const srcNode = store.doc.node(drag.imgDragging);
      // The dragged bitmap is the one from the grabbed slot — with side
      // images a node may hold several, and the ghost must follow the one
      // being moved.
      const srcImg = srcNode?.style[slotKey(drag.imgSlot)] ?? null;
      const hit = rendererRef.current!.hitTest(rs, world.x, world.y);
      if (hit && hit !== drag.imgDragging) {
        const r = rendererRef.current!.nodeWorldRect(rs, hit);
        const side = r ? nearestImageSide(r, world.x, world.y) : "top";
        drag.imgDropSlot = side;
        store.setDrop({ mode: "child", nodeId: hit });
        // Over a target the ghost SNAPS onto that slot instead of following
        // the cursor — the exact rect the image will occupy on drop.
        ghostRef.current = srcImg ? { imageId: srcImg, x: world.x, y: world.y, nodeId: hit, side } : null;
      } else {
        drag.imgDropSlot = "top";
        store.setDrop({ mode: "none", nodeId: drag.imgDragging });
        ghostRef.current = srcImg ? { imageId: srcImg, x: world.x, y: world.y, nodeId: drag.imgDragging } : null;
      }
      return;
    }
    if (!drag.dragging) {
      const p = localPoint(e);
      const w = screenToWorld(s0.camera, sizeRef.current.w, sizeRef.current.h, p.x, p.y);
      const renderer = rendererRef.current;
      const rs = currentRenderState();
      const rh = renderer?.hitTestResize(rs, w.x, w.y) ?? null;
      const ih = renderer?.hitTestImageResize(rs, w.x, w.y) ?? null;
      setResizeHover(!!rh);
      setImgResizeHover(!!ih);
      store.setHover(rh || ih ? null : (renderer?.hitTest(rs, w.x, w.y) ?? null));
    }
    if (!drag.dragging) return;
    if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 4) return;
    drag.moved = true;

    const s = store.getSnapshot();
    const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
    const renderer = rendererRef.current!;
    const rs = currentRenderState();
    const hit = renderer.hitTest(rs, world.x, world.y);

    let dropMode: "child" | "before" | "after" | "floating" | "none" = "none";
    if (hit && hit !== drag.dragging && !isDescendantOf(store.doc, drag.dragging, hit)) {
      const r = renderer.nodeWorldRect(rs, hit);
      if (r) {
        const relY = (world.y - r.y) / r.h;
        dropMode = relY < 0.28 ? "before" : relY > 0.72 ? "after" : "child";
        store.setDrop({ mode: dropMode, nodeId: hit });
      }
    } else {
      // Only main topics (root children) and floating topics can be pinned to
      // a free position — deeper hierarchical nodes stay in the auto layout.
      const dragged = store.doc.node(drag.dragging);
      const canFloat = !!dragged && (!dragged.parentId || dragged.parentId === store.sheet.rootNodeId);
      dropMode = canFloat ? "floating" : "none";
      store.setDrop({ mode: dropMode, nodeId: drag.dragging });
    }
    // Live follow (fluid drag): while the node is free-floating it follows
    // the cursor and its subtree re-flows around it every move. Over a drop
    // target it returns to its slot so the reorder indicator stays usable;
    // deeper nodes never float, so nothing moves for them.
    if (dropMode === "floating") {
      store.setNodeDragDraft(drag.dragging, world.x - drag.grabOffsetX, world.y - drag.grabOffsetY);
    } else {
      store.resetNodeDragDraft(drag.dragging);
    }
  };

  const onPointerUp = (e: RPointerEvent): void => {
    const drag = dragRef.current;
    // A plain click on empty canvas (marquee never activated): just reset.
    if (drag.marqueeStartX !== null && !drag.marqueeActive) {
      drag.marqueeStartX = null;
      drag.marqueeStartY = null;
    }
    if (drag.marqueeActive) {
      const s = store.getSnapshot();
      const { x, y } = localPoint(e);
      const w0 = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, drag.marqueeStartX!, drag.marqueeStartY!);
      const w1 = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
      const ids = rendererRef.current!.nodesInRect(currentRenderState(), w0.x, w0.y, w1.x, w1.y);
      if (ids.length > 0) store.selectMany(ids, { additive: e.shiftKey || e.ctrlKey || e.metaKey });
      marqueeSelRef.current = null;
      drag.marqueeActive = false;
      drag.marqueeStartX = null;
      drag.marqueeStartY = null;
      setMarquee(null);
      schedule();
      return;
    }
    if (drag.imgResizing) {
      store.commitImageResize();
      drag.imgResizing = null;
      drag.moved = false;
      setResizing(false);
      return;
    }
    if (drag.resizing) {
      store.commitResize();
      drag.resizing = null;
      drag.resizeSide = null;
      drag.moved = false;
      setResizing(false);
      return;
    }
    if (drag.panning) {
      drag.panning = false;
      drag.dragging = null;
      setPanning(false);
      return;
    }
    // Image move dropped: assign the image to the highlighted node. A plain
    // click (no move) only leaves the image selected — never moves it.
    if (drag.imgDragging) {
      if (drag.moved) {
        const drop = store.getSnapshot().drop;
        if (drop && drop.mode !== "none" && drop.nodeId !== drag.imgDragging) {
          store.assignImageToNode(drag.imgDragging, drop.nodeId, drag.imgDropSlot, drag.imgSlot);
        }
      }
      store.setDrop(null);
      ghostRef.current = null;
      drag.imgDragging = null;
      drag.moved = false;
      return;
    }
    if (drag.dragging && drag.moved) {
      const s = store.getSnapshot();
      const drop = s.drop;
      if (drop && drop.mode !== "none") {
        const { x, y } = localPoint(e);
        const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
        const target = drop.mode === "floating" ? null : drop.nodeId;
        store.commitNodeDrag(
          drag.dragging,
          target,
          drop.mode,
          world.x - drag.grabOffsetX,
          world.y - drag.grabOffsetY
        );
      }
    }
    drag.dragging = null;
    drag.moved = false;
  };

  const onDblClick = (e: RMouseEvent): void => {
    const s = store.getSnapshot();
    const { x, y } = localPoint(e as unknown as RPointerEvent);
    const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
    const renderer = rendererRef.current!;
    const hit = renderer.hitTest(currentRenderState(), world.x, world.y);
    if (hit) {
      store.startEdit(hit);
    } else {
      store.createFloatingAt(world.x - 60, world.y - 18);
    }
  };

  const onContextMenu = (e: RMouseEvent): void => {
    e.preventDefault();
  };

  // -------------------------------------------------------------------------
  // Wrapper-level pan over the editing overlay
  // -------------------------------------------------------------------------
  // Bound in CAPTURE phase on .canvas-wrap (see the main effect): capture runs
  // before any stopPropagation an inner element could do, so right/middle-drag
  // over the Lexical overlay pans the map even while editing. The left button
  // is never touched here — it stays with the editor (text selection/caret).

  const onWrapPointerDown = (e: RPointerEvent): void => {
    if (e.target === canvasRef.current) return; // the canvas path handles it
    if (e.button !== 2 && e.button !== 1) return; // never steal left-click
    if (!store.getSnapshot().editingId) return;
    e.preventDefault();
    const { x, y } = localPoint(e);
    const drag = dragRef.current;
    drag.panning = true;
    drag.dragging = null;
    drag.startX = x;
    drag.startY = y;
    drag.lastX = x;
    drag.lastY = y;
    overlayPanRef.current = { pointerId: e.pointerId };
    panMovedRef.current = false;
    setPanning(true);
    try {
      canvasRef.current!.parentElement!.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable (e.g. synthetic event) */
    }
  };

  const onWrapPointerMove = (e: RPointerEvent): void => {
    if (!overlayPanRef.current) return;
    const drag = dragRef.current;
    const { x, y } = localPoint(e);
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;
    if (Math.hypot(x - drag.startX, y - drag.startY) > 3) panMovedRef.current = true;
    store.panBy(dx, dy);
  };

  const onWrapPointerUp = (e: RPointerEvent): void => {
    if (!overlayPanRef.current) return;
    const drag = dragRef.current;
    drag.panning = false;
    drag.dragging = null;
    setPanning(false);
    const wrap = canvasRef.current?.parentElement;
    if (wrap?.hasPointerCapture(e.pointerId)) {
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
    overlayPanRef.current = null;
  };

  const onWrapContextMenu = (e: RMouseEvent): void => {
    // A real right-drag pan must not leave a browser context menu behind;
    // a plain right-click on the editor keeps the native menu (paste etc.).
    if (panMovedRef.current) {
      e.preventDefault();
      panMovedRef.current = false;
    }
  };

  const currentRenderState = (): RenderState => {
    const s = store.getSnapshot();
    return {
      sheet: store.sheet,
      // Enables the renderer's placement cache. Every geometry change ends in
      // a notify(), which bumps this — so a stale placement cannot outlive the
      // change that invalidates it.
      rev: store.revision,
      camera: s.camera,
      selection: new Set(s.selection),
      editingId: s.editingId,
      hoverId: s.hoverId,
      drop: s.drop,
      themeName: s.theme,
      viewW: sizeRef.current.w,
      viewH: sizeRef.current.h,
      relSel: s.relSel,
      groupSel: s.groupSel,
      summarySel: s.summarySel,
      // MUST match the state `paint` builds, field for field. This one was
      // missing here: selecting an image drew its ring (paint had it) while
      // the resize handle could not be grabbed (the hit tests read this), so
      // the picture said "grab me" and the hit test had never heard of the
      // selection. A field present in one copy and absent from the other is a
      // feature that looks present and is not.
      imageSel: s.imageSel,
      imageSlot: s.imageSlot,
      ghostImage: ghostRef.current,
      marqueeSel: marqueeSelRef.current,
    };
  };

  // -------------------------------------------------------------------------
  // External drag ghost (Explorer / browser drags)
  // -------------------------------------------------------------------------

  const clearExternalGhost = useCallback(() => {
    const g = extGhostRef.current;
    if (g?.revoke) URL.revokeObjectURL(g.src);
    extGhostRef.current = null;
    extDropSideRef.current = null;
    setExtGhostSrc(null);
  }, []);

  /** Resolve the dragged payload into a previewable src, once per drag. */
  const ensureExternalGhost = useCallback((dt: DataTransfer) => {
    if (extGhostRef.current) return; // already resolved for this drag
    const file = firstImageFile(dt.files);
    let src: string | null = null;
    let revoke = false;
    if (file) {
      src = URL.createObjectURL(file);
      revoke = true;
    } else {
      src = firstUriFromList(dt.getData("text/uri-list"));
    }
    if (!src) return;
    extGhostRef.current = { src, revoke };
    setExtGhostSrc(src);
  }, []);

  // -------------------------------------------------------------------------
  // Inline editor overlay
  // -------------------------------------------------------------------------

  let editStyle: CSSProperties | null = null;
  // The overlay wears the node's painted colors; resolving them in the
  // renderer keeps branch palettes in one place.
  let editColors: { fill: string; text: string } | undefined;
  if (state.editingId) {
    const n = store.doc.node(state.editingId);
    if (n) {
      // The overlay box must match the canvas box: same measurer, same image
      // resolver (invariant I9) — otherwise the node jumps on double-click.
      // Memoized on the sheet: building it inline reallocated the map on every
      // render, which is invisible at 20 nodes and is not at 5.000.
      const m = measureNode(n, overlayMeasurer, overlayImageResolver(store.sheet));
      const { x, y } = worldToScreen(state.camera, viewSize.w, viewSize.h, n.position.x, n.position.y);
      editStyle = {
        left: x,
        top: y,
        width: m.w * state.camera.scale,
        height: m.h * state.camera.scale,
      };
      editColors = rendererRef.current?.nodeColors(currentRenderState(), state.editingId) ?? undefined;
    }
  }

  return (
    <div
      className="canvas-wrap"
      onPointerDownCapture={onWrapPointerDown}
      onPointerMoveCapture={onWrapPointerMove}
      onPointerUpCapture={onWrapPointerUp}
      onContextMenuCapture={onWrapContextMenu}
    >
      <canvas
        ref={canvasRef}
        className="canvas"
        style={{
          cursor:
            imgResizeHover || dragRef.current.imgResizing
              ? "nwse-resize"
              : resizing || resizeHover
                ? "ew-resize"
                : panning
                  ? "grabbing"
                  : state.mode === "pan"
                    ? "grab"
                    : "default",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          store.setHover(null);
          setResizeHover(false);
          setImgResizeHover(false);
        }}
        onDoubleClick={onDblClick}
        onContextMenu={onContextMenu}
        onDragOver={(e) => {
          // Accept the drop (T13-2): without preventDefault the browser would
          // navigate away on drop. Highlight the node under the cursor while
          // dragging so the user sees the target.
          if (!acceptsExternalDrop(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          // Ghost preview: resolve the dragged payload once, then pin the
          // image under the cursor (direct DOM update — dragover fires at
          // ~10Hz and React re-renders are wasted here).
          ensureExternalGhost(e.dataTransfer);
          const { x, y } = localPoint(e as unknown as RPointerEvent);
          const s = store.getSnapshot();
          const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
          const rs = currentRenderState();
          const hit = rendererRef.current?.hitTest(rs, world.x, world.y) ?? null;
          store.setHover(hit);
          // Over a node the ghost SNAPS onto the slot the cursor is nearest
          // to — the exact rect the image will occupy on drop. Elsewhere it
          // keeps following the cursor.
          const el = extGhostElRef.current;
          const rect = canvasRef.current!.getBoundingClientRect();
          let side: ImageSlot | null = null;
          if (hit) {
            const r = rendererRef.current?.nodeWorldRect(rs, hit);
            if (r) side = nearestImageSide(r, world.x, world.y);
          }
          extDropSideRef.current = side;
          if (el && extGhostRef.current) {
            if (side && hit) {
              const sr = rendererRef.current?.imageSlotWorldRect(rs, hit, side);
              if (sr) {
                const p1 = worldToScreen(s.camera, sizeRef.current.w, sizeRef.current.h, sr.x, sr.y);
                const p2 = worldToScreen(s.camera, sizeRef.current.w, sizeRef.current.h, sr.x + sr.w, sr.y + sr.h);
                el.style.left = `${rect.left + p1.x}px`;
                el.style.top = `${rect.top + p1.y}px`;
                el.style.width = `${p2.x - p1.x}px`;
                el.style.height = `${p2.y - p1.y}px`;
                return;
              }
            }
            el.style.left = `${e.clientX - rect.left + 16}px`;
            el.style.top = `${e.clientY - rect.top + 12}px`;
            el.style.width = "";
            el.style.height = "";
          }
        }}
        onDragLeave={(e) => {
          if (!dragRef.current?.dragging) store.setHover(null);
          // The canvas has no children: relatedTarget is null only when the
          // drag actually leaves the canvas area — clear the ghost then.
          // Moving over the editing overlay (a sibling) keeps the preview.
          if (!e.relatedTarget) clearExternalGhost();
        }}
        onDrop={async (e) => {
          // External sources: an OS file (Explorer, or a browser image that
          // Chromium materializes as a temp file) OR a browser image URL
          // (text/uri-list, the only payload some browsers hand over).
          if (!acceptsExternalDrop(e.dataTransfer)) return;
          e.preventDefault();
          clearExternalGhost();
          const { x, y } = localPoint(e as unknown as RPointerEvent);
          const world = screenToWorld(store.getSnapshot().camera, sizeRef.current.w, sizeRef.current.h, x, y);
          const target = rendererRef.current?.hitTest(currentRenderState(), world.x, world.y) ?? null;
          const side = extDropSideRef.current ?? "top";
          store.setHover(null);
          if (!target) {
            store.toast("Drop the image on a topic");
            return;
          }
          let file = firstImageFile(e.dataTransfer.files);
          if (!file) {
            const url = firstUriFromList(e.dataTransfer.getData("text/uri-list"));
            if (!url) {
              store.toast("Drop an image file or a browser image on a topic");
              return;
            }
            file = await fetchImageAsFile(url);
            if (!file) {
              store.toast("Could not load the image from its URL");
              return;
            }
          }
          const res = await store.attachImageFile(target, file, side);
          if (!res.ok) store.toast(res.reason ?? "Could not import image");
        }}
      />
      {state.relFrom && <div className="rel-pending">Click a target topic to link — Esc cancels</div>}
      {extGhostSrc && <img ref={extGhostElRef} className="ext-drop-ghost" src={extGhostSrc} alt="" draggable={false} />}
      {marquee && (
        <div
          className="marquee"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
      {editStyle && state.editingId && (
        <RichEditor
          key={state.editingId}
          node={store.doc.node(state.editingId)!}
          style={editStyle}
          scale={state.camera.scale}
          colors={editColors}
        />
      )}
    </div>
  );
}
