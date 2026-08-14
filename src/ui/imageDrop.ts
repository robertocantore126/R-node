/**
 * Where a dragged image lands when it is dropped on a topic.
 *
 * Pure and framework-free so it can be tested on its own: it is the only
 * piece of the four-sides feature the user drives by hand, and the rule it
 * implements is not obvious from watching it once.
 */

import type { ImageSlot } from "../core/types";

/**
 * How much of the box, per axis, counts as "on that edge". Everything further
 * in than this on both axes is the middle of the box, which keeps the legacy
 * behaviour: drop in the middle, the image goes on top.
 */
export const SIDE_BAND = 0.25;

/**
 * The slot a drop at (wx, wy) targets on a topic occupying `rect`.
 *
 * Distances are NORMALISED to the box, not measured in pixels. In pixels the
 * centre of a tall narrow topic is closer to its left and right edges than to
 * its top — 84px wide by 140px tall puts the centre 42px from a side and 70px
 * from the top — so an absolute "nearest edge" test sends a drop aimed at the
 * middle of the node to `left`, which is what made the feature feel broken.
 * Normalised, the centre is 0.5 away from all four edges whatever the shape of
 * the box, and the band below decides side-versus-middle instead of the aspect
 * ratio deciding it.
 *
 * Corner ties resolve left → right → top → bottom; any tie further in than
 * SIDE_BAND is moot, since the middle answers "top" regardless.
 */
export function nearestImageSide(rect: { x: number; y: number; w: number; h: number }, wx: number, wy: number): ImageSlot {
  const u = rect.w > 0 ? (wx - rect.x) / rect.w : 0.5;
  const v = rect.h > 0 ? (wy - rect.y) / rect.h : 0.5;
  const distance: Record<ImageSlot, number> = { left: u, right: 1 - u, top: v, bottom: 1 - v };
  let nearest: ImageSlot = "left";
  for (const slot of ["right", "top", "bottom"] as const) {
    if (distance[slot] < distance[nearest]) nearest = slot;
  }
  return distance[nearest] > SIDE_BAND ? "top" : nearest;
}
