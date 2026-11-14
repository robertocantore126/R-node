/**
 * "Diagram from AI": the draw.io-style generator, without an API key.
 *
 *  1. Describe the diagram or paste the material (as much as you like), pick a
 *     kind, and copy the prompt.
 *  2. Paste it into any AI chat (ChatGPT, Claude, DeepSeek...).
 *  3. Paste the answer back here and Import (or Ctrl+V on the canvas).
 *
 * The prompt (core/diagramPrompt.ts) restricts the AI to the draw.io dialect
 * the importer (core/drawio.ts) reads. DOM chrome over the map, like the quiz.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { useStore } from "../editor/context";
import { DIAGRAM_KINDS, diagramPrompt, type DiagramKind } from "../core/diagramPrompt";

const KIND_LABELS: Record<DiagramKind, string> = {
  auto: "Let the AI choose",
  flowchart: "Flowchart",
  architecture: "Architecture (cloud / system)",
  process: "Process with swimlanes",
  concept: "Concept map",
  hierarchy: "Hierarchy / tree",
  sequence: "Timeline / sequence",
  comparison: "Comparison",
};

/** What the user typed survives closing the window (not the document). */
let lastMaterial = "";
let lastKind: DiagramKind = "auto";

export function AiDiagramWindow({ nodeId }: { nodeId: string }): JSX.Element {
  const store = useStore();
  const [material, setMaterial] = useState(lastMaterial);
  const [kind, setKind] = useState<DiagramKind>(lastKind);
  const [answer, setAnswer] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const winRef = useRef<HTMLDivElement>(null);
  const node = store.doc.node(nodeId);
  const intoCanvas = !!node?.style.freeform;

  useEffect(() => { lastMaterial = material; }, [material]);
  useEffect(() => { lastKind = kind; }, [kind]);
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
    const ok = await store.copyDiagramPrompt(material, kind);
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
          <div className="field">
            <span>Kind</span>
            <select value={kind} title={DIAGRAM_KINDS[kind]} onChange={(e) => { setKind(e.target.value as DiagramKind); setCopied(false); }}>
              {(Object.keys(KIND_LABELS) as DiagramKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </div>
          <div className="ai-diagram-row">
            <button className="btn primary" onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy prompt"}</button>
            <button className="btn small" aria-expanded={showPrompt} onClick={() => setShowPrompt((v) => !v)}>{showPrompt ? "Hide prompt" : "Show prompt"}</button>
            <span className="muted">{material.length ? `${material.length.toLocaleString()} characters` : ""}</span>
          </div>
          {showPrompt && <textarea className="ai-diagram-prompt" readOnly rows={8} value={diagramPrompt(material, kind)} onFocus={(e) => e.currentTarget.select()} />}
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
