/**
 * What a mouse or pen press on the map is doing, from pointerdown to release.
 *
 * This replaces a bag of nullable fields where "only one of these is set" was
 * a hope. Each gesture now carries only its own data, and a press can be
 * exactly one of them. Fingers go through touchGestures.ts instead.
 */
import { Machine, type TransitionTable } from "../editor/machine";
import type { ImageSlot, InkStroke, RelAnchor } from "../core/types";

export type ConnectGrip =
  | { kind: "new"; fromId: string; fromAnchor: RelAnchor }
  | { kind: "end"; relId: string; end: "from" | "to" };

export type CanvasGesture =
  | { kind: "idle" }
  /** Right/middle drag or pan mode, on the canvas or over the text editor. */
  | { kind: "pan"; over: "canvas" | "overlay" }
  /** Armed on empty canvas; `active` once the pointer has travelled 4px. */
  /** `scope`: started inside a freeform canvas, so it picks only that canvas's items. */
  | { kind: "marquee"; anchorX: number; anchorY: number; active: boolean; scope?: string }
  | { kind: "node-drag"; nodeId: string; grabOffsetX: number; grabOffsetY: number }
  /** A multi-selection inside one freeform canvas moving together (draw.io style). */
  | { kind: "group-drag"; nodeId: string; startWorldX: number; startWorldY: number }
  | { kind: "resize-topic"; nodeId: string; side: "left" | "right"; startWorldX: number; startWidth: number; startX: number }
  /** A canvas resized from one of its four corners; the start is in screen pixels. */
  | { kind: "resize-freeform"; nodeId: string; corner: "nw" | "ne" | "sw" | "se"; startScreenX: number; startScreenY: number }
  /** An item of a canvas resized from a corner: width and height together. */
  | { kind: "resize-item"; nodeId: string; corner: "nw" | "ne" | "sw" | "se"; startScreenX: number; startScreenY: number }
  | { kind: "resize-image"; nodeId: string; startWorldX: number; startWidth: number }
  /** A picture carried to another topic; `dropSlot` is the side it would take. */
  | { kind: "move-image"; nodeId: string; slot: ImageSlot; dropSlot: ImageSlot }
  /** A gallery cell in hand; `to` is the gap it would drop into. */
  | { kind: "move-cell"; from: { nodeId: string; index: number }; to: { nodeId: string; index: number } | null }
  | { kind: "connect"; grip: ConnectGrip }
  /**
   * Reshaping the selected relationship (draw.io): moving a bend, pulling a
   * new one out, sliding an elbow segment, or carrying the label. `base` is
   * the bends (world) - or, for the label, its offset - when the press began.
   */
  | { kind: "rel-bend"; relId: string; mode: "point" | "insert" | "segment" | "label"; index: number; base: { x: number; y: number }[]; startWorldX: number; startWorldY: number }
  /** A pen stroke being written; the origin converts world points to canvas-local. */
  | { kind: "ink-stroke"; canvasId: string; originX: number; originY: number; stroke: InkStroke }
  /** The eraser passing over a canvas; `erased` is removed on release. */
  | { kind: "ink-erase"; canvasId: string; originX: number; originY: number; erased: Set<InkStroke> }
  | { kind: "chart-grow"; id: string; grow: "row" | "col"; startWorld: number; pitch: number; current: number };

export const IDLE_GESTURE: CanvasGesture = { kind: "idle" };

const BACK_TO_IDLE = ["idle"] as const;

/** A gesture only ever starts from idle and only ever ends there. */
export const CANVAS_GESTURE_TABLE: TransitionTable<CanvasGesture> = {
  idle: ["pan", "marquee", "node-drag", "group-drag", "resize-topic", "resize-freeform", "resize-item", "resize-image", "move-image", "move-cell", "connect", "rel-bend", "chart-grow", "ink-stroke", "ink-erase"],
  pan: BACK_TO_IDLE,
  marquee: BACK_TO_IDLE,
  "node-drag": BACK_TO_IDLE,
  "group-drag": BACK_TO_IDLE,
  "resize-topic": BACK_TO_IDLE,
  "resize-freeform": BACK_TO_IDLE,
  "resize-item": BACK_TO_IDLE,
  "resize-image": BACK_TO_IDLE,
  "move-image": BACK_TO_IDLE,
  "move-cell": BACK_TO_IDLE,
  connect: BACK_TO_IDLE,
  "rel-bend": BACK_TO_IDLE,
  "chart-grow": BACK_TO_IDLE,
  "ink-stroke": BACK_TO_IDLE,
  "ink-erase": BACK_TO_IDLE,
};

export function createCanvasGestureMachine(): Machine<CanvasGesture> {
  return new Machine<CanvasGesture>("canvasGesture", IDLE_GESTURE, CANVAS_GESTURE_TABLE);
}

/**
 * Whether this gesture has something to commit on release. While it does, the
 * keyboard is held off: Delete or undo would change the document underneath a
 * drag whose release is about to write to it. A pan changes only the view, so
 * typing carries on during one, and an editing overlay keeps working.
 */
export function gestureHoldsKeyboard(gesture: CanvasGesture): boolean {
  return gesture.kind !== "idle" && gesture.kind !== "pan";
}

export function isResizeGesture(kind: CanvasGesture["kind"]): boolean {
  return kind === "resize-topic" || kind === "resize-freeform" || kind === "resize-item" || kind === "resize-image";
}
