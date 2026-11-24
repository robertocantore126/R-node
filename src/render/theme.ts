/**
 * Design tokens for the canvas renderer.
 * The same palette drives the CSS chrome (see styles.css) so every theme
 * stays coherent everywhere. `light` is the default; `dark` and `vanilla`
 * (warm paper) are alternatives the user picks from the TopBar.
 */
import type { CodePalette } from "../core/codeHighlight";

export type ThemeName = "light" | "dark" | "vanilla" | "matte" | "fog" | "xmind";

/** Cycle order of the theme button. Matte first: it is the default. */
export const THEME_ORDER: ThemeName[] = ["matte", "light", "dark", "vanilla", "fog", "xmind"];

/** Coerce an arbitrary stored value to a known theme (unknown -> matte). */
export function asThemeName(value: unknown): ThemeName {
  return value === "light" || value === "dark" || value === "vanilla" || value === "fog" || value === "xmind" ? value : "matte";
}

export type GridPattern = "lines" | "dots" | "graph" | "fine" | "none";

/** Coerce a stored value to a pattern; anything unknown means "theme default". */
export function asGridPattern(value: unknown): GridPattern | undefined {
  return value === "lines" || value === "dots" || value === "graph" || value === "fine" || value === "none" ? value : undefined;
}

/** What a theme draws when the document picked no pattern. */
export function defaultGridPattern(theme: RenderTheme): GridPattern {
  return theme.defaultGrid ?? (theme.noGrid ? "none" : "lines");
}

/**
 * Ink for background marks, derived from the background itself: black on a
 * light or mid canvas, white on a dark one, at a low alpha. A fixed theme grid
 * colour is wrong as soon as the user picks their own background (a light grey
 * line on a mid grey reads as a scratch, not as paper).
 */
export function gridInk(background: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(background.trim());
  const n = m ? parseInt(m[1], 16) : 0xf3f4f6;
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum >= 0.4 ? `rgba(0,0,0,${alpha.toFixed(3)})` : `rgba(255,255,255,${(alpha * 0.8).toFixed(3)})`;
}

export interface RenderTheme {
  name: ThemeName;
  background: string;
  grid: string;
  /** Solid matte canvas: skip drawing the dot grid pattern. */
  noGrid?: boolean;
  /** The pattern a document gets when it picked none (overrides noGrid). */
  defaultGrid?: GridPattern;
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
  /** Default fill for a freeform canvas (falls back to `background` when unset). */
  freeformFill?: string;
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
  /** Every topic below the main ones wears its branch's soft tint (no
   *  accent strip, no white deep levels), as XMind draws them. */
  tintedTopics?: boolean;
  /** Main-topic text picks dark or white for contrast with its fill, instead
   *  of the theme text colour (white on XMind's vivid branch colours). */
  contrastMainText?: boolean;
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
 * The vignette behind a transparent canvas, derived from the theme's own
 * background so its middle stop IS the background. Hand-picked stops ran from
 * +15 to -20 levels on Matte: the corners looked dirty and the canvas no longer
 * matched the colour the theme (and the exports) say it has. This keeps the
 * whole swing within a few percent, felt rather than seen.
 */
export function vignetteFor(background: string): string {
  return `radial-gradient(ellipse farthest-corner at 50% 50%, ${lighten(background, 0.025)} 0%, ${background} 55%, ${darken(background, 0.045)} 100%)`;
}

/** Mix a `#rrggbb` colour toward black by `t` (0..1). */
export function darken(hex: string, t: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c * (1 - t));
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
    background: "#f3f4f6",
    grid: "#cfd5de",
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
    grid: "#262e3d",
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
    grid: "#d7cbb2",
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
  matte: {
    name: "matte",
    background: "#878787",
    grid: "transparent",
    noGrid: true,
    defaultGrid: "dots",
    text: "#13131f",
    textMuted: "#3d3b48",
    selection: "#4f46e5",
    selectionFill: "rgba(79, 70, 229, 0.14)",
    dropIndicator: "#4f46e5",
    searchMatch: "#f59e0b",
    searchMatchActive: "#d97706",
    rootFill: "#f8f8fa",
    rootText: "#13131f",
    freeformFill: "#f5f5f7",
    branch: ["#ff646b", "#ff9a66", "#4eb5e8", "#55c9bd", "#a7d9bb", "#d979e5", "#70b9e8", "#f0bd62"],
    branchSoft: ["#ffdfe1", "#ffe8dc", "#dff4ff", "#dff8f5", "#e5f6ec", "#f6e1f9", "#deeffb", "#fff0d3"],
    deepFill: "#f8f8fa",
    code: {
      id: "matte",
      plain: "#13131f",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#545261",
      fn: "#6c68c9",
      punct: "#57606a",
    },
    codeBg: "#f5f5f8",
    codeBar: "#e2e1e6",
    connector: "#3d3b48",
    collapsedBadge: "#c2c1c7",
    collapsedBadgeText: "#13131f",
    nodeBorder: "rgba(19,19,31,0.12)",
    shadow: "rgba(19,19,31,0.22)",
  },
  /**
   * Fog: a soft grey-white at ~77% brightness (Light is ~96%, Matte ~53%) on
   * graph paper. Topic fills are pulled off pure white so no box glares
   * against the dimmer canvas.
   */
  fog: {
    name: "fog",
    background: "#c4c3be",
    grid: "rgba(0,0,0,0.1)",
    defaultGrid: "graph",
    text: "#1d1e24",
    textMuted: "#4f515a",
    selection: "#4f46e5",
    selectionFill: "rgba(79, 70, 229, 0.12)",
    dropIndicator: "#4f46e5",
    searchMatch: "#d97706",
    searchMatchActive: "#b45309",
    rootFill: "#ecebe6",
    rootText: "#1d1e24",
    freeformFill: "#e6e5e0",
    branch: ["#f2575e", "#f58a55", "#3fa6da", "#45b8ac", "#8fc9a6", "#c96ad6", "#5fa9d9", "#e2ad50"],
    branchSoft: ["#f6d6d7", "#f6e0d4", "#d6eaf4", "#d6eeeb", "#dcebe2", "#ecd8ef", "#d6e6f1", "#f3e6cc"],
    deepFill: "#ecebe6",
    code: {
      id: "fog",
      plain: "#24292f",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#5f6670",
      fn: "#8250df",
      punct: "#57606a",
    },
    codeBg: "#efeeea",
    codeBar: "#dddcd6",
    connector: "#6f7280",
    collapsedBadge: "#d6d5cf",
    collapsedBadgeText: "#2c2e36",
    nodeBorder: "rgba(0,0,0,0.08)",
    shadow: "rgba(30,30,36,0.16)",
  },
  /**
   * XMind: white paper with no grid, a navy-black root, XMind's own branch
   * colours (from its default theme: F9423A F6A04D F3D321 00BC7B 486AFF
   * 4D49BE, plus a cyan and a pink to fill the eight slots), white text on
   * the main topics and every deeper topic in a 20% tint of its branch.
   */
  xmind: {
    name: "xmind",
    background: "#ffffff",
    grid: "rgba(0,0,0,0.06)",
    noGrid: true,
    defaultGrid: "none",
    text: "#1f2133",
    textMuted: "#6b6e80",
    selection: "#486aff",
    selectionFill: "rgba(72, 106, 255, 0.12)",
    dropIndicator: "#486aff",
    searchMatch: "#f6a04d",
    searchMatchActive: "#f9423a",
    rootFill: "#000229",
    // Used when the root has no box (on the white paper); a boxed root gets
    // white on its navy fill through contrastMainText.
    rootText: "#000229",
    freeformFill: "#fafafc",
    branch: ["#f9423a", "#f6a04d", "#f3d321", "#00bc7b", "#486aff", "#4d49be", "#00b4d8", "#ff5fa2"],
    branchSoft: ["#fed9d8", "#fdecdb", "#fdf6d3", "#ccf2e5", "#dae1ff", "#dbdbf2", "#ccf0f7", "#ffdfec"],
    deepFill: "#ffffff",
    code: {
      id: "xmind",
      plain: "#1f2133",
      keyword: "#d1242f",
      string: "#0a3069",
      number: "#0550ae",
      comment: "#6b6e80",
      fn: "#4d49be",
      punct: "#57606a",
    },
    codeBg: "#f6f7fb",
    codeBar: "#eceef5",
    connector: "#8a8ea0",
    collapsedBadge: "#eceef5",
    collapsedBadgeText: "#1f2133",
    nodeBorder: "rgba(0,2,41,0.08)",
    shadow: "rgba(0,2,41,0.12)",
    tintedTopics: true,
    contrastMainText: true,
  },
};

/**
 * Whether a run colour is a theme's text leaking into the document rather than
 * a choice: a near-white or near-black grey with no hue. Text copied off a dark
 * page (this editor's `#e6e8ee`, another site's `#e7ebf1`) carries that
 * colour, and stored as a run colour it stays near-white after the map goes
 * back to light. Such a grey reads on only one kind of background, so the
 * theme should decide: text with no colour follows it.
 *
 * Pure white and pure black are kept: they are what a person picks on purpose,
 * e.g. white on a vivid fill. Anything with a hue passes.
 */
export function isThemeDependentColor(color: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return false;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1].slice(0, 6);
  if (h === "ffffff" || h === "000000") return false;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (Math.max(r, g, b) - Math.min(r, g, b) > 32) return false;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum >= 150 || lum <= 70;
}
