import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { useStore } from "../editor/context";
import { viewSize } from "../editor/view";
import { setExportPngHandler } from "../editor/exportBridge";
import { Renderer, type RenderState } from "../render/renderer";
import { screenToWorld, worldToScreen } from "../render/viewport";
import { measureNode } from "../layout/mindmap";
import { createCanvasTextMeasurer } from "../layout/measure";
import { isDescendantOf } from "../core/tree";

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
}

const overlayMeasurer = createCanvasTextMeasurer();

export function CanvasView(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sizeRef = useRef({ w: viewSize.w, h: viewSize.h });
  const dragRef = useRef<DragState>({ dragging: null, moved: false, panning: false, startX: 0, startY: 0, lastX: 0, lastY: 0, grabOffsetX: 0, grabOffsetY: 0 });
  const [, force] = useState(0);
  const [panning, setPanning] = useState(false);

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

    // wheel must be non-passive to preventDefault
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const { w, h } = sizeRef.current;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        store.zoomAt(sx, sy, e.deltaY < 0 ? 1.12 : 1 / 1.12, w, h);
      } else {
        store.panBy(e.deltaX, e.deltaY);
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      clearTimeout(fitTimer);
      ro.disconnect();
      unsub();
      canvas.removeEventListener("wheel", onWheel);
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
    canvasRef.current!.setPointerCapture(e.pointerId);
    const s = store.getSnapshot();
    const { x, y } = localPoint(e);
    const drag = dragRef.current;
    drag.startX = x;
    drag.startY = y;
    drag.lastX = x;
    drag.lastY = y;
    drag.moved = false;

    // Panning is right-drag (or middle-drag / pan mode): left-click never
    // pans, it only selects or drags topics.
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
    } else {
      store.clearSelection();
    }
  };

  const onPointerMove = (e: RPointerEvent): void => {
    const s0 = store.getSnapshot();
    if (!dragRef.current.panning && !dragRef.current.dragging) {
      const p = localPoint(e);
      const w = screenToWorld(s0.camera, sizeRef.current.w, sizeRef.current.h, p.x, p.y);
      store.setHover(rendererRef.current?.hitTest(currentRenderState(), w.x, w.y) ?? null);
    }
    const drag = dragRef.current;
    const { x, y } = localPoint(e);
    const dx = x - drag.lastX;
    const dy = y - drag.lastY;
    drag.lastX = x;
    drag.lastY = y;

    if (drag.panning) {
      store.panBy(dx, dy);
      return;
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
      store.setDrop({ mode: "floating", nodeId: drag.dragging });
    }
  };

  const onPointerUp = (e: RPointerEvent): void => {
    const drag = dragRef.current;
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
    };
  };

  // -------------------------------------------------------------------------
  // Inline editor overlay
  // -------------------------------------------------------------------------

  let editStyle: CSSProperties | null = null;
  if (state.editingId) {
    const n = store.doc.node(state.editingId);
    if (n) {
      const m = measureNode(n, overlayMeasurer);
      const { x, y } = worldToScreen(state.camera, viewSize.w, viewSize.h, n.position.x, n.position.y);
      editStyle = {
        left: x,
        top: y,
        width: m.w * state.camera.scale,
        height: m.h * state.camera.scale,
        fontSize: (n.style.fontSize ?? 14) * state.camera.scale,
        lineHeight: 1.2,
      };
    }
  }

  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        className="canvas"
        style={{ cursor: panning ? "grabbing" : state.mode === "pan" ? "grab" : "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => store.setHover(null)}
        onDoubleClick={onDblClick}
        onContextMenu={onContextMenu}
      />
      {state.relFrom && <div className="rel-pending">Click a target topic to link — Esc cancels</div>}
      {editStyle && <TopicEditor key={state.editingId ?? "topic-editor"} style={editStyle} />}
    </div>
  );
}

function TopicEditor({ style }: { style: CSSProperties }): JSX.Element {
  const store = useStore();
  // The editing node is the one being typed into — with Tab the selection
  // stays on the source node, so the editor must NOT read selectionNode.
  const editingId = store.getSnapshot().editingId;
  const node = editingId ? store.doc.node(editingId) : store.selectionNode;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(node?.title ?? "");

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (): void => {
    store.commitEdit(value);
  };

  return (
    <textarea
      ref={ref}
      className="topic-editor"
      style={style}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          store.cancelEdit();
        } else if (e.key === "Tab") {
          e.preventDefault();
          setValue((v) => v + "\t");
        }
      }}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
