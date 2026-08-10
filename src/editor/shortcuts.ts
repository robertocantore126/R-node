/**
 * Keyboard shortcuts.
 *
 * Central, customizable mapping (a profile object so users can rebind later).
 * Returns true when a key combo was consumed. While a topic is being edited
 * inline, the editor overlay owns the keyboard and shortcuts are skipped.
 */
import type { EditorStore } from "./store";

export interface ShortcutProfile {
  [key: string]: string; // canonical combo -> action id
}

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  Enter: "create-sibling",
  Tab: "create-child",
  "Shift+Tab": "promote",
  ArrowUp: "nav-up",
  ArrowDown: "nav-down",
  ArrowLeft: "nav-left",
  ArrowRight: "nav-right",
  F2: "edit",
  Space: "toggle-collapse",
  Delete: "delete",
  Backspace: "delete",
  "Mod+z": "undo",
  "Mod+Shift+z": "redo",
  "Mod+y": "redo",
  "Mod+c": "copy",
  "Mod+x": "cut",
  "Mod+v": "paste",
  "Mod+k": "palette",
  "Mod+f": "search",
  "Mod+s": "save",
  "Mod+o": "open",
  "Mod+e": "export-json",
  "Mod+d": "duplicate",
  "Mod+Enter": "task-complete",
  "Mod+=": "zoom-in",
  "Mod+-": "zoom-out",
  "Mod+0": "zoom-reset",
  "Mod+p": "present",
  "Mod+Shift+f": "zen",
  "Mod+1": "fit-view",
  "Mod+t": "theme",
};

export function handleShortcut(store: EditorStore, e: KeyboardEvent, vw: number, vh: number): boolean {
  if (store.getSnapshot().editingId) return false;

  if (e.key === "Escape") {
    const s = store.getSnapshot();
    if (s.showPalette) {
      store.togglePalette();
    } else if (s.relFrom) {
      store.clearRelFrom();
    } else if (s.selection.length > 0) {
      store.clearSelection();
    }
    return true;
  }

  const mod = e.metaKey || e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (e.shiftKey && !["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(e.key === " " ? "Space" : e.key);
  const combo = parts.join("+");
  const key = e.key === " " ? "Space" : e.key;

  const action = DEFAULT_SHORTCUTS[combo] ?? (mod ? undefined : DEFAULT_SHORTCUTS[key]);
  if (!action) return false;

  // Tab is special: never let it move focus out of the canvas.
  if (e.key === "Tab" || e.key === "Enter") e.preventDefault();

  switch (action) {
    case "create-sibling":
      store.createSibling();
      return true;
    case "create-child":
      store.createChild();
      return true;
    case "promote":
      store.promote();
      return true;
    case "nav-up":
      store.navigate("up");
      return true;
    case "nav-down":
      store.navigate("down");
      return true;
    case "nav-left":
      store.navigate("left");
      return true;
    case "nav-right":
      store.navigate("right");
      return true;
    case "edit": {
      const n = store.selectionNode;
      if (n) store.startEdit(n.id);
      return true;
    }
    case "toggle-collapse": {
      const n = store.selectionNode;
      if (n) store.toggleCollapsed(n.id);
      return true;
    }
    case "delete":
      e.preventDefault();
      store.deleteSelection();
      return true;
    case "undo":
      e.preventDefault();
      store.undo();
      return true;
    case "redo":
      e.preventDefault();
      store.redo();
      return true;
    case "copy":
      void store.copySelection();
      return true;
    case "cut":
      void store.cutSelection();
      return true;
    case "paste":
      e.preventDefault();
      void store.paste();
      return true;
    case "palette":
      e.preventDefault();
      store.togglePalette();
      return true;
    case "search":
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("r-mind:focus-search"));
      return true;
    case "save":
      e.preventDefault();
      void store.saveNow();
      return true;
    case "open":
      e.preventDefault();
      void store.loadFile();
      return true;
    case "export-json":
      e.preventDefault();
      store.exportJson();
      return true;
    case "duplicate":
      store.duplicateTopic();
      return true;
    case "task-complete": {
      const n = store.selectionNode;
      if (n) store.toggleTaskComplete(n.id);
      return true;
    }
    case "zoom-in":
      store.zoomStep(1.2, vw, vh);
      return true;
    case "zoom-out":
      store.zoomStep(1 / 1.2, vw, vh);
      return true;
    case "zoom-reset":
      store.fitView(vw, vh);
      return true;
    case "present":
      store.toast("Presentation mode lands in Phase 4");
      return true;
    case "zen":
      store.toggleZen();
      return true;
    case "fit-view":
      store.fitView(vw, vh);
      return true;
    case "theme":
      store.toggleTheme();
      return true;
    default:
      return false;
  }
}
