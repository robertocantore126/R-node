import { flashcardCounts } from "../core/flashcards";
import { quizHasMistakes } from "../core/quiz";
import type { FlashcardDeck, QuizInfo } from "../core/types";

interface Props {
  quizzes: QuizInfo[];
  flashcards: FlashcardDeck[];
  showQuizMistakes: boolean;
  activeQuizId: string | null;
  activeDeckId: string | null;
  onOpenQuiz: (quizId: string) => void;
  onRemoveQuiz: (quizId: string) => void;
  onAddFromClipboard: () => void;
  onToggleMistakes: () => void;
  onCopyQuizPrompt: () => void;
  onOpenFlashcards: (deckId: string) => void;
  onRemoveFlashcards: (deckId: string) => void;
  onCopyFlashcardsPrompt: () => void;
}

/**
 * Shared quiz + flashcard strips and prompt copy actions for both topic and
 * group right-click menus. "+" and "×" keep the menu open so decks/quizzes can
 * be pasted or cleaned up in batches.
 */
export function StudyMenuStrips(p: Props): JSX.Element {
  return (
    <>
      <div className="ctx-quiz-row" role="group" aria-label="Quizzes">
        {p.quizzes.map((q) => {
          const total = q.questions.length;
          const pct = q.score && total > 0 ? Math.round((q.score.last / total) * 100) : null;
          const active = p.activeQuizId === q.id;
          return (
            <span key={q.id} className="quiz-chip-wrap">
              <button
                className={`quiz-chip${active ? " active" : ""}`}
                title={q.name ?? "Quiz"}
                onClick={() => p.onOpenQuiz(q.id)}
              >
                <span className="quiz-chip-box" aria-hidden="true">
                  <svg viewBox="0 0 32 32" width="30" height="30">
                    <rect
                      x="1.5"
                      y="1.5"
                      width="29"
                      height="29"
                      rx="8"
                      fill="#33313d"
                      stroke={pct !== null || active ? "#726ed6" : "#5a586b"}
                      strokeWidth="1.6"
                    />
                    <path
                      d="M12.2 12.2a3.9 3.9 0 0 1 7.6 1.2c0 2.2-2.6 2.9-3.5 4.2-.2.3-.3.7-.3 1.2"
                      fill="none"
                      stroke="#f3f3f6"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    />
                    <circle cx="16" cy="23.2" r="2.1" fill={pct !== null ? "#e0b82e" : "#726ed6"} />
                  </svg>
                </span>
                <span className="quiz-chip-pct">{pct === null ? "—" : `${pct}%`}</span>
              </button>
              <button
                className="quiz-chip-del"
                title={`Delete ${q.name ?? "quiz"}`}
                aria-label={`Delete ${q.name ?? "quiz"}`}
                onClick={() => p.onRemoveQuiz(q.id)}
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          className="quiz-chip quiz-chip-add"
          title="Add a quiz from the clipboard"
          onClick={p.onAddFromClipboard}
        >
          +
        </button>
        <button
          className="quiz-chip quiz-mistakes-toggle"
          aria-label="Show quiz mistakes on map"
          aria-pressed={p.showQuizMistakes}
          disabled={!p.showQuizMistakes && !p.quizzes.some(quizHasMistakes)}
          title={p.showQuizMistakes ? "Hide mistake arrows" : "Show red arrows on topics missed in the latest quiz attempts"}
          onClick={p.onToggleMistakes}
        >
          <svg viewBox="0 0 40 52" width="24" height="28" aria-hidden="true"><path fill="currentColor" d="M13 2H27Q30 2 30 5V29H37Q41 29 38 33L22 49Q20 51 18 49L2 33Q-1 29 3 29H10V5Q10 2 13 2Z"/></svg>
          <span className="quiz-chip-pct">Review</span>
        </button>
      </div>
      <button role="menuitem" onClick={p.onCopyQuizPrompt}>
        Copy as quiz prompt
      </button>
      <div className="ctx-quiz-row" role="group" aria-label="Flashcards">
        {p.flashcards.map((d) => {
          const counts = flashcardCounts(d);
          const total = d.cards.length;
          const active = p.activeDeckId === d.id;
          return (
            <span key={d.id} className="quiz-chip-wrap">
              <button
                className={`quiz-chip flash-chip${active ? " active" : ""}`}
                title={`${d.name ?? "Flashcards"} · ${total} card${total > 1 ? "s" : ""}`}
                onClick={() => p.onOpenFlashcards(d.id)}
              >
                <span className="quiz-chip-box flash-chip-box" aria-hidden="true">
                  <svg viewBox="0 0 32 32" width="30" height="30">
                    <rect
                      x="1.5"
                      y="1.5"
                      width="29"
                      height="29"
                      rx="8"
                      fill="#33313d"
                      stroke={active ? "#8c88eb" : "#726ed6"}
                      strokeWidth="1.6"
                    />
                    <rect x="10.5" y="7" width="13.5" height="16.5" rx="2.6" transform="rotate(10 17 15)" fill="#726ed6" />
                    <rect x="7.5" y="8.5" width="13.5" height="16.5" rx="2.6" fill="#f3f3f6" />
                    <line x1="10.5" y1="14.5" x2="18" y2="14.5" stroke="#33313d" strokeWidth="1.8" strokeLinecap="round" />
                    <line x1="10.5" y1="18.2" x2="15.5" y2="18.2" stroke="#6c68c9" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="18" cy="11.3" r="1.4" fill="#e0b82e" />
                  </svg>
                </span>
                <span className="flash-chip-bar" aria-hidden="true">
                  {(["red", "yellow", "green", "none"] as const).map((k) =>
                    counts[k] > 0 ? <span key={k} className={k} style={{ flexGrow: counts[k] }} /> : null)}
                </span>
              </button>
              <button
                className="quiz-chip-del"
                title={`Delete ${d.name ?? "flashcards"}`}
                aria-label={`Delete ${d.name ?? "flashcards"}`}
                onClick={() => p.onRemoveFlashcards(d.id)}
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
          onClick={p.onAddFromClipboard}
        >
          +
        </button>
      </div>
      <button role="menuitem" onClick={p.onCopyFlashcardsPrompt}>
        Copy as flashcards prompt
      </button>
    </>
  );
}
