/**
 * Recently used topic colours, shown as a row of swatches in the node
 * context menu (and recorded wherever a fill is set).
 *
 * Persisted in localStorage under one key: a plain JSON array of hex colours,
 * most recent first, deduped and capped. Reading/writing is defensive — this
 * is UI preference data, and a storage hiccup (or an environment without
 * localStorage) must never break a colour change or the menu; the feature
 * simply degrades to an empty Recent row.
 */

const KEY = "r-node.recent-colors";
const MAX = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c)).slice(0, MAX);
  } catch {
    return [];
  }
}

function write(colors: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(colors.slice(0, MAX)));
  } catch {
    /* best-effort */
  }
}

/** The recorded recent colours, most recent first. */
export function getRecentColors(): string[] {
  return read();
}

/** Record a colour as recently used (moves it to the front, dedupes, caps). */
export function addRecentColor(color: string): void {
  if (typeof color !== "string" || color.length === 0) return;
  const next = [color, ...read().filter((c) => c.toLowerCase() !== color.toLowerCase())];
  write(next);
}
