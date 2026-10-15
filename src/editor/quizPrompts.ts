/**
 * The prompt handed to an LLM beside a copied branch, and the function that
 * assembles the clipboard text the "Copy as quiz prompt" menu item writes.
 *
 * It lives in code, not in a document, for the same reason as `shapePrompts`:
 * the menu item and the format the paste side accepts are one definition, so
 * they cannot drift apart. The format block below is exactly what
 * `normalizeQuiz` (src/core/quiz.ts) accepts — four answers, a 0-based
 * `correct` index, and nothing else around the JSON.
 */

export const QUIZ_PROMPT = `Create a multiple-choice quiz about the topics in the outline above.

Rules:
- Write the questions in the SAME language as the outline.
- Every question has EXACTLY four answers, and exactly one of them is correct.
- "correct" is the 0-based index (0, 1, 2 or 3) of the right answer inside "answers".
- "explain" is optional: one short sentence on why the correct answer is right.
- Only ask about material that is IN the outline; do not invent facts.
- Reply with the JSON object ONLY - no prose, no markdown fence. Any sentence
  before or after it is a parse error when this is pasted back into R-node.

Format:
{
  "app": "r-node",
  "kind": "quiz",
  "name": "short title for the quiz",
  "questions": [
    { "q": "Question text?", "answers": ["first", "second", "third", "fourth"], "correct": 0, "explain": "optional" }
  ]
}

Write between 5 and 15 questions.`;

/** Compose what "Copy as quiz prompt" puts on the clipboard: the branch's
 *  indented outline, then the prompt that asks an LLM to quiz on it. */
export function quizClipText(outline: string): string {
  const body = outline.trim();
  return body === "" ? QUIZ_PROMPT : `${body}\n\n---\n\n${QUIZ_PROMPT}`;
}
