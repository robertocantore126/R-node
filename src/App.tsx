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
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (handleShortcut(store, e, viewSize.w, viewSize.h)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const zen = state.zen;

  return (
    <div className="app">
      {!zen && <Sidebar />}

      <div className="main">
        {!zen && <TopBar />}

        <div className="workspace">
          <div className="canvas-area">
            <CanvasView />
            {!zen && state.showOutliner && <Outliner />}
          </div>
          {!zen && state.showInspector && <Inspector />}
        </div>

        {!zen && <StatusBar />}
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
      <span>{Math.round(state.camera.scale * 100)}%</span>
      <span className="sep">·</span>
      <span>{state.selection.length > 0 ? `${state.selection.length} selected` : `${store.doc.visibleNodeCount} topics`}</span>
      <span className="sep">·</span>
      <span className={state.sync}>{state.sync === "saved" ? "Saved locally" : "Saving…"}</span>
      <span className="spacer" />
      {state.relFrom && <span className="status-hint">Link mode: click a target</span>}
      <span className="sep">·</span>
      <span>Enter/Tab create · drag to move · scroll to pan · Ctrl+scroll to zoom</span>
    </footer>
  );
}
