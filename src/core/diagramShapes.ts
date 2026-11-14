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

export const DIAGRAM_SHAPES = ["ellipse", "cylinder", "document", "parallelogram", "triangle", "process", "note"] as const;
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
    case "note": {
      const f = Math.min(16, w * 0.3, h * 0.3);
      return {
        outline: [["M", x, y], ["L", x + w - f, y], ["L", x + w, y + f], ["L", x + w, y + h], ["L", x, y + h], ["Z"]],
        detail: [["M", x + w - f, y], ["L", x + w - f, y + f], ["L", x + w, y + f]],
      };
    }
  }
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
};
