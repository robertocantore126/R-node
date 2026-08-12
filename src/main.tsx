import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EditorStore } from "./editor/store";
import { StoreContext } from "./editor/context";
import { LocalStorageAdapter, TauriStorageAdapter } from "./persist/storage";
import "./styles.css";

// Same runtime switch as the asset factory (T19): the Tauri webview carries
// window.__TAURI__, a plain browser tab does not. On desktop the document is
// a folder, so localStorage never touches the document.
const adapter =
  typeof window !== "undefined" && window.__TAURI__ ? new TauriStorageAdapter() : new LocalStorageAdapter();

const store = new EditorStore(adapter);

// Dev-only debug handle for performance spikes / automated testing.
(window as unknown as Record<string, unknown>).__rnode = { store };

void store.init().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </StrictMode>
  );
});
