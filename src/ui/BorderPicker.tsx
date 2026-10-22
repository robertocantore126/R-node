/**
 * Outline controls: line style, thickness, colour. One component for the two
 * things that have an outline — a topic (Inspector + right-click menu) and a
 * group boundary — so the two offer the same vocabulary and cannot drift into
 * two pickers that disagree about what "dotted" looks like.
 *
 * It holds no state and knows nothing about the store: it shows `value` and
 * reports a patch. `undefined` in a patch means "back to the default", which
 * is how the callers' resets work.
 */
import { BORDER_STYLES, borderDash, type BorderStyle } from "../core/types";
import { THEMES } from "../render/theme";

export interface BorderValue {
  color?: string;
  width?: number;
  style?: BorderStyle;
}

interface Props {
  value: BorderValue;
  /** Thickness used when `value.width` is absent — shown as selected. */
  defaultWidth: number;
  /** Line style used when `value.style` is absent — shown as selected. */
  defaultStyle: BorderStyle;
  widths: number[];
  styles?: BorderStyle[];
  /** Colour token meaning "follow the branch" — offered as its own swatch. */
  branchToken?: string;
  onChange: (patch: BorderValue) => void;
  onReset: () => void;
}

const STYLE_NAMES: Record<BorderStyle, string> = {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  dashdot: "Dash-dot",
  double: "Double",
  none: "No outline",
};

/** A short sample of the line, drawn with the same dash rule as the canvas. */
function StyleSample({ style }: { style: BorderStyle }): JSX.Element {
  if (style === "none") {
    return (
      <svg width="30" height="12" viewBox="0 0 30 12" aria-hidden>
        <line x1="4" y1="10" x2="26" y2="2" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
      </svg>
    );
  }
  const w = 2;
  const { dash, cap } = borderDash(style, w);
  if (style === "double") {
    return (
      <svg width="30" height="12" viewBox="0 0 30 12" aria-hidden>
        <line x1="2" y1="4" x2="28" y2="4" stroke="currentColor" strokeWidth="1.2" />
        <line x1="2" y1="8" x2="28" y2="8" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  return (
    <svg width="30" height="12" viewBox="0 0 30 12" aria-hidden>
      <line x1="3" y1="6" x2="27" y2="6" stroke="currentColor" strokeWidth={w} strokeDasharray={dash.join(" ") || undefined} strokeLinecap={cap} />
    </svg>
  );
}

export function BorderPicker({ value, defaultWidth, defaultStyle, widths, styles = BORDER_STYLES, branchToken, onChange, onReset }: Props): JSX.Element {
  const style = value.style ?? defaultStyle;
  const width = value.width ?? defaultWidth;
  // A width from a document need not be a preset: show it as its own chip so
  // the row never pretends a different thickness is selected.
  const shownWidths = widths.includes(width) ? widths : [...widths, width].sort((a, b) => a - b);
  const off = style === "none";
  return (
    <div className="border-picker">
      <div className="border-row" role="radiogroup" aria-label="Line style">
        {styles.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={style === s}
            className={`border-chip${style === s ? " active" : ""}`}
            title={STYLE_NAMES[s]}
            onClick={() => onChange({ style: s })}
          >
            <StyleSample style={s} />
          </button>
        ))}
      </div>
      <div className="border-row" role="radiogroup" aria-label="Thickness">
        {shownWidths.map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={width === w}
            disabled={off}
            className={`border-chip width${width === w ? " active" : ""}`}
            title={`${w} px`}
            onClick={() => onChange({ width: w })}
          >
            <span className="border-width-bar" style={{ height: Math.min(w, 8) }} />
          </button>
        ))}
      </div>
      <div className="border-row colors">
        {branchToken && (
          <button
            type="button"
            className={`ctx-swatch border-branch${value.color === branchToken || (value.color === undefined && (value.width !== undefined || value.style !== undefined)) ? " active" : ""}`}
            title="Branch colour (follows the theme)"
            disabled={off}
            onClick={() => onChange({ color: branchToken })}
          />
        )}
        {THEMES.light.branch.map((c) => (
          <button
            key={c}
            type="button"
            className={`ctx-swatch${value.color === c ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            disabled={off}
            onClick={() => onChange({ color: c })}
          />
        ))}
        <input
          type="color"
          className="ctx-color"
          title="Custom colour"
          disabled={off}
          value={value.color && value.color.startsWith("#") ? value.color : "#4f46e5"}
          onChange={(e) => onChange({ color: e.target.value })}
        />
        <button type="button" className="ctx-reset" onClick={onReset} title="Back to the default outline">
          Reset
        </button>
      </div>
    </div>
  );
}
