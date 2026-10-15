/**
 * The quiz window — a modal over the app, opened from a topic's right-click
 * menu ("Start quiz"). It is DOM chrome, not canvas: the single-<canvas>
 * invariant (I1) governs the map, and a quiz is not part of the map.
 *
 * One question at a time, immediate right/wrong feedback, then a final score.
 * The score is written to the topic's `Style.quiz` through the store, so it is
 * persisted in the document and undone by one Ctrl+Z like any other edit; the
 * number recomputes from this run only, never from the stored value.
 */
import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";

export function QuizWindow(): JSX.Element | null {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const nodeId = state.quizNodeId;
  const node = nodeId ? store.doc.node(nodeId) : null;
  const quiz = node?.style.quiz ?? null;

  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [results, setResults] = useState<number[]>([]);
  const [done, setDone] = useState(false);
  const submitted = useRef(false);

  // Escape closes the window (capture so it beats the map's own Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        store.closeQuiz();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store]);

  const questions = quiz?.questions ?? [];
  const correctCount = results.filter((r, k) => r === questions[k]?.correct).length;

  // Persist the score exactly once per finished run (a retry resets the guard).
  useEffect(() => {
    if (!done || !nodeId || submitted.current) return;
    submitted.current = true;
    store.submitQuizScore(nodeId, correctCount);
  }, [done, nodeId, correctCount, store]);

  if (!node || !quiz || questions.length === 0) return null;

  const q = questions[index];
  const isLast = index === questions.length - 1;
  const answered = picked !== null;

  const answer = (choice: number): void => {
    if (answered) return;
    setPicked(choice);
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

  return (
    <div
      className="quiz-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) store.closeQuiz();
      }}
    >
      <div className="quiz-window" role="dialog" aria-modal="true" aria-label={quiz.name ?? node.title}>
        <div className="quiz-head">
          <span className="quiz-title">{quiz.name ?? node.title ?? "Quiz"}</span>
          <span className="quiz-progress">
            {done ? "Result" : `Question ${index + 1} / ${questions.length}`}
          </span>
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
            {score && (
              <p className="quiz-best">
                Best {score.best} / {questions.length} · {score.attempts} attempt{score.attempts > 1 ? "s" : ""}
              </p>
            )}
            <div className="quiz-actions">
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
