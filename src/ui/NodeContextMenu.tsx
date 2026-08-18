/**
 * Right-click context menu for a topic.
 *
 * Appears when the user right-clicks a topic and offers the topic-level
 * actions that have no keyboard gesture: New subtopic, New code topic,
 * Delete and Change color. It is DOM chrome — the single-canvas invariant
 * (I1) governs the MAP, not the menus around it, exactly like the Inspector.
 *
 * Positioned in canvas-wrap space (the wrap is `position: absolute; inset: 0`),
 * clamped to stay inside the canvas area. Closes on: an action, a click
 * outside, Escape, or a wheel/pan gesture.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../editor/context";
import { getRecentColors } from "../editor/recentColors";
import { THEMES } from "../render/theme";

export interface CtxMenuState {
  /** Canvas-wrap coordinates of the cursor when the menu opened. */
  x: number;
  y: number;
  /** The right-clicked topic. */
  nodeId: string;
}

interface Props {
  menu: CtxMenuState;
  onClose: () => void;
}

export function NodeContextMenu({ menu, onClose }: Props): JSX.Element {
  const store = useStore();
  const [recent, setRecent] = useState<string[]>(() => getRecentColors());
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const ref = useRef<HTMLDivElement>(null);

  // Keep the menu inside the canvas area: measure after mount and clamp when
  // it would run past the right/bottom edge (the menu is ~200px wide).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wrap = el.parentElement?.getBoundingClientRect();
    if (!wrap) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(6, Math.min(menu.x, wrap.width - r.width - 6)),
      y: Math.max(6, Math.min(menu.y, wrap.height - r.height - 6)),
    });
  }, [menu.x, menu.y]);

  // Close on: a pointerdown outside the menu, Escape, or any wheel gesture
  // (a pan/zoom while the menu is open would leave it floating over the map).
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onWheel = (): void => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [onClose]);

  const node = store.doc.node(menu.nodeId);
  if (!node) return <></>;
  const isRoot = node.id === store.sheet.rootNodeId;

  const act = (fn: () => void) => (): void => {
    fn();
    onClose();
  };

  // Colour applies to the SELECTED topics only — never to their descendants:
  // right-clicking a topic already inside a marquee multi-selection keeps the
  // whole selection, so one pick recolours every selected topic, exactly like
  // the Inspector's colour input would. The picked colour is recorded and
  // shown in the Recent row next time.
  const pick = (color: string): void => {
    store.setSelectionColor(color);
    setRecent(getRecentColors());
    onClose();
  };

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <button role="menuitem" onClick={act(() => store.createChildOf(node.id))}>
        New subtopic
      </button>
      <button role="menuitem" onClick={act(() => store.createCodeTopic(node.id))}>
        New code topic
      </button>
      <button role="menuitem" onClick={act(() => store.createGalleryTopic(node.id))}>
        New gallery topic
      </button>
      <div className="ctx-sep" />
      <button
        role="menuitem"
        disabled={isRoot}
        title={isRoot ? "The central topic cannot be deleted" : undefined}
        onClick={act(() => store.deleteNodes([node.id]))}
      >
        Delete
      </button>
      {/* A code topic is VIEW ONLY (T22): its colours are derived from the
          theme at paint time, so the colour rows — which are editing — are
          not offered for it, whatever the selection holds. */}
      {!node.style.code && (
        <>
          <div className="ctx-sep" />
          {/* The colour rows are ALWAYS visible — no dropdown to open: the
              theme palette and the recent picks sit right in the menu, one
              small square per colour. */}
          <div className="ctx-color-row">
            <span className="ctx-label">Color</span>
            {THEMES.light.branch.map((c) => (
              <button key={c} className="ctx-swatch" style={{ background: c }} title={c} onClick={() => pick(c)} />
            ))}
          </div>
          {recent.length > 0 && (
            <div className="ctx-color-row">
              <span className="ctx-label">Recent</span>
              {recent.map((c) => (
                <button key={c} className="ctx-swatch" style={{ background: c }} title={c} onClick={() => pick(c)} />
              ))}
            </div>
          )}
          <div className="ctx-color-tools">
            <input
              type="color"
              className="ctx-color"
              defaultValue="#4f46e5"
              title="Custom color"
              onChange={(e) => pick(e.target.value)}
            />
            <button className="ctx-reset" onClick={act(() => store.resetSelectionColor())}>
              Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
