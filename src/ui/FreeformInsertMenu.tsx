/**
 * The draw.io-style picker a double-click on an empty part of a freeform
 * canvas opens: plain text or one of the base shapes, then any shape saved in
 * the library. The choice is created at the double-clicked point (shapes
 * centred on it) and plain text / base shapes open the editor at once.
 *
 * DOM chrome over the canvas, like the context menu. It closes on a choice,
 * Escape, a click elsewhere, or a wheel (the camera would move under it).
 */
import { useEffect, useRef, type JSX } from "react";
import { useStore } from "../editor/context";
import { FREEFORM_SHAPES, type FreeformShape } from "../core/freeform";
import { listShapes } from "../editor/shapeLibrary";

export interface FreeformInsertAt {
  /** The canvas topic the item goes into. */
  parentId: string;
  /** Where the double-click landed, in world coordinates (where it is created). */
  world: { x: number; y: number };
  /** The same point relative to the canvas element (where the menu opens). */
  screen: { x: number; y: number };
}

function ShapeIcon({ shape }: { shape: FreeformShape | "text" }): JSX.Element {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  let body: JSX.Element;
  switch (shape) {
    case "text":
      body = <text x="14" y="15" textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor">Aa</text>;
      break;
    case "rect":
      body = <rect x="3" y="4" width="22" height="13" {...common} />;
      break;
    case "rounded":
      body = <rect x="3" y="4" width="22" height="13" rx="4" {...common} />;
      break;
    case "capsule":
      body = <rect x="2" y="5" width="24" height="11" rx="5.5" {...common} />;
      break;
    case "circle":
      body = <circle cx="14" cy="10.5" r="7.5" {...common} />;
      break;
    case "diamond":
      body = <polygon points="14,2 26,10.5 14,19 2,10.5" {...common} />;
      break;
    case "hexagon":
      body = <polygon points="8,3 20,3 26,10.5 20,18 8,18 2,10.5" {...common} />;
      break;
  }
  return (
    <svg width="28" height="21" viewBox="0 0 28 21" aria-hidden="true">
      {body}
    </svg>
  );
}

export function FreeformInsertMenu({ at, bounds, onClose }: { at: FreeformInsertAt; bounds: { w: number; h: number }; onClose: () => void }): JSX.Element {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const library = listShapes();

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Capture on window, ahead of the map's own shortcuts (App's window
    // listener): while focus is in the picker, Enter/Space must press the
    // focused button, not create or edit a topic. Stopping propagation keeps
    // the browser's default action, which is exactly that click.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const menu = ref.current;
      if (!menu || !menu.contains(document.activeElement)) return;
      e.stopPropagation();
      // Arrow keys walk the buttons (four per row in the grid).
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 4 : e.key === "ArrowUp" ? -4 : 0;
      if (!step) return;
      e.preventDefault();
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[Math.max(0, Math.min(buttons.length - 1, i + step))]?.focus();
    };
    const onWheel = (): void => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [onClose]);

  const create = (shape?: FreeformShape): void => {
    onClose();
    store.createFreeformItem(at.parentId, at.world.x, at.world.y, "", undefined, shape);
  };

  // Keep the menu inside the canvas area: open up/left of the point near the edges.
  const W = 184, H = 100 + (library.length ? 30 + library.length * 28 : 0);
  const maxX = bounds.w - W - 8;
  const maxY = bounds.h - H - 8;
  const left = Math.max(8, Math.min(at.screen.x, maxX));
  const top = Math.max(8, Math.min(at.screen.y, maxY));

  return (
    <div
      ref={ref}
      className="ff-insert"
      role="menu"
      aria-label="Insert into canvas"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="ff-insert-grid">
        <button role="menuitem" className="ff-insert-btn" title="Text" onClick={() => create()}>
          <ShapeIcon shape="text" />
        </button>
        {FREEFORM_SHAPES.map(({ shape, label }) => (
          <button key={shape} role="menuitem" className="ff-insert-btn" title={label} onClick={() => create(shape)}>
            <ShapeIcon shape={shape} />
          </button>
        ))}
      </div>
      {library.length > 0 && (
        <>
          <div className="ff-insert-label">Library</div>
          {library.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              className="ff-insert-row"
              title={`Insert “${t.name}”`}
              onClick={() => {
                onClose();
                store.insertShape(t, at.parentId, at.world);
              }}
            >
              {t.name}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
