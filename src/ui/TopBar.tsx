import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import { runExportPng, runExportSvg } from "../editor/exportBridge";
import { referencedAssetIds } from "../persist/assets";
import { viewSize } from "../editor/view";
import { trace } from "../dev/trace";

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
        <button className="btn" title="Open a .rnode.json file (Ctrl+O)" onClick={() => void store.loadFile()}>
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
        {/* Dev only: capture what just happened, then start a clean buffer so
            the NEXT capture is scoped to the next problem. It downloads before
            clearing on purpose — by the time you reach for this, the bug has
            already happened and clearing first would throw the evidence away. */}
        {trace.enabled && (
          <button
            className="btn icon"
            title="Capture a session trace (Ctrl+Shift+D) — downloads the recent events, then starts a fresh recording"
            onClick={() => {
              trace.download();
              trace.clear();
              store.toast("Trace captured — recording restarted");
            }}
          >
            ⏺
          </button>
        )}
      </div>

      <div className="topbar-group" ref={exportRef}>
        <div className="menu-wrap">
          <button className="btn" onClick={() => setExportOpen((o) => !o)}>
            Export ▾
          </button>
          {exportOpen && (
            <div className="menu">
              <button onClick={() => { store.exportJson(); setExportOpen(false); }}>JSON (.rnode.json)</button>
              {/* Only offered when there is something to carry: a .rnode.zip of
                  an image-less map is just document.json in a container. */}
              {referencedAssetIds(store.sheet).size > 0 && (
                <>
                  <button onClick={() => { void store.exportRnodeZip("complete"); setExportOpen(false); }}>
                    With images — originals (.rnode.zip)
                  </button>
                  <button onClick={() => { void store.exportRnodeZip("compact"); setExportOpen(false); }}>
                    With images — compact (.rnode.zip)
                  </button>
                </>
              )}
              <button onClick={() => { store.exportMarkdown(); setExportOpen(false); }}>Markdown (.md)</button>
              <button onClick={() => { runExportSvg(); setExportOpen(false); }}>SVG (vector, whole map)</button>
              <button onClick={() => { runExportPng(); setExportOpen(false); }}>PNG image</button>
              <div className="menu-sep" />
              <button onClick={() => { store.toast("PDF / DOCX export land in Phase 4"); setExportOpen(false); }}>PDF · DOCX (soon)</button>
            </div>
          )}
        </div>

      </div>
    </header>
  );
}
