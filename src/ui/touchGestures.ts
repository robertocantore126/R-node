/**
 * Finger gestures on the map canvas (phones, tablets).
 *
 * The mouse model does not survive a touch screen: panning is a right-drag
 * there, zoom is ctrl+wheel and the node menu is a right-click — none of which
 * a finger can produce (iOS Safari never fires contextmenu at all). Touch
 * pointers are therefore routed here instead of through the mouse handlers:
 *
 * - one finger drags the map, anywhere (topics are never moved by a finger,
 *   so scrolling a map cannot rearrange it by accident);
 * - two fingers pinch-zoom around their midpoint and pan with it;
 * - a tap selects, a long press opens the node menu.
 *
 * Pen and mouse keep the desktop behaviour untouched.
 */

/** Movement (px) under which a press still counts as a tap / long press. */
const TAP_SLOP = 8;
/** Hold time (ms) that turns a press into the right-click equivalent. */
const LONG_PRESS_MS = 500;

export interface TouchGestureHandlers {
  pan(dx: number, dy: number): void;
  /** Scale by `factor` keeping the canvas point (sx, sy) fixed. */
  zoom(sx: number, sy: number, factor: number): void;
  tap(x: number, y: number): void;
  longPress(x: number, y: number, clientX: number, clientY: number): void;
}

interface Pt {
  x: number;
  y: number;
}

export class TouchGestures {
  private pts = new Map<number, Pt>();
  private start: Pt = { x: 0, y: 0 };
  /** The gesture has moved, pinched or fired a long press: no tap at the end. */
  private spent = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinch: { dist: number; mid: Pt } | null = null;
  /** Time of the last touch event, so the mouse-compat events that follow a
   *  tap (contextmenu, dblclick) can be recognised and dropped. */
  lastTouchAt = 0;

  constructor(private h: TouchGestureHandlers) {}

  get active(): boolean {
    return this.pts.size > 0;
  }

  down(id: number, x: number, y: number, clientX: number, clientY: number): void {
    this.lastTouchAt = performance.now();
    this.pts.set(id, { x, y });
    if (this.pts.size === 1) {
      this.start = { x, y };
      this.spent = false;
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pts.size !== 1 || this.spent) return;
        this.spent = true;
        this.h.longPress(this.start.x, this.start.y, clientX, clientY);
      }, LONG_PRESS_MS);
    } else {
      this.spent = true;
      this.clearTimer();
      this.pinch = this.measure();
    }
  }

  move(id: number, x: number, y: number): void {
    const p = this.pts.get(id);
    if (!p) return;
    this.lastTouchAt = performance.now();
    if (this.pts.size >= 2) {
      p.x = x;
      p.y = y;
      const next = this.measure();
      if (this.pinch && this.pinch.dist > 0) {
        this.h.pan(next.mid.x - this.pinch.mid.x, next.mid.y - this.pinch.mid.y);
        this.h.zoom(next.mid.x, next.mid.y, next.dist / this.pinch.dist);
      }
      this.pinch = next;
      return;
    }
    if (!this.spent && Math.hypot(x - this.start.x, y - this.start.y) < TAP_SLOP) return;
    if (!this.spent) {
      this.spent = true;
      this.clearTimer();
    }
    this.h.pan(x - p.x, y - p.y);
    p.x = x;
    p.y = y;
  }

  up(id: number, cancelled = false): void {
    if (!this.pts.has(id)) return;
    this.lastTouchAt = performance.now();
    const p = this.pts.get(id)!;
    this.pts.delete(id);
    if (this.pts.size === 1) {
      // Back from a pinch to one finger: it keeps panning from where it is,
      // with no jump (its own last point is already current).
      this.pinch = null;
      return;
    }
    if (this.pts.size > 1) {
      this.pinch = this.measure();
      return;
    }
    this.clearTimer();
    this.pinch = null;
    if (!this.spent && !cancelled) this.h.tap(p.x, p.y);
  }

  /** True when a mouse-compat event fired now most likely came from a finger. */
  fromTouch(): boolean {
    return this.active || performance.now() - this.lastTouchAt < 800;
  }

  dispose(): void {
    this.clearTimer();
    this.pts.clear();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private measure(): { dist: number; mid: Pt } {
    const [a, b] = [...this.pts.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
}
