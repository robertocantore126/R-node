/**
 * The one small helper behind R-node's explicit state machines.
 *
 * A machine is a discriminated union (`kind` plus only the data that state
 * needs) and a table of the moves allowed between kinds. There is no library
 * and no statechart: the catalog of what is and is not a machine, and why, is
 * docs/STATE_MACHINES.md.
 *
 * Data inside a state may be updated in place (a drag's `moved`, a drop
 * target). Changing `kind` goes through `to()`, which is what makes every
 * change of state checkable, traceable and readable from the console.
 */
import { trace } from "../dev/trace";

export interface MachineState {
  readonly kind: string;
}

/** Required key per kind: adding a kind without its moves does not compile. */
export type TransitionTable<S extends MachineState> = { readonly [K in S["kind"]]: readonly S["kind"][] };

/** Anything that can report its current state to `__rnode.machines()`. */
export interface Inspectable {
  readonly name: string;
  inspect(): unknown;
}

const registry = new Map<string, Inspectable>();

/** Publish a live instance. A later one with the same name replaces it. */
export function registerInspectable(item: Inspectable): void {
  registry.set(item.name, item);
}

export function machineNames(): string[] {
  return [...registry.keys()].sort();
}

/** Every machine's current state, as plain data (`__rnode.machines()`). */
export function inspectMachines(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, item] of registry) out[name] = item.inspect();
  return out;
}

function isTestRun(): boolean {
  return (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === "test";
}

export class Machine<S extends MachineState> implements Inspectable {
  private current: S;
  private listeners = new Set<() => void>();
  /** Illegal moves seen by this instance. Always 0 in a correct build. */
  violations = 0;

  constructor(
    readonly name: string,
    initial: S,
    private readonly table: TransitionTable<S>,
    /** Throw on an illegal move. On under tests, off for users. */
    private readonly strict: boolean = isTestRun()
  ) {
    this.current = initial;
  }

  get state(): S {
    return this.current;
  }

  /**
   * Move to `next`; `event` says why, for the trace. An illegal move is a bug
   * in the caller, so tests fail on it, but a user's session never does: it is
   * recorded and applied, which is what the code did before this check existed.
   */
  to(next: S, event: string): S {
    const from: S["kind"] = this.current.kind;
    if (!this.table[from as keyof TransitionTable<S>].includes(next.kind)) {
      this.violations++;
      const message = `${this.name}: illegal move ${from} -> ${next.kind} on "${event}"`;
      trace.invariant(message);
      if (this.strict) throw new Error(message);
    }
    this.current = next;
    // The merge key keeps a sequence of different moves from collapsing into one.
    trace.mark("state", "state:machine", { machine: this.name, from, to: next.kind, event }, undefined, `${this.name}:${from}:${next.kind}`);
    for (const listener of this.listeners) listener();
    return next;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A copy: a console poking at the result cannot change the live state. */
  inspect(): S {
    return { ...this.current };
  }
}
