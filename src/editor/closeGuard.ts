/**
 * Ask before the app goes away with unsaved changes.
 *
 * Saving is manual (Ctrl+S) and there is no autosave, so closing the window
 * used to drop every change since the last save without a word.
 *
 *  - Desktop (Tauri): the window's close-requested event. Registering a
 *    listener makes Tauri wait for it; the default is cancelled when the user
 *    says no, otherwise the window is destroyed (needs
 *    `core:window:allow-destroy` in the capability).
 *  - Web, and a reload inside the desktop webview: `beforeunload`, where the
 *    browser shows its own generic prompt.
 */

interface CloseRequestedEvent {
  preventDefault(): void;
}

interface TauriWindowHandle {
  onCloseRequested(handler: (event: CloseRequestedEvent) => void | Promise<void>): Promise<() => void>;
}

interface TauriWindowApi {
  getCurrentWindow?: () => TauriWindowHandle;
}

export interface CloseGuardTarget {
  hasUnsavedChanges(): boolean;
}

export const CLOSE_PROMPT = "There are unsaved changes. Close R-node without saving them?";

export function installCloseGuard(store: CloseGuardTarget, win: Window = window): () => void {
  // Set once the user agreed to close the desktop window: destroying it may
  // run beforeunload, and asking a second time would be absurd.
  let closing = false;

  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (closing || !store.hasUnsavedChanges()) return;
    e.preventDefault();
    // Older engines only show the prompt when returnValue is set.
    e.returnValue = "";
  };
  win.addEventListener("beforeunload", onBeforeUnload);

  let unlistenTauri: (() => void) | null = null;
  let disposed = false;
  const tauriWindow = (win as unknown as { __TAURI__?: { window?: TauriWindowApi } }).__TAURI__?.window;
  if (tauriWindow?.getCurrentWindow) {
    void tauriWindow
      .getCurrentWindow()
      .onCloseRequested((event) => {
        if (!store.hasUnsavedChanges()) {
          closing = true;
          return;
        }
        if (win.confirm(CLOSE_PROMPT)) closing = true;
        else event.preventDefault();
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenTauri = unlisten;
      })
      .catch((e: unknown) => console.error("r-node: close guard not installed", e));
  }

  return () => {
    disposed = true;
    win.removeEventListener("beforeunload", onBeforeUnload);
    unlistenTauri?.();
  };
}
