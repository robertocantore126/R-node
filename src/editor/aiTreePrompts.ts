/**
 * The prompt handed to an LLM beside a copied branch by "Copy as AI expand
 * prompt". Same reasoning as `quizPrompts`: the menu item and the format the
 * paste side accepts (`parseAiTree`, src/core/aiTree.ts) are one definition.
 */

export const AI_EXPAND_PROMPT = `Expand the mind-map branch in the outline above.

Rules:
- The first line of the outline is the root topic; indentation shows children.
- Write in the SAME language as the outline.
- Keep every existing topic, with its text EXACTLY as written, in its place.
- Add new subtopics where they help: deeper detail, missing aspects, examples.
- Topics are short labels (a few words), not sentences or paragraphs.
- Reply with the JSON object ONLY - no prose, no markdown fence. Any sentence
  before or after it is a parse error when this is pasted back into R-node.

Format:
{
  "app": "r-node",
  "kind": "tree",
  "root": {
    "text": "root topic, exactly as in the outline",
    "children": [
      { "text": "subtopic", "children": [ { "text": "detail", "children": [] } ] }
    ]
  }
}`;

/** Compose what "Copy as AI expand prompt" puts on the clipboard: the branch's
 *  indented outline, then the prompt that asks an LLM to expand it. */
export function aiExpandClipText(outline: string): string {
  const body = outline.trim();
  return body === "" ? AI_EXPAND_PROMPT : `${body}\n\n---\n\n${AI_EXPAND_PROMPT}`;
}
