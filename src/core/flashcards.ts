/**
 * Flashcard payload — what an LLM returns from the "Copy as flashcards prompt"
 * text, and what `paste` recognises to attach a deck to a topic
 * (`Style.flashcards`). The sibling of `quiz.ts`, with the same gate rule:
 * `normalizeFlashcards` accepts only a well-shaped payload, and one bad card
 * fails the whole paste, so a half-valid deck never reaches the document.
 *
 * `kind` is what tells the two apart on Ctrl+V: both share `app: "r-node"`.
 */
import type { Flashcard, FlashcardDeck, FlashcardRating } from "./types";
import { extractQuizJson, QUIZ_APP } from "./quiz";

/** A parsed deck before the store gives it an `id`. Ratings are the user's,
 *  so the parser never takes them from a payload. */
export interface FlashcardSeed {
  name?: string;
  cards: Flashcard[];
}

export const FLASHCARDS_KIND = "flashcards";

/** Order of a criticality run: what you don't know first. An unrated card is
 *  one you haven't judged yet, so it comes before the ones you partly know. */
const CRITICALITY: Record<FlashcardRating | "none", number> = { red: 0, none: 1, yellow: 2, green: 3 };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCard(value: unknown): Flashcard | null {
  const o = asRecord(value);
  if (!o) return null;
  const term = text(o.term);
  const definition = text(o.definition);
  if (!term || !definition) return null;
  const card: Flashcard = { term, definition };
  const topic = text(o.topic);
  if (topic) card.topic = topic;
  return card;
}

/** Accept a parsed object as a deck, or null if any rule is broken. */
export function normalizeFlashcards(value: unknown): FlashcardSeed | null {
  const o = asRecord(value);
  if (!o) return null;
  if (o.app !== QUIZ_APP || o.kind !== FLASHCARDS_KIND) return null;
  if (!Array.isArray(o.cards) || o.cards.length === 0) return null;
  const cards: Flashcard[] = [];
  for (const item of o.cards) {
    const card = normalizeCard(item);
    if (!card) return null;
    cards.push(card);
  }
  const seed: FlashcardSeed = { cards };
  const name = text(o.name);
  if (name) seed.name = name;
  return seed;
}

/** Parse clipboard text into a deck, tolerating fences and prose around it. */
export function parseFlashcards(raw: string): FlashcardSeed | null {
  let value: unknown;
  try {
    value = JSON.parse(extractQuizJson(raw));
  } catch {
    return null;
  }
  return normalizeFlashcards(value);
}

/** Card indices for one run: deck order, or red → unrated → yellow → green
 *  with deck order kept inside each colour. */
export function flashcardRunOrder(deck: FlashcardDeck, byCriticality: boolean): number[] {
  const order = deck.cards.map((_, i) => i);
  if (!byCriticality) return order;
  const rank = (i: number): number => CRITICALITY[deck.cards[i].rating ?? "none"];
  return order.sort((a, b) => rank(a) - rank(b) || a - b);
}

/** How many cards carry each rating — the bar under the deck's square. */
export function flashcardCounts(deck: FlashcardDeck): Record<FlashcardRating | "none", number> {
  const counts = { red: 0, yellow: 0, green: 0, none: 0 };
  for (const card of deck.cards) counts[card.rating ?? "none"]++;
  return counts;
}
