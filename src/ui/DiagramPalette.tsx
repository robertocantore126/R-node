/**
 * Diagram mode's shape bar (draw.io's "General" panel): the base shapes in a
 * grid on the left of the canvas. A click drops the shape in the middle of
 * the view (each further click a little lower-right, so they do not stack);
 * dragging a shape out and releasing it over the map puts it there. Either way
 * the shape is a free top-level shape, and Tab grows its tree.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { useStore } from "../editor/context";
import { FREEFORM_SHAPES, type FreeformShape } from "../core/freeform";
import { ShapeIcon } from "./FreeformInsertMenu";

export function DiagramPalette({
  toWorld,
  viewCenter,
}: {
  /** Client (page) point → world point, or null when it is not over the map. */
  toWorld: (clientX: number, clientY: number) => { x: number; y: number } | null;
  /** The world point in the middle of the view. */
  viewCenter: () => { x: number; y: number };
}): JSX.Element {
  const store = useStore();
  const clicks = useRef(0);
  const [ghost, setGhost] = useState<{ shape: FreeformShape; x: number; y: number } | null>(null);
  const drag = useRef<{ shape: FreeformShape; x0: number; y0: number; moved: boolean; pointerId: number } | null>(null);

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      d.moved = true;
      setGhost({ shape: d.shape, x: e.clientX, y: e.clientY });
    };
    const up = (e: PointerEvent): void => {
      const d = drag.current;
      // Another pointer's release (a second finger, a pen) is not this drag's.
      if (d && e.pointerId !== d.pointerId) return;
      drag.current = null;
      setGhost(null);
      if (!d) return;
      if (!d.moved) {
        // A click: middle of the view, nudged so repeated clicks fan out.
        const c = viewCenter();
        const k = clicks.current++ % 6;
        store.createDiagramShape(d.shape, c.x + k * 24, c.y + k * 24);
        return;
      }
      const w = toWorld(e.clientX, e.clientY);
      if (w) store.createDiagramShape(d.shape, w.x, w.y);
    };
    // A cancelled gesture (touch interrupted, capture lost) or the window
    // losing focus drops the drag: no shape, no ghost left on screen, and no
    // stale drag for the next unrelated release to turn into a shape.
    const cancel = (): void => {
      if (!drag.current) return;
      drag.current = null;
      setGhost(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [store, toWorld, viewCenter]);

  return (
    <>
      <div
        className="diagram-palette"
        // The map must not see these presses (it would start a marquee). In
        // the bubble phase, so the shape buttons still get them first.
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="diagram-palette-title">Shapes</div>
        <div className="diagram-palette-grid">
          {FREEFORM_SHAPES.map(({ shape, label }) => (
            <button
              key={shape}
              className="diagram-palette-item"
              title={`${label} — click to add, or drag onto the map`}
              onPointerDown={(e) => {
                e.preventDefault();
                // Captured: the release reaches us even outside the window.
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
                drag.current = { shape, x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId };
              }}
            >
              <ShapeIcon shape={shape} />
            </button>
          ))}
        </div>
        <div className="diagram-palette-hint">Tab adds a child shape</div>
      </div>
      {ghost && (
        <div className="diagram-palette-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <ShapeIcon shape={ghost.shape} />
        </div>
      )}
    </>
  );
}
