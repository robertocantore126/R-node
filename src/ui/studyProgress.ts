/**
 * Where an unfinished quiz or flashcard run stopped, so closing the window and
 * opening it again resumes on the same card. A per-viewer convenience, not
 * document data: it lives in localStorage (no undo step, no "unsaved"), keyed
 * by topic + quiz/deck id, and every read is validated by the caller against
 * the current questions/cards — a stale or foreign entry is simply ignored.
 */

const PREFIX = "rnode.study.";

function key(nodeId: string, id: string): string {
  return `${PREFIX}${nodeId}:${id}`;
}

export function loadStudyProgress<T>(nodeId: string, id: string): T | null {
  try {
    const raw = localStorage.getItem(key(nodeId, id));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveStudyProgress(nodeId: string, id: string, value: unknown): void {
  try {
    localStorage.setItem(key(nodeId, id), JSON.stringify(value));
  } catch {
    /* storage blocked or full: the run just starts from card 1 next time */
  }
}

export function clearStudyProgress(nodeId: string, id: string): void {
  try {
    localStorage.removeItem(key(nodeId, id));
  } catch {
    /* see saveStudyProgress */
  }
}

const isIndex = (n: unknown, length: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < length;

/** A flashcard run: the fixed order, the position in it, and the order mode. */
export interface FlashcardProgress {
  order: number[];
  pos: number;
  byCriticality: boolean;
}

/** The saved run if it still fits a deck of `cardCount` cards, else null. */
export function validFlashcardProgress(value: unknown, cardCount: number): FlashcardProgress | null {
  const p = value as Partial<FlashcardProgress> | null;
  if (!p || !Array.isArray(p.order) || p.order.length !== cardCount) return null;
  if (new Set(p.order).size !== cardCount || !p.order.every((i) => isIndex(i, cardCount))) return null;
  if (!isIndex(p.pos, cardCount)) return null;
  return { order: p.order, pos: p.pos, byCriticality: !!p.byCriticality };
}

/** A quiz run: the question on screen and the answers given so far. */
export interface QuizProgress {
  index: number;
  results: number[];
}

/** The saved run if it still fits a quiz of `questionCount` questions. */
export function validQuizProgress(value: unknown, questionCount: number): QuizProgress | null {
  const p = value as Partial<QuizProgress> | null;
  if (!p || !Array.isArray(p.results) || !isIndex(p.index, questionCount)) return null;
  if (p.results.length < p.index || p.results.length > p.index + 1 || p.results.length > questionCount) return null;
  if (!p.results.every((a) => isIndex(a, 4))) return null;
  return { index: p.index, results: p.results };
}
