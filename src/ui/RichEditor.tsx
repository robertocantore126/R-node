/**
 * RichEditor — the ONE HTML overlay for topic editing (Lexical).
 *
 * Architecture (hybrid scoped):
 *  - The canvas renders every non-editing node as cached rich text;
 *  - while editing, this single Lexical overlay owns the node (the renderer
 *    skips it, so no ghosting);
 *  - at most one overlay exists at any time — starting a new edit unmounts
 *    the previous one (CanvasView keys it by editingId);
 *  - Lexical's HistoryPlugin is intentionally absent: undo/redo lives ONLY in
 *    the store's op history. The editor is a pure draft generator that pushes
 *    TextRun[] into the store on every change (editingDraftRuns), and the
 *    store applies the final setTitle op on commit.
 *  - Wheel pan/zoom keeps working while editing: CanvasView positions this
 *    overlay from the store camera on every render, so the overlay stays
 *    glued to the node even while the map moves under it.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isTextNode, COMMAND_PRIORITY_HIGH, FORMAT_TEXT_COMMAND, INSERT_TAB_COMMAND, PASTE_COMMAND, type LexicalEditor, type TextFormatType } from "lexical";
import { HeadingNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { useStore } from "../editor/context";
import type { EditorStore } from "../editor/store";
import type { MindNode, TextRun } from "../core/types";
import { nodeRuns, plainToRuns } from "../core/text";
import { BLOCK_GAP_FACTOR, BULLET_WIDTH_EM, FONT_STACK, IMAGE_GAP, LINE_HEIGHT_FACTOR, MAX_IMAGE_W, TEXT_INSET } from "../layout/measure";
import { getAssetStore } from "../persist/assets";
import { editorStateToRuns, runsToParagraphNodes, setEditorRuns } from "./lexicalRuns";
import { htmlToRuns, sanitizeHtml } from "./pasteSanitizer";

const editorTheme = {
  textBold: "rnode-text-bold",
  textItalic: "rnode-text-italic",
  textUnderline: "rnode-text-underline",
  textStrikethrough: "rnode-text-strike",
};

export function RichEditor({
  node,
  style,
  scale,
  colors,
}: {
  node: MindNode;
  style: CSSProperties;
  scale: number;
  /** Fill + text color the canvas paints this node with (see Renderer.nodeColors). */
  colors?: { fill: string; text: string };
}): JSX.Element {
  const store = useStore();
  const config = {
    namespace: "rnode-topic",
    nodes: [ListNode, ListItemNode, HeadingNode],
    theme: editorTheme,
    onError: (err: Error) => console.error("rich editor error", err),
  };
  const ns = node.style;
  // The overlay is laid out in WORLD units and scaled as a whole with a CSS
  // transform: fonts, paddings, the border and the block gaps then match the
  // canvas pixel-for-pixel at every zoom. (Scaling each property separately
  // broke the WYSIWYG: heading font-size was absolute px and the padding was
  // screen px, so the editor text inflated and wrapped elsewhere.)
  const decoration = [ns.underline ? "underline" : null, ns.strikethrough ? "line-through" : null].filter(Boolean).join(" ");
  const inner: CSSProperties = {
    width: Math.max(1, ((style.width as number) ?? 60) / scale),
    height: Math.max(1, ((style.height as number) ?? 28) / scale),
    fontSize: ns.fontSize ?? 14,
    lineHeight: LINE_HEIGHT_FACTOR,
    textAlign: (ns.align === "left" ? "left" : "center") as CSSProperties["textAlign"],
    // Everything the canvas paints the node with, so double-clicking a topic
    // does not change how it looks: same face, same weight, same emphasis,
    // same fill, same resolved text color.
    fontFamily: ns.fontFamily ?? FONT_STACK,
    fontWeight: ns.fontWeight ?? 400,
    fontStyle: ns.italic ? "italic" : "normal",
    textDecoration: decoration.length > 0 ? decoration : undefined,
    background: colors?.fill,
    color: colors?.text,
    transform: `scale(${scale})`,
    transformOrigin: "0 0",
  };
  // Shared block gap: the canvas advances BLOCK_GAP_FACTOR × line-height at
  // every block boundary (paragraph end, list item end) — the overlay applies
  // the identical rule via this CSS variable (see .topic-rich-editable).
  (inner as Record<string, string | number>)["--rnode-block-gap"] = `calc(${BLOCK_GAP_FACTOR} * ${LINE_HEIGHT_FACTOR}em)`;
  // Bullet column width, the same constant wrapRunLines indents list text by.
  (inner as Record<string, string | number>)["--rnode-bullet-w"] = `${BULLET_WIDTH_EM}em`;
  // The editable overlays the node's box EXACTLY like the canvas draws the
  // text: same wrap width (boxW − pad·2 − TEXT_INSET), and the block is
  // centered vertically by .topic-rich-inner (justify-content: center) exactly
  // as the renderer centers the bitmap.
  const pad = node.style.padding ?? 10;
  const editablePad: CSSProperties = {
    paddingTop: pad + 2,
    paddingBottom: pad + 2,
    paddingLeft: pad - 2,
    paddingRight: pad + TEXT_INSET - 2,
  };

  // A node image reserves its rect above the editable (T12-3): without it the
  // box's text would sit where the image is and the box would jump at the
  // double click. Geometry mirrors measureTopic/renderer: imgW from
  // style.imageWidth (capped at MAX_IMAGE_W), imgH by aspect ratio, IMAGE_GAP
  // below — all in world units (the inner is scaled as a whole).
  const card = node.style.image ? store.sheet.attachments.find((a) => a.id === node.style.image) : undefined;
  const hasImage = !!card && card.w > 0;
  const imgW = hasImage ? node.style.imageWidth ?? Math.min(card!.w, MAX_IMAGE_W) : 0;
  const imgH = hasImage ? (imgW * card!.h) / card!.w : 0;
  const boxW = Math.max(1, ((style.width as number) ?? 60) / scale);

  return (
    <div className="topic-rich-editor" style={{ left: style.left, top: style.top }}>
      <LexicalComposer initialConfig={config}>
        {/* Outside the scaled box on purpose: inside it the toolbar shrank
            with the zoom (unreadable at 40%, huge at 300%). */}
        <Toolbar />
        <div className="topic-rich-inner" style={inner}>
          {hasImage && <NodeImageBlock id={node.style.image!} imgW={imgW} imgH={imgH} left={(boxW - imgW) / 2} top={pad} />}
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="topic-rich-editable"
                style={
                  hasImage
                    ? {
                        ...editablePad,
                        // The text lives below the image, in the remaining
                        // region — same placement the canvas gives it.
                        position: "absolute",
                        top: imgH + IMAGE_GAP,
                        left: 0,
                        right: 0,
                        bottom: 0,
                      }
                    : editablePad
                }
                ariaLabel="Edit topic"
                spellCheck={false}
                onBlur={() => store.commitEdit()}
              />
            }
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <ListPlugin />
        <DraftSyncPlugin store={store} node={node} />
        <PasteSanitizerPlugin />
        <KeysPlugin store={store} />
      </LexicalComposer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reserved image block (T12-3): non-editable, sized to the node's image rect,
// sitting above the editable exactly where the canvas draws the image.
// ---------------------------------------------------------------------------

const overlayAssetStore = getAssetStore();

function NodeImageBlock({ id, imgW, imgH, left, top }: { id: string; imgW: number; imgH: number; left: number; top: number }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    void (async () => {
      const blob = await overlayAssetStore.get(id, "large");
      if (cancelled || !blob) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [id]);
  return (
    <div
      contentEditable={false}
      style={{
        position: "absolute",
        top,
        left,
        width: imgW,
        height: imgH,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: 4,
      }}
    >
      {url && <img src={url} alt="" draggable={false} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keys: capture-phase listener on the editor root so we run BEFORE Lexical's
// bubble-phase handlers (Enter must commit, not insert a newline).
// ---------------------------------------------------------------------------

function KeysPlugin({ store }: { store: EditorStore }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Inline formatting: Ctrl/Cmd+B / I / U toggle bold / italic /
      // underline on the current selection (or the pending format for the
      // next keystroke). Handled here, in capture phase, so the browser's
      // own contenteditable defaults never get a chance.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        const fmt: TextFormatType | null = k === "b" ? "bold" : k === "i" ? "italic" : k === "u" ? "underline" : null;
        if (fmt) {
          e.preventDefault();
          e.stopPropagation();
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        // Save while editing: commit the draft (editor stays open) so the
        // browser "Save page" dialog never eats the keystroke.
        e.preventDefault();
        e.stopPropagation();
        void store.saveNow();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        store.commitEdit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        store.cancelEdit();
        return;
      }
      if (e.key === "Tab") {
        // Keep focus inside the overlay; insert a literal tab char in the
        // title (matches the previous textarea behavior).
        e.preventDefault();
        e.stopPropagation();
        editor.dispatchCommand(INSERT_TAB_COMMAND, undefined);
        return;
      }
    };
    return editor.registerRootListener((root, prev) => {
      if (prev) prev.removeEventListener("keydown", handler, true);
      if (root) root.addEventListener("keydown", handler, true);
    });
  }, [editor, store]);
  return null;
}

// ---------------------------------------------------------------------------
// Draft sync: seed content once, then mirror every change to the store.
// ---------------------------------------------------------------------------

function DraftSyncPlugin({ store, node }: { store: EditorStore; node: MindNode }): null {
  const [editor] = useLexicalComposerContext();
  const seeded = useRef(false);

  // Debug handle for driving the editor from the console / preview.
  useEffect(() => {
    (window as unknown as { __rnodeEditor?: LexicalEditor }).__rnodeEditor = editor;
    return () => {
      const w = window as unknown as { __rnodeEditor?: LexicalEditor };
      if (w.__rnodeEditor === editor) delete w.__rnodeEditor;
    };
  }, [editor]);

  // Update listener — lives in its OWN effect so it survives React
  // StrictMode's mount → cleanup → mount cycle (and any re-render): the
  // `seeded` guard in the seeding effect below would otherwise skip the
  // re-registration and the draft would never follow keystrokes.
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      store.setEditingDraftRuns(editorStateToRuns(editorState));
    });
  }, [editor, store]);

  // Seeding — guarded so it only ever runs once per overlay instance.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    // Type/paste-to-edit hands us initial content that replaces the title.
    const pending = store.consumePendingInsert();
    const initial = pending !== null ? plainToRuns(pending) : nodeRuns(node.title, node.titleRuns);
    setEditorRuns(editor, initial);
    store.setEditingDraftRuns(initial);
    const focusTimer = setTimeout(() => editor.focus(), 0);
    return () => clearTimeout(focusTimer);
  }, [editor, store, node]);

  return null;
}

// ---------------------------------------------------------------------------
// Paste sanitization: Word / Google Docs / Draw.io / web.
// ---------------------------------------------------------------------------

function PasteSanitizerPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        // PasteCommandType payload differs across Lexical versions; read the
        // clipboard defensively.
        const payload = (event ?? {}) as unknown as { clipboardData?: DataTransfer | null };
        if (!payload.clipboardData) return false;
        const html = payload.clipboardData.getData("text/html");
        if (!html) return false; // plain-text paste → Lexical default
        event.preventDefault();
        const cleaned = sanitizeHtml(html);
        editor.update(() => {
          // ALWAYS route through our run pipeline (not Lexical's DOM import):
          // $insertNodes converts HeadingNode to paragraph at a collapsed
          // selection, while plain paragraphs/lists survive — and our runs
          // carry heading size as inline font-size, paragraph gaps and list
          // indent, so the canvas renders the exact pasted structure.
          const paragraphs = runsToParagraphNodes(htmlToRuns(cleaned));
          const sel = $getSelection();
          if (sel) sel.insertNodes(paragraphs);
          else $getRoot().append(...paragraphs);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor]);

  return null;
}

// ---------------------------------------------------------------------------
// Mini formatting toolbar (B / I / color) — stays inside the overlay.
// ---------------------------------------------------------------------------

function Toolbar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  return (
    <div className="topic-rich-toolbar" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Bold (Ctrl+B)"
        onMouseDown={(e) => {
          e.preventDefault();
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
        }}
      >
        <b>B</b>
      </button>
      <button
        type="button"
        title="Italic (Ctrl+I)"
        onMouseDown={(e) => {
          e.preventDefault();
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
        }}
      >
        <i>I</i>
      </button>
      <button
        type="button"
        title="Underline (Ctrl+U)"
        onMouseDown={(e) => {
          e.preventDefault();
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline");
        }}
      >
        <u>U</u>
      </button>
      <input
        type="color"
        title="Text color"
        defaultValue="#d43a3a"
        onMouseDown={(e) => e.preventDefault()}
        onChange={(e) => applyColor(editor, e.target.value)}
      />
      <button
        type="button"
        title="Clear color"
        onMouseDown={(e) => {
          e.preventDefault();
          clearColor(editor);
        }}
      >
        <span style={{ textDecoration: "line-through" }}>A</span>
      </button>
    </div>
  );
}

function applyColor(editor: LexicalEditor, color: string): void {
  editor.update(() => {
    const sel = $getSelection();
    if (!sel) return;
    for (const n of sel.getNodes()) {
      if ($isTextNode(n)) n.setStyle(`color: ${color}`);
    }
  });
}

function clearColor(editor: LexicalEditor): void {
  editor.update(() => {
    const sel = $getSelection();
    if (!sel) return;
    for (const n of sel.getNodes()) {
      if ($isTextNode(n)) n.setStyle("");
    }
  });
}

// Re-export the run type so callers stay type-safe.
export type { TextRun };
