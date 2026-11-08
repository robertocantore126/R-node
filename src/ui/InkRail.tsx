import { useSyncExternalStore, type MouseEvent } from "react";
import { useStore } from "../editor/context";
import { INK_MAX_WIDTH, INK_MIN_WIDTH } from "../core/ink";

/** Keep focus on the map: a focused button would catch the next Enter. */
const keepFocus = (e: MouseEvent): void => e.preventDefault();

/** Pen and eraser, floating at the top left of the map. */
export function InkRail(): JSX.Element {
  const store = useStore();
  const { mode, ink } = useSyncExternalStore(store.subscribe, store.getUiSnapshot);
  const penOn = mode === "ink" && ink.tool === "pen";
  const eraserOn = mode === "ink" && ink.tool === "eraser";
  return (
    <div className="ink-rail" role="toolbar" aria-label="Handwriting" aria-orientation="vertical">
      <button
        className={penOn ? "on" : ""}
        aria-label="Pen"
        aria-pressed={penOn}
        data-help="Pen"
        data-help-more="Write by hand on a freeform canvas. Click again, or press Escape, to stop."
        onMouseDown={keepFocus}
        onClick={() => store.pickInkTool("pen")}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
      <button
        className={eraserOn ? "on" : ""}
        aria-label="Eraser"
        aria-pressed={eraserOn}
        data-help="Eraser"
        data-help-more="Drag over handwriting on a freeform canvas to remove whole strokes. Click again, or press Escape, to stop."
        onMouseDown={keepFocus}
        onClick={() => store.pickInkTool("eraser")}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l6.6 6.6a1 1 0 0 1 0 1.4L13 21" />
          <path d="M22 21H7" />
          <path d="m5 11 9 9" />
        </svg>
      </button>
      {penOn && (
        <label className="ink-width">
          <input
            type="range"
            min={INK_MIN_WIDTH}
            max={INK_MAX_WIDTH}
            step={1}
            value={ink.width}
            aria-label="Pen thickness in pixels"
            onChange={(e) => store.setInkSettings({ width: Number(e.target.value) })}
            // Hand the keyboard back, so P and Escape keep working after a drag.
            onPointerUp={(e) => e.currentTarget.blur()}
          />
          <span>{ink.width} px</span>
        </label>
      )}
    </div>
  );
}
