/**
 * Keyboard shortcuts.
 *
 * Central, customizable mapping (a profile object so users can rebind later).
 * Returns true when a key combo was consumed. While a topic is being edited
 * inline, the editor overlay owns the keyboard and shortcuts are skipped.
 */
import type { EditorStore } from "./store";
import { trace } from "../dev/trace";

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
  "Mod+Shift+c": "copy-outline",
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
  "Mod+1": "fit-view",
};

export function handleShortcut(store: EditorStore, e: KeyboardEvent, vw: number, vh: number): boolean {
  if (store.getSnapshot().editingId) {
    // While the type-to-edit editor is still mounting, buffer printable
    // characters into the pending insert so fast typing never loses a key.
    // Once the textarea is mounted (pending consumed) keys reach it directly.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && !e.key.match(/\s/)) {
      return store.appendPendingInsert(e.key);
    }
    return false;
  }

  if (e.key === "Escape") {
    const s = store.getSnapshot();
    if (s.showPalette) {
      store.togglePalette();
    } else if (s.relFrom) {
      store.clearRelFrom();
    } else if (s.gallerySel) {
      // Step OUT of the cell, not out of the topic (T25): the grid is inside
      // the topic, so one Escape should climb one level, and the Inspector
      // that edits the caption is only there while the topic is selected.
      store.clearGalleryCell();
    } else if (s.selection.length > 0 || s.imageSel) {
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
  if (!action) {
    // XMind-style type-to-edit: any printable character with a topic selected
    // starts editing it with that character. Modifier keys, Space (collapse)
    // and special keys never reach this branch.
    if (!mod && !e.altKey && e.key.length === 1 && !e.key.match(/\s/)) {
      store.typeToEdit(e.key);
      return true;
    }
    return false;
  }

  // Tab is special: never let it move focus out of the canvas.
  if (e.key === "Tab" || e.key === "Enter") e.preventDefault();

  // Tracer 2.0 ui:keyboard-shortcut — every dispatched shortcut, at the one
  // choke point every key passes through (tracer 2.0).
  trace.applied("ui:shortcut", { combo, action });

  // With a gallery cell selected, the arrows walk the GRID instead of the map
  // (T25). Intercepted here rather than inside the four nav cases so the
  // directions cannot drift apart, and so `navigate` never sees a keystroke
  // that was aimed at a cell.
  const navDir = { "nav-up": "up", "nav-down": "down", "nav-left": "left", "nav-right": "right" } as const;
  if (action in navDir && store.getSnapshot().gallerySel) {
    store.navigateGalleryCell(navDir[action as keyof typeof navDir]);
    return true;
  }

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
    case "delete": {
      e.preventDefault();
      const s = store.getSnapshot();
      // An image or a gallery cell selected inside its node: Backspace/Delete
      // removes ONLY that picture's place in the node — never the node.
      if (s.gallerySel) store.deleteSelectedGalleryCell();
      else if (s.imageSel) store.deleteSelectedImage();
      else if (s.relSel) store.deleteSelectedRelationship();
      else if (s.groupSel) store.deleteGroup(s.groupSel);
      else if (s.summarySel) store.deleteSummary(s.summarySel);
      else store.deleteSelection();
      return true;
    }
    case "copy-outline":
      void store.copySelectionOutline();
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
      window.dispatchEvent(new CustomEvent("r-node:focus-search"));
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
    case "fit-view":
      store.fitView(vw, vh);
      return true;
    default:
      return false;
  }
}
