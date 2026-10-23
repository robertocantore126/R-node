/**
 * The flashcard window — a modal over the app, opened from a deck's square in
 * the topic's right-click menu. DOM chrome like the quiz window (the single-
 * <canvas> invariant governs the map, and a deck is not part of the map).
 *
 * One card at a time: the front shows the term, Flip (or Space) turns it to
 * the definition, and red / yellow / green rate it and move on. Each rating is
 * written to the document at once, so closing halfway keeps it. The order
 * toggle beside the ratings switches between deck order and criticality
 * (red → unrated → yellow → green); the run order is fixed when the run starts
 * so a card does not jump while you rate it. Closing mid-run remembers the
 * card you were on (`studyProgress`); "From card 1" starts the run over.
 */
import { useCallback, useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import { flashcardCounts, flashcardRunOrder } from "../core/flashcards";
import type { FlashcardRating } from "../core/types";
import { clearStudyProgress, loadStudyProgress, saveStudyProgress, validFlashcardProgress } from "./studyProgress";

const RATINGS: { rating: FlashcardRating; label: string; key: string }[] = [
  { rating: "red", label: "Don't know", key: "1" },
  { rating: "yellow", label: "Partly", key: "2" },
  { rating: "green", label: "Know it", key: "3" },
];

export function FlashcardWindow(): JSX.Element | null {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const nodeId = state.flashcardsOpen?.nodeId ?? null;
  const deckId = state.flashcardsOpen?.deckId ?? null;
  const node = nodeId ? store.doc.node(nodeId) : null;
  const deck = nodeId && deckId ? node?.style.flashcards?.find((d) => d.id === deckId) ?? null : null;

  // Resume where the last run stopped, if it still fits this deck.
  const [saved] = useState(() =>
    nodeId && deckId && deck ? validFlashcardProgress(loadStudyProgress(nodeId, deckId), deck.cards.length) : null);
  const [byCriticality, setByCriticality] = useState(saved?.byCriticality ?? false);
  const [order, setOrder] = useState<number[]>(() => saved?.order ?? (deck ? flashcardRunOrder(deck, false) : []));
  const [pos, setPos] = useState(saved?.pos ?? 0);
  const [flipped, setFlipped] = useState(false);

  const cardIndex = order[pos];
  const card = deck && cardIndex !== undefined ? deck.cards[cardIndex] : undefined;
  const done = !!deck && pos >= order.length;

  // A finished run is forgotten, so the next open starts from card 1.
  useEffect(() => {
    if (!nodeId || !deckId || order.length === 0) return;
    if (done) clearStudyProgress(nodeId, deckId);
    else saveStudyProgress(nodeId, deckId, { order, pos, byCriticality });
  }, [nodeId, deckId, order, pos, byCriticality, done]);

  const restart = useCallback((critical: boolean): void => {
    if (!deck) return;
    setByCriticality(critical);
    setOrder(flashcardRunOrder(deck, critical));
    setPos(0);
    setFlipped(false);
  }, [deck]);

  const rate = useCallback((rating: FlashcardRating): void => {
    if (!nodeId || !deckId || cardIndex === undefined) return;
    store.rateFlashcard(nodeId, deckId, cardIndex, rating);
    setPos((p) => p + 1);
    setFlipped(false);
  }, [store, nodeId, deckId, cardIndex]);

  const step = useCallback((delta: number): void => {
    setPos((p) => Math.max(0, Math.min(order.length - 1, p + delta)));
    setFlipped(false);
  }, [order.length]);

  // Keys in capture, and swallowed, so the map's own shortcuts never see them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      if (e.key === "Escape") store.closeFlashcards();
      else if (done) handled = false;
      else if (e.key === " " || e.key === "Enter") setFlipped((f) => !f);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else {
        const hit = RATINGS.find((r) => r.key === e.key);
        if (hit) rate(hit.rating);
        else handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store, done, rate, step]);

  if (!node || !deck || deck.cards.length === 0) return null;

  const title = deck.name ?? node.title ?? "Flashcards";
  const counts = flashcardCounts(deck);
  const orderToggle = (
    <button
      className={`btn flash-order${byCriticality ? " active" : ""}`}
      aria-pressed={byCriticality}
      title={byCriticality ? "Showing red cards first, then unrated, yellow and green — click for deck order" : "Showing cards in deck order — click for red first, then yellow and green"}
      onClick={() => restart(!byCriticality)}
    >
      {byCriticality ? "Red first" : "In order"}
    </button>
  );

  return (
    <div
      className="quiz-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) store.closeFlashcards();
      }}
    >
      <div className="quiz-window flash-window" role="dialog" aria-modal="true" aria-label={title}>
        <div className="quiz-head">
          <span className="quiz-title">{title}</span>
          <span className="quiz-progress">{done ? "Done" : `Card ${pos + 1} / ${order.length}`}</span>
          {!done && pos > 0 && (
            <button className="quiz-restart" title="Start again from card 1" onClick={() => restart(byCriticality)}>
              ↺ Card 1
            </button>
          )}
          <button className="quiz-close" title="Close" onClick={() => store.closeFlashcards()}>
            ×
          </button>
        </div>

        {!done && card ? (
          <div className="quiz-body">
            <div className="flash-stage">
              <button className="flash-nav" title="Previous card (←)" aria-label="Previous card" disabled={pos === 0} onClick={() => step(-1)}>
                ‹
              </button>
              <button
                className={`flash-card${flipped ? " flipped" : ""}${card.rating ? ` rated-${card.rating}` : ""}`}
                aria-label={flipped ? "Definition — click to show the term" : "Term — click to show the definition"}
                onClick={() => setFlipped((f) => !f)}
              >
                {card.topic && <span className="flash-topic">{card.topic}</span>}
                <span className="flash-face-label">{flipped ? "Definition" : "Term"}</span>
                <span className={flipped ? "flash-definition" : "flash-term"}>{flipped ? card.definition : card.term}</span>
              </button>
              <button className="flash-nav" title="Next card (→)" aria-label="Next card" disabled={pos >= order.length - 1} onClick={() => step(1)}>
                ›
              </button>
            </div>
            <div className="flash-actions">
              <button className="btn flash-flip" onClick={() => setFlipped((f) => !f)}>
                Flip
              </button>
              <span className="flash-ratings" role="group" aria-label="How well do you know it?">
                {RATINGS.map((r) => (
                  <button
                    key={r.rating}
                    className={`btn flash-rate ${r.rating}${card.rating === r.rating ? " current" : ""}`}
                    title={`${r.label} (${r.key})`}
                    onClick={() => rate(r.rating)}
                  >
                    {r.label}
                  </button>
                ))}
              </span>
              {orderToggle}
            </div>
          </div>
        ) : (
          <div className="quiz-body quiz-result">
            <p className="quiz-score">{counts.green} / {deck.cards.length}</p>
            <p className="quiz-score-label">cards you know</p>
            <p className="flash-tally">
              <span className="red">{counts.red} don't know</span>
              <span className="yellow">{counts.yellow} partly</span>
              <span className="green">{counts.green} know it</span>
              {counts.none > 0 && <span>{counts.none} not rated</span>}
            </p>
            <div className="quiz-actions">
              {orderToggle}
              <button className="btn" onClick={() => restart(byCriticality)}>
                Again
              </button>
              <button className="btn primary" onClick={() => store.closeFlashcards()}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
