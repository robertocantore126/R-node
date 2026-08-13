/**
 * Export self-audit — what an exporter drew, what it SKIPPED, and what looks
 * wrong by its own thresholds.
 *
 * Not a tracer. A tracer records what happened over time; this answers one
 * question about one file: is this export honest, and would anyone be able to
 * read it? Every field here exists because something got past us tonight:
 *
 *   - A PDF came out completely blank. Its structure was flawless — valid
 *     xref, correct offsets, right MediaBox — and only the payload was
 *     undecodable, so every check we ran passed. `selfCheck` re-reads the
 *     bytes the exporter just produced.
 *   - The text was unreadable at 0.43pt. Nothing computed that number; it fell
 *     out of a scale nobody looked at. `warnings` compares derived quantities
 *     against thresholds instead of hoping someone notices.
 *   - The SVG stalled at 64,743 elements, and the map's fidelity gap — no
 *     relationships, no groups, no summaries, six style properties ignored —
 *     was found by a person reading the repo and comparing it to the renderer.
 *     `coverage` makes the exporter declare its own gaps.
 *
 * Written to `.trace/export-latest.json` through the same dev-server sink as
 * the session tracer, so whoever is investigating reads it instead of asking.
 */
import type { Sheet } from "../core/types";

/** Style properties the RENDERER honours. An exporter that ignores one of
 *  these is lossy, and has to say so rather than look complete. */
export const RENDERED_STYLE_PROPS = [
  "fill", "stroke", "borderWidth", "borderStyle", "cornerRadius", "shape",
  "textColor", "fontSize", "fontWeight", "fontFamily", "italic", "underline",
  "strikethrough", "opacity", "shadow", "icon", "image", "imageWidth",
  "align", "width", "height", "rotation",
] as const;

export type StyleProp = (typeof RENDERED_STYLE_PROPS)[number];

export interface ExportReport {
  format: "svg" | "pdf";
  at: string;
  ms: number;
  bytes: number;
  /** Emitted vs present, per element kind. Present-but-not-emitted is the
   *  fidelity gap, stated by the exporter instead of discovered by a reader. */
  coverage: Record<string, { present: number; emitted: number }>;
  /** Style properties USED by this document that the exporter ignores. */
  styleGaps: { prop: StyleProp; nodes: number }[];
  /** Whatever the format counts as its unit of work (elements, operators). */
  units: Record<string, number>;
  /** Threshold breaches, most severe first. Empty is the goal. */
  warnings: string[];
  /** Did the output survive being read back? null = not attempted. */
  selfCheck: { ok: boolean; detail: string } | null;
}

/** Style properties that appear on at least one node, with counts. */
export function styleUsage(sheet: Sheet): Map<StyleProp, number> {
  const used = new Map<StyleProp, number>();
  for (const n of Object.values(sheet.nodes)) {
    const s = n.style as unknown as Record<string, unknown>;
    for (const p of RENDERED_STYLE_PROPS) {
      const v = s[p];
      if (v === undefined || v === null || v === false) continue;
      used.set(p, (used.get(p) ?? 0) + 1);
    }
  }
  return used;
}

/**
 * Assemble the report.
 *
 * `honoured` is what the exporter claims to reproduce; everything else that
 * the document actually uses becomes a declared gap. Claiming is deliberate:
 * an exporter cannot detect its own omissions, so it has to list what it
 * covers and let the difference be computed.
 */
export function buildReport(args: {
  format: "svg" | "pdf";
  sheet: Sheet;
  ms: number;
  bytes: number;
  emitted: Record<string, number>;
  honoured: readonly StyleProp[];
  units: Record<string, number>;
  /** Smallest text size in the output, in the unit a viewer will see. */
  minEffectiveFontPt?: number;
  selfCheck?: { ok: boolean; detail: string } | null;
}): ExportReport {
  const { sheet, emitted } = args;
  const present: Record<string, number> = {
    nodes: Object.keys(sheet.nodes).length,
    relationships: sheet.relationships.length,
    boundaries: sheet.boundaries.length,
    summaries: sheet.summaries.length,
    images: new Set(Object.values(sheet.nodes).map((n) => n.style.image).filter(Boolean)).size,
  };
  const coverage: ExportReport["coverage"] = {};
  for (const k of new Set([...Object.keys(present), ...Object.keys(emitted)])) {
    coverage[k] = { present: present[k] ?? 0, emitted: emitted[k] ?? 0 };
  }

  const honoured = new Set<string>(args.honoured);
  const styleGaps = [...styleUsage(sheet)]
    .filter(([p]) => !honoured.has(p))
    .map(([prop, nodes]) => ({ prop, nodes }))
    .sort((a, b) => b.nodes - a.nodes);

  const warnings: string[] = [];
  for (const [kind, c] of Object.entries(coverage)) {
    if (c.present > 0 && c.emitted === 0) warnings.push(`${kind}: ${c.present} present, NONE emitted`);
    else if (c.emitted < c.present) warnings.push(`${kind}: ${c.emitted} of ${c.present} emitted`);
  }
  // 4pt is roughly where a viewer at 100% stops rendering glyphs anyone can
  // read. This must be fed the PESSIMISTIC size — what a viewer draws with no
  // help from any optional feature. Fed the optimistic one, this check reported
  // "no warnings" for a PDF whose text arrived on screen at 0.37pt, because a
  // /UserUnit multiplier that Chrome ignores had been folded into it. A gate
  // that assumes its way past the failure is worse than no gate: it converts an
  // open question into a false all-clear.
  if (args.minEffectiveFontPt !== undefined && args.minEffectiveFontPt < 4) {
    warnings.push(
      `text down to ${args.minEffectiveFontPt.toFixed(2)}pt — unreadable, and viewers cap their zoom`
    );
  }
  // Past ~10,000 nodes an SVG viewer builds a DOM tree it cannot pan smoothly.
  const elements = args.units.elements ?? 0;
  if (elements > 10_000) {
    warnings.push(`${elements.toLocaleString()} DOM elements — viewers stall past ~10,000`);
  }
  const imgBytes = args.units.imageBytes ?? 0;
  if (args.bytes > 0 && imgBytes / args.bytes > 0.7) {
    warnings.push(`${Math.round((imgBytes / args.bytes) * 100)}% of the file is embedded image data`);
  }
  if (styleGaps.length > 0) {
    warnings.push(`style ignored: ${styleGaps.map((g) => `${g.prop}(${g.nodes})`).join(", ")}`);
  }

  return {
    format: args.format,
    at: new Date().toISOString(),
    ms: Math.round(args.ms),
    bytes: args.bytes,
    coverage,
    styleGaps,
    units: args.units,
    warnings,
    selfCheck: args.selfCheck ?? null,
  };
}

/**
 * Send the report to `.trace/export-latest.json`. Silent when there is no sink
 * — a production build, or the dev server gone — because an export must never
 * fail over its own diagnostics.
 */
export async function publishReport(report: ExportReport): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    await fetch("/__trace?name=export-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report, null, 2),
    });
  } catch {
    /* no sink: the report still went to the console */
  }
}
