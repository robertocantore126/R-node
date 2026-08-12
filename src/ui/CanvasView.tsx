import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { useStore } from "../editor/context";
import { viewSize } from "../editor/view";
import { setExportPngHandler } from "../editor/exportBridge";
import { Renderer, type RenderState } from "../render/renderer";
import { screenToWorld, worldToScreen } from "../render/viewport";
import { imageResolver, measureNode } from "../layout/mindmap";
import { createCanvasTextMeasurer, MIN_TOPIC_W } from "../layout/measure";
import { isDescendantOf } from "../core/tree";
import type { MindNode } from "../core/types";
import { RichEditor } from "./RichEditor";
import { installTrace, trace } from "../dev/trace";

/**
 * Paint synchronously on every store change. rAF is unreliable in embedded
 * webviews (it never fires when the view is not compositing), so we render
 * directly; culling keeps this cheap even for large maps. A rAF-coalescing
 * fast path can be reintroduced once the WebGPU renderer lands.
 */
function schedulePaint(fn: () => void): void {
  fn();
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

export function CanvasView(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sizeRef = useRef({ w: viewSize.w, h: viewSize.h });
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
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const paint = useCallback(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) return;
    const { w, h } = sizeRef.current;
    const s = store.getSnapshot();
    const rs: RenderState = {
      sheet: store.sheet,
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
    };
    renderer.render(rs);
  }, [store]);

  const schedule = useCallback(() => {
    schedulePaint(paint);
  }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;

    const ro = new ResizeObserver(() => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
      viewSize.w = rect.width;
      viewSize.h = rect.height;
      renderer.resize(canvas, rect.width, rect.height);
      schedule();
    });
    ro.observe(canvas.parentElement!);
    renderer.resize(canvas, sizeRef.current.w, sizeRef.current.h);
    schedule();
    // fit the map into view once layout settles after mount
    const fitTimer = setTimeout(() => {
      store.fitView(sizeRef.current.w, sizeRef.current.h);
    }, 150);

    setExportPngHandler(() => {
      const s = store.getSnapshot();
      const rs: RenderState = {
        sheet: store.sheet,
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
    };
  }, [store, schedule]);

  // re-paint when state changes (camera, selection, edits, layout…)
  useEffect(() => {
    schedule();
    force((n) => n + 1);
  }, [state, schedule]);

  // -------------------------------------------------------------------------
  // Pointer handling
  // -------------------------------------------------------------------------

  const localPoint = (e: RPointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: RPointerEvent): void => {
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
      return;
    }
    if (!drag.dragging) {
      const p = localPoint(e);
      const w = screenToWorld(s0.camera, sizeRef.current.w, sizeRef.current.h, p.x, p.y);
      const renderer = rendererRef.current;
      const rs = currentRenderState();
      const rh = renderer?.hitTestResize(rs, w.x, w.y) ?? null;
      setResizeHover(!!rh);
      store.setHover(rh ? null : (renderer?.hitTest(rs, w.x, w.y) ?? null));
    }
    if (!drag.dragging) return;
    if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 4) return;
    drag.moved = true;

    const s = store.getSnapshot();
    const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
    const renderer = rendererRef.current!;
    const rs = currentRenderState();
    const hit = renderer.hitTest(rs, world.x, world.y);

    if (hit && hit !== drag.dragging && !isDescendantOf(store.doc, drag.dragging, hit)) {
      const r = renderer.nodeWorldRect(rs, hit);
      if (r) {
        const relY = (world.y - r.y) / r.h;
        const mode = relY < 0.28 ? "before" : relY > 0.72 ? "after" : "child";
        store.setDrop({ mode, nodeId: hit });
      }
    } else {
      // Only main topics (root children) and floating topics can be pinned to
      // a free position — deeper hierarchical nodes stay in the auto layout.
      const dragged = store.doc.node(drag.dragging);
      const canFloat = !!dragged && (!dragged.parentId || dragged.parentId === store.sheet.rootNodeId);
      store.setDrop(canFloat ? { mode: "floating", nodeId: drag.dragging } : { mode: "none", nodeId: drag.dragging });
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
      drag.marqueeActive = false;
      drag.marqueeStartX = null;
      drag.marqueeStartY = null;
      setMarquee(null);
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
    if (drag.dragging && drag.moved) {
      const s = store.getSnapshot();
      const drop = s.drop;
      if (drop && drop.mode !== "none") {
        const { x, y } = localPoint(e);
        const world = screenToWorld(s.camera, sizeRef.current.w, sizeRef.current.h, x, y);
        const target = drop.mode === "floating" ? null : drop.nodeId;
        store.dropAt(
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
    };
  };

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
      const m = measureNode(n, overlayMeasurer, imageResolver(store.sheet));
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
          cursor: resizing || resizeHover ? "ew-resize" : panning ? "grabbing" : state.mode === "pan" ? "grab" : "default",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          store.setHover(null);
          setResizeHover(false);
        }}
        onDoubleClick={onDblClick}
        onContextMenu={onContextMenu}
      />
      {state.relFrom && <div className="rel-pending">Click a target topic to link — Esc cancels</div>}
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
