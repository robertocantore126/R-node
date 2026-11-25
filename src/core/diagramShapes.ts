/**
 * Flowchart / diagram outlines (draw.io's basic set), described ONCE as a
 * list of path commands and replayed by every painter: the canvas renderer,
 * the SVG exporter and the PDF exporter. Three hand-written copies of the same
 * curve would drift; one list cannot.
 *
 * `outline` is the closed silhouette (filled, then stroked as the border).
 * `detail` is extra linework stroked with the border and never filled: the
 * front rim of a cylinder, the side bars of a process box, a note's fold.
 *
 * Only M / L / C / Z are used, because those map one to one onto Canvas2D,
 * SVG path data and PDF path operators.
 */
export type PathCmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

export const DIAGRAM_SHAPES = [
  "ellipse", "cylinder", "document", "parallelogram", "triangle", "process", "note", "actor",
  "trapezoid", "manualInput", "delay", "offPage", "internalStorage", "multiDocument",
  "step", "arrowRight", "doubleArrow", "cross", "star", "octagon", "cube", "callout", "cloud",
] as const;
export type DiagramShape = (typeof DIAGRAM_SHAPES)[number];

export function isDiagramShape(shape: string | undefined): shape is DiagramShape {
  return (DIAGRAM_SHAPES as readonly string[]).includes(shape ?? "");
}

/** Bezier constant for a quarter ellipse. */
const K = 0.5522847498;

function ellipse(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  return [
    ["M", cx - rx, cy],
    ["C", cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry],
    ["C", cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy],
    ["C", cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry],
    ["C", cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy],
    ["Z"],
  ];
}

/** The cap height of a cylinder: draw.io's 15px, never more than a quarter of the box. */
export function cylinderCap(h: number): number {
  return Math.min(15, h / 4) / 2;
}

export function diagramShapePath(shape: DiagramShape, x: number, y: number, w: number, h: number): { outline: PathCmd[]; detail: PathCmd[] } {
  switch (shape) {
    case "ellipse":
      return { outline: ellipse(x + w / 2, y + h / 2, w / 2, h / 2), detail: [] };
    case "cylinder": {
      const ry = cylinderCap(h) * 2, rx = w / 2, cx = x + w / 2;
      const top = y + ry, bottom = y + h - ry;
      return {
        outline: [
          ["M", x, top],
          ["C", x, top - ry * K, cx - rx * K, y, cx, y],
          ["C", cx + rx * K, y, x + w, top - ry * K, x + w, top],
          ["L", x + w, bottom],
          ["C", x + w, bottom + ry * K, cx + rx * K, y + h, cx, y + h],
          ["C", cx - rx * K, y + h, x, bottom + ry * K, x, bottom],
          ["Z"],
        ],
        // The near half of the lid, which is what makes it read as a drum.
        detail: [
          ["M", x, top],
          ["C", x, top + ry * K, cx - rx * K, top + ry, cx, top + ry],
          ["C", cx + rx * K, top + ry, x + w, top + ry * K, x + w, top],
        ],
      };
    }
    case "document": {
      const a = h * 0.1;
      return {
        outline: [
          ["M", x, y],
          ["L", x + w, y],
          ["L", x + w, y + h - a],
          ["C", x + w * 0.6, y + h - a * 3, x + w * 0.4, y + h + a, x, y + h - a],
          ["Z"],
        ],
        detail: [],
      };
    }
    case "parallelogram": {
      const s = Math.min(w * 0.2, h * 0.5, 20);
      return { outline: [["M", x + s, y], ["L", x + w, y], ["L", x + w - s, y + h], ["L", x, y + h], ["Z"]], detail: [] };
    }
    case "triangle":
      return { outline: [["M", x + w / 2, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]], detail: [] };
    case "process": {
      const b = Math.min(w * 0.1, 16);
      return {
        outline: [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]],
        detail: [["M", x + b, y], ["L", x + b, y + h], ["M", x + w - b, y], ["L", x + w - b, y + h]],
      };
    }
    case "actor": {
      // A stick figure in the top part of the box; its name goes underneath
      // (Style.titleAt "bottom"), in the band ACTOR_FIGURE leaves free.
      const fh = h * ACTOR_FIGURE, cx = x + w / 2;
      const r = Math.min(w * 0.2, fh * 0.15);
      const neck = y + r * 2, hip = y + fh * 0.62, arms = y + fh * 0.4;
      return {
        outline: ellipse(cx, y + r, r, r),
        detail: [
          ["M", cx, neck], ["L", cx, hip],
          ["M", x + w * 0.12, arms], ["L", x + w * 0.88, arms],
          ["M", cx, hip], ["L", x + w * 0.15, y + fh],
          ["M", cx, hip], ["L", x + w * 0.85, y + fh],
        ],
      };
    }
    case "note": {
      const f = Math.min(16, w * 0.3, h * 0.3);
      return {
        outline: [["M", x, y], ["L", x + w - f, y], ["L", x + w, y + f], ["L", x + w, y + h], ["L", x, y + h], ["Z"]],
        detail: [["M", x + w - f, y], ["L", x + w - f, y + f], ["L", x + w, y + f]],
      };
    }
    case "trapezoid": {
      // Manual operation: narrower at the top.
      const s = Math.min(w * 0.2, 20);
      return { outline: poly([[x + s, y], [x + w - s, y], [x + w, y + h], [x, y + h]]), detail: [] };
    }
    case "manualInput": {
      // A keyboard's slanted top edge.
      const a = Math.min(h * 0.3, 20);
      return { outline: poly([[x, y + a], [x + w, y], [x + w, y + h], [x, y + h]]), detail: [] };
    }
    case "delay": {
      // Flat left side, round right side (the "D").
      const ry = h / 2, rx = Math.min(w / 2, ry), cy = y + ry, ex = x + w - rx;
      return {
        outline: [
          ["M", x, y], ["L", ex, y],
          ["C", ex + rx * K, y, x + w, cy - ry * K, x + w, cy],
          ["C", x + w, cy + ry * K, ex + rx * K, y + h, ex, y + h],
          ["L", x, y + h], ["Z"],
        ],
        detail: [],
      };
    }
    case "offPage": {
      // Off-page connector: a box with a point at the bottom.
      const a = Math.min(h * 0.3, 20);
      return { outline: poly([[x, y], [x + w, y], [x + w, y + h - a], [x + w / 2, y + h], [x, y + h - a]]), detail: [] };
    }
    case "internalStorage": {
      const b = Math.min(w * 0.15, 12), c = Math.min(h * 0.2, 12);
      return {
        outline: poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]),
        detail: [["M", x + b, y], ["L", x + b, y + h], ["M", x, y + c], ["L", x + w, y + c]],
      };
    }
    case "multiDocument": {
      // Two sheets behind a document, each offset up-right by `o`.
      const o = Math.min(6, w * 0.06, h * 0.08);
      const W = w - 2 * o, a = (h - 2 * o) * 0.1;
      return {
        outline: [
          ["M", x, y + 2 * o], ["L", x + o, y + 2 * o], ["L", x + o, y + o], ["L", x + 2 * o, y + o], ["L", x + 2 * o, y],
          ["L", x + w, y], ["L", x + w, y + h - 2 * o], ["L", x + w - o, y + h - 2 * o], ["L", x + w - o, y + h - o],
          ["L", x + W, y + h - o], ["L", x + W, y + h - a],
          ["C", x + W * 0.6, y + h - a * 3, x + W * 0.4, y + h + a, x, y + h - a],
          ["Z"],
        ],
        detail: [
          ["M", x + 2 * o, y + o], ["L", x + w - o, y + o], ["L", x + w - o, y + h - 2 * o],
          ["M", x + o, y + 2 * o], ["L", x + W, y + 2 * o], ["L", x + W, y + h - o],
        ],
      };
    }
    case "step": {
      // A chevron: a step of a process.
      const s = Math.min(w * 0.25, h * 0.5, 20);
      return { outline: poly([[x, y], [x + w - s, y], [x + w, y + h / 2], [x + w - s, y + h], [x, y + h], [x + s, y + h / 2]]), detail: [] };
    }
    case "arrowRight": {
      const hl = Math.min(w * 0.35, h * 0.9), t = y + h * 0.25, b = y + h * 0.75;
      return { outline: poly([[x, t], [x + w - hl, t], [x + w - hl, y], [x + w, y + h / 2], [x + w - hl, y + h], [x + w - hl, b], [x, b]]), detail: [] };
    }
    case "doubleArrow": {
      const hl = Math.min(w * 0.25, h * 0.9), t = y + h * 0.25, b = y + h * 0.75;
      return {
        outline: poly([
          [x, y + h / 2], [x + hl, y], [x + hl, t], [x + w - hl, t], [x + w - hl, y], [x + w, y + h / 2],
          [x + w - hl, y + h], [x + w - hl, b], [x + hl, b], [x + hl, y + h],
        ]),
        detail: [],
      };
    }
    case "cross": {
      const x1 = x + w / 3, x2 = x + (2 * w) / 3, y1 = y + h / 3, y2 = y + (2 * h) / 3;
      return {
        outline: poly([[x1, y], [x2, y], [x2, y1], [x + w, y1], [x + w, y2], [x2, y2], [x2, y + h], [x1, y + h], [x1, y2], [x, y2], [x, y1], [x1, y1]]),
        detail: [],
      };
    }
    case "star": {
      const cx = x + w / 2, cy = y + h / 2, pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 1 : 0.4, a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([cx + (w / 2) * r * Math.cos(a), cy + (h / 2) * r * Math.sin(a)]);
      }
      return { outline: poly(pts), detail: [] };
    }
    case "octagon": {
      const c = Math.min(w, h) * 0.29;
      return { outline: poly([[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]]), detail: [] };
    }
    case "cube": {
      // A box seen from the front-right: front face plus top and side.
      const d = Math.min(w, h) * 0.18;
      return {
        outline: poly([[x, y + d], [x + d, y], [x + w, y], [x + w, y + h - d], [x + w - d, y + h], [x, y + h]]),
        detail: [["M", x, y + d], ["L", x + w - d, y + d], ["L", x + w, y], ["M", x + w - d, y + d], ["L", x + w - d, y + h]],
      };
    }
    case "callout": {
      // A speech bubble: the box, and a tail at the bottom left.
      const hb = h * 0.8;
      return { outline: poly([[x, y], [x + w, y], [x + w, y + hb], [x + w * 0.45, y + hb], [x + w * 0.22, y + h], [x + w * 0.27, y + hb], [x, y + hb]]), detail: [] };
    }
    case "cloud": {
      const X = (f: number): number => x + w * f, Y = (f: number): number => y + h * f;
      return {
        outline: [
          ["M", X(0.25), Y(0.25)],
          ["C", X(0.05), Y(0.25), X(0), Y(0.5), X(0.16), Y(0.55)],
          ["C", X(0), Y(0.66), X(0.18), Y(0.9), X(0.31), Y(0.8)],
          ["C", X(0.4), Y(1), X(0.7), Y(1), X(0.8), Y(0.8)],
          ["C", X(1), Y(0.8), X(1), Y(0.6), X(0.875), Y(0.5)],
          ["C", X(1), Y(0.3), X(0.8), Y(0.1), X(0.625), Y(0.2)],
          ["C", X(0.5), Y(0.05), X(0.3), Y(0.05), X(0.25), Y(0.25)],
          ["Z"],
        ],
        detail: [],
      };
    }
  }
}

/** A closed polygon through `pts`. */
function poly(pts: [number, number][]): PathCmd[] {
  return [["M", pts[0][0], pts[0][1]], ...pts.slice(1).map(([px, py]): PathCmd => ["L", px, py]), ["Z"]];
}

/** Replay onto a Canvas2D path (the caller begins and fills/strokes it). */
export function tracePath(ctx: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "bezierCurveTo" | "closePath">, cmds: PathCmd[]): void {
  for (const c of cmds) {
    if (c[0] === "M") ctx.moveTo(c[1], c[2]);
    else if (c[0] === "L") ctx.lineTo(c[1], c[2]);
    else if (c[0] === "C") ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else ctx.closePath();
  }
}

/** SVG path data; `fmt` is the exporter's number formatter. */
export function svgPathData(cmds: PathCmd[], fmt: (n: number) => string): string {
  return cmds.map((c) => (c[0] === "Z" ? "Z" : c[0] + c.slice(1).map((n) => fmt(n as number)).join(" "))).join(" ");
}

/** PDF path operators, through the page frame's X/Y mapping. */
export function pdfPathOps(cmds: PathCmd[], X: (n: number) => number, Y: (n: number) => number, fmt: (n: number) => string): string {
  return cmds
    .map((c) => {
      if (c[0] === "M") return `${fmt(X(c[1]))} ${fmt(Y(c[2]))} m`;
      if (c[0] === "L") return `${fmt(X(c[1]))} ${fmt(Y(c[2]))} l`;
      if (c[0] === "C") return `${fmt(X(c[1]))} ${fmt(Y(c[2]))} ${fmt(X(c[3]))} ${fmt(Y(c[4]))} ${fmt(X(c[5]))} ${fmt(Y(c[6]))} c`;
      return "h";
    })
    .join("\n");
}

/** Every outline R-node draws, for pickers that list them. */
export const DIAGRAM_SHAPE_LABELS: Record<DiagramShape, string> = {
  ellipse: "Ellipse",
  cylinder: "Database",
  document: "Document",
  parallelogram: "Data (parallelogram)",
  triangle: "Triangle",
  process: "Process",
  note: "Note",
  actor: "Actor (person)",
  trapezoid: "Manual operation (trapezoid)",
  manualInput: "Manual input",
  delay: "Delay",
  offPage: "Off-page connector",
  internalStorage: "Internal storage",
  multiDocument: "Multiple documents",
  step: "Step (chevron)",
  arrowRight: "Arrow",
  doubleArrow: "Double arrow",
  cross: "Cross",
  star: "Star",
  octagon: "Octagon (stop)",
  cube: "Cube",
  callout: "Callout",
  cloud: "Cloud",
};

/** The share of an actor's box its figure takes; the rest is its name. */
export const ACTOR_FIGURE = 0.72;
