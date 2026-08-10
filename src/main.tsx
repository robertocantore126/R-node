import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EditorStore } from "./editor/store";
import { StoreContext } from "./editor/context";
import "./styles.css";

const store = new EditorStore();

// Dev-only debug handle for performance spikes / automated testing.
(window as unknown as Record<string, unknown>).__rmind = { store };

void store.init().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </StrictMode>
  );
});
