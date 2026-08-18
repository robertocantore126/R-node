/**
 * Session tracer 2.0 — a repro capture with a coverage contract, NOT a
 * monitoring system.
 *
 * Tracer 1.0 recorded DECISIONS (every guard that drops an input logs why).
 * That stays: it is what separates "the app did nothing" from "the app
 * refused, on purpose". Tracer 2.0 adds the other half of diagnosis — the
 * boundaries. Anything crossing a subsystem boundary generates an event, so
 * a capture shows the whole chain:
 *
 *   UI (click) → Command (op) → State (mutated) → Persistence → Rust → Filesystem
 *
 * and, crucially, where the chain STOPS. The headline detection is derived at
 * capture time: every command/state mutation since the last persistence event
 * is reported as `gaps.stateToPersist.unpersisted` — exactly the
 * "UI says DELETE_NODE / Command: DELETE_NODE / State: node removed /
 * Persistence: NO EVENT" shape. A capture also carries `transitions`, the
 * subsystem→subsystem matrix, so a missing boundary is visible as an absent
 * transition.
 *
 * Coverage: the TRACE COVERAGE CONTRACT (docs/TRACER_COVERAGE.md) is checked
 * live — every observed area:item pair is marked in the capture's `coverage`
 * section, so a capture not only shows what happened, it shows which parts of
 * the contract were never exercised (e.g. `async:worker` stays unobserved
 * because the app has no workers — and now the capture says so).
 *
 * Three layers of instrumentation:
 *  - explicit: trace.mark / trace.span called at the subsystem boundaries
 *    (store, renderer, layout, persistence adapters, shortcuts);
 *  - automatic: the Tauri invoke wrapper (every IPC call → rust:*), the
 *    IndexedDB prototype patch (every object-store op → data:idb-*) and the
 *    DOM UI listeners (focus/blur, context menu, drag/drop, clicks → ui:*)
 *    installed by installTrace;
 *  - derived: the transition matrix and the state→persist gap, computed from
 *    the event stream at capture time, with no extra instrumentation.
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

export type Subsystem =
  | "ui"
  | "cmd"
  | "state"
  | "persist"
  | "data"
  | "files"
  | "render"
  | "layout"
  | "async"
  | "err"
  | "rust";

export type TraceEvent =
  | { kind: "input"; sub: "ui"; t: number; n: number; what: string; outcome: "applied" | "ignored"; reason?: string; detail?: Detail }
  | { kind: "op"; sub: "cmd"; t: number; n: number; what: "op"; types: string; count: number; ms: number }
  | { kind: "layout"; sub: "layout"; t: number; n: number; what: "layout:run"; nodes: number; ms: number }
  | { kind: "render"; sub: "render"; t: number; n: number; what: "render:frame"; frames: number; scale: number; nodes: number; visible: number; rels: number; relsDrawn: number; links: number; linksDrawn: number; textHits: number; textMisses: number; imgVisible: number; imgCached: number; imgBytes: number; imgInflight: number; maxMs: number }
  | { kind: "edit"; sub: "cmd"; t: number; n: number; what: string; nodeId?: string; detail?: Detail }
  | { kind: "invariant"; sub: "state"; t: number; n: number; what: "invariant"; message: string }
  | { kind: "error"; sub: "err"; t: number; n: number; what: string; message: string; stack?: string }
  | { kind: "mark"; sub: Subsystem; t: number; n: number; what: string; detail?: Detail; ms?: number };

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

// ---------------------------------------------------------------------------
// The TRACE COVERAGE CONTRACT (docs/TRACER_COVERAGE.md).
//
// Each item lists the `what` prefixes that count as observing it. Matching is
// exact-prefix: `what === prefix` or `what.startsWith(prefix + ":")`, so a
// broad prefix like "pointerdown" also catches "pointerdown:pan".
// ---------------------------------------------------------------------------

export interface CoverageItem {
  id: string;
  label: string;
  prefixes: string[];
}

export const COVERAGE_CONTRACT: Partial<Record<Subsystem, CoverageItem[]>> = {
  ui: [
    { id: "click", label: "click", prefixes: ["ui:click"] },
    { id: "keyboard-shortcut", label: "keyboard shortcut", prefixes: ["ui:shortcut"] },
    { id: "pointer", label: "pointer interaction", prefixes: ["pointerdown", "pointermove", "pointerup", "pointercancel", "dblclick", "wheel"] },
    { id: "drag-drop", label: "drag/drop", prefixes: ["ui:drag-drop", "drop", "dragstart"] },
    { id: "selection", label: "selection", prefixes: ["ui:selection"] },
    { id: "focus-blur", label: "focus/blur", prefixes: ["ui:focus-blur"] },
    { id: "modal", label: "modal open/close", prefixes: ["ui:modal"] },
    { id: "context-menu", label: "context menu", prefixes: ["ui:context-menu"] },
    { id: "input-change", label: "input/change", prefixes: ["edit:commit", "ui:input-change"] },
    { id: "undo-redo", label: "undo/redo", prefixes: ["ui:undo-redo"] },
  ],
  state: [
    { id: "created", label: "state creation", prefixes: ["state:created"] },
    { id: "mutated", label: "state mutation", prefixes: ["state:mutated"] },
    { id: "deleted", label: "state deletion", prefixes: ["state:deleted"] },
    { id: "derived", label: "derived state", prefixes: ["state:derived", "layout:"] },
    { id: "sync", label: "state synchronization", prefixes: ["state:sync"] },
    { id: "transaction", label: "transaction start/end", prefixes: ["state:transaction"] },
  ],
  data: [
    { id: "idb-read", label: "IndexedDB read", prefixes: ["data:idb-read"] },
    { id: "idb-write", label: "IndexedDB write", prefixes: ["data:idb-write"] },
    { id: "idb-delete", label: "IndexedDB delete", prefixes: ["data:idb-delete"] },
    { id: "serialize", label: "serialization", prefixes: ["data:serialize"] },
    { id: "deserialize", label: "deserialization", prefixes: ["data:deserialize"] },
    { id: "migrate", label: "migration", prefixes: ["data:migrate"] },
    { id: "import", label: "import", prefixes: ["data:import"] },
    { id: "export", label: "export", prefixes: ["data:export"] },
  ],
  files: [
    { id: "open", label: "file open", prefixes: ["files:open"] },
    { id: "read", label: "file read", prefixes: ["files:read"] },
    { id: "write", label: "file write", prefixes: ["files:write"] },
    { id: "rename", label: "file rename", prefixes: ["files:rename"] },
    { id: "delete", label: "file delete", prefixes: ["files:delete"] },
    { id: "failure", label: "file failure", prefixes: ["files:failure"] },
  ],
  render: [
    { id: "render-start", label: "render start", prefixes: ["render:frame", "render:start"] },
    { id: "render-end", label: "render end", prefixes: ["render:frame", "render:end"] },
    { id: "image-decode", label: "image decode", prefixes: ["render:image-decode"] },
    { id: "texture-create", label: "texture creation", prefixes: ["render:text-cache"] },
    { id: "texture-destroy", label: "texture destruction", prefixes: ["render:cache-evict"] },
    { id: "cache-insert", label: "cache insertion", prefixes: ["render:text-cache", "render:image-cache"] },
    { id: "cache-evict", label: "cache eviction", prefixes: ["render:cache-evict"] },
    { id: "gpu-alloc", label: "GPU resource allocation", prefixes: ["render:gpu-alloc"] },
    { id: "gpu-free", label: "GPU resource free", prefixes: ["render:gpu-free"] },
  ],
  layout: [
    { id: "start", label: "layout start", prefixes: ["layout:run", "layout:start"] },
    { id: "end", label: "layout end", prefixes: ["layout:run", "layout:end"] },
    { id: "invalidate", label: "invalidation", prefixes: ["layout:invalidate"] },
    { id: "node-calc", label: "node calculation", prefixes: ["layout:node-calc"] },
    { id: "constraint", label: "constraint resolution", prefixes: ["layout:constraint"] },
    { id: "failure", label: "layout failure", prefixes: ["layout:failure"] },
  ],
  async: [
    { id: "promise", label: "promise start/end", prefixes: ["async:promise"] },
    { id: "worker", label: "worker start/end", prefixes: ["async:worker"] },
    { id: "cancel", label: "cancellation", prefixes: ["async:cancel"] },
    { id: "timeout", label: "timeout", prefixes: ["async:timeout"] },
    { id: "race", label: "race-sensitive operation", prefixes: ["async:race"] },
  ],
  err: [
    { id: "exception", label: "exception", prefixes: ["error", "err:exception"] },
    { id: "rejection", label: "rejected promise", prefixes: ["err:rejection"] },
    { id: "failed-op", label: "failed operation", prefixes: ["error", "err:failed-op"] },
    { id: "recovery", label: "recovery", prefixes: ["err:recovery"] },
    { id: "fallback", label: "fallback", prefixes: ["err:fallback"] },
  ],
  rust: [
    { id: "invoke", label: "command invocation", prefixes: ["rust:invoke"] },
    { id: "result", label: "command result", prefixes: ["rust:result"] },
    { id: "error", label: "command error", prefixes: ["rust:error"] },
    { id: "filesystem", label: "filesystem operation", prefixes: ["rust:filesystem"] },
    { id: "ipc", label: "IPC", prefixes: ["rust:invoke", "rust:result", "rust:error"] },
  ],
};

/** Flat (key, prefix) pairs, precompiled so push() matching is a plain loop. */
const CONTRACT_FLAT: { key: string; prefix: string }[] = [];
for (const [sub, items] of Object.entries(COVERAGE_CONTRACT)) {
  for (const item of items) {
    for (const prefix of item.prefixes) CONTRACT_FLAT.push({ key: `${sub}:${item.id}`, prefix });
  }
}

/** Which contract items have been observed, and when/what last observed them. */
const coverageObserved = new Set<string>();
const coverageLast = new Map<string, { t: number; what: string }>();

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

  // Live coverage check: mark every contract item whose prefix matches.
  const w = ev.what;
  if (w) {
    for (const c of CONTRACT_FLAT) {
      if (w === c.prefix || w.startsWith(c.prefix + ":")) {
        coverageObserved.add(c.key);
        coverageLast.set(c.key, { t: ev.t, what: w });
      }
    }
  }
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
      sub: "render",
      what: "render:frame",
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

export interface SpanHandle {
  end(detail?: Detail): void;
}

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
    push({ kind: "input", sub: "ui", t: now(), n: 1, what, outcome: "applied", detail }, `input:${what}:applied`);
  },

  /**
   * An input that was deliberately NOT acted on, and why. This is the most
   * valuable call in the file: "nothing happened" is indistinguishable from
   * "it was dropped on purpose" from the outside.
   */
  ignored(what: string, reason: string, detail?: Detail): void {
    if (!enabled) return;
    push({ kind: "input", sub: "ui", t: now(), n: 1, what, outcome: "ignored", reason, detail }, `input:${what}:ignored:${reason}`);
  },

  op(types: string, count: number, ms: number): void {
    if (!enabled) return;
    push({ kind: "op", sub: "cmd", t: now(), n: 1, what: "op", types, count, ms: Math.round(ms * 100) / 100 }, `op:${types}`);
  },

  layout(nodes: number, ms: number): void {
    if (!enabled) return;
    push({ kind: "layout", sub: "layout", t: now(), n: 1, what: "layout:run", nodes, ms: Math.round(ms * 100) / 100 }, `layout:${nodes}`);
  },

  edit(what: string, nodeId?: string, detail?: Detail): void {
    if (!enabled) return;
    push({ kind: "edit", sub: "cmd", t: now(), n: 1, what, nodeId, detail }, `edit:${what}:${nodeId ?? ""}`);
  },

  invariant(message: string): void {
    if (!enabled) return;
    push({ kind: "invariant", sub: "state", t: now(), n: 1, what: "invariant", message }, `invariant:${message}`);
  },

  error(message: string, stack?: string): void {
    if (!enabled) return;
    push({ kind: "error", sub: "err", t: now(), n: 1, what: "error", message, stack }, `error:${message}`);
  },

  /**
   * A point event at a subsystem boundary. This is the general escape hatch
   * every explicit call site uses: `trace.mark("persist", "persist:save", …)`.
   * Keep `what` in the `area:action` shape so the coverage contract can match
   * it (see COVERAGE_CONTRACT).
   *
   * `merge` splits the coalescing key: two consecutive marks with the same
   * `what` but a different `merge` (e.g. focusin vs focusout, or the Tauri
   * command name) stay as separate entries instead of folding into one.
   */
  mark(sub: Subsystem, what: string, detail?: Detail, ms?: number, merge?: string): void {
    if (!enabled) return;
    push(
      { kind: "mark", sub, t: now(), n: 1, what, detail, ms: ms === undefined ? undefined : Math.round(ms * 100) / 100 },
      `mark:${sub}:${what}${merge ? `:${merge}` : ""}`
    );
  },

  /**
   * A timed operation: nothing is emitted until `end()` is called, which
   * records ONE mark with the elapsed ms. Use it for promises, transactions,
   * decodes — anything whose duration is the answer.
   */
  span(sub: Subsystem, what: string, detail?: Detail): SpanHandle {
    if (!enabled) return { end() {} };
    const start = typeof performance !== "undefined" ? performance.now() : 0;
    return {
      end(endDetail?: Detail): void {
        if (!enabled) return;
        const ms = (typeof performance !== "undefined" ? performance.now() : 0) - start;
        push(
          {
            kind: "mark",
            sub,
            t: now(),
            n: 1,
            what,
            detail: endDetail ?? detail,
            ms: Math.round(ms * 100) / 100,
          },
          `span:${sub}:${what}`
        );
      },
    };
  },

  /**
   * An explicit boundary gap ("state changed, persistence never followed").
   * Most gaps need no call site: capture() derives `gaps.stateToPersist` from
   * the event stream. This is for the ones only the code knows about.
   */
  gap(from: Subsystem, to: Subsystem, detail?: Detail): void {
    if (!enabled) return;
    push({ kind: "mark", sub: from, t: now(), n: 1, what: `gap:${from}->${to}`, detail }, `gap:${from}->${to}`);
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

  /**
   * The TRACE COVERAGE CONTRACT, live: which area:item pairs have been
   * observed in this session, and the event that last observed each.
   */
  coverage(): CoverageReport {
    const byArea = {} as CoverageReport["byArea"];
    for (const [sub, items] of Object.entries(COVERAGE_CONTRACT)) {
      byArea[sub as Subsystem] = (items ?? []).map((item) => {
        const key = `${sub}:${item.id}`;
        const last = coverageLast.get(key);
        return { id: item.id, label: item.label, observed: coverageObserved.has(key), ...(last ? { last } : {}) };
      });
    }
    const total = Object.values(byArea).reduce((a, items) => a + items.length, 0);
    const covered = Object.values(byArea).reduce((a, items) => a + items.filter((i) => i.observed).length, 0);
    return { total, covered, byArea };
  },

  /** Everything needed to reproduce, as a plain object. */
  capture(note?: string, extra?: Detail): unknown {
    flushRender();
    const counts: Record<string, number> = {};
    for (const ev of buffer) counts[ev.kind] = (counts[ev.kind] ?? 0) + ev.n;

    // Subsystem→subsystem transition matrix: which boundaries were crossed,
    // and which were not. A missing "state->persist" row is a finding.
    const transitions: Record<string, number> = {};
    let prev: Subsystem | null = null;
    for (const ev of buffer) {
      if (prev !== null && ev.sub !== prev) {
        const key = `${prev}->${ev.sub}`;
        transitions[key] = (transitions[key] ?? 0) + ev.n;
      }
      prev = ev.sub;
    }

    // The headline gap: commands/state mutations with no persistence after.
    // Walks the stream; every persist event resets the counter. A user editing
    // without pressing Ctrl+S is NOT a gap (manual save is the contract); this
    // answers the "I saved but did it actually persist?" question and its
    // inverse — "the state shows X, why does the file not?".
    let unpersisted = 0;
    let lastMutation: { what: string; t: number } | null = null;
    let lastPersist: { what: string; t: number } | null = null;
    for (const ev of buffer) {
      if (ev.sub === "persist") {
        unpersisted = 0;
        lastPersist = { what: ev.what, t: ev.t };
      } else if (ev.kind === "op" || (ev.kind === "mark" && ev.sub === "state" && /^state:(created|mutated|deleted)/.test(ev.what))) {
        unpersisted += ev.n;
        lastMutation = { what: ev.what, t: ev.t };
      }
    }

    return {
      README:
        "R-node session trace (tracer 2.0). `events` is chronological, `t` is ms since page load and `n` is how many " +
        "identical events were coalesced into that entry. Every event carries `sub`, its subsystem: " +
        "ui → cmd → state → persist → data/files → rust. `transitions` counts the boundary crossings between " +
        "subsystems: a chain that stops early shows up as a missing transition. `gaps.stateToPersist.unpersisted` " +
        "is how many commands/state mutations happened since the last persistence event — 0 means every change " +
        "reached storage, >0 means some did not (the 'Persistence: NO EVENT' shape). `coverage` is the live " +
        "TRACE COVERAGE CONTRACT: which area:item pairs were ever observed. Read the `input` entries with " +
        "outcome:'ignored' first — they say which gesture was deliberately dropped and why. `render` entries are " +
        "aggregated over `frames` frames: if relsDrawn equals rels while the user reports missing arrows, the bug " +
        "is in painting, not in culling.",
      note: note ?? null,
      at: new Date().toISOString(),
      counts,
      coverage: this.coverage(),
      transitions,
      gaps: {
        stateToPersist: {
          unpersisted,
          lastMutation,
          lastPersist,
        },
      },
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
   * press the hotkey, save the download, tell someone the path. Resolves
   * false when there is no sink — a production build, or the dev server gone —
   * and the caller falls back to a download.
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
    coverageObserved.clear();
    coverageLast.clear();
  },
};

export interface CoverageReport {
  total: number;
  covered: number;
  byArea: Record<Subsystem, { id: string; label: string; observed: boolean; last?: { t: number; what: string } }[]>;
}

// ---------------------------------------------------------------------------
// Automatic instrumentation
//
// These wrap real platform surfaces so every crossing of a boundary is seen
// without the call sites knowing. Each returns an uninstall function, so the
// dev session can be torn down cleanly (StrictMode mounts twice).
// ---------------------------------------------------------------------------

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The commands that ARE the filesystem layer of the desktop backend. */
const FS_COMMANDS = new Set([
  "read_document",
  "write_document",
  "rename_document",
  "remove_document",
  "document_file_exists",
  "put_asset",
  "get_asset",
  "delete_asset",
  "list_assets",
  "default_document_path",
]);

/** Collapse large IPC payloads (image bytes!) into a length instead of a dump. */
function summarize(args?: Record<string, unknown>): Detail | undefined {
  if (!args) return undefined;
  const out: Detail = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) out[k] = String(v);
    else if (v instanceof Uint8Array || v instanceof ArrayBuffer || Array.isArray(v)) {
      out[k] = `[${(v as { byteLength?: number; length?: number }).byteLength ?? (v as unknown[]).length} bytes]`;
    } else if (typeof v === "string") out[k] = v.length > 80 ? v.slice(0, 80) + "…" : v;
    else if (typeof v === "object") out[k] = Object.keys(v as object).join(",");
    else out[k] = v as string | number | boolean;
  }
  return out;
}

/**
 * Wrap `window.__TAURI__.core.invoke` so every IPC call emits rust:* events:
 * invocation (with a summarized argument list), then result or error. This one
 * hook covers the whole RUST/TAURI row of the contract — command, arguments,
 * result, error, filesystem (the fs commands are tagged rust:filesystem).
 *
 * Exported for unit tests; installTrace calls it against the real global.
 */
export function wrapTauriInvoke(api: { core: { invoke: TauriInvoke } } | undefined): () => void {
  if (!api?.core || typeof api.core.invoke !== "function") return () => {};
  const orig = api.core.invoke;
  const wrapped: TauriInvoke = (cmd, args) => {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const fs = FS_COMMANDS.has(cmd);
    trace.mark("rust", fs ? "rust:filesystem" : "rust:invoke", { cmd, ...summarize(args) }, undefined, cmd);
    const finish = (ok: boolean, err?: unknown): void => {
      const ms = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
      if (ok) trace.mark("rust", "rust:result", { cmd, ms: Math.round(ms * 100) / 100 }, undefined, cmd);
      else trace.mark("rust", "rust:error", { cmd, error: String(err), ms: Math.round(ms * 100) / 100 }, undefined, cmd);
    };
    try {
      const p = orig.apply(api.core, [cmd, args] as never) as Promise<unknown>;
      if (p && typeof (p as Promise<unknown>).then === "function") {
        return (p as Promise<unknown>).then(
          (r) => {
            finish(true);
            return r;
          },
          (e: unknown) => {
            finish(false, e);
            throw e;
          }
        ) as never;
      }
      finish(true);
      return p;
    } catch (e) {
      finish(false, e);
      throw e;
    }
  };
  api.core.invoke = wrapped;
  return () => {
    if (api.core.invoke === wrapped) api.core.invoke = orig;
  };
}

/**
 * Patch the IDBObjectStore prototype so every IndexedDB op emits a data:idb-*
 * event. This sees the asset store AND the file-handle store — any code that
 * touches IndexedDB, without any of it knowing. Restores on uninstall.
 *
 * Exported for unit tests; installTrace calls it in the browser only.
 */
export function patchIndexedDb(storeProto: unknown): () => void {
  const proto = storeProto as { get?: unknown; getAll?: unknown; getAllKeys?: unknown; put?: unknown; add?: unknown; delete?: unknown } | null;
  if (!proto) return () => {};
  const cleanups: (() => void)[] = [];
  const wrap = (name: keyof typeof proto, what: string): void => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    (proto as Record<string, unknown>)[name] = function (this: { name?: string }, ...args: unknown[]): unknown {
      const t0 = typeof performance !== "undefined" ? performance.now() : 0;
      const ms = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
      trace.mark("data", what, { store: this.name ?? "", ms: Math.round(ms * 100) / 100 });
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
    cleanups.push(() => {
      (proto as Record<string, unknown>)[name] = orig;
    });
  };
  wrap("get", "data:idb-read");
  wrap("getAll", "data:idb-read");
  wrap("getAllKeys", "data:idb-read");
  wrap("put", "data:idb-write");
  wrap("add", "data:idb-write");
  wrap("delete", "data:idb-delete");
  return () => {
    for (const c of cleanups) c();
  };
}

/**
 * Coarse UI listeners for the contract rows no call site traces today:
 * focus/blur, context menu, drag/drop, and clicks on DOM controls (the canvas
 * pointer path is already traced precisely, so canvas clicks are skipped).
 */
export function installUiListeners(win: Window): () => void {
  const onFocus = (e: FocusEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName ?? "";
    trace.mark("ui", "ui:focus-blur", { type: e.type, tag }, undefined, e.type);
  };
  const onContext = (e: MouseEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName ?? "";
    trace.mark("ui", "ui:context-menu", { tag });
  };
  const onDrag = (e: Event): void => {
    trace.mark("ui", "ui:drag-drop", { type: e.type }, undefined, e.type);
  };
  const onClick = (e: MouseEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.tagName === "CANVAS" || (typeof t.closest === "function" && t.closest("canvas"))) return;
    trace.mark("ui", "ui:click", { tag: t.tagName, text: (t.textContent ?? "").trim().slice(0, 40) || undefined }, undefined, t.tagName);
  };
  win.addEventListener("focusin", onFocus, true);
  win.addEventListener("focusout", onFocus, true);
  win.addEventListener("contextmenu", onContext, true);
  win.addEventListener("dragstart", onDrag, true);
  win.addEventListener("drop", onDrag, true);
  win.addEventListener("click", onClick, true);
  return () => {
    win.removeEventListener("focusin", onFocus, true);
    win.removeEventListener("focusout", onFocus, true);
    win.removeEventListener("contextmenu", onContext, true);
    win.removeEventListener("dragstart", onDrag, true);
    win.removeEventListener("drop", onDrag, true);
    win.removeEventListener("click", onClick, true);
  };
}

/**
 * Install the capture hotkey, the console handle, the auto-instrumentation
 * (Tauri IPC, IndexedDB, UI listeners) and the crash capture. Uncaught errors
 * are folded into the same stream so a crash arrives with the twenty events
 * that led to it instead of on its own.
 */
export function installTrace(): () => void {
  if (!enabled || typeof window === "undefined") return () => {};
  (window as unknown as { __rnodeTrace: typeof trace }).__rnodeTrace = trace;

  const autoCleanups: (() => void)[] = [];
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: TauriInvoke } } }).__TAURI__;
  try {
    autoCleanups.push(wrapTauriInvoke(tauri));
  } catch {
    /*
     * Best-effort, exactly like the two hooks below — and the ONLY one of the
     * three that can take the whole app down, because it is the only one that
     * runs solely on the desktop.
     *
     * `window.__TAURI__.core` is `Object.freeze({__proto__: null, …, invoke: h,
     * …})` in the global bundle Tauri injects (v2.11.5, scripts/bundle.global.js),
     * so assigning `core.invoke` throws TypeError under the module system's
     * strict mode. installTrace runs inside a useEffect in CanvasView, so that
     * throw unmounted the React tree and the desktop window came up BLANK while
     * the browser was fine — in a browser `__TAURI__` is undefined and
     * wrapTauriInvoke returns early without ever assigning.
     *
     * With this guard the desktop app runs and simply records no rust:* events.
     * Restoring IPC tracing needs a seam that is not frozen —
     * `window.__TAURI_INTERNALS__.invoke`, which `core.invoke` delegates to, is
     * the obvious candidate.
     */
  }
  try {
    const proto = typeof IDBObjectStore !== "undefined" ? IDBObjectStore.prototype : null;
    autoCleanups.push(patchIndexedDb(proto));
  } catch {
    /* no IndexedDB in this environment */
  }
  try {
    autoCleanups.push(installUiListeners(window));
  } catch {
    /* listeners are best-effort */
  }

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
    for (const c of autoCleanups) c();
  };
}
