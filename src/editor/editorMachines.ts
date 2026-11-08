/**
 * The state machines the EditorStore owns, as pure data and small classes so
 * they can be read and tested without the store. See docs/STATE_MACHINES.md.
 */
import type { ImageSlot } from "../core/types";
import type { Inspectable, TransitionTable } from "./machine";

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------

/**
 * One save runs at a time. A request that arrives during it sets `queued`, and
 * the save re-runs once with the content of that moment: dropping the request
 * would report "Saved" while the file holds a stale version.
 */
export type SaveFlow = { kind: "idle" } | { kind: "saving"; queued: boolean };

export const SAVE_FLOW_TABLE: TransitionTable<SaveFlow> = {
  idle: ["saving"],
  saving: ["idle"],
};

/**
 * How a save ended. "cancelled" and "refused" mean the user stopped it or the
 * target was unsafe, so a queued re-run would only ask the same question again.
 */
export type SaveOutcome = "saved" | "cancelled" | "refused" | "failed";

export function saveRerunAllowed(outcome: SaveOutcome): boolean {
  return outcome === "saved" || outcome === "failed";
}

// ---------------------------------------------------------------------------
// Long operations (progress bar in the status bar)
// ---------------------------------------------------------------------------

export type LongOpKind = "save" | "export" | "open";

/** What the status bar shows. Published as `EditorState.op`. */
export interface LongOpView {
  kind: LongOpKind;
  label: string;
  /** 0..1, or null when there is no honest fraction to show. */
  progress: number | null;
  cancellable: boolean;
}

/**
 * The heavy operations in flight, newest on top; the bar shows the top one.
 *
 * Operations can overlap: an export can start during a save. A single slot
 * made the newer one abort the older (a running save was silently cancelled)
 * and let whichever finished first clear the bar of the one still running.
 */
export class LongOps implements Inspectable {
  readonly name = "longOps";
  private stack: { view: LongOpView; abort: AbortController }[] = [];

  begin(kind: LongOpKind, label: string, cancellable: boolean): AbortSignal {
    const abort = new AbortController();
    this.stack.push({ view: { kind, label, progress: 0, cancellable }, abort });
    return abort.signal;
  }

  private latest(kind: LongOpKind): number {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].view.kind === kind) return i;
    return -1;
  }

  /** Update the newest op of `kind`. False when none is running. */
  update(kind: LongOpKind, label: string, progress: number | null): boolean {
    const i = this.latest(kind);
    if (i < 0) return false;
    this.stack[i].view = { ...this.stack[i].view, label, progress };
    return true;
  }

  end(kind: LongOpKind): void {
    const i = this.latest(kind);
    if (i >= 0) this.stack.splice(i, 1);
  }

  /** Abort the op the user is looking at; never one hidden beneath it. */
  cancelCurrent(): void {
    this.stack[this.stack.length - 1]?.abort.abort();
  }

  get current(): LongOpView | null {
    return this.stack[this.stack.length - 1]?.view ?? null;
  }

  inspect(): LongOpView[] {
    return this.stack.map((entry) => entry.view);
  }
}

// ---------------------------------------------------------------------------
// Selection target
// ---------------------------------------------------------------------------

/**
 * What the selection is ON. The store still publishes the flat fields below,
 * which the renderer, Inspector and shortcuts read; this union is the only way
 * to write them, so "at most one kind of thing is selected" cannot drift.
 *
 * A gallery cell lives inside "nodes" because its topic stays selected with it
 * (the Inspector's caption list only exists for a selected topic).
 */
export type SelectionTarget =
  | { kind: "none" }
  | { kind: "nodes"; ids: string[]; cell?: { nodeId: string; index: number } }
  | { kind: "image"; nodeId: string; slot: ImageSlot }
  | { kind: "relationship"; id: string }
  | { kind: "group"; id: string }
  | { kind: "summary"; id: string };

export interface SelectionFields {
  selection: string[];
  relSel: string | null;
  groupSel: string | null;
  summarySel: string | null;
  imageSel: string | null;
  imageSlot: ImageSlot | null;
  gallerySel: { nodeId: string; index: number } | null;
}

export function selectionFields(target: SelectionTarget): SelectionFields {
  return {
    selection: target.kind === "nodes" ? target.ids : [],
    relSel: target.kind === "relationship" ? target.id : null,
    groupSel: target.kind === "group" ? target.id : null,
    summarySel: target.kind === "summary" ? target.id : null,
    imageSel: target.kind === "image" ? target.nodeId : null,
    imageSlot: target.kind === "image" ? target.slot : null,
    gallerySel: target.kind === "nodes" ? target.cell ?? null : null,
  };
}

/** The inverse of `selectionFields`: read the published fields as a target. */
export function selectionTargetOf(s: SelectionFields): SelectionTarget {
  if (s.imageSel) return { kind: "image", nodeId: s.imageSel, slot: s.imageSlot ?? "top" };
  if (s.relSel) return { kind: "relationship", id: s.relSel };
  if (s.groupSel) return { kind: "group", id: s.groupSel };
  if (s.summarySel) return { kind: "summary", id: s.summarySel };
  if (s.selection.length > 0) return { kind: "nodes", ids: s.selection, ...(s.gallerySel ? { cell: s.gallerySel } : {}) };
  return { kind: "none" };
}
