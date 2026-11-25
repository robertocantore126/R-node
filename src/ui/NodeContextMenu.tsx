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
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import { getRecentColors } from "../editor/recentColors";
import { THEMES } from "../render/theme";
import { NodeBorderPicker } from "./Inspector";
import { ColorWheelPanel } from "./ColorWheelPanel";
import { StudyMenuStrips } from "./StudyMenuStrips";
import { toHex } from "../core/paint";
import { chartSlotNote, freeformNote } from "../core/chartNotes";
import { freeformOwner, isFreeTransform } from "../core/freeform";

export interface CtxMenuState {
  /** Canvas-wrap coordinates of the cursor when the menu opened. */
  x: number;
  y: number;
  /** The right-clicked topic. */
  nodeId: string;
  /** Set when the topic is a chart with one of its boxes selected: the menu
   *  is then the BOX menu, about that slot, instead of the topic menu. */
  cell?: number;
}

interface Props {
  menu: CtxMenuState;
  onClose: () => void;
}

export function NodeContextMenu({ menu, onClose }: Props): JSX.Element {
  const store = useStore();
  // The quiz strip lives in this menu and changes while it is open (each "+"
  // appends a quiz), so the menu must re-render on store changes.
  const state = useSyncExternalStore(store.subscribe, store.getUiSnapshot);
  const [recent, setRecent] = useState<string[]>(() => getRecentColors());
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [wheelPos, setWheelPos] = useState<{ x: number; y: number } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);

  // Keep the menu inside the canvas area: measure after mount and clamp when
  // it would run past the right/bottom edge (the menu is ~200px wide).
  // Position the companion ColorWheelPanel beside the menu (right side when
  // room allows, otherwise flipped to the left).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wrap = el.parentElement?.getBoundingClientRect();
    if (!wrap) return;
    const r = el.getBoundingClientRect();
    const mx = Math.max(6, Math.min(menu.x, wrap.width - r.width - 6));
    const my = Math.max(6, Math.min(menu.y, wrap.height - r.height - 6));
    setPos({ x: mx, y: my });

    const wEl = wheelRef.current;
    if (wEl) {
      const wr = wEl.getBoundingClientRect();
      const gap = 10;
      const rightX = mx + r.width + gap;
      const leftX = mx - wr.width - gap;
      const wx =
        rightX + wr.width <= wrap.width - 6
          ? rightX
          : leftX >= 6
            ? leftX
            : Math.max(6, wrap.width - wr.width - 6);
      const wy = Math.max(6, Math.min(my + 24, wrap.height - wr.height - 6));
      setWheelPos({ x: wx, y: wy });
    }
  }, [menu.x, menu.y]);

  // Close on: a pointerdown outside the menu + wheel, Escape, or any wheel gesture
  // (a pan/zoom while the menu is open would leave it floating over the map).
  useEffect(() => {
    const inside = (target: EventTarget | null): boolean => {
      const n = target as Node | null;
      return !!(n && (ref.current?.contains(n) || wheelRef.current?.contains(n)));
    };
    const onDown = (e: PointerEvent): void => {
      if (!inside(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onWheel = (e: WheelEvent): void => {
      if (!inside(e.target)) onClose();
    };
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

  // Picking from the side color wheel keeps the menu open so the user can
  // explore harmonies or fine-tune lightness without reopening right-click.
  const pickStayOpen = (color: string): void => {
    store.setSelectionColor(color);
    setRecent(getRecentColors());
  };

  if (menu.cell !== undefined && node.style.gallery?.chart) {
    const cell = menu.cell;
    const note = chartSlotNote(store.sheet, node.id, cell);
    const slot = node.style.gallery.items[cell];
    const boxEmpty = !slot?.id && !slot?.caption && !note;
    return (
      <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu" aria-label="Box">
        {note ? <>
          <button role="menuitem" onClick={act(() => store.startEdit(note.id))}>Edit note</button>
          <button role="menuitem" onClick={act(() => store.removeChartNote(node.id, cell))}>Remove note</button>
        </> : (
          <button role="menuitem" onClick={act(() => store.addChartNote(node.id, cell))}>Add note</button>
        )}
        <button role="menuitem" onClick={act(() => void store.addChartPlaceholder(node.id, cell))}>Add placeholder box</button>
        <div className="ctx-sep" />
        <button role="menuitem" disabled={boxEmpty} onClick={act(() => store.clearChartBox(node.id, cell))}>Clear box</button>
      </div>
    );
  }

  const initialWheelHex = toHex(node.style.fill) ?? "#6c68c9";

  return (
    <>
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <button role="menuitem" onClick={act(() => store.createChildOf(node.id))}>
        New subtopic
      </button>
      <button role="menuitem" onClick={act(() => store.createCodeTopic(node.id))}>
        New code topic
      </button>
      <button role="menuitem" onClick={act(() => store.createFreeformTopic(node.id))}>
        New freeform topic
      </button>
      <button role="menuitem" title="Ask any AI chat for a draw.io diagram and import it" onClick={act(() => store.openAiDiagram(node.id))}>
        {node.style.freeform ? "Diagram from AI…" : "New diagram from AI…"}
      </button>
      <button role="menuitem" onClick={act(() => store.createChartTopic(node.id))}>
        New chart topic
      </button>
      {node.style.freeform && <button role="menuitem" onClick={act(() => store.createFreeformItem(node.id))}>Add text / node</button>}
      {node.style.freeform && <button role="menuitem" onClick={act(() => store.toggleInkMode())}>Write with pen</button>}
      {node.style.freeform && (freeformNote(store.sheet, node.id) ? <>
        <button role="menuitem" onClick={act(() => store.toggleCanvasNote(node.id))}>{state.shownCanvasNote === node.id ? "Hide notes" : "Show notes"}</button>
        <button role="menuitem" onClick={act(() => store.addCanvasNote(node.id))}>Edit note</button>
        <button role="menuitem" onClick={act(() => store.removeCanvasNote(node.id))}>Remove note</button>
      </> : (
        <button role="menuitem" onClick={act(() => store.addCanvasNote(node.id))}>Add note</button>
      ))}
      {/* Growing a chart keeps the menu open, like the quiz "+": the point is
          to click "+ column" three times in a row. */}
      {node.style.gallery?.chart && (
        <div className="ctx-size-row" role="group" aria-label="Chart size">
          <span className="ctx-label">Chart</span>
          <button role="menuitem" title="Add a row at the bottom" onClick={() => store.resizeChart(node.id, 1, 0)}>+ row</button>
          <button role="menuitem" title="Add a column on the right" onClick={() => store.resizeChart(node.id, 0, 1)}>+ col</button>
          <button role="menuitem" title="Remove the bottom row" onClick={() => store.resizeChart(node.id, -1, 0)}>− row</button>
          <button role="menuitem" title="Remove the right column" onClick={() => store.resizeChart(node.id, 0, -1)}>− col</button>
        </div>
      )}
      <button role="menuitem" onClick={act(() => store.createGalleryTopic(node.id))}>
        New gallery topic
      </button>
      {!node.style.code && !node.style.gallery && !node.style.freeform && !node.style.shapeParts && <>
        <div className="ctx-sep" />
        <div className="ctx-size-row" role="group" aria-label="Topic size">
          <span className="ctx-label">Size</span>
          <button role="menuitem" aria-label="Smaller text" title="Smaller text and node" onClick={() => store.setSelectionTopicSize("smaller")}>A?</button>
          <span className="ctx-size-value">{node.style.fontSize ?? 14} px</span>
          <button role="menuitem" aria-label="Larger text" title="Larger text and node" onClick={() => store.setSelectionTopicSize("larger")}>A+</button>
        </div>
        <div className="ctx-size-presets" role="group" aria-label="Topic size presets">
          <button role="menuitem" title="14 px ? regular" onClick={act(() => store.setSelectionTopicSize("normal"))}>Normal</button>
          <button role="menuitem" title="80 px - semibold" onClick={act(() => store.setSelectionTopicSize("large"))}>Large</button>
          <button role="menuitem" title="200 px - bold" onClick={act(() => store.setSelectionTopicSize("heading"))}>Heading</button>
        </div>
        {freeformOwner(store.sheet, node.id) && (
          <button
            role="menuitem"
            title="Corner-resizing scales text size proportionally instead of only resizing the box"
            onClick={act(() => store.setSelectionStyle({ freeTransform: !isFreeTransform(store.sheet, node) }, [node.id]))}
          >
            {isFreeTransform(store.sheet, node) ? "✓ Free transform resize" : "Free transform resize"}
          </button>
        )}
      </>}
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
      {/* Outline: folded behind one row so the menu does not double in
          height, and kept open while picking — style, width and colour are
          usually chosen together. Applies to the selection like Color does. */}
      {!node.style.code && !node.style.freeform && (
        <>
          <button role="menuitem" aria-expanded={outlineOpen} onClick={() => setOutlineOpen((v) => !v)}>
            Outline {outlineOpen ? "▾" : "▸"}
          </button>
          {outlineOpen && (
            <div className="ctx-outline">
              <NodeBorderPicker style={node.style} ids={state.selection.includes(node.id) ? state.selection : [node.id]} />
            </div>
          )}
        </>
      )}
      <div className="ctx-sep" />
      {/* Quiz and flashcard strips — "+" and "×" keep the menu open so several
          quizzes or decks can be pasted or deleted in one go. */}
      <StudyMenuStrips
        quizzes={node.style.quizzes ?? []}
        flashcards={node.style.flashcards ?? []}
        showQuizMistakes={!!node.style.showQuizMistakes}
        activeQuizId={state.quizOpen?.quizId ?? null}
        activeDeckId={state.flashcardsOpen?.deckId ?? null}
        onOpenQuiz={(quizId) => act(() => store.openQuiz(node.id, quizId))()}
        onRemoveQuiz={(quizId) => store.removeQuiz(node.id, quizId)}
        onAddFromClipboard={() => void store.addQuizFromClipboard(node.id)}
        onToggleMistakes={() => store.setQuizMistakesVisible(node.id, !node.style.showQuizMistakes)}
        onCopyQuizPrompt={act(() => void store.copyQuizPrompt(node.id))}
        onOpenFlashcards={(deckId) => act(() => store.openFlashcards(node.id, deckId))()}
        onRemoveFlashcards={(deckId) => store.removeFlashcards(node.id, deckId)}
        onCopyFlashcardsPrompt={act(() => void store.copyFlashcardsPrompt(node.id))}
      />
      <div className="ctx-sep" />
      {/* The AI expand round trip: copy the branch with a prompt asking an LLM
          to grow it, then paste its JSON answer back as new subtopics. A
          separate paste from the quiz "+" so the two payloads never mix. */}
      <button role="menuitem" onClick={act(() => void store.copyAiExpandPrompt(node.id))}>
        Copy as AI expand prompt
      </button>
      <button role="menuitem" onClick={act(() => void store.pasteAiExpand(node.id))}>
        Paste as AI expand
      </button>
    </div>
    {!node.style.code && (
      <ColorWheelPanel
        key={node.id}
        panelRef={wheelRef}
        initialHex={initialWheelHex}
        onCommit={pickStayOpen}
        style={
          wheelPos
            ? { left: wheelPos.x, top: wheelPos.y }
            : { left: pos.x + 230, top: pos.y + 24, visibility: "hidden" }
        }
      />
    )}
    </>
  );
}
