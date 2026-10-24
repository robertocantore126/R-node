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
import { quizHasMistakes } from "../core/quiz";
import { flashcardCounts } from "../core/flashcards";
import { NodeBorderPicker } from "./Inspector";
import { chartSlotNote } from "../core/chartNotes";

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
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [recent, setRecent] = useState<string[]>(() => getRecentColors());
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [outlineOpen, setOutlineOpen] = useState(false);
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
    const onWheel = (e: WheelEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  return (
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
      <button role="menuitem" onClick={act(() => store.createChartTopic(node.id))}>
        New chart topic
      </button>
      {node.style.freeform && <button role="menuitem" onClick={act(() => store.createFreeformItem(node.id))}>Add text / node</button>}
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
      {/* The quiz strip: one square per quiz on this topic — each opens it and
          shows the last result under it — plus a "+" that appends a quiz from
          the clipboard. The "+" does NOT close the menu on purpose: the point
          is to paste several quizzes one after another. */}
      <div className="ctx-quiz-row" role="group" aria-label="Quizzes">
        {(node.style.quizzes ?? []).map((q) => {
          const total = q.questions.length;
          const pct = q.score && total > 0 ? Math.round((q.score.last / total) * 100) : null;
          const active = state.quizOpen?.quizId === q.id;
          return (
            <span key={q.id} className="quiz-chip-wrap">
              <button
                className={`quiz-chip${active ? " active" : ""}`}
                title={q.name ?? "Quiz"}
                onClick={act(() => store.openQuiz(node.id, q.id))}
              >
                <span className="quiz-chip-box" />
                <span className="quiz-chip-pct">{pct === null ? "—" : `${pct}%`}</span>
              </button>
              {/* Like the "+", deleting keeps the menu open; undo restores it. */}
              <button
                className="quiz-chip-del"
                title={`Delete ${q.name ?? "quiz"}`}
                aria-label={`Delete ${q.name ?? "quiz"}`}
                onClick={() => store.removeQuiz(node.id, q.id)}
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          className="quiz-chip quiz-chip-add"
          title="Add a quiz from the clipboard"
          onClick={() => void store.addQuizFromClipboard(node.id)}
        >
          +
        </button>
        <button
          className="quiz-chip quiz-mistakes-toggle"
          aria-label="Show quiz mistakes on map"
          aria-pressed={!!node.style.showQuizMistakes}
          disabled={!node.style.showQuizMistakes && !(node.style.quizzes ?? []).some(quizHasMistakes)}
          title={node.style.showQuizMistakes ? "Hide mistake arrows" : "Show red arrows on topics missed in the latest quiz attempts"}
          onClick={() => store.setQuizMistakesVisible(node.id,!node.style.showQuizMistakes)}
        >
          <svg viewBox="0 0 40 52" width="24" height="28" aria-hidden="true"><path fill="currentColor" d="M13 2H27Q30 2 30 5V29H37Q41 29 38 33L22 49Q20 51 18 49L2 33Q-1 29 3 29H10V5Q10 2 13 2Z"/></svg>
          <span className="quiz-chip-pct">Review</span>
        </button>
      </div>
      {/* Copies the branch's outline followed by a prompt that asks an LLM for
          a quiz; pasting the answer back attaches it to the selected topic. */}
      <button role="menuitem" onClick={act(() => void store.copyQuizPrompt(node.id))}>
        Copy as quiz prompt
      </button>
      {/* The flashcard strip, built like the quiz strip: one square per deck
          (its bar shows the red / yellow / green split), "×" deletes, "+"
          appends from the clipboard and keeps the menu open. */}
      <div className="ctx-quiz-row" role="group" aria-label="Flashcards">
        {(node.style.flashcards ?? []).map((d) => {
          const counts = flashcardCounts(d);
          const total = d.cards.length;
          const active = state.flashcardsOpen?.deckId === d.id;
          return (
            <span key={d.id} className="quiz-chip-wrap">
              <button
                className={`quiz-chip flash-chip${active ? " active" : ""}`}
                title={`${d.name ?? "Flashcards"} · ${total} card${total > 1 ? "s" : ""}`}
                onClick={act(() => store.openFlashcards(node.id, d.id))}
              >
                <span className="quiz-chip-box flash-chip-box" />
                <span className="flash-chip-bar" aria-hidden="true">
                  {(["red", "yellow", "green", "none"] as const).map((k) =>
                    counts[k] > 0 ? <span key={k} className={k} style={{ flexGrow: counts[k] }} /> : null)}
                </span>
              </button>
              <button
                className="quiz-chip-del"
                title={`Delete ${d.name ?? "flashcards"}`}
                aria-label={`Delete ${d.name ?? "flashcards"}`}
                onClick={() => store.removeFlashcards(node.id, d.id)}
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          className="quiz-chip quiz-chip-add"
          title="Add flashcards from the clipboard"
          aria-label="Add flashcards from the clipboard"
          onClick={() => void store.addQuizFromClipboard(node.id)}
        >
          +
        </button>
      </div>
      <button role="menuitem" onClick={act(() => void store.copyFlashcardsPrompt(node.id))}>
        Copy as flashcards prompt
      </button>
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
  );
}
