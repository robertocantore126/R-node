/**
 * Design tokens for the canvas renderer.
 * The same palette drives the CSS chrome (see styles.css) so light/dark
 * switching stays coherent.
 */
export type ThemeName = "light" | "dark";

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
  branchSoft: string[]; // lighter fills for descendants of each main branch
  connector: string;
  collapsedBadge: string;
  collapsedBadgeText: string;
  nodeBorder: string;
  shadow: string;
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
    connector: "#9aa3b2",
    collapsedBadge: "#e5e7eb",
    collapsedBadgeText: "#374151",
    nodeBorder: "rgba(0,0,0,0.06)",
    shadow: "rgba(28,35,51,0.14)",
  },
  dark: {
    name: "dark",
    background: "#11141c",
    grid: "#1d2230",
    text: "#e6e9f0",
    textMuted: "#8b93a7",
    selection: "#818cf8",
    selectionFill: "rgba(129, 140, 248, 0.14)",
    dropIndicator: "#818cf8",
    rootFill: "#6366f1",
    rootText: "#ffffff",
    branch: ["#60a5fa", "#a78bfa", "#f472b6", "#fb923c", "#4ade80", "#22d3ee", "#facc15", "#2dd4bf"],
    branchSoft: ["#1e3a5f", "#4a2f1e", "#17404a", "#17453f", "#21452e", "#45224c", "#1f3f5b", "#4b3b1a"],
    connector: "#39415a",
    collapsedBadge: "#2a3145",
    collapsedBadgeText: "#aeb6c8",
    nodeBorder: "rgba(255,255,255,0.08)",
    shadow: "rgba(0,0,0,0.4)",
  },
};
