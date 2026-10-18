/**
 * The tree payload an LLM sends back after "Copy as AI expand prompt", and the
 * parser "Paste as AI expand" runs on it. Kept apart from `quiz.ts` on purpose:
 * the two pastes are separate menu items, so a quiz can never be read as a
 * tree or the other way round.
 *
 * Format (the prompt in `src/editor/aiTreePrompts.ts` asks for exactly this):
 *   { "app": "r-node", "kind": "tree",
 *     "root": { "text": "Topic", "children": [ { "text": "Sub", "children": [] } ] } }
 *
 * The parser is lenient where LLMs drift: a ```json fence or prose around the
 * object, `title`/`name` instead of `text`, a child given as a bare string, a
 * bare `{ "text", "children" }` object without the envelope.
 */
import { extractQuizJson } from "./quiz";

export interface AiTreeNode {
  text: string;
  children: AiTreeNode[];
}

/** Hard ceiling so a runaway answer cannot flood the map in one paste. */
export const AI_TREE_MAX_NODES = 2000;

function normalizeNode(raw: unknown, budget: { left: number }, depth: number): AiTreeNode | null {
  if (budget.left <= 0 || depth > 64) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return null;
    budget.left--;
    return { text, children: [] };
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = [o.text, o.title, o.name, o.topic].find((v) => typeof v === "string") as string | undefined;
  const text = (label ?? "").trim();
  if (text === "") return null;
  budget.left--;
  const kids = Array.isArray(o.children) ? o.children : [];
  const children: AiTreeNode[] = [];
  for (const k of kids) {
    const c = normalizeNode(k, budget, depth + 1);
    if (c) children.push(c);
  }
  return { text, children };
}

/** Parse clipboard text into a tree, or null when it holds no tree payload. */
export function parseAiTree(text: string): AiTreeNode | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractQuizJson(text));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rootRaw = o.root ?? (Array.isArray(o.children) ? o : null);
  if (!rootRaw) return null;
  return normalizeNode(rootRaw, { left: AI_TREE_MAX_NODES }, 0);
}

/** Case- and space-insensitive key used to match AI topics to existing ones. */
export function topicKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
