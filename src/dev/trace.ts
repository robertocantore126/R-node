/**
 * Session tracer — a repro capture, NOT a monitoring system.
 *
 * The problem it solves: a person testing the app can see the effect of a bug
 * ("the arrows disappear when I zoom out") but never the cause, because the
 * decisive information is invisible from outside — whether the renderer drew
 * the arrows at all, whether an input was deliberately ignored, whether the
 * layout ran. Describing the symptom in prose forces whoever fixes it to
 * re-derive all of that by reading code.
 *
 * So this records the DECISIONS, not just the actions. Every guard that drops
 * an input logs why it dropped it (example shape):
 *
 *   [INPUT] wheel ctrl=true → ignored (reason)
 *
 * That single line answers "why did this gesture do nothing", which no amount
 * of prose from the user ever could. Applied gestures are traced too, so a
 * dead input is distinguishable from a handled one.
 *
 * Usage: in dev it writes itself to `.trace/latest.json` every few seconds, so
 * whoever is investigating just reads that file — no one has to be asked for a
 * capture. Ctrl+Shift+D at the moment the bug happens also writes a timestamped
 * copy with a note, and resets the window. Also on `window.__rnodeTrace`.
 *
 * Disabled in production builds: every entry point returns immediately, so
 * the cost is a boolean test.
 */

const CAPACITY = 500;

export type TraceEvent =
  | { kind: "input"; t: number; n: number; what: string; outcome: "applied" | "ignored"; reason?: string; detail?: Detail }
  | { kind: "op"; t: number; n: number; types: string; count: number; ms: number }
  | { kind: "layout"; t: number; n: number; nodes: number; ms: number }
  | { kind: "render"; t: number; n: number; frames: number; scale: number; nodes: number; visible: number; rels: number; relsDrawn: number; links: number; linksDrawn: number; textHits: number; textMisses: number; imgVisible: number; imgCached: number; imgBytes: number; imgInflight: number; maxMs: number }
  | { kind: "edit"; t: number; n: number; what: string; nodeId?: string; detail?: Detail }
  | { kind: "invariant"; t: number; n: number; message: string }
  | { kind: "error"; t: number; n: number; message: string; stack?: string };

type Detail = Record<string, string | number | boolean | null | undefined>;

function devEnabled(): boolean {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

let enabled = devEnabled();
const buffer: TraceEvent[] = [];
const t0 = typeof performance !== "undefined" ? performance.now() : 0;

function now(): number {
  return Math.round(((typeof performance !== "undefined" ? performance.now() : 0) - t0) * 10) / 10;
}

/**
 * Bumped on every recorded event, coalesced ones included.
 *
 * The auto-flush needs to know whether anything happened since the last write,
 * and `buffer.length` cannot answer: coalescing raises the last entry's `n`
 * without appending, so a whole gesture of wheel events leaves the length
 * untouched. A counter is the only cheap signal that does not lie.
 */
let revision = 0;

/**
 * Append, coalescing repeats. Without this a wheel gesture (dozens of events)
 * or a render loop would flush the whole buffer in a second and the capture
 * would hold nothing but the last instant — exactly the part you already know.
 */
function push(ev: TraceEvent, mergeKey: string): void {
  if (!enabled) return;
  revision++;
  const last = buffer[buffer.length - 1] as (TraceEvent & { _k?: string }) | undefined;
  if (last && last._k === mergeKey) {
    last.n += 1;
    last.t = ev.t;
    return;
  }
  (ev as TraceEvent & { _k?: string })._k = mergeKey;
  buffer.push(ev);
  if (buffer.length > CAPACITY) buffer.shift();
}

// ---------------------------------------------------------------------------
// Render coalescing: 60 fps would drown everything else, but the per-frame
// counters are the whole point for "it isn't painted" bugs. So frames are
// aggregated and flushed at most every 250 ms, or immediately when the shape
// of the frame changes (zoom bucket, visible count, relationships drawn).
// ---------------------------------------------------------------------------

interface RenderSample {
  scale: number;
  nodes: number;
  visible: number;
  rels: number;
  relsDrawn: number;
  links: number;
  linksDrawn: number;
  textHits: number;
  textMisses: number;
  imgVisible: number;
  imgCached: number;
  imgBytes: number;
  imgInflight: number;
}

let pending: RenderSample | null = null;
let pendingFrames = 0;
let pendingMaxMs = 0;
let lastFlush = -Infinity;

function shapeOf(s: RenderSample): string {
  return `${s.scale.toFixed(2)}|${s.visible}|${s.rels}|${s.relsDrawn}|${s.linksDrawn}`;
}

function flushRender(): void {
  if (!pending) return;
  push(
    {
      kind: "render",
      t: now(),
      n: 1,
      frames: pendingFrames,
      scale: Math.round(pending.scale * 1000) / 1000,
      nodes: pending.nodes,
      visible: pending.visible,
      rels: pending.rels,
      relsDrawn: pending.relsDrawn,
      links: pending.links,
      linksDrawn: pending.linksDrawn,
      textHits: pending.textHits,
      textMisses: pending.textMisses,
      imgVisible: pending.imgVisible,
      imgCached: pending.imgCached,
      imgBytes: pending.imgBytes,
      imgInflight: pending.imgInflight,
      maxMs: Math.round(pendingMaxMs * 100) / 100,
    },
    `render:${shapeOf(pending)}`
  );
  pending = null;
  pendingFrames = 0;
  pendingMaxMs = 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const trace = {
  get enabled(): boolean {
    return enabled;
  },

  enable(on = true): void {
    enabled = on;
  },

  /** An input that was acted on. */
  applied(what: string, detail?: Detail): void {
    if (!enabled) return;
    push({ kind: "input", t: now(), n: 1, what, outcome: "applied", detail }, `input:${what}:applied`);
  },

  /**
   * An input that was deliberately NOT acted on, and why. This is the most
   * valuable call in the file: "nothing happened" is indistinguishable from
   * "it was dropped on purpose" from the outside.
   */
  ignored(what: string, reason: string, detail?: Detail): void {
    if (!enabled) return;
    push({ kind: "input", t: now(), n: 1, what, outcome: "ignored", reason, detail }, `input:${what}:ignored:${reason}`);
  },

  op(types: string, count: number, ms: number): void {
    if (!enabled) return;
    push({ kind: "op", t: now(), n: 1, types, count, ms: Math.round(ms * 100) / 100 }, `op:${types}`);
  },

  layout(nodes: number, ms: number): void {
    if (!enabled) return;
    push({ kind: "layout", t: now(), n: 1, nodes, ms: Math.round(ms * 100) / 100 }, `layout:${nodes}`);
  },

  edit(what: string, nodeId?: string, detail?: Detail): void {
    if (!enabled) return;
    push({ kind: "edit", t: now(), n: 1, what, nodeId, detail }, `edit:${what}:${nodeId ?? ""}`);
  },

  invariant(message: string): void {
    if (!enabled) return;
    push({ kind: "invariant", t: now(), n: 1, message }, `invariant:${message}`);
  },

  error(message: string, stack?: string): void {
    if (!enabled) return;
    push({ kind: "error", t: now(), n: 1, message, stack }, `error:${message}`);
  },

  /** One painted frame. Aggregated — see the note above. */
  render(sample: RenderSample, ms: number): void {
    if (!enabled) return;
    const changed = pending !== null && shapeOf(pending) !== shapeOf(sample);
    if (changed) flushRender();
    pending = sample;
    pendingFrames += 1;
    pendingMaxMs = Math.max(pendingMaxMs, ms);
    const t = now();
    if (changed || t - lastFlush > 250) {
      lastFlush = t;
      flushRender();
    }
  },

  /** Everything needed to reproduce, as a plain object. */
  capture(note?: string, extra?: Detail): unknown {
    flushRender();
    const counts: Record<string, number> = {};
    for (const ev of buffer) counts[ev.kind] = (counts[ev.kind] ?? 0) + ev.n;
    return {
      README:
        "R-node session trace. `events` is chronological, `t` is ms since page load and `n` is how many identical " +
        "events were coalesced into that entry. Read the `input` entries with outcome:'ignored' first — they say " +
        "which gesture was deliberately dropped and why. `render` entries are aggregated over `frames` frames: if " +
        "relsDrawn equals rels while the user reports missing arrows, the bug is in painting, not in culling.",
      note: note ?? null,
      at: new Date().toISOString(),
      counts,
      env:
        typeof window === "undefined"
          ? null
          : {
              url: window.location.href,
              userAgent: navigator.userAgent,
              dpr: window.devicePixelRatio,
              viewport: { w: window.innerWidth, h: window.innerHeight },
            },
      ...extra,
      events: buffer.map(({ _k, ...ev }: TraceEvent & { _k?: string }) => ev),
    };
  },

  /**
   * Write the trace to `.trace/latest.json` through the dev server.
   *
   * Replaces the hand-off that used to sit in the middle of every diagnosis:
   * press the hotkey, save the download, tell someone the path. Resolves false
   * when there is no sink — a production build, or the dev server gone — and
   * the caller falls back to a download.
   *
   * `keep` also writes a timestamped copy: keypress captures carry a note and
   * must survive the next automatic flush.
   */
  async flush(note?: string, keep = false): Promise<boolean> {
    if (!enabled || typeof fetch === "undefined") return false;
    try {
      const res = await fetch("/__trace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(keep ? { "X-Trace-Keep": "1" } : {}) },
        body: JSON.stringify(this.capture(note), null, 2),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  download(note?: string, extra?: Detail): void {
    if (typeof document === "undefined") return;
    const blob = new Blob([JSON.stringify(this.capture(note, extra), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rnode-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  clear(): void {
    buffer.length = 0;
    pending = null;
    pendingFrames = 0;
  },
};

/**
 * Install the capture hotkey and the console handle. Uncaught errors are
 * folded into the same stream so a crash arrives with the twenty events that
 * led to it instead of on its own.
 */
export function installTrace(): () => void {
  if (!enabled || typeof window === "undefined") return () => {};
  (window as unknown as { __rnodeTrace: typeof trace }).__rnodeTrace = trace;

  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      const note = window.prompt("What did you expect to happen? (optional)") ?? undefined;
      void trace.flush(note, true).then((written) => {
        // Only fall back to a download when there is no sink to write to.
        if (!written) trace.download(note);
        // Reset after capturing, never before: the bug has already happened by
        // the time anyone reaches for this, so clearing first would discard the
        // very evidence being asked for. Each capture is scoped to what came
        // after the previous one.
        trace.clear();
      });
    }
  };

  /**
   * Rolling auto-flush, so `.trace/latest.json` is simply always current and
   * nobody has to be asked for it.
   *
   * Only when something was recorded, and never two at once: an idle app must
   * not rewrite the same file forever, and a busy one must not queue writes
   * behind each other. Three seconds is slow enough to cost nothing next to a
   * 16ms frame and quick enough that the file is fresh by the time anyone
   * looks. The buffer is NOT cleared — this is a window on the last events,
   * while the hotkey is a scoped capture.
   */
  let lastWritten = -1;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || revision === lastWritten) return;
    inFlight = true;
    const at = revision;
    void trace.flush().then((ok) => {
      inFlight = false;
      if (ok) lastWritten = at;
    });
  }, 3000);
  const onError = (e: ErrorEvent): void => trace.error(e.message, e.error?.stack);
  const onRejection = (e: PromiseRejectionEvent): void => trace.error(String(e.reason), (e.reason as Error)?.stack);

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  // eslint-disable-next-line no-console
  console.info("[trace] recording → .trace/latest.json — Ctrl+Shift+D for a noted capture, window.__rnodeTrace in the console");

  return () => {
    clearInterval(timer);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
