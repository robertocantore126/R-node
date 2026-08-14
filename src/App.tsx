import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { useStore } from "./editor/context";
import { handleShortcut } from "./editor/shortcuts";
import { viewSize } from "./editor/view";
import { Sidebar } from "./ui/Sidebar";
import { TopBar } from "./ui/TopBar";
import { CanvasView } from "./ui/CanvasView";
import { Outliner } from "./ui/Outliner";
import { Inspector } from "./ui/Inspector";
import { Palette } from "./ui/Palette";

export function App(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const isField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target?.isContentEditable;
      if (isField) {
        // Save/Open must work even from a text field (Inspector title, doc
        // title, search…): blur it first so its onBlur commit fires, then run
        // the shortcut. Otherwise Ctrl+S falls through to the browser's
        // "Save page" dialog and nothing is saved.
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && (key === "s" || key === "o")) {
          e.preventDefault();
          (target as HTMLElement).blur();
          if (handleShortcut(store, e, viewSize.w, viewSize.h)) e.preventDefault();
        }
        return;
      }
      if (handleShortcut(store, e, viewSize.w, viewSize.h)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  return (
    // .app is a two-column grid (sidebar + main). With the sidebar unmounted
    // the single remaining child would land in the first 264px slot and crush
    // the whole UI into it — the canvas went zero-width (blank) and the
    // inspector overflowed on the left. Switching the grid to one column keeps
    // main spanning the full window.
    <div className={`app${state.showSidebar ? "" : " app-no-sidebar"}`}>
      {state.showSidebar && <Sidebar />}

      <div className="main">
        <TopBar />

        <div className="workspace">
          <div className="canvas-area">
            <CanvasView />
            {state.showOutliner && <Outliner />}
          </div>
          {state.showInspector && <Inspector />}
        </div>

        <StatusBar />
      </div>

      <Palette />

      {state.message && (
        <div className="toast" onClick={() => (store as unknown as { toast: (m: string) => void }).toast("")}>
          {state.message}
        </div>
      )}

    </div>
  );
}

function StatusBar(): JSX.Element {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <footer className="statusbar">
      <span data-help="Current zoom" data-help-more="Zoom level of the map view. Ctrl+scroll to zoom, Ctrl+1 to fit the map.">{Math.round(state.camera.scale * 100)}%</span>
      <span className="sep">·</span>
      <span data-help="Topic count" data-help-more="How many topics the current map contains.">{state.selection.length > 0 ? `${state.selection.length} selected` : `${store.doc.visibleNodeCount} topics`}</span>
      <span className="sep">·</span>
      <span className={state.sync} data-help="Save status" data-help-more="Saved: everything up to your last Save is on disk. Unsaved changes: nothing has been written since.">{state.sync === "saved" ? "Saved" : "Unsaved changes"}</span>
      {state.op && (
        <>
          <span className="sep">·</span>
          <span className="statusbar-op">
            <span className="statusbar-op-label">{state.op.label}</span>
            <span
              className={`statusbar-op-track${state.op.progress == null ? " indeterminate" : ""}`}
            >
              <span
                className="statusbar-op-fill"
                style={state.op.progress == null ? undefined : { width: `${Math.round(state.op.progress * 100)}%` }}
              />
            </span>
            {state.op.cancellable && (
              <button
                className="btn small"
                title="Cancel the running operation"
                onClick={() => store.cancelLongOp()}
              >
                Cancel
              </button>
            )}
          </span>
        </>
      )}
      <span className="spacer" />
      {state.relFrom && <span className="status-hint">Link mode: click a target</span>}
      <span className="sep">·</span>
      <span>Enter/Tab create · drag to move · right-drag to pan · Ctrl+scroll to zoom</span>
    </footer>
  );
}
