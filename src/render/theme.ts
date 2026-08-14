/**
 * Design tokens for the canvas renderer.
 * The same palette drives the CSS chrome (see styles.css) so the light
 * theme stays coherent everywhere. (Dark theme was intentionally removed.)
 */
export type ThemeName = "light";

export interface RenderTheme {
  name: ThemeName;
  background: string;
  grid: string;
  text: string;
  textMuted: string;
  selection: string;
  selectionFill: string;
  dropIndicator: string;
  rootFill: string;
  rootText: string;
  branch: string[]; // branch palette, rotated by main-branch index
  branchSoft: string[]; // lighter fills for the children of each main branch
  deepFill: string; // depth 3+: everything below a branch's children (white in light)
  connector: string;
  collapsedBadge: string;
  collapsedBadgeText: string;
  nodeBorder: string;
  shadow: string;
}

/**
 * Mix a `#rrggbb` colour toward white by `t` (0..1). Used to derive the child
 * shades of an explicitly-coloured node, so a branch the user painted keeps
 * its hue down the tree instead of falling back to the palette. Anything that
 * is not a 6-digit hex colour passes through unchanged.
 */
export function lighten(hex: string, t: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
}

export const THEMES: Record<ThemeName, RenderTheme> = {
  light: {
    name: "light",
    background: "#ffffff",
    grid: "#f5f7fa",
    text: "#111827",
    textMuted: "#6b7280",
    selection: "#4f46e5",
    selectionFill: "rgba(79, 70, 229, 0.10)",
    dropIndicator: "#4f46e5",
    rootFill: "#ffffff",
    rootText: "#111827",
    branch: ["#ff646b", "#ff9a66", "#4eb5e8", "#55c9bd", "#a7d9bb", "#d979e5", "#70b9e8", "#f0bd62"],
    branchSoft: ["#ffdfe1", "#ffe8dc", "#dff4ff", "#dff8f5", "#e5f6ec", "#f6e1f9", "#deeffb", "#fff0d3"],
    deepFill: "#ffffff",
    connector: "#9aa3b2",
    collapsedBadge: "#e5e7eb",
    collapsedBadgeText: "#374151",
    nodeBorder: "rgba(0,0,0,0.06)",
    shadow: "rgba(28,35,51,0.14)",
  },
};
// Dark theme intentionally removed — the app is light-only.
