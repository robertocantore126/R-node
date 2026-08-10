import type { DocumentModel } from "./doc";

/** Is `id` a descendant of `ancestorId`? (strictly below) */
export function isDescendantOf(doc: DocumentModel, ancestorId: string, id: string): boolean {
  if (ancestorId === id) return false;
  let cur = doc.node(id)?.parentId ?? null;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = doc.node(cur)?.parentId ?? null;
  }
  return false;
}
