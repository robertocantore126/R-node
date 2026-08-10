/**
 * Camera / viewport transforms.
 *
 * camera.x/y = the world coordinate at the center of the viewport.
 * screen = (world - camera) * scale + viewportSize / 2
 */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4.0;

export const HOME_CAMERA: Camera = { x: 0, y: 0, scale: 1 };

export function worldToScreen(c: Camera, vw: number, vh: number, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - c.x) * c.scale + vw / 2, y: (wy - c.y) * c.scale + vh / 2 };
}

export function screenToWorld(c: Camera, vw: number, vh: number, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vw / 2) / c.scale + c.x, y: (sy - vh / 2) / c.scale + c.y };
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(c: Camera, vw: number, vh: number, sx: number, sy: number, factor: number): Camera {
  const anchor = screenToWorld(c, vw, vh, sx, sy);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor));
  // Keep the world point currently under the cursor at the same screen
  // coordinate after changing scale. The camera center is not the anchor
  // point unless the cursor happens to be in the middle of the viewport.
  return {
    scale,
    x: anchor.x - (sx - vw / 2) / scale,
    y: anchor.y - (sy - vh / 2) / scale,
  };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x - dx / c.scale, y: c.y - dy / c.scale };
}

export function centerOn(c: Camera, wx: number, wy: number, scale = c.scale): Camera {
  return { x: wx, y: wy, scale };
}

/** Fit the given world bounds (with padding) into a viewport. */
export function fitBounds(_c: Camera, vw: number, vh: number, bounds: { minX: number; minY: number; maxX: number; maxY: number }): Camera {
  const pad = 60;
  const bw = Math.max(bounds.maxX - bounds.minX, 1);
  const bh = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { x: cx, y: cy, scale: Math.min(scale, 1.25) };
}
