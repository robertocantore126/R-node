export interface RibbonBezier {
  x0: number;
  y0: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x1: number;
  y1: number;
}

export interface ConnectorRibbon {
  forward: RibbonBezier;
  backward: RibbonBezier;
  w0: number;
  w1: number;
}

export function taperWidthsForDepth(depth: number): [number, number] {
  if (depth <= 1) return [7, 3];
  if (depth === 2) return [3.2, 1.6];
  if (depth === 3) return [2, 1.2];
  return [1.6, 1];
}

/**
 * Compute the two cubic Beziers forming a tapered branch ribbon.
 * Horizontal connectors offset in Y; vertical connectors offset in X.
 */
export function connectorRibbon(
  sx: number,
  sy: number,
  cp1x: number,
  cp1y: number,
  cp2x: number,
  cp2y: number,
  ex: number,
  ey: number,
  depth: number,
  vertical: boolean
): ConnectorRibbon {
  const [w0, w1] = taperWidthsForDepth(depth);
  const h0 = w0 * 0.5;
  const h1 = w1 * 0.5;
  if (vertical) {
    return {
      w0,
      w1,
      forward: {
        x0: sx - h0,
        y0: sy,
        cp1x: cp1x - h0,
        cp1y,
        cp2x: cp2x - h1,
        cp2y,
        x1: ex - h1,
        y1: ey,
      },
      backward: {
        x0: ex + h1,
        y0: ey,
        cp1x: cp2x + h1,
        cp1y: cp2y,
        cp2x: cp1x + h0,
        cp2y: cp1y,
        x1: sx + h0,
        y1: sy,
      },
    };
  }
  return {
    w0,
    w1,
    forward: {
      x0: sx,
      y0: sy - h0,
      cp1x,
      cp1y: cp1y - h0,
      cp2x,
      cp2y: cp2y - h1,
      x1: ex,
      y1: ey - h1,
    },
    backward: {
      x0: ex,
      y0: ey + h1,
      cp1x: cp2x,
      cp1y: cp2y + h1,
      cp2x: cp1x,
      cp2y: cp1y + h0,
      x1: sx,
      y1: sy + h0,
    },
  };
}
