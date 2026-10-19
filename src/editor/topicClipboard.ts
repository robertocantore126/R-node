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
  // encodeURIComponent leaves ' ( ) ! * unescaped; ' is the one that matters,
  // since some clipboard round trips re-serialise the attribute in single
  // quotes. Encoded, the value holds no quote of either kind.
  const encoded = encodeURIComponent(payload).replace(/'/g, "%27");
  return `<div data-rnode-clipboard="${encoded}"><pre>${escaped}</pre></div>`;
}

export function topicClipboardFromHtml(html: string): string | null {
  // Read up to the quote that OPENED the value. The old `[^"']+` stopped at
  // the first apostrophe of any title ("L'idea"), truncating the payload, and
  // the paste then fell back to plain text.
  const m = /data-rnode-clipboard=(?:"([^"]*)"|'([^']*)')/.exec(html);
  const encoded = m?.[1] ?? m?.[2];
  if (!encoded) return null;
  try { return decodeURIComponent(encoded); } catch { return null; }
}
