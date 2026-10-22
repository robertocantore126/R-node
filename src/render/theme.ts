/**
 * Design tokens for the canvas renderer.
 * The same palette drives the CSS chrome (see styles.css) so every theme
 * stays coherent everywhere. `light` is the default; `dark` and `vanilla`
 * (warm paper) are alternatives the user picks from the TopBar.
 */
import type { CodePalette } from "../core/codeHighlight";

export type ThemeName = "light" | "dark" | "vanilla";

/** Cycle order of the theme button. Light first: it is the default. */
export const THEME_ORDER: ThemeName[] = ["light", "dark", "vanilla"];

/** Coerce an arbitrary stored value to a known theme (unknown -> light). */
export function asThemeName(value: unknown): ThemeName {
  return value === "dark" || value === "vanilla" ? value : "light";
}

export interface RenderTheme {
  name: ThemeName;
  background: string;
  grid: string;
  text: string;
  textMuted: string;
  selection: string;
  selectionFill: string;
  dropIndicator: string;
  /** In-map search (Ctrl+F): dashed ring for every match, solid for the current. */
  searchMatch: string;
  searchMatchActive: string;
  rootFill: string;
  rootText: string;
  branch: string[]; // branch palette, rotated by main-branch index
  branchSoft: string[]; // lighter fills for the children of each main branch
  deepFill: string; // depth 3+: everything below a branch's children (white in light)
  /** Colours the tokenizer lends to code (T22). The palette id must differ
   *  between themes: the tokenizer's cache is keyed on it, and two themes
   *  sharing an id would serve one theme's colours to the other. */
  code: CodePalette;
  /** The surface a code block is painted on, and its title strip (T22). */
  codeBg: string;
  codeBar: string;
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

/**
 * Near-black or white, whichever reads on `color` (a hex, rgb() or rgba()).
 * For text drawn on a surface the user coloured — a group's title tab — where
 * no theme colour is guaranteed to contrast.
 */
export function readableOn(color: string): string {
  let r = 128, g = 128, b = 128;
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else if (fn) {
    r = Number(fn[1]); g = Number(fn[2]); b = Number(fn[3]);
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#1a1a1a" : "#ffffff";
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
    searchMatch: "#f59e0b",
    searchMatchActive: "#d97706",
    rootFill: "#ffffff",
    rootText: "#111827",
    branch: ["#ff646b", "#ff9a66", "#4eb5e8", "#55c9bd", "#a7d9bb", "#d979e5", "#70b9e8", "#f0bd62"],
    branchSoft: ["#ffdfe1", "#ffe8dc", "#dff4ff", "#dff8f5", "#e5f6ec", "#f6e1f9", "#deeffb", "#fff0d3"],
    deepFill: "#ffffff",
    code: {
      id: "light",
      plain: "#24292f",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#6e7781",
      fn: "#8250df",
      punct: "#57606a",
    },
    codeBg: "#f6f8fa",
    codeBar: "#eaeef2",
    connector: "#9aa3b2",
    collapsedBadge: "#e5e7eb",
    collapsedBadgeText: "#374151",
    nodeBorder: "rgba(0,0,0,0.06)",
    shadow: "rgba(28,35,51,0.14)",
  },
  dark: {
    name: "dark",
    background: "#0f1319",
    grid: "#1a1f29",
    text: "#e6e8ee",
    textMuted: "#9aa3b2",
    selection: "#6366f1",
    selectionFill: "rgba(99, 102, 241, 0.18)",
    dropIndicator: "#6366f1",
    searchMatch: "#fbbf24",
    searchMatchActive: "#f59e0b",
    rootFill: "#1b2029",
    rootText: "#f5f6fa",
    // The vivid branch palette is shared with the light theme on purpose:
    // stored colours and the user's mental model of a branch stay the same
    // when the theme changes. Only the soft step differs, so the children
    // keep their hue without turning into unreadable pale slabs.
    branch: ["#ff646b", "#ff9a66", "#4eb5e8", "#55c9bd", "#a7d9bb", "#d979e5", "#70b9e8", "#f0bd62"],
    branchSoft: ["#4a2a2d", "#463226", "#1e3a4d", "#1f3f3d", "#25352b", "#3f2a45", "#233a4a", "#4a3d20"],
    deepFill: "#171b22",
    code: {
      id: "dark",
      plain: "#e6edf3",
      keyword: "#ff7b72",
      string: "#a5d6ff",
      number: "#79c0ff",
      comment: "#8b949e",
      fn: "#d2a8ff",
      punct: "#8b949e",
    },
    codeBg: "#161b22",
    codeBar: "#21262d",
    connector: "#5b6472",
    collapsedBadge: "#2a303a",
    collapsedBadgeText: "#c9d1d9",
    nodeBorder: "rgba(255,255,255,0.10)",
    shadow: "rgba(0,0,0,0.55)",
  },
  vanilla: {
    name: "vanilla",
    background: "#f7f1e3",
    grid: "#efe4cf",
    text: "#3b2f24",
    textMuted: "#8a7358",
    selection: "#b45309",
    selectionFill: "rgba(180, 83, 9, 0.12)",
    dropIndicator: "#b45309",
    searchMatch: "#d97706",
    searchMatchActive: "#b45309",
    rootFill: "#fffaf0",
    rootText: "#3b2f24",
    branch: ["#ff646b", "#ff9a66", "#4eb5e8", "#55c9bd", "#a7d9bb", "#d979e5", "#70b9e8", "#f0bd62"],
    branchSoft: ["#ffdfe1", "#ffe8dc", "#dff4ff", "#dff8f5", "#e5f6ec", "#f6e1f9", "#deeffb", "#fff0d3"],
    deepFill: "#fffaf0",
    code: {
      id: "vanilla",
      plain: "#3b2f24",
      keyword: "#9a3412",
      string: "#166534",
      number: "#92400e",
      comment: "#8a7358",
      fn: "#7c2d12",
      punct: "#6b5842",
    },
    codeBg: "#efe4cf",
    codeBar: "#e6d8bd",
    connector: "#b8a68c",
    collapsedBadge: "#e6d8bd",
    collapsedBadgeText: "#5b4a37",
    nodeBorder: "rgba(91,74,55,0.14)",
    shadow: "rgba(91,74,55,0.22)",
  },
};
