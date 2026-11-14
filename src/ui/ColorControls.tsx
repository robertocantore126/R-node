/**
 * The Inspector's Colours section (draw.io's style panel, in R-node's terms):
 * quick styles that set fill + outline + text together, then fill (with its own
 * transparency), text colour, the whole item's opacity and, on a container,
 * its header band. Everything applies to the whole selection in one undo step.
 *
 * "Auto" hands a colour back to the theme (the branch palette); "None" is a
 * real transparent fill. A colour picker cannot show either, so the swatch
 * says which one is in effect instead of showing a meaningless black.
 */
import { useEffect, useState, type JSX } from "react";
import { useStore } from "../editor/context";
import type { MindNode, Style } from "../core/types";
import { colorAlpha, DIAGRAM_PALETTE, toHex, withAlpha } from "../core/paint";

/** A colour input that can also say "none" or "auto". */
export function ColorSwatch({ value, fallback, onPick, title }: { value: string | undefined; fallback: string; onPick: (hex: string) => void; title: string }): JSX.Element {
  const hex = toHex(value);
  const state = value === undefined ? "auto" : hex === null ? "none" : null;
  return (
    <span className="color-swatch" data-state={state ?? undefined}>
      <input type="color" title={title} aria-label={title} value={hex ?? fallback} onChange={(e) => onPick(e.target.value)} />
      {state && <span className="color-swatch-state">{state}</span>}
    </span>
  );
}

/**
 * A 0..100 slider that previews locally and writes ONE op when released, so a
 * drag is one undo step rather than one per pixel.
 */
function PercentSlider({ value, min, onCommit, title }: { value: number; min: number; onCommit: (v: number) => void; title: string }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => { if (draft !== value) onCommit(draft); };
  return (
    <>
      <input
        type="range" min={min} max={100} step={5} value={draft} title={title} aria-label={title}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit}
      />
      <span className="muted">{draft}%</span>
    </>
  );
}

export function ColorControls({ node, ids }: { node: MindNode; ids: string[] }): JSX.Element {
  const store = useStore();
  const s = node.style;
  const box = s.container;
  const fill = s.fill;
  const fillAlpha = Math.round(colorAlpha(fill) * 100);
  const apply = (patch: Partial<Style> | ((n: MindNode) => Partial<Style>)): void => store.setSelectionStyle(patch, ids);

  return (
    <div className="inspector-section">
      <div
        className="inspector-label"
        data-help="Colours"
        data-help-more="Applies to every selected topic. A quick style sets fill, outline and text together (on a container: its header band and outline)."
      >
        Colours
      </div>
      <div className="color-presets" role="group" aria-label="Quick styles">
        {DIAGRAM_PALETTE.map((p) => (
          <button
            key={p.name}
            className="color-preset"
            title={p.name}
            aria-label={`${p.name} style`}
            style={{ background: p.fill, borderColor: p.stroke, color: p.text }}
            onClick={() => apply((n) => n.style.container
              ? { container: { ...n.style.container, headerFill: p.fill }, stroke: p.stroke, textColor: p.text }
              : { fill: p.fill, stroke: p.stroke, textColor: p.text, borderWidth: n.style.borderWidth || 1 })}
          >
            Aa
          </button>
        ))}
        <button
          className="color-preset color-preset-clear"
          title="Clear: back to the theme's colours"
          aria-label="Clear colours"
          onClick={() => apply((n) => n.style.container
            ? { container: { ...n.style.container, headerFill: "transparent" }, stroke: undefined, textColor: undefined }
            : { fill: undefined, stroke: undefined, textColor: undefined })}
        >
          ⌀
        </button>
      </div>

      <div className="field">
        <span>Fill</span>
        <ColorSwatch value={fill} fallback="#dae8fc" title="Fill colour" onPick={(hex) => apply({ fill: withAlpha(hex, fillAlpha > 0 && fill !== undefined ? fillAlpha / 100 : 1) })} />
        <button className="btn small" title="No fill: see-through" aria-pressed={fill !== undefined && toHex(fill) === null} onClick={() => apply({ fill: "transparent" })}>None</button>
        <button className="btn small" title="The theme's colour for this branch" aria-pressed={fill === undefined} onClick={() => apply({ fill: undefined })}>Auto</button>
      </div>
      {toHex(fill) && (
        <div className="field">
          <span>Fill opacity</span>
          <PercentSlider value={fillAlpha} min={5} title="Fill opacity (the outline and text stay solid)" onCommit={(v) => apply({ fill: withAlpha(fill!, v / 100) })} />
        </div>
      )}
      <div className="field">
        <span>Text</span>
        <ColorSwatch value={s.textColor} fallback="#1a1a1a" title="Text colour" onPick={(hex) => apply({ textColor: hex })} />
        <button className="btn small" title="The theme's text colour" aria-pressed={s.textColor === undefined} onClick={() => apply({ textColor: undefined })}>Auto</button>
      </div>
      {box && (
        <div className="field">
          <span>Header</span>
          <ColorSwatch value={box.headerFill} fallback="#dae8fc" title="Header band colour" onPick={(hex) => apply((n) => (n.style.container ? { container: { ...n.style.container, headerFill: hex } } : {}))} />
          <button className="btn small" title="No header colour, only the line under the title" onClick={() => apply((n) => (n.style.container ? { container: { ...n.style.container, headerFill: "transparent" } } : {}))}>None</button>
        </div>
      )}
      <div className="field">
        <span>Opacity</span>
        <PercentSlider value={Math.round((s.opacity ?? 1) * 100)} min={10} title="The whole item's opacity" onCommit={(v) => apply({ opacity: v >= 100 ? undefined : v / 100 })} />
      </div>
    </div>
  );
}
