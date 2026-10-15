/**
 * Quiz payload — the format an LLM returns from the "copy as quiz prompt" text,
 * and what `paste` recognises to attach a quiz to a topic (`Style.quiz`).
 *
 * `normalizeQuiz` is the gate: it accepts ONLY a well-shaped payload and
 * rejects everything else by returning null, so a half-valid answer can never
 * reach the document. One bad question fails the whole payload on purpose — a
 * quiz the user can start and then get stuck on midway is worse than a paste
 * that says "not a quiz" up front.
 *
 * The four-answer / index rules are checked here rather than tolerated: the
 * runtime has already fixed the shape by the time this returns non-null.
 */
import type { QuizInfo, QuizQuestion } from "./types";

export const QUIZ_APP = "r-node";
export const QUIZ_KIND = "quiz";

/** The exact answer count every question must have. */
export const QUIZ_ANSWER_COUNT = 4;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeQuestion(value: unknown): QuizQuestion | null {
  const o = asRecord(value);
  if (!o) return null;
  const q = typeof o.q === "string" ? o.q.trim() : "";
  if (!q) return null;
  if (!Array.isArray(o.answers) || o.answers.length !== QUIZ_ANSWER_COUNT) return null;
  const answers = o.answers.map((a) => (typeof a === "string" ? a : ""));
  if (answers.some((a) => a.trim() === "")) return null;
  const correct = o.correct;
  if (typeof correct !== "number" || !Number.isInteger(correct) || correct < 0 || correct >= QUIZ_ANSWER_COUNT) return null;
  const explain = typeof o.explain === "string" && o.explain.trim() !== "" ? o.explain.trim() : undefined;
  const question: QuizQuestion = { q, answers, correct };
  if (explain) question.explain = explain;
  return question;
}

/** Accept a parsed object as a quiz, or null if any rule is broken. */
export function normalizeQuiz(value: unknown): QuizInfo | null {
  const o = asRecord(value);
  if (!o) return null;
  if (o.app !== QUIZ_APP || o.kind !== QUIZ_KIND) return null;
  if (!Array.isArray(o.questions) || o.questions.length === 0) return null;
  const questions: QuizQuestion[] = [];
  for (const item of o.questions) {
    const q = normalizeQuestion(item);
    if (!q) return null;
    questions.push(q);
  }
  const name = typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : undefined;
  const quiz: QuizInfo = { questions };
  if (name) quiz.name = name;
  return quiz;
}

/** Parse clipboard text into a quiz, tolerating surrounding whitespace. */
export function parseQuiz(text: string): QuizInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeQuiz(raw);
}
