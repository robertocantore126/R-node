/**
 * Unsaved changes are tracked per document and are never reported as saved
 * when they did not reach the disk; closing with unsaved changes asks first.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStore } from "../src/editor/store";
import { CLOSE_PROMPT, installCloseGuard } from "../src/editor/closeGuard";
import { TauriStorageAdapter, type StorageAdapter } from "../src/persist/storage";

const memoryAdapter = (): StorageAdapter => ({ label: "test", async load() { return []; }, async save() {} });

type G = { window?: Record<string, unknown> };
const g = globalThis as unknown as G;

afterEach(() => {
  if (g.window) delete g.window.__TAURI__;
});

/** A desktop store whose write_document waits until `release()` is called. */
function desktopStore(): { store: EditorStore; written: () => string; release: () => void; writing: () => boolean } {
  g.window ??= globalThis as unknown as Record<string, unknown>;
  let written = "";
  let release: (() => void) | null = null;
  let docJson = "";
  g.window.__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "read_document") return docJson;
        if (cmd === "write_document") {
          written = args.data as string;
          await new Promise<void>((r) => { release = r; });
        }
        return null;
      },
    },
  };
  const adapter = new TauriStorageAdapter();
  adapter.setRoot("C:/maps/Map.rnode");
  const store = new EditorStore(adapter);
  docJson = JSON.stringify(store.doc.doc);
  return {
    store,
    written: () => written,
    release: () => release?.(),
    writing: () => release !== null,
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
}

describe("unsaved changes per document", () => {
  it("an edited document still reads unsaved after switching away and back", () => {
    const store = new EditorStore(memoryAdapter());
    const a = store.getSnapshot().activeDocId;
    store.newDocument();
    const b = store.getSnapshot().activeDocId;
    store.switchToDoc(a);
    store.createChildOf(store.sheet.rootNodeId);
    expect(store.getSnapshot().sync).toBe("dirty");

    store.switchToDoc(b);
    store.switchToDoc(a);
    expect(store.getSnapshot().sync).toBe("dirty");
    expect(store.hasUnsavedChanges()).toBe(true);
  });

  it("a deleted document no longer counts as unsaved", () => {
    const store = new EditorStore(memoryAdapter());
    store.newDocument();
    const b = store.getSnapshot().activeDocId;
    store.createChildOf(store.sheet.rootNodeId);
    store.deleteDocument(b);
    expect(store.hasUnsavedChanges()).toBe(false);
  });

  it("a desktop save with no edit in between leaves everything saved", async () => {
    const d = desktopStore();
    d.store.createChildOf(d.store.sheet.rootNodeId);
    const p = d.store.saveNow();
    await until(d.writing);
    d.release();
    await p;
    expect(d.store.getSnapshot().sync).toBe("saved");
    expect(d.store.hasUnsavedChanges()).toBe(false);
  });

  it("an edit made while the desktop write is in flight stays unsaved", async () => {
    const d = desktopStore();
    const p = d.store.saveNow();
    await until(d.writing);
    const id = d.store.createChildOf(d.store.sheet.rootNodeId)!;
    d.release();
    await p;
    expect(d.written()).not.toContain(id); // the write took the older content…
    expect(d.store.getSnapshot().sync).toBe("dirty"); // …so the edit is not "saved"
    expect(d.store.hasUnsavedChanges()).toBe(true);
  });
});

describe("close guard", () => {
  function fakeWindow(confirmAnswer: boolean): {
    win: Window;
    requestClose: () => Promise<boolean>;
    beforeUnload: () => boolean;
    confirm: ReturnType<typeof vi.fn>;
  } {
    const listeners = new Map<string, (e: unknown) => void>();
    let closeHandler: ((e: { preventDefault(): void }) => void | Promise<void>) | null = null;
    const confirm = vi.fn(() => confirmAnswer);
    const win = {
      addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
      confirm,
      __TAURI__: {
        window: {
          getCurrentWindow: () => ({
            onCloseRequested: async (h: typeof closeHandler) => {
              closeHandler = h;
              return () => { closeHandler = null; };
            },
          }),
        },
      },
    } as unknown as Window;
    return {
      win,
      confirm,
      // true = the window closes
      requestClose: async () => {
        await new Promise((r) => setTimeout(r, 0));
        let prevented = false;
        await closeHandler!({ preventDefault: () => { prevented = true; } });
        return !prevented;
      },
      // true = the browser would prompt
      beforeUnload: () => {
        let prevented = false;
        listeners.get("beforeunload")!({ preventDefault: () => { prevented = true; }, returnValue: undefined });
        return prevented;
      },
    };
  }

  it("closes without asking when everything is saved", async () => {
    const f = fakeWindow(false);
    installCloseGuard({ hasUnsavedChanges: () => false }, f.win);
    expect(await f.requestClose()).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.beforeUnload()).toBe(false);
  });

  it("asks with unsaved changes and stays open on cancel", async () => {
    const f = fakeWindow(false);
    installCloseGuard({ hasUnsavedChanges: () => true }, f.win);
    expect(await f.requestClose()).toBe(false);
    expect(f.confirm).toHaveBeenCalledWith(CLOSE_PROMPT);
  });

  it("closes when the user confirms, without a second prompt from beforeunload", async () => {
    const f = fakeWindow(true);
    installCloseGuard({ hasUnsavedChanges: () => true }, f.win);
    expect(await f.requestClose()).toBe(true);
    expect(f.beforeUnload()).toBe(false);
  });

  it("the web build prompts on unload with unsaved changes", () => {
    const f = fakeWindow(false);
    (f.win as unknown as { __TAURI__?: unknown }).__TAURI__ = undefined;
    installCloseGuard({ hasUnsavedChanges: () => true }, f.win);
    expect(f.beforeUnload()).toBe(true);
  });
});
