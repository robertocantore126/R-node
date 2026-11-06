/**
 * The quiz window — a floating, draggable, NON-modal window over the app
 * (the map stays usable behind it, so the notes for a question can be looked
 * up mid-quiz), opened from a topic's right-click menu ("Start quiz").
 * "Find in map" runs the plain map search on the question's words (and the
 * answer's, once answered) — see `quizSearchTiers`. It is DOM chrome, not canvas: the single-<canvas>
 * invariant (I1) governs the map, and a quiz is not part of the map.
 *
 * One question at a time, immediate right/wrong feedback, then a final score.
 * The score is written to the topic's `Style.quiz` through the store, so it is
 * persisted in the document and undone by one Ctrl+Z like any other edit; the
 * number recomputes from this run only, never from the stored value.
 * Closing mid-run remembers the question and the answers so far
 * (`studyProgress`); "Question 1" starts the run over.
 */
import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../editor/context";
import { clearStudyProgress, loadStudyProgress, saveStudyProgress, validQuizProgress } from "./studyProgress";
import { quizSearchTiers } from "../core/quiz";

let lastPos: { x: number; y: number } | null = null;

/** Keep at least the head on screen so the window can always be grabbed back. */
function clampPos(x: number, y: number, win: HTMLElement): { x: number; y: number } {
  const w = win.offsetWidth;
  const keep = 80;
  return {
    x: Math.min(Math.max(x, keep - w), window.innerWidth - keep),
    y: Math.min(Math.max(y, 0), window.innerHeight - 44),
  };
}

/**
 * Shift (screen px from the canvas centre) that puts a centred node in the
 * widest free strip beside the window — left/right first, above/below when
 * the sides are too narrow. 0,0 when the window does not cover the centre.
 */
export function centerOffsetBeside(canvas: DOMRect, win: DOMRect): { dx: number; dy: number } {
  const cx = (canvas.left + canvas.right) / 2;
  const cy = (canvas.top + canvas.bottom) / 2;
  const margin = 60;
  const covers = win.left - margin < cx && win.right + margin > cx && win.top - margin < cy && win.bottom + margin > cy;
  if (!covers) return { dx: 0, dy: 0 };
  const left = win.left - canvas.left;
  const right = canvas.right - win.right;
  const top = win.top - canvas.top;
  const bottom = canvas.bottom - win.bottom;
  if (Math.max(left, right) >= 160) {
    const mid = left >= right ? canvas.left + left / 2 : win.right + right / 2;
    return { dx: mid - cx, dy: 0 };
  }
  if (Math.max(top, bottom) >= 80) {
    const mid = top >= bottom ? canvas.top + top / 2 : win.bottom + bottom / 2;
    return { dx: 0, dy: mid - cy };
  }
  return { dx: 0, dy: 0 };
}

export function QuizWindow(): JSX.Element | null {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const nodeId = state.quizOpen?.nodeId ?? null;
  const quizId = state.quizOpen?.quizId ?? null;
  const node = nodeId ? store.doc.node(nodeId) : null;
  const quiz = nodeId && quizId ? node?.style.quizzes?.find((q) => q.id === quizId) ?? null : null;

  // Resume where the last run stopped, if it still fits this quiz.
  const [saved] = useState(() =>
    nodeId && quizId && quiz ? validQuizProgress(loadStudyProgress(nodeId, quizId), quiz.questions.length) : null);
  const [index, setIndex] = useState(saved?.index ?? 0);
  const [picked, setPicked] = useState<number | null>(saved && saved.results.length > saved.index ? saved.results[saved.index] : null);
  const [results, setResults] = useState<number[]>(saved?.results ?? []);
  const [done, setDone] = useState(false);
  const submitted = useRef(false);

  // Where the window sits (null = centred by CSS until first dragged). Kept in
  // the module so the next quiz opens where the user left the last one.
  const [pos, setPosState] = useState<{ x: number; y: number } | null>(lastPos);
  const setPos = (p: { x: number; y: number }): void => {
    lastPos = p;
    setPosState(p);
  };
  const winRef = useRef<HTMLDivElement>(null);

  // A remembered spot may be off-screen after a window resize: pull it back.
  useEffect(() => {
    const fit = (): void => {
      if (lastPos && winRef.current) setPos(clampPos(lastPos.x, lastPos.y, winRef.current));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Search jumps centre the match on the map — aim them at the free part of
  // the canvas, not under this window. Cheap, so re-measured on every render.
  useEffect(() => {
    const win = winRef.current;
    const canvas = document.querySelector(".canvas-area");
    if (win && canvas) {
      const o = centerOffsetBeside(canvas.getBoundingClientRect(), win.getBoundingClientRect());
      store.setCenterOffset(o.dx, o.dy);
    }
  });
  useEffect(() => () => store.setCenterOffset(0, 0), [store]);

  // The window is not modal: the map stays live behind it. Escape closes it
  // only while focus is inside it, so the map's and the search bar's own
  // Escape keep working.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const target = e.target as Node | null;
      if (target && winRef.current?.contains(target)) {
        e.preventDefault();
        store.closeQuiz();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store]);

  const questions = quiz?.questions ?? [];
  const correctCount = results.filter((r, k) => r === questions[k]?.correct).length;

  // A finished run is forgotten, so the next open starts from question 1.
  useEffect(() => {
    if (!nodeId || !quizId) return;
    if (done || results.length === 0) clearStudyProgress(nodeId, quizId);
    else saveStudyProgress(nodeId, quizId, { index, results });
  }, [nodeId, quizId, index, results, done]);

  // Persist the score exactly once per finished run (a retry resets the guard).
  useEffect(() => {
    if (!done || !nodeId || !quizId || submitted.current) return;
    submitted.current = true;
    store.submitQuizScore(nodeId, quizId, results);
  }, [done, nodeId, quizId, results, store]);

  if (!node || !quiz || questions.length === 0) return null;

  const q = questions[index];
  const isLast = index === questions.length - 1;
  const answered = picked !== null;

  const answer = (choice: number): void => {
    if (answered) return;
    setPicked(choice);
    winRef.current?.focus(); // the button is about to be disabled and drop focus; keep Escape working
    setResults((r) => [...r, choice]);
  };
  const next = (): void => {
    if (isLast) setDone(true);
    else {
      setIndex((i) => i + 1);
      setPicked(null);
    }
  };
  const retry = (): void => {
    setIndex(0);
    setPicked(null);
    setResults([]);
    setDone(false);
    submitted.current = false;
  };

  const pct = questions.length > 0 ? Math.round((correctCount / questions.length) * 100) : 0;
  const score = quiz.score;

  const onHeadPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const win = winRef.current;
    if (!win) return;
    e.preventDefault();
    const rect = win.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => setPos(clampPos(ev.clientX - dx, ev.clientY - dy, win));
    const up = (): void => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  };

  const findInMap = (): void => {
    store.searchBest(quizSearchTiers(q, answered));
  };

  return (
    <div className={`quiz-float${pos ? " placed" : ""}`} style={pos ? { left: pos.x, top: pos.y } : undefined}>
      <div
        ref={winRef}
        className="quiz-window"
        role="dialog"
        aria-modal="false"
        aria-label={quiz.name ?? node.title}
        tabIndex={-1}
        onPointerDown={(e) => {
          // A click on the window body focuses it, so Escape closes the quiz.
          if (!(e.target as HTMLElement).closest("button, input, textarea")) e.currentTarget.focus();
        }}
      >
        <div className="quiz-head" onPointerDown={onHeadPointerDown} title="Drag to move">
          <span className="quiz-title">{quiz.name ?? node.title ?? "Quiz"}</span>
          <span className="quiz-progress">
            {done ? "Result" : `Question ${index + 1} / ${questions.length}`}
          </span>
          {!done && results.length > 0 && (
            <button className="quiz-restart" title="Start again from question 1" onClick={retry}>
              ↺ Question 1
            </button>
          )}
          <button className="quiz-close" title="Close" onClick={() => store.closeQuiz()}>
            ×
          </button>
        </div>

        {!done ? (
          <div className="quiz-body">
            <p className="quiz-q">{q.q}</p>
            <div className="quiz-answers">
              {q.answers.map((a, idx) => {
                let cls = "quiz-answer";
                if (answered) {
                  if (idx === q.correct) cls += " correct";
                  else if (idx === picked) cls += " wrong";
                }
                return (
                  <button key={idx} className={cls} disabled={answered} onClick={() => answer(idx)}>
                    {a}
                  </button>
                );
              })}
            </div>
            {answered && q.explain && <p className="quiz-explain">{q.explain}</p>}
            <div className="quiz-actions">
              <button
                className="btn quiz-find"
                title={answered
                  ? "Search the map for the answer (plain search on the answer's words)"
                  : "Search the map for this question's topic (plain search, the answer is not used until you answer)"}
                onClick={findInMap}
              >
                ⌕ Find in map
              </button>
              {answered && (
                <button className="btn primary" onClick={next}>
                  {isLast ? "See result" : "Next"}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="quiz-body quiz-result">
            <p className="quiz-score">
              {correctCount} / {questions.length}
            </p>
            <p className="quiz-score-label">{pct}% correct</p>
            {results.some((answer,i) => answer !== questions[i]?.correct && !questions[i]?.sourceNodeIds?.length) &&
              <p className="quiz-best">Unlinked questions mark the topic holding this quiz. Generate a new quiz to link questions to individual topics.</p>}
            {score && (
              <p className="quiz-best">
                Best {score.best} / {questions.length} · {score.attempts} attempt{score.attempts > 1 ? "s" : ""}
              </p>
            )}
            <div className="quiz-actions">
              {correctCount < questions.length && <button className="btn" onClick={() => {
                store.setQuizMistakesVisible(node.id,true);
                store.closeQuiz();
              }}>Show mistakes on map</button>}
              <button className="btn" onClick={retry}>
                Retry
              </button>
              <button className="btn primary" onClick={() => store.closeQuiz()}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
