import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import { runExportPng } from "../editor/exportBridge";
import { viewSize } from "../editor/view";

export function TopBar(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [title, setTitle] = useState(state.docTitle);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTitle(state.docTitle);
  }, [state.docTitle]);

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  return (
    <header className="topbar">
      <input
        className="doc-title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => store.renameDocument(state.activeDocId, title || "Untitled map")}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />

      <div className="topbar-group">
        <button className="btn icon" title="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={() => store.undo()}>
          ↶
        </button>
        <button className="btn icon" title="Redo (Ctrl+Shift+Z)" disabled={!state.canRedo} onClick={() => store.redo()}>
          ↷
        </button>
        <button className="btn primary" title="Save (Ctrl+S)" onClick={() => void store.saveNow()}>
          Save
        </button>
        <button className="btn" title="Open a .rmind.json file (Ctrl+O)" onClick={() => void store.loadFile()}>
          Open
        </button>
        <span className={`save-status ${state.sync}`} title="Changes are saved only when you press Save or Ctrl+S">
          {state.sync === "saved" ? "Saved" : "Unsaved"}
        </span>
      </div>

      <div className="topbar-group zoom-group">
        <button className="btn icon" title="Zoom out (Ctrl+-)" onClick={() => store.zoomStep(1 / 1.2, viewSize.w, viewSize.h)}>
          −
        </button>
        <button className="btn zoom-pct" title="Fit view (Ctrl+1)" onClick={() => store.fitView(viewSize.w, viewSize.h)}>
          {Math.round(state.camera.scale * 100)}%
        </button>
        <button className="btn icon" title="Zoom in (Ctrl+=)" onClick={() => store.zoomStep(1.2, viewSize.w, viewSize.h)}>
          +
        </button>
      </div>

      <div className="topbar-group">
        <button className={`btn icon${state.showOutliner ? " on" : ""}`} title="Outline panel" onClick={() => store.toggleOutliner()}>
          ☰
        </button>
        <button className={`btn icon${state.showInspector ? " on" : ""}`} title="Inspector panel" onClick={() => store.toggleInspector()}>
          ⚙
        </button>
        <button className={`btn icon${state.zen ? " on" : ""}`} title="Zen / focus mode (Ctrl+Shift+F)" onClick={() => store.toggleZen()}>
          ◎
        </button>
        <button className="btn icon" title="Command palette (Ctrl+K)" onClick={() => store.togglePalette()}>
          ⌘
        </button>
      </div>

      <div className="topbar-group" ref={exportRef}>
        <div className="menu-wrap">
          <button className="btn" onClick={() => setExportOpen((o) => !o)}>
            Export ▾
          </button>
          {exportOpen && (
            <div className="menu">
              <button onClick={() => { store.exportJson(); setExportOpen(false); }}>JSON (.rmind.json)</button>
              <button onClick={() => { store.exportMarkdown(); setExportOpen(false); }}>Markdown (.md)</button>
              <button onClick={() => { runExportPng(); setExportOpen(false); }}>PNG image</button>
              <div className="menu-sep" />
              <button onClick={() => { store.toast("SVG / PDF / DOCX export land in Phase 4"); setExportOpen(false); }}>SVG · PDF · DOCX (soon)</button>
            </div>
          )}
        </div>
        <button className="btn icon" title="Toggle light/dark theme (Ctrl+T)" onClick={() => store.toggleTheme()}>
          {state.theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </header>
  );
}
