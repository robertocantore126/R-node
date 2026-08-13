import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "../editor/context";
import { runExportHtml } from "../editor/exportBridge";
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
      <div className="topbar-group">
        <button
          className={`btn icon${state.showSidebar ? " on" : ""}`}
          data-help="Documents panel"
          data-help-more="Shows or hides the document list on the left."
          title="Documents panel"
          onClick={() => store.toggleSidebar()}
        >
          ☰
        </button>
      </div>
      <input
        className="doc-title-input"
        data-help="Document title"
        data-help-more="The name of the map. It becomes the file name when you save."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => store.renameDocument(state.activeDocId, title || "Untitled map")}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />

      <div className="topbar-group">
        <button className="btn icon" data-help="Undo" data-help-more="Reverses the last operation (Ctrl+Z)." title="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={() => store.undo()}>
          ↶
        </button>
        <button className="btn icon" data-help="Redo" data-help-more="Re-applies the last undone operation (Ctrl+Shift+Z)." title="Redo (Ctrl+Shift+Z)" disabled={!state.canRedo} onClick={() => store.redo()}>
          ↷
        </button>
        <button className="btn primary" data-help="Save" data-help-more="Persists the document to storage (Ctrl+S). Changes reach disk only when you press this." title="Save (Ctrl+S)" onClick={() => void store.saveNow()}>
          Save
        </button>
        <button className="btn small" data-help="New document" data-help-more="Creates a fresh empty map. Nothing is saved until you press Save." onClick={() => store.newDocument()}>
          + New
        </button>
        <button className="btn small" data-help="From template" data-help-more="Creates a document from the built-in roadmap template." onClick={() => store.switchToDoc(store.duplicateSample())} title="Create a doc from the roadmap template">
          Template
        </button>
        <button className="btn" data-help="Open" data-help-more="Opens a .rnode document from disk (Ctrl+O)." title="Open a .rnode.json file (Ctrl+O)" onClick={() => void store.loadFile()}>
          Open
        </button>
        <span className={`save-status ${state.sync}`} data-help="Save status" data-help-more="Saved: everything up to your last Save is on disk. Unsaved: there are changes not yet persisted." title="Changes are saved only when you press Save or Ctrl+S">
          {state.sync === "saved" ? "Saved" : "Unsaved"}
        </span>
      </div>

      <div className="topbar-group zoom-group">
        <button className="btn icon" data-help="Zoom out" data-help-more="Shrinks the view around the cursor (Ctrl+-)." title="Zoom out (Ctrl+-)" onClick={() => store.zoomStep(1 / 1.2, viewSize.w, viewSize.h)}>
          −
        </button>
        <button className="btn zoom-pct" data-help="Current zoom" data-help-more="Click to fit the whole map into view (Ctrl+1)." title="Fit view (Ctrl+1)" onClick={() => store.fitView(viewSize.w, viewSize.h)}>
          {Math.round(state.camera.scale * 100)}%
        </button>
        <button className="btn icon" data-help="Zoom in" data-help-more="Enlarges the view around the cursor (Ctrl+=)." title="Zoom in (Ctrl+=)" onClick={() => store.zoomStep(1.2, viewSize.w, viewSize.h)}>
          +
        </button>
      </div>

      <div className="topbar-group">
        <button className={`btn icon${state.showInspector ? " on" : ""}`} data-help="Inspector panel" data-help-more="Toggles the style/task/notes panel for the selected topic." title="Inspector panel" onClick={() => store.toggleInspector()}>
          ⚙
        </button>
        <button className="btn icon" data-help="Command palette" data-help-more="Search any command or open a document (Ctrl+K)." title="Command palette (Ctrl+K)" onClick={() => store.togglePalette()}>
          ⌘
        </button>
        {/* Dev only: capture what just happened, then start a clean buffer so
            the NEXT capture is scoped to the next problem. It downloads before
            clearing on purpose — by the time you reach for this, the bug has
            already happened and clearing first would throw the evidence away. */}
        {trace.enabled && (
          <button
            className="btn icon"
            data-help="Capture trace"
            data-help-more="Downloads the recent diagnostic events, then starts a fresh recording (Ctrl+Shift+D). Developer tool."
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
          <button className="btn" data-help="Export menu" data-help-more="Exports the document: JSON, ZIP with images, Markdown, or a self-contained HTML viewer. Only working formats are listed." onClick={() => setExportOpen((o) => !o)}>
            Export ▾
          </button>
          {exportOpen && (
            <div className="menu">
              <button data-help="Export JSON" data-help-more="The document as plain JSON — text, styles, positions. No images." onClick={() => { store.exportJson(); setExportOpen(false); }}>JSON (.rnode.json)</button>
              {/* Only offered when there is something to carry: a .rnode.zip of
                  an image-less map is just document.json in a container. */}
              {referencedAssetIds(store.sheet).size > 0 && (
                <>
                  <button data-help="Export with images — originals" data-help-more="A .rnode.zip carrying the original image files (large but lossless)." onClick={() => { void store.exportRnodeZip("complete"); setExportOpen(false); }}>
                    With images — originals (.rnode.zip)
                  </button>
                  <button data-help="Export with images — compact" data-help-more="A .rnode.zip with scaled-down images (smaller, good enough on screen)." onClick={() => { void store.exportRnodeZip("compact"); setExportOpen(false); }}>
                    With images — compact (.rnode.zip)
                  </button>
                </>
              )}
              <button data-help="Export Markdown" data-help-more="The map as a bulleted Markdown outline. Text only." onClick={() => { store.exportMarkdown(); setExportOpen(false); }}>Markdown (.md)</button>
              <button data-help="Interactive viewer" data-help-more="A self-contained HTML file with the renderer built in — open it anywhere, no R-node needed." onClick={() => { runExportHtml(); setExportOpen(false); }}>Interactive viewer (.html) — read on screen</button>
              {/* SVG / PNG / PDF exist in the code (src/export, src/dev/pdfProbe) but
                  are not real yet: SVG stalls on large maps, PNG is the viewport
                  only, PDF is an experiment with a blank-page history. Removed
                  from the GUI until they are. */}
            </div>
          )}
        </div>

      </div>

      {/* Outline panel, mirrored to the sidebar hamburger on the far left. */}
      <div className="topbar-group topbar-outline">
        <button className={`btn icon${state.showOutliner ? " on" : ""}`} data-help="Outline panel" data-help-more="Toggles the document outline — the same tree as the canvas, as a list." title="Outline panel" onClick={() => store.toggleOutliner()}>
          ▤
        </button>
      </div>
    </header>
  );
}
