/**
 * The saved shape library, under the Inspector (T23).
 *
 * Two kinds live here. A STRUCTURE is N native topics with base shapes that
 * resize to their text; a SHAPE is one topic with a custom silhouette and a
 * fixed size (T24). Each kind carries a copy button for the prompt that
 * generates one, because the panel is both where shapes live and where you go
 * to make another.
 *
 * A row is dragged onto the map. The drop must land ON a topic — the shape
 * becomes its child — which is why the canvas refuses a drop on empty space
 * and says so in the trace.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { listShapes, removeShape, saveShape, ShapeRejected, type ShapeTemplate } from "../editor/shapeLibrary";
import { SHAPE_NODE_PROMPT, STRUCTURE_NODE_PROMPT } from "../editor/shapePrompts";

/** The MIME the canvas listens for. Custom, so an image drag never matches. */
export const SHAPE_DRAG_TYPE = "application/x-rnode-shape";

function CopyPromptButton({ prompt, title }: { prompt: string; title: string }): JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn icon small"
      title={title}
      onClick={() => {
        void navigator.clipboard.writeText(prompt).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => setDone(false),
        );
      }}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

export function ShapeLibrary(): JSX.Element {
  const [shapes, setShapes] = useState<ShapeTemplate[]>(() => listShapes());
  const [adding, setAdding] = useState(false);
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => setShapes(listShapes()), []);

  // Another tab writing the library must not leave this one stale.
  useEffect(() => {
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [refresh]);

  const submit = (): void => {
    try {
      saveShape(name, json);
      setAdding(false);
      setJson("");
      setName("");
      setError(null);
      refresh();
    } catch (e) {
      // Every refusal names what is wrong, and often the topic responsible.
      setError(e instanceof ShapeRejected ? e.message : String(e));
    }
  };

  return (
    <section className="shapes" aria-label="Shape library">
      <div className="shapes-head">
        <span className="shapes-title">Shapes</span>
        <span className="shapes-kinds">
          <span className="shapes-kind" title="Structure: several topics and the links between them">⬡</span>
          <CopyPromptButton prompt={STRUCTURE_NODE_PROMPT} title="Copy the prompt for a STRUCTURE (many topics)" />
          <span className="shapes-kind" title="Shape: one topic with a custom silhouette">◗</span>
          <CopyPromptButton prompt={SHAPE_NODE_PROMPT} title="Copy the prompt for a SHAPE (one topic)" />
        </span>
        <button className="btn small" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      {adding && (
        <div className="shapes-add">
          <textarea
            className="shapes-json"
            placeholder="Paste the JSON here"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
          />
          <div className="shapes-add-row">
            <input
              className="shapes-name"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button className="btn small primary" onClick={submit}>
              Save
            </button>
          </div>
          {error && <p className="shapes-error">{error}</p>}
        </div>
      )}

      <ul className="shapes-list">
        {shapes.length === 0 && !adding && (
          <li className="shapes-empty">Nothing saved yet. Copy a prompt, ask an LLM, paste the answer with “+ Add”.</li>
        )}
        {shapes.map((t) => (
          <li
            key={t.id}
            className="shapes-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SHAPE_DRAG_TYPE, t.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            title="Drag onto a topic to insert it as its child"
          >
            <span className="shapes-item-name">{t.name}</span>
            <span className="shapes-item-meta">{t.payload.nodes.length}</span>
            <button
              className="btn icon small"
              title={`Delete “${t.name}”`}
              onClick={() => {
                removeShape(t.id);
                refresh();
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
