/**
 * The prompt the "Copy as flashcards prompt" menu item puts beside a copied
 * branch. Same reasoning as `quizPrompts`: the format block below is exactly
 * what `normalizeFlashcards` (src/core/flashcards.ts) accepts, so the menu
 * item and the paste side are one definition and cannot drift apart.
 */

export const FLASHCARDS_PROMPT = `Create a set of study flashcards about the topics in the outline above.

Rules:
- Write the cards in the SAME language as the outline.
- Every card has three fields:
  - "topic": the subject the card belongs to (a short label, e.g. the outline
    topic it comes from).
  - "term": the front of the card - a term, a command, a name or a short
    question.
  - "definition": the back of the card - its definition or answer, in one to
    three sentences.
- One idea per card. Do not put the answer in the term.
- Only use material that is IN the outline; do not invent facts.
- Reply with the JSON object ONLY - no prose, no markdown fence. Any sentence
  before or after it is a parse error when this is pasted back into R-node.

Format:
{
  "app": "r-node",
  "kind": "flashcards",
  "name": "short title for the deck",
  "cards": [
    { "topic": "subject", "term": "front of the card", "definition": "back of the card" }
  ]
}

Write between 10 and 30 cards, covering every part of the outline.`;

/** Compose what "Copy as flashcards prompt" puts on the clipboard: the
 *  branch's indented outline, then the prompt. */
export function flashcardsClipText(outline: string): string {
  const body = outline.trim();
  return body === "" ? FLASHCARDS_PROMPT : `${body}\n\n---\n\n${FLASHCARDS_PROMPT}`;
}
