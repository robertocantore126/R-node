/**
 * Inline title field of one gallery / chart cell, opened by double-clicking
 * the cell. A plain <input> laid over the cell's title band — chrome, like the
 * context menu, not a second renderer of node text: a caption is a plain
 * string (see `GalleryItem`), so nothing here has to match the canvas glyph
 * for glyph. Its opaque background hides the caption the canvas painted under
 * it, so the text is never seen twice.
 *
 * Being a real input is the point: the title can be selected, copied, cut and
 * pasted with the browser's own gestures (Ctrl+A/C/X/V, the native right-click
 * menu). The app's shortcuts already skip focused fields (App.tsx) and the
 * canvas paste handler skips inputs, so none of them reach the map.
 *
 * Commits on Enter and on blur; Escape cancels.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

interface Props {
  /** Screen rect of the title band, in canvas-wrap pixels. */
  rect: { left: number; top: number; width: number; height: number };
  /** Font size in screen pixels (caption size × zoom). */
  fontSize: number;
  caption: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function CaptionField({ rect, fontSize, caption, onCommit, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(caption);
  const ref = useRef<HTMLInputElement>(null);
  // Escape must not ALSO commit through the blur that unmounting causes.
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(text);
    else onCancel();
  };

  // Zoomed out, a cell is narrower than a title worth reading: the field
  // widens around the cell's centre instead of shrinking with it.
  const width = Math.max(rect.width, 140);
  const style: CSSProperties = {
    left: rect.left - (width - rect.width) / 2,
    top: rect.top,
    width,
    // Never shorter than one readable line, whatever the zoom.
    height: Math.max(rect.height, fontSize * 1.6, 18),
    fontSize: Math.max(fontSize, 11),
  };

  return (
    <input
      ref={ref}
      className="caption-field"
      style={style}
      type="text"
      value={text}
      placeholder="title"
      aria-label="Cell title"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Kept inside the field: Enter/Escape here are about the title, not
        // the map.
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      // Clicks and drags inside the field select text; they must not reach
      // the canvas, which would start a pan, a marquee or a cell drag.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
