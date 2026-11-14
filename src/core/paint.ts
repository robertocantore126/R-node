/**
 * Colour values as R-node stores them: "#rgb", "#rrggbb", "rgb()/rgba()",
 * "transparent", or absent (the theme decides). Semi-transparent colours are
 * written as rgba(), the one form every painter reads: Canvas2D, SVG, and the
 * PDF exporter (which turns its alpha into an ExtGState).
 */

export interface Rgba { r: number; g: number; b: number; a: number }

export function parseColor(color: string | undefined): Rgba | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  if (c === "transparent" || c === "none") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) {
    const [r, g, b] = m[1].split("").map((h) => parseInt(h + h, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  const f = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (f) {
    const alpha = f[4] === undefined ? 1 : f[4].endsWith("%") ? Number(f[4].slice(0, -1)) / 100 : Number(f[4]);
    return { r: Number(f[1]), g: Number(f[2]), b: Number(f[3]), a: Math.max(0, Math.min(1, alpha)) };
  }
  return null;
}

const hex2 = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** "#rrggbb" for an <input type="color">, or null for no colour / transparent / unreadable. */
export function toHex(color: string | undefined): string | null {
  const p = parseColor(color);
  return p && p.a > 0 ? `#${hex2(p.r)}${hex2(p.g)}${hex2(p.b)}` : null;
}

/** The alpha of a colour, 1 when it has none. */
export function colorAlpha(color: string | undefined): number {
  return parseColor(color)?.a ?? 1;
}

/** The same colour at `alpha`: plain hex when opaque, rgba() otherwise. */
export function withAlpha(color: string, alpha: number): string {
  const p = parseColor(color);
  if (!p) return color;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 100) / 100;
  if (a >= 1) return `#${hex2(p.r)}${hex2(p.g)}${hex2(p.b)}`;
  return `rgba(${Math.round(p.r)}, ${Math.round(p.g)}, ${Math.round(p.b)}, ${a})`;
}

/**
 * draw.io's quick styles: a light fill, the darker outline that goes with it,
 * and dark text, so a diagram reads on light and dark themes alike.
 */
export const DIAGRAM_PALETTE: { name: string; fill: string; stroke: string; text: string }[] = [
  { name: "Blue", fill: "#dae8fc", stroke: "#6c8ebf", text: "#1a1a1a" },
  { name: "Green", fill: "#d5e8d4", stroke: "#82b366", text: "#1a1a1a" },
  { name: "Orange", fill: "#ffe6cc", stroke: "#d79b00", text: "#1a1a1a" },
  { name: "Yellow", fill: "#fff2cc", stroke: "#d6b656", text: "#1a1a1a" },
  { name: "Red", fill: "#f8cecc", stroke: "#b85450", text: "#1a1a1a" },
  { name: "Purple", fill: "#e1d5e7", stroke: "#9673a6", text: "#1a1a1a" },
  { name: "Grey", fill: "#f5f5f5", stroke: "#666666", text: "#333333" },
  { name: "White", fill: "#ffffff", stroke: "#000000", text: "#000000" },
  { name: "Dark", fill: "#333333", stroke: "#000000", text: "#ffffff" },
];
