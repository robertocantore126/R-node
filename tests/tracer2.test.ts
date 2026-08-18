import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  trace,
  wrapTauriInvoke,
  patchIndexedDb,
  installUiListeners,
  COVERAGE_CONTRACT,
  type CoverageReport,
} from "../src/dev/trace";

type AnyEvent = { what: string; sub?: string; kind?: string; n?: number; ms?: number; detail?: Record<string, unknown> };

function find(cov: CoverageReport, sub: string, id: string): { observed: boolean } {
  const item = (cov.byArea as Record<string, { id: string; observed: boolean }[]>)[sub].find((i) => i.id === id);
  if (!item) throw new Error(`no coverage item ${sub}:${id}`);
  return item;
}

describe("tracer 2.0 — subsystem tagging", () => {
  beforeEach(() => {
    trace.enable(true);
    trace.clear();
  });
  afterEach(() => {
    trace.enable(false);
    trace.clear();
  });

  it("existing events carry a subsystem: input→ui, op→cmd, layout→layout, error→err", () => {
    trace.applied("pointerdown:node", { id: "n1" });
    trace.op("createNode", 1, 0.5);
    trace.layout(12, 3);
    trace.error("boom");
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs.find((e) => e.what === "pointerdown:node")?.sub).toBe("ui");
    expect(evs.find((e) => e.kind === "op")?.sub).toBe("cmd");
    expect(evs.find((e) => e.kind === "layout")?.sub).toBe("layout");
    expect(evs.find((e) => e.kind === "error")?.sub).toBe("err");
  });

  it("mark records an explicit subsystem with the what in area:action shape", () => {
    trace.mark("persist", "persist:save", { via: "test" });
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs).toHaveLength(1);
    expect(evs[0].sub).toBe("persist");
    expect(evs[0].what).toBe("persist:save");
    expect(evs[0].detail).toEqual({ via: "test" });
  });

  it("span emits nothing until end(), then one event with ms", () => {
    const s = trace.span("async", "async:promise", { what: "save" });
    expect((trace.capture() as { events: AnyEvent[] }).events).toHaveLength(0);
    s.end({ done: true });
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs).toHaveLength(1);
    expect(evs[0].what).toBe("async:promise");
    expect(evs[0].sub).toBe("async");
    expect(typeof evs[0].ms).toBe("number");
    expect(evs[0].detail).toEqual({ done: true });
  });

  it("gap announces an explicit boundary gap", () => {
    trace.gap("state", "persist", { what: "deleteNode" });
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs.some((e) => e.what === "gap:state->persist")).toBe(true);
  });
});

describe("tracer 2.0 — the coverage contract", () => {
  beforeEach(() => {
    trace.enable(true);
    trace.clear();
  });
  afterEach(() => {
    trace.enable(false);
    trace.clear();
  });

  it("starts empty and flips observed as events arrive", () => {
    expect(find(trace.coverage(), "ui", "click").observed).toBe(false);
    trace.applied("ui:click", {});
    trace.mark("rust", "rust:invoke", { cmd: "write_document" });
    trace.mark("render", "render:image-decode", { bytes: 1 });
    const cov = trace.coverage();
    expect(find(cov, "ui", "click").observed).toBe(true);
    expect(find(cov, "rust", "invoke").observed).toBe(true);
    expect(find(cov, "render", "image-decode").observed).toBe(true);
    // Never observed, and never will be: no workers exist.
    expect(find(cov, "async", "worker").observed).toBe(false);
    expect(find(cov, "rust", "error").observed).toBe(false);
  });

  it("the contract lists every area the user asked to cover", () => {
    const areas = Object.keys(COVERAGE_CONTRACT).sort();
    expect(areas).toEqual(["async", "data", "err", "files", "layout", "render", "rust", "state", "ui"]);
    // Spot-check the rows the app emits by hand.
    const ui = COVERAGE_CONTRACT.ui!.map((i) => i.id);
    expect(ui).toContain("keyboard-shortcut");
    expect(ui).toContain("context-menu");
    expect(ui).toContain("undo-redo");
    const rust = COVERAGE_CONTRACT.rust!.map((i) => i.id);
    expect(rust).toContain("filesystem");
  });

  it("a broad prefix catches qualified whats (pointerdown:pan observes pointer)", () => {
    trace.applied("pointerdown:pan", {});
    expect(find(trace.coverage(), "ui", "pointer").observed).toBe(true);
  });
});

describe("tracer 2.0 — transitions and the state→persist gap", () => {
  beforeEach(() => {
    trace.enable(true);
    trace.clear();
  });
  afterEach(() => {
    trace.enable(false);
    trace.clear();
  });

  it("capture derives the boundary matrix from consecutive subsystem changes", () => {
    // The DELETE_NODE chain: UI → Command → State → (no Persistence).
    trace.applied("ui:shortcut", { action: "delete" });
    trace.op("deleteNode", 1, 0.5);
    trace.mark("state", "state:deleted", { types: "deleteNode" });
    const cap = trace.capture() as {
      transitions: Record<string, number>;
      gaps: { stateToPersist: { unpersisted: number; lastMutation: unknown; lastPersist: unknown } };
    };
    expect(cap.transitions["ui->cmd"]).toBe(1);
    expect(cap.transitions["cmd->state"]).toBe(1);
    // The missing boundary: state never crossed into persist.
    expect(cap.transitions["state->persist"]).toBeUndefined();
  });

  it("reports unpersisted mutations until a persist event resets it", () => {
    trace.applied("ui:click", {});
    trace.op("deleteNode", 1, 0.5);
    trace.mark("state", "state:deleted", {});
    trace.op("createNode", 2, 0.5);
    type GapCap = { gaps: { stateToPersist: { unpersisted: number; lastPersist: unknown } } };
    let cap = trace.capture() as GapCap;
    expect(cap.gaps.stateToPersist.unpersisted).toBe(3);
    expect(cap.gaps.stateToPersist.lastPersist).toBeNull();

    trace.mark("persist", "persist:save", { via: "test" });
    cap = trace.capture() as GapCap;
    expect(cap.gaps.stateToPersist.unpersisted).toBe(0);
    expect(cap.gaps.stateToPersist.lastPersist).toBeTruthy();

    // And it counts again once new mutations arrive after the save.
    trace.op("setTitle", 1, 0.2);
    cap = trace.capture() as GapCap;
    expect(cap.gaps.stateToPersist.unpersisted).toBe(1);
  });
});

describe("tracer 2.0 — automatic Tauri IPC instrumentation", () => {
  beforeEach(() => {
    trace.enable(true);
    trace.clear();
  });
  afterEach(() => {
    trace.enable(false);
    trace.clear();
  });

  it("wraps invoke: emits rust:invoke + rust:result on success, rust:error on failure", async () => {
    const api = {
      core: {
        invoke: async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
          if (cmd === "boom") throw new Error("nope");
          return "ok";
        },
      },
    };
    const orig = api.core.invoke;
    const un = wrapTauriInvoke(api);
    expect(api.core.invoke).not.toBe(orig);

    expect(await api.core.invoke("read_document", { path: "C:/x.rnode" })).toBe("ok");
    await expect(api.core.invoke("boom", {})).rejects.toThrow("nope");

    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs.some((e) => e.sub === "rust" && e.what === "rust:invoke")).toBe(true);
    expect(evs.some((e) => e.what === "rust:result" && e.detail?.cmd === "read_document")).toBe(true);
    expect(evs.some((e) => e.what === "rust:error" && e.detail?.cmd === "boom")).toBe(true);
    expect(evs.some((e) => e.what === "rust:filesystem")).toBe(true); // read_document is a filesystem command

    un();
    expect(api.core.invoke).toBe(orig);
  });

  it("collapses big IPC payloads to a length instead of dumping bytes", async () => {
    const api = {
      core: {
        invoke: async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => "ok",
      },
    };
    const un = wrapTauriInvoke(api);
    await api.core.invoke("put_asset", {
      path: "C:/x.rnode",
      id: "abc",
      bytes: new Uint8Array(1_000_000),
      note: "x".repeat(500),
    });
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    // put_asset is a filesystem command, so its invocation mark is rust:filesystem.
    const invoke = evs.find((e) => e.what === "rust:filesystem");
    expect(invoke?.detail?.bytes).toBe("[1000000 bytes]");
    expect(String(invoke?.detail?.note).endsWith("…")).toBe(true);
    un();
  });
});

describe("tracer 2.0 — automatic IndexedDB instrumentation", () => {
  beforeEach(() => {
    trace.enable(true);
    trace.clear();
  });
  afterEach(() => {
    trace.enable(false);
    trace.clear();
  });

  it("patches the object-store prototype: read/write/delete events, restored on uninstall", () => {
    class FakeStore {
      name = "assets";
      get(k: string): string {
        return `v:${k}`;
      }
      put(v: unknown): unknown {
        return v;
      }
      delete(k: string): string {
        return k;
      }
    }
    const proto = FakeStore.prototype;
    const origGet = proto.get;
    const un = patchIndexedDb(proto);
    const s = new FakeStore();
    s.get("a");
    s.put(1);
    s.delete("b");
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs.filter((e) => e.what === "data:idb-read")).toHaveLength(1);
    expect(evs.filter((e) => e.what === "data:idb-write")).toHaveLength(1);
    expect(evs.filter((e) => e.what === "data:idb-delete")).toHaveLength(1);
    expect(evs.find((e) => e.what === "data:idb-read")?.detail?.store).toBe("assets");
    un();
    expect(proto.get).toBe(origGet);
  });

  it("does nothing when given a missing prototype", () => {
    expect(patchIndexedDb(null)).toBeTypeOf("function");
    expect(patchIndexedDb(undefined)).toBeTypeOf("function");
  });
});

describe("tracer 2.0 — automatic DOM UI instrumentation", () => {
  beforeEach(() => {
    trace.enable(true);
    trace.clear();
  });
  afterEach(() => {
    trace.enable(false);
    trace.clear();
  });

  class FakeWin {
    private listeners = new Map<string, ((e: unknown) => void)[]>();
    addEventListener(type: string, fn: (e: unknown) => void): void {
      const arr = this.listeners.get(type) ?? [];
      arr.push(fn);
      this.listeners.set(type, arr);
    }
    removeEventListener(type: string, fn: (e: unknown) => void): void {
      const arr = this.listeners.get(type) ?? [];
      this.listeners.set(type, arr.filter((f) => f !== fn));
    }
    fire(type: string, e: unknown): void {
      for (const f of this.listeners.get(type) ?? []) f(e);
    }
  }

  it("traces focus/blur, context menu, drag/drop and non-canvas clicks", () => {
    const win = new FakeWin();
    const un = installUiListeners(win as unknown as Window);
    win.fire("focusin", { type: "focusin", target: { tagName: "INPUT" } });
    win.fire("focusout", { type: "focusout", target: { tagName: "INPUT" } });
    win.fire("contextmenu", { type: "contextmenu", target: { tagName: "DIV" } });
    win.fire("dragstart", { type: "dragstart" });
    win.fire("drop", { type: "drop" });
    win.fire("click", { type: "click", target: { tagName: "BUTTON", textContent: "Save", closest: () => null } });
    win.fire("click", { type: "click", target: { tagName: "CANVAS", closest: () => null } });
    const evs = (trace.capture() as { events: AnyEvent[] }).events;
    expect(evs.filter((e) => e.what === "ui:focus-blur")).toHaveLength(2);
    expect(evs.filter((e) => e.what === "ui:context-menu")).toHaveLength(1);
    expect(evs.filter((e) => e.what === "ui:drag-drop")).toHaveLength(2);
    // The canvas click is skipped: its pointer path is traced precisely.
    expect(evs.filter((e) => e.what === "ui:click")).toHaveLength(1);
    expect(evs.find((e) => e.what === "ui:click")?.detail?.tag).toBe("BUTTON");
    un();
    // Uninstall removes the listeners: no more events.
    trace.clear();
    win.fire("contextmenu", { target: { tagName: "DIV" } });
    expect((trace.capture() as { events: AnyEvent[] }).events).toHaveLength(0);
  });
});
