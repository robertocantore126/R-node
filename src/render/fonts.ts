/**
 * The app's own text face: Xmind (SIL Open Font License 1.1, see
 * src/assets/fonts/xmind/OFL.txt), shipped with the app as two variable fonts
 * (upright and italic, weight axis 100–900), so every weight the topics use
 * comes from the same file.
 *
 * It must be loaded BEFORE anything is measured. The measurer caches widths by
 * font string and the layout caches topic sizes by content; a measurement
 * taken while the fallback face was still in place would size every topic for
 * the wrong font, and the canvas would then draw Xmind into those boxes.
 */
import xmindUrl from "../assets/fonts/xmind/Xmind-VariableFont_wght.ttf?url";
import xmindItalicUrl from "../assets/fonts/xmind/Xmind-Italic-VariableFont_wght.ttf?url";

export const APP_FONT_FAMILY = "Xmind";

let loading: Promise<void> | null = null;

/**
 * Register and load both faces. Never rejects and never waits longer than
 * `timeoutMs`: a font that cannot load leaves the fallback stack in place, it
 * must not keep the app from starting.
 */
export function loadAppFonts(timeoutMs = 4000): Promise<void> {
  if (loading) return loading;
  if (typeof document === "undefined" || typeof FontFace === "undefined" || !document.fonts) {
    loading = Promise.resolve();
    return loading;
  }
  const faces = [
    new FontFace(APP_FONT_FAMILY, `url(${xmindUrl})`, { weight: "100 900", style: "normal" }),
    new FontFace(APP_FONT_FAMILY, `url(${xmindItalicUrl})`, { weight: "100 900", style: "italic" }),
  ];
  const all = Promise.all(
    faces.map(async (f) => {
      try {
        await f.load();
        document.fonts.add(f);
      } catch (e) {
        console.warn("[fonts] could not load", APP_FONT_FAMILY, e);
      }
    })
  ).then(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  loading = Promise.race([all, timeout]);
  return loading;
}

/**
 * The upright face as an @font-face rule with the font inlined, for the
 * standalone HTML viewer: it has no server to fetch the file from. The italic
 * face is left out (the browser slants the upright one) to keep the export
 * small. Null when the file cannot be read; the viewer then falls back.
 */
export async function inlineAppFontCss(): Promise<string | null> {
  try {
    const buf = await (await fetch(xmindUrl)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `@font-face{font-family:"${APP_FONT_FAMILY}";src:url(data:font/ttf;base64,${btoa(bin)}) format("truetype");font-weight:100 900;font-style:normal}`;
  } catch {
    return null;
  }
}
