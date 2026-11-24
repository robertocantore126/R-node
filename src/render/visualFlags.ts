export interface VisualFlags {
  taper: boolean;           // V1
  /** V2, withdrawn: text colours are the original ones again. No effect. */
  mutedDeep: boolean;
  flatShadow: boolean;      // V3
  accentStrip: boolean;     // V4
  rootPolish: boolean;      // V5
  junctions: boolean;       // V6
  softSelect: boolean;      // V7
  /** V8, reduced: below LOD_BARE it drops borders, shadows, strips and dots.
   *  It never touches text or images (greeking was withdrawn). */
  lod: boolean;
  animateCollapse: boolean; // V9
  vignette: boolean;        // V10
  overlayLayer: boolean;    // E1
  sceneCache: boolean;      // E2
  batchedPaths: boolean;    // E3
  motionQuality: boolean;   // E5
}

export const LOD_BARE = 0.2;

const STORAGE_KEY = "r-node.visual";

export const DEFAULT_VISUAL_FLAGS: VisualFlags = {
  taper: true,
  mutedDeep: true,
  flatShadow: true,
  accentStrip: true,
  rootPolish: true,
  junctions: true,
  softSelect: true,
  lod: true,
  animateCollapse: true,
  vignette: true,
  overlayLayer: true,
  sceneCache: true,
  batchedPaths: true,
  motionQuality: true,
};

let cachedFlags: VisualFlags | null = null;
const listeners = new Set<() => void>();

function loadFlags(): VisualFlags {
  const flags: VisualFlags = { ...DEFAULT_VISUAL_FLAGS };
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<keyof VisualFlags, unknown>>;
        if (parsed && typeof parsed === "object") {
          for (const key of Object.keys(DEFAULT_VISUAL_FLAGS) as (keyof VisualFlags)[]) {
            if (typeof parsed[key] === "boolean") {
              flags[key] = parsed[key] as boolean;
            }
          }
        }
      }
    }
  } catch {
    // Ignore malformed storage or restricted environments.
  }
  return flags;
}

function saveFlags(flags: VisualFlags): void {
  try {
    if (typeof localStorage !== "undefined") {
      const diff: Partial<VisualFlags> = {};
      for (const key of Object.keys(DEFAULT_VISUAL_FLAGS) as (keyof VisualFlags)[]) {
        if (flags[key] !== DEFAULT_VISUAL_FLAGS[key]) {
          diff[key] = flags[key];
        }
      }
      if (Object.keys(diff).length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(diff));
      }
    }
  } catch {
    // Ignore storage errors.
  }
}

export function getVisualFlags(): VisualFlags {
  if (!cachedFlags) {
    cachedFlags = loadFlags();
  }
  return cachedFlags;
}

export function setVisualFlags(partial: Partial<VisualFlags>): VisualFlags {
  const next: VisualFlags = { ...getVisualFlags() };
  for (const key of Object.keys(DEFAULT_VISUAL_FLAGS) as (keyof VisualFlags)[]) {
    if (typeof partial[key] === "boolean") {
      next[key] = partial[key] as boolean;
    }
  }
  cachedFlags = next;
  saveFlags(next);
  for (const fn of listeners) fn();
  return { ...next };
}

export function resetVisualFlags(): VisualFlags {
  cachedFlags = { ...DEFAULT_VISUAL_FLAGS };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
  for (const fn of listeners) fn();
  return { ...cachedFlags };
}

export function subscribeVisualFlags(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
