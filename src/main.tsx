import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppErrorBoundary } from "./App";
import { EditorStore } from "./editor/store";
import { inspectMachines } from "./editor/machine";
import { StoreContext } from "./editor/context";
import { installCloseGuard } from "./editor/closeGuard";
import { LocalStorageAdapter, TauriStorageAdapter } from "./persist/storage";
import { generateStressMap, type StressOptions } from "./dev/stress";
import "./styles.css";

// Same runtime switch as the asset factory (T19): the Tauri webview carries
// window.__TAURI__, a plain browser tab does not. On desktop the document is
// a single .rnode file, so localStorage never touches the document.
const adapter =
  typeof window !== "undefined" && window.__TAURI__ ? new TauriStorageAdapter() : new LocalStorageAdapter();

const store = new EditorStore(adapter);

// Dev-only debug handle for performance spikes / automated testing.
(window as unknown as Record<string, unknown>).__rnode = {
  store,
  /** The current state of every explicit machine — see docs/STATE_MACHINES.md. */
  machines: inspectMachines,
  /** Build a punishing map in place — see src/dev/stress.ts. */
  stress: (opts?: StressOptions) =>
    generateStressMap(store, {
      ...opts,
      onProgress: (f, label) => console.info(`[stress] ${Math.round(f * 100)}% — ${label}`),
    }),
};

void store.boot().then(() => {
  installCloseGuard(store);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <AppErrorBoundary onExport={() => store.exportJson()}>
          <App />
        </AppErrorBoundary>
      </StoreContext.Provider>
    </StrictMode>
  );
});
