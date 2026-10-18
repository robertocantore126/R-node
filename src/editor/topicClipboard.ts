import type { AttachmentInfo, MindNode, Relationship } from "../core/types";

export interface TopicClipboard {
  rootId: string;
  rootIds?: string[];
  nodes: MindNode[];
  relationships: Relationship[];
  attachments?: AttachmentInfo[];
  canvas?: { id: string; x: number; y: number };
}

/** HTML is a standard clipboard format; arbitrary text/rnode is often rejected. */
export function topicClipboardHtml(payload: string, plain: string): string {
  const escaped = plain.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<div data-rnode-clipboard="${encodeURIComponent(payload)}"><pre>${escaped}</pre></div>`;
}

export function topicClipboardFromHtml(html: string): string | null {
  const encoded = /data-rnode-clipboard=["']([^"']+)["']/.exec(html)?.[1];
  if (!encoded) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}
