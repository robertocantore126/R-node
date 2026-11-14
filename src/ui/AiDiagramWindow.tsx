/**
 * "Diagram from AI": the draw.io-style generator, without an API key.
 *
 *  1. Describe the diagram or paste the material (as much as you like) and
 *     copy the prompt.
 *  2. Paste it into any AI chat (ChatGPT, Claude, DeepSeek...).
 *  3. Paste the answer back here and Import (or Ctrl+V on the canvas).
 *
 * The prompt (core/diagramPrompt.ts) states only the output format the
 * importer (core/drawio.ts) reads. DOM chrome over the map, like the quiz.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { useStore } from "../editor/context";
import { diagramPrompt } from "../core/diagramPrompt";

/** What the user typed survives closing the window (not the document). */
let lastMaterial = "";

export function AiDiagramWindow({ nodeId }: { nodeId: string }): JSX.Element {
  const store = useStore();
  const [material, setMaterial] = useState(lastMaterial);
  const [answer, setAnswer] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const winRef = useRef<HTMLDivElement>(null);
  const node = store.doc.node(nodeId);
  const intoCanvas = !!node?.style.freeform;

  useEffect(() => { lastMaterial = material; }, [material]);
  useEffect(() => {
    winRef.current?.querySelector("textarea")?.focus();
    // In capture, ahead of App's window shortcuts: Escape closes this window,
    // and keys typed here never reach the map.
    const onKey = (e: KeyboardEvent): void => {
      if (!winRef.current?.contains(document.activeElement) && e.key !== "Escape") return;
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); store.closeAiDiagram(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store]);

  const copy = async (): Promise<void> => {
    const ok = await store.copyDiagramPrompt(material);
    setCopied(ok);
    if (!ok) setShowPrompt(true);
  };
  const importAnswer = async (): Promise<void> => {
    if (await store.importDiagramText(answer, nodeId)) store.closeAiDiagram();
  };

  return (
    <div className="ai-diagram-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) store.closeAiDiagram(); }}>
      <div ref={winRef} className="ai-diagram-window" role="dialog" aria-modal="true" aria-label="Diagram from AI">
        <div className="ai-diagram-head">
          <span>Diagram from AI</span>
          <button className="btn small" aria-label="Close" onClick={() => store.closeAiDiagram()}>✕</button>
        </div>
        <div className="ai-diagram-body">
          <label className="ai-diagram-step">
            <span><b>1.</b> What should the diagram show? Describe it, or paste your notes / material.</span>
            <textarea
              rows={7}
              value={material}
              placeholder={"e.g. an AWS architecture for a web shop: CloudFront, ALB, two EC2 in private subnets, RDS with a replica, S3 for images\n\n…or paste a whole chapter of notes."}
              onChange={(e) => { setMaterial(e.target.value); setCopied(false); }}
            />
          </label>
          <div className="ai-diagram-row">
            <button className="btn primary" onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy prompt"}</button>
            <button className="btn small" aria-expanded={showPrompt} onClick={() => setShowPrompt((v) => !v)}>{showPrompt ? "Hide prompt" : "Show prompt"}</button>
            <span className="muted">{material.length ? `${material.length.toLocaleString()} characters` : ""}</span>
          </div>
          {showPrompt && <textarea className="ai-diagram-prompt" readOnly rows={8} value={diagramPrompt(material)} onFocus={(e) => e.currentTarget.select()} />}
          <p className="muted ai-diagram-note"><b>2.</b> Paste the prompt into any AI chat (ChatGPT, Claude, DeepSeek, Gemini…).</p>
          <label className="ai-diagram-step">
            <span><b>3.</b> Paste the AI's whole answer here, then Import. {intoCanvas ? "It goes into this canvas, below what it already holds." : "It goes into a new canvas under this topic."} You can also just press Ctrl+V on the canvas.</span>
            <textarea rows={5} value={answer} placeholder="<mxGraphModel> … </mxGraphModel>" onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <div className="ai-diagram-row">
            <button className="btn primary" disabled={!answer.trim()} onClick={() => void importAnswer()}>Import diagram</button>
          </div>
        </div>
      </div>
    </div>
  );
}
