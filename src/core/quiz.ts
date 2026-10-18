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
import type { QuizInfo, QuizQuestion, Sheet } from "./types";
import { nodeRuns, runsToPlain } from "./text";

/**
 * A parsed quiz BEFORE it is attached to a topic: the LLM supplies a name and
 * questions, and the store adds the `id` (and later the `score`). Keeping the
 * seed separate from `QuizInfo` means the parser never invents the fields the
 * document owns.
 */
export interface QuizSeed {
  name?: string;
  questions: QuizQuestion[];
}

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
  if (o.sourceNodeIds !== undefined) {
    if (!Array.isArray(o.sourceNodeIds) || !o.sourceNodeIds.length || o.sourceNodeIds.length > 32 ||
        o.sourceNodeIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256)) return null;
    question.sourceNodeIds = [...new Set(o.sourceNodeIds as string[])];
  }
  return question;
}

/** Direct traversal also works for a selected floating topic or a freeform. */
export function quizBranchIds(sheet: Sheet, rootId: string): Set<string> {
  const seen = new Set<string>(), stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!, node = sheet.nodes[id];
    if (!node || seen.has(id)) continue;
    seen.add(id); stack.push(...node.childrenIds.slice().reverse());
  }
  return seen;
}

export function quizTopicOutline(sheet: Sheet, rootId: string): string {
  const lines: string[] = [], seen = new Set<string>();
  const stack = [{ id: rootId, depth: 0 }];
  while (stack.length) {
    const { id, depth } = stack.pop()!, node = sheet.nodes[id];
    if (!node || seen.has(id)) continue;
    seen.add(id);
    // JSON strings keep newlines and bracket-like text from impersonating another source.
    lines.push(`${"  ".repeat(depth)}[topic ${JSON.stringify(id)}] ${JSON.stringify(runsToPlain(nodeRuns(node.title,node.titleRuns)))}`);
    stack.push(...node.childrenIds.slice().reverse().map(id => ({ id, depth: depth + 1 })));
  }
  return lines.join("\n");
}

export function quizHasMistakes(quiz: QuizInfo): boolean {
  return Array.isArray(quiz.lastAnswers) && quiz.lastAnswers.length === quiz.questions.length
    ? quiz.lastAnswers.some((answer,i) => answer !== quiz.questions[i].correct)
    : !!quiz.score && quiz.score.last < quiz.questions.length;
}

/** Explicit question links only; unlinked/obsolete questions fall back to their quiz owner. */
export function quizMistakeNodeIds(sheet: Sheet): Set<string> {
  const result = new Set<string>();
  for (const owner of Object.values(sheet.nodes)) {
    if (!owner.style.showQuizMistakes) continue;
    const allowed = quizBranchIds(sheet,owner.id);
    for (const quiz of owner.style.quizzes ?? []) {
      if (!quizHasMistakes(quiz)) continue;
      if (!Array.isArray(quiz.lastAnswers) || quiz.lastAnswers.length !== quiz.questions.length) { result.add(owner.id); continue; }
      quiz.questions.forEach((question,i) => {
        if (quiz.lastAnswers![i] === question.correct) return;
        const targets = Array.isArray(question.sourceNodeIds) ? question.sourceNodeIds.filter(id => allowed.has(id)) : [];
        for (const id of targets.length ? targets : [owner.id]) result.add(id);
      });
    }
  }
  return result;
}

/** Accept a parsed object as a quiz, or null if any rule is broken. */
export function normalizeQuiz(value: unknown): QuizSeed | null {
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
  const seed: QuizSeed = { questions };
  if (name) seed.name = name;
  return seed;
}

/**
 * The JSON object inside `text`, fences and prose aside. An LLM asked for "JSON
 * only" still wraps its answer in a ```json fence often enough that refusing
 * those would make the feature feel broken; and anything before/after the first
 * `{` … last `}` is dropped rather than typed into the document. `normalizeQuiz`
 * is still the gate — this only finds the candidate object.
 */
export function extractQuizJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Parse clipboard text into a quiz seed, tolerating fences and prose around it. */
export function parseQuiz(text: string): QuizSeed | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractQuizJson(text));
  } catch {
    return null;
  }
  return normalizeQuiz(raw);
}
