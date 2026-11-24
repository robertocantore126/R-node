/**
 * The page itself never zooms: only the map does.
 *
 * Ctrl+wheel (and a touchpad pinch, which the browser reports as Ctrl+wheel)
 * zooms the map over the canvas, but over the toolbar, the Inspector or the
 * sidebar it fell through to the browser and scaled the whole UI. Ctrl+= /
 * Ctrl+- / Ctrl+0 did the same whenever a text field had focus, because the
 * app's shortcut handler steps aside for fields.
 *
 * Both are cancelled here, in a window capture listener that runs before
 * everything else. It only calls preventDefault — never stopPropagation — so
 * the canvas still receives the wheel and zooms the map, and the shortcut
 * handler still runs its own zoom-in / zoom-out / fit.
 */
const ZOOM_KEYS = new Set(["=", "+", "-", "_", "0"]);
const ZOOM_CODES = new Set(["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"]);

export function installBrowserZoomBlock(target: Window = window): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (ZOOM_KEYS.has(e.key) || ZOOM_CODES.has(e.code)) e.preventDefault();
  };
  // Safari's own pinch gestures.
  const onGesture = (e: Event): void => e.preventDefault();

  target.addEventListener("wheel", onWheel, { capture: true, passive: false });
  target.addEventListener("keydown", onKey, { capture: true });
  target.addEventListener("gesturestart", onGesture, { capture: true });
  target.addEventListener("gesturechange", onGesture, { capture: true });
  return () => {
    target.removeEventListener("wheel", onWheel, { capture: true });
    target.removeEventListener("keydown", onKey, { capture: true });
    target.removeEventListener("gesturestart", onGesture, { capture: true });
    target.removeEventListener("gesturechange", onGesture, { capture: true });
  };
}
