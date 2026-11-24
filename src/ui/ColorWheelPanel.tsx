/**
 * Compact interactive color wheel panel displayed beside NodeContextMenu.
 *
 * Mirrors the classic wheel + outer lightness ring + harmony dots layout:
 * - Inner disc: Hue (angle) & Saturation (radius)
 * - Outer ring: Lightness (top = dark, right = vivid, bottom = pale)
 * - Harmony strip: Analogous / Complementary / Triadic / Split swatches
 * - Hex input + Random color button
 *
 * Pure CSS gradients + pointer capture (no extra canvas allocation). Dragging
 * updates the wheel live at 60fps and commits once on pointerup so every drag
 * is a single undo step and does not flood the Recent colours strip.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { readableOn } from "../render/theme";

export type HarmonyMode = "analogous" | "complementary" | "triadic" | "split";

interface Hsl {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // 8..94
}

interface Props {
  /** Current topic hex colour (e.g. "#bf534f"), used as initial wheel state. */
  initialHex: string;
  /** Called when the user commits a colour (pointerup, swatch click, hex submit, random). */
  onCommit: (hex: string) => void;
  /** Positioning styles computed by NodeContextMenu. */
  style?: CSSProperties;
  panelRef?: React.RefObject<HTMLDivElement>;
}

const WHEEL_SIZE = 166; // outer diameter px
const RING_THICKNESS = 11; // outer lightness ring thickness px
const RING_GAP = 5; // gap between ring and inner disc
const DISC_SIZE = WHEEL_SIZE - (RING_THICKNESS + RING_GAP) * 2; // 134px
const DISC_R = DISC_SIZE / 2;
const RING_R = WHEEL_SIZE / 2 - RING_THICKNESS / 2;

const MIN_L = 10;
const MAX_L = 92;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toLowerCase();
  }
  return null;
}

function hexToHsl(hex: string): Hsl {
  const clean = normHex(hex) ?? "#6c68c9";
  const n = parseInt(clean.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: clamp(Math.round(l * 100), MIN_L, MAX_L) };
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0, g = 0, b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toByte = (v: number) => Math.round((v + m) * 255);
  return `#${((1 << 24) | (toByte(r) << 16) | (toByte(g) << 8) | toByte(b)).toString(16).slice(1)}`;
}

function harmonyOffsets(mode: HarmonyMode): number[] {
  switch (mode) {
    case "analogous":
      return [-30, 0, 30];
    case "complementary":
      return [0, 180];
    case "triadic":
      return [0, 120, 240];
    case "split":
      return [0, 150, 210];
  }
}

export function ColorWheelPanel({ initialHex, onCommit, style, panelRef }: Props): JSX.Element {
  const [hsl, setHsl] = useState<Hsl>(() => hexToHsl(initialHex));
  const [mode, setMode] = useState<HarmonyMode>("analogous");
  const [hexDraft, setHexDraft] = useState(() => (normHex(initialHex) ?? "#6c68c9").slice(1).toUpperCase());
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragMode = useRef<"disc" | "ring" | null>(null);
  const latestHex = useRef<string>(normHex(initialHex) ?? "#6c68c9");

  const currentHex = useMemo(() => hslToHex(hsl.h, hsl.s, hsl.l), [hsl.h, hsl.s, hsl.l]);
  latestHex.current = currentHex;

  useEffect(() => {
    setHexDraft(currentHex.slice(1).toUpperCase());
  }, [currentHex]);

  const swatches = useMemo(() => {
    return harmonyOffsets(mode).map((deg) => {
      const h = (hsl.h + deg + 360) % 360;
      return { deg, h, hex: hslToHex(h, hsl.s, hsl.l) };
    });
  }, [hsl.h, hsl.s, hsl.l, mode]);

  const updateFromPointer = (clientX: number, clientY: number, kind: "disc" | "ring"): void => {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;

    if (kind === "ring") {
      // Top = 0deg (dark), bottom = 180deg (light), symmetric on left/right.
      const angle = Math.atan2(dx, -dy); // -PI..PI, 0 at top
      const t = Math.abs(angle) / Math.PI; // 0 (top) .. 1 (bottom)
      const nextL = Math.round(MIN_L + t * (MAX_L - MIN_L));
      setHsl((prev) => ({ ...prev, l: clamp(nextL, MIN_L, MAX_L) }));
    } else {
      // 0deg at top (red), clockwise — matches CSS conic-gradient(from 0deg, ...)
      let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      const dist = Math.min(DISC_R, Math.hypot(dx, dy));
      const nextS = Math.round((dist / DISC_R) * 100);
      setHsl((prev) => ({ ...prev, h: Math.round(deg) % 360, s: clamp(nextS, 0, 100) }));
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = wheelRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
    const kind: "disc" | "ring" = dist > DISC_R + RING_GAP / 2 ? "ring" : "disc";
    dragMode.current = kind;
    el.setPointerCapture(e.pointerId);
    updateFromPointer(e.clientX, e.clientY, kind);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragMode.current) return;
    updateFromPointer(e.clientX, e.clientY, dragMode.current);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragMode.current) return;
    dragMode.current = null;
    try {
      wheelRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onCommit(latestHex.current);
  };

  // Handle positions inside the wheel box (center = WHEEL_SIZE / 2)
  const center = WHEEL_SIZE / 2;
  const dotPos = (hDeg: number, sat: number) => {
    const rad = (hDeg * Math.PI) / 180;
    const r = (sat / 100) * DISC_R;
    return { x: center + Math.sin(rad) * r, y: center - Math.cos(rad) * r };
  };

  // Lightness handle on the right side of the outer ring (0 = top/dark .. PI = bottom/light)
  const lFrac = (hsl.l - MIN_L) / (MAX_L - MIN_L);
  const ringRad = lFrac * Math.PI;
  const ringHandle = {
    x: center + Math.sin(ringRad) * RING_R,
    y: center - Math.cos(ringRad) * RING_R,
  };

  const ringGrad = `conic-gradient(from 0deg, ${hslToHex(hsl.h, hsl.s, MIN_L)} 0deg, ${hslToHex(hsl.h, hsl.s, 50)} 90deg, ${hslToHex(hsl.h, hsl.s, MAX_L)} 180deg, ${hslToHex(hsl.h, hsl.s, 50)} 270deg, ${hslToHex(hsl.h, hsl.s, MIN_L)} 360deg)`;

  const applyHexDraft = (): void => {
    const parsed = normHex(hexDraft);
    if (!parsed) {
      setHexDraft(currentHex.slice(1).toUpperCase());
      return;
    }
    setHsl(hexToHsl(parsed));
    onCommit(parsed);
  };

  const pickRandom = (): void => {
    const next: Hsl = {
      h: Math.floor(Math.random() * 360),
      s: 48 + Math.floor(Math.random() * 36),
      l: 46 + Math.floor(Math.random() * 20),
    };
    setHsl(next);
    onCommit(hslToHex(next.h, next.s, next.l));
  };

  return (
    <div
      ref={panelRef}
      className="ctx-color-wheel-panel"
      style={style}
      role="dialog"
      aria-label="Color wheel"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Interactive outer lightness ring + inner hue/saturation disc */}
      <div
        ref={wheelRef}
        className="cw-stage"
        style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          className="cw-ring"
          style={{
            background: ringGrad,
            WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${RING_THICKNESS}px), #000 calc(100% - ${RING_THICKNESS - 1}px))`,
            mask: `radial-gradient(farthest-side, transparent calc(100% - ${RING_THICKNESS}px), #000 calc(100% - ${RING_THICKNESS - 1}px))`,
          }}
        />
        <div
          className="cw-disc"
          style={{
            width: DISC_SIZE,
            height: DISC_SIZE,
            left: RING_THICKNESS + RING_GAP,
            top: RING_THICKNESS + RING_GAP,
          }}
        >
          <div
            className="cw-disc-light"
            style={{
              background:
                hsl.l >= 50
                  ? `rgba(255, 255, 255, ${((hsl.l - 50) / 50) * 0.72})`
                  : `rgba(0, 0, 0, ${((50 - hsl.l) / 50) * 0.78})`,
            }}
          />
        </div>

        {/* Harmony secondary dots */}
        {swatches
          .filter((sw) => sw.deg !== 0)
          .map((sw) => {
            const p = dotPos(sw.h, hsl.s);
            return <span key={sw.deg} className="cw-dot-sub" style={{ left: p.x, top: p.y }} />;
          })}

        {/* Main Hue/Saturation handle */}
        {(() => {
          const p = dotPos(hsl.h, hsl.s);
          return <span className="cw-dot-main" style={{ left: p.x, top: p.y, background: currentHex }} />;
        })()}

        {/* Outer Lightness ring handle */}
        <span className="cw-dot-ring" style={{ left: ringHandle.x, top: ringHandle.y }} />
      </div>

      {/* Harmony selector + clickable harmony swatches */}
      <div className="cw-harmony-head">
        <select
          className="cw-harmony-select"
          aria-label="Color harmony"
          value={mode}
          onChange={(e) => setMode(e.target.value as HarmonyMode)}
        >
          <option value="analogous">Analogous</option>
          <option value="complementary">Complementary</option>
          <option value="triadic">Triadic</option>
          <option value="split">Split</option>
        </select>
        <button
          type="button"
          className="cw-rand-btn"
          title="Random harmonious color"
          onClick={pickRandom}
        >
          Random
        </button>
      </div>

      <div className="cw-swatches" role="group" aria-label="Harmony swatches">
        {swatches.map((sw) => (
          <button
            key={sw.deg}
            type="button"
            className={`cw-swatch${sw.deg === 0 ? " is-main" : ""}`}
            style={{ background: sw.hex, color: readableOn(sw.hex) }}
            title={`Apply ${sw.hex.toUpperCase()}`}
            onClick={() => {
              setHsl(hexToHsl(sw.hex));
              onCommit(sw.hex);
            }}
          >
            {sw.hex.slice(1).toUpperCase()}
          </button>
        ))}
      </div>

      {/* Hex input row */}
      <div className="cw-hex-row">
        <span className="cw-hex-dot" style={{ background: currentHex }} />
        <span className="cw-hex-hash">#</span>
        <input
          className="cw-hex-input"
          aria-label="Hex color"
          maxLength={7}
          value={hexDraft}
          onChange={(e) => setHexDraft(e.target.value.replace(/[^0-9a-fA-F#]/g, ""))}
          onBlur={applyHexDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              applyHexDraft();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </div>
    </div>
  );
}
