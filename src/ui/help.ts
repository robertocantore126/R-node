/**
 * Help overlay — "what is this?" inspection mode.
 *
 * Hold Shift to enter inspection: hovering a GUI element (any DOM node with
 * a `data-help` attribute) or a canvas object (hit-tested by the renderer)
 * shows a tooltip explaining what the object is and does.
 *
 * Phase 1 ships the overlay only; Shift+click → LLM chat is the planned
 * phase 2 and intentionally does nothing yet.
 *
 * The module is framework-free: `HelpOverlay` subscribes via `subscribeHelp`.
 */

export interface HelpInfo {
  /** Short name of the object, e.g. "Save button". */
  title: string;
  /** Longer description, shown under the title. */
  body: string;
  /** Screen-space anchor of the tooltip. */
  x: number;
  y: number;
  /** "element" → tooltip floats above the anchor; "cursor" → beside it. */
  anchor: "element" | "cursor";
}

let shiftHeld = false;
let current: HelpInfo | null = null;
let hoveredEl: HTMLElement | null = null;
const listeners = new Set<(info: HelpInfo | null) => void>();

function publish(info: HelpInfo | null): void {
  current = info;
  for (const l of listeners) l(info);
}

export function subscribeHelp(cb: (info: HelpInfo | null) => void): () => void {
  listeners.add(cb);
  cb(current);
  return () => {
    listeners.delete(cb);
  };
}

export function isShiftHeld(): boolean {
  return shiftHeld;
}

/** Called by the global key listeners; revealing help for the element that is
 *  already under the cursor the moment Shift goes down (no mouse move needed). */
export function setShiftHeld(v: boolean): void {
  if (shiftHeld === v) return;
  shiftHeld = v;
  if (v) {
    if (hoveredEl) publishFromElement(hoveredEl);
  } else {
    publish(null);
  }
}

/** Track the DOM element currently under the cursor (document mouseover). */
export function trackHover(el: HTMLElement | null): void {
  hoveredEl = el;
  if (shiftHeld) {
    if (el) publishFromElement(el);
    else publish(null);
  }
}

function publishFromElement(el: HTMLElement): void {
  const title = el.getAttribute("data-help");
  if (!title) {
    publish(null);
    return;
  }
  const rect = el.getBoundingClientRect();
  publish({
    title,
    body: el.getAttribute("data-help-more") ?? "",
    x: rect.left + rect.width / 2,
    y: rect.top,
    anchor: "element",
  });
}

/** Canvas objects are not DOM nodes; CanvasView hit-tests and calls this. */
export function showCanvasHelp(info: HelpInfo | null): void {
  if (!shiftHeld) return;
  publish(info);
}

/** Hide the tooltip when the pointer leaves the app window. */
export function hideHelp(): void {
  hoveredEl = null;
  publish(null);
}
