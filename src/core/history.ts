/**
 * History — undo/redo stack.
 *
 * Each entry is a BATCH of ops (a single user gesture may produce several
 * ops, e.g. deleting multiple selected topics). The entry stores the forward
 * ops and their inverses in undo order, so undo/redo are pure replays.
 */
import type { Op } from "./ops";

export interface HistoryEntry {
  ops: Op[];
  /** Inverses in the order they must be applied to undo the batch. */
  inverse: Op[];
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly max = 400;

  /**
   * Record an applied batch.
   * @param ops forward ops, already applied to the sheet
   * @param inverses per-op inverse lists, in forward order
   */
  push(ops: Op[], inverses: Op[][]): HistoryEntry {
    const entry: HistoryEntry = {
      ops,
      // undo applies each batch's inverses in reverse order
      inverse: [...inverses].reverse().flat(),
    };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
    return entry;
  }

  /** Ops to apply for undo (already in correct order). */
  undo(): Op[] | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry.inverse;
  }

  redo(): Op[] | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry.ops;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
