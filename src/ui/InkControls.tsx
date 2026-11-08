import { useStore } from "../editor/context";
import { INK_MAX_WIDTH, INK_MIN_WIDTH, inkStrokes } from "../core/ink";

/** The pen's settings, shown in the Inspector while a freeform canvas is selected. */
export function InkControls({ canvasId }: { canvasId: string }): JSX.Element {
  const store = useStore();
  const { mode, ink } = store.getSnapshot();
  const node = store.doc.node(canvasId);
  const writing = mode === "ink";
  const hasInk = !!node && inkStrokes(node.style).length > 0;
  return (
    <>
      <div className="field">
        <span>Pen</span>
        <button className={`btn small${writing ? " on" : ""}`} aria-pressed={writing} onClick={() => store.toggleInkMode()}>
          {writing ? "Stop writing" : "Write with pen"}
        </button>
      </div>
      {writing && (
        <>
          <div className="field">
            <span>Tool</span>
            <button className={`btn small${ink.tool === "pen" ? " on" : ""}`} aria-pressed={ink.tool === "pen"} onClick={() => store.setInkSettings({ tool: "pen" })}>Pen</button>
            <button className={`btn small${ink.tool === "eraser" ? " on" : ""}`} aria-pressed={ink.tool === "eraser"} onClick={() => store.setInkSettings({ tool: "eraser" })}>Eraser</button>
          </div>
          <div className="field">
            <span>Thickness</span>
            <input type="range" min={INK_MIN_WIDTH} max={INK_MAX_WIDTH} step={1} value={ink.width} aria-label="Pen thickness in pixels" onChange={(e) => store.setInkSettings({ width: Number(e.target.value), tool: "pen" })} />
            <span>{ink.width} px</span>
          </div>
          <div className="field">
            <span>Colour</span>
            <input type="color" value={ink.color ?? "#111827"} onChange={(e) => store.setInkSettings({ color: e.target.value, tool: "pen" })} />
            <button className="btn small" disabled={ink.color === null} title="Use the theme's text colour" onClick={() => store.setInkSettings({ color: null })}>Auto</button>
          </div>
        </>
      )}
      {hasInk && (
        <div className="field">
          <span>Handwriting</span>
          <button className="btn small" onClick={() => store.clearInk(canvasId)}>Clear</button>
        </div>
      )}
    </>
  );
}
