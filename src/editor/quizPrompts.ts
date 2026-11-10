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

What to ask:
- Test whether the learner understands the material, not whether they
  remember how the outline is worded. About TWO THIRDS of the questions are
  THEORY and ONE THIRD are PRACTICE:
  THEORY - the concepts themselves:
  * what something is, what it is for, how it works inside
  * why it is designed that way, its properties, limits and trade-offs
  * the difference between two concepts that are easy to confuse
  * a consequence: "What happens if ...?" / "What does X do when ...?"
  PRACTICE - applying them:
  * a task: "You need to <do X>. Which command / service / setting do you use?"
  * a short scenario you invent: a team, a requirement, a constraint -> best choice
  * a problem to troubleshoot: a symptom -> the likely cause or fix
- NEVER ask the learner to recall a specific example, sample command, sample
  file, sample template, sample value or sample name from the outline. Wrong:
  "In the CLI example, which command is shown for launching an instance?",
  "In the template example, what resource type is used for the bucket?".
  Right: turn the concept the example illustrates into a new task with your own
  values: "You want to launch a t3.small instance from the command line. Which
  command do you run?".
- Never mention the outline, the notes, "the material" or "the example" in a
  question or answer. The question must make sense on its own.
- The KNOWLEDGE tested must come from the outline - do not test facts it does
  not support. Scenarios, names and values you invent to set up a question are
  fine and encouraged.

The four answers:
- EXACTLY four answers, and exactly one of them is correct beyond dispute.
- All four are the same kind of thing (all commands, all services, all numbers,
  all short statements) with the same grammatical form, and SIMILAR LENGTH and
  level of detail. The correct answer must not stand out as the longest, the
  most precise or the most carefully qualified one.
- Every wrong answer is something a learner who half-knows the topic could
  pick: a related service, a neighbouring command or option, a real value from
  a different context, a common misconception. Never an absurd, joking or
  out-of-category option, never "all/none of the above".
- Do not let the question give the answer away (a word repeated only in the
  correct answer, a grammatical hint, an obviously different style).
- Put the correct answer at a different position from question to question.
- "correct" is the 0-based index (0, 1, 2 or 3) of the right answer inside "answers".
- "explain" is optional: one or two short sentences on why the correct answer is
  right and, when useful, why the most tempting wrong answer is wrong.
- Write the questions in the SAME language as the outline.

Before you reply, check every question against these rules and rewrite any
that breaks one.

Format rules:
- Each outline entry has a [topic "..."] identifier. For EVERY question, include
  "sourceNodeIds": an array of the exact topic identifiers whose text supports
  the question. Include at least one, use only identifiers from this outline,
  and choose the most specific topics. Do not use titles as identifiers.
- Lines tagged [note], [labels], [cell N], [picture N], [arrow ...], [group]
  or [summary] are NOT topics: they are the content of the topic line above
  them (its notes, a chart cell's caption, an arrow and its label, ...). Ask
  about that content too, and cite the topic they belong to.
- Reply with the JSON object ONLY - no prose, no markdown fence. Any sentence
  before or after it is a parse error when this is pasted back into R-node.

Format:
{
  "app": "r-node",
  "kind": "quiz",
  "name": "short title for the quiz",
  "questions": [
    { "q": "Question text?", "answers": ["first", "second", "third", "fourth"], "correct": 0, "explain": "optional", "sourceNodeIds": ["exact topic identifier from the outline"] }
  ]
}

Write between 5 and 15 questions.`;

/** Compose what "Copy as quiz prompt" puts on the clipboard: the branch's
 *  indented outline, then the prompt that asks an LLM to quiz on it. */
export function quizClipText(outline: string): string {
  const body = outline.trim();
  return body === "" ? QUIZ_PROMPT : `${body}\n\n---\n\n${QUIZ_PROMPT}`;
}
