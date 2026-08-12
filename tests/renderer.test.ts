import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "../src/render/renderer";
import type { MindNode } from "../src/core/types";

/**
 * Every offscreen canvas reports the SAME fixed dimensions (2048×2048 → exactly
 * 16 MB per bitmap), ignoring the width/height assignments renderTextBitmap
 * makes. That lets the test drive the byte accounting without rendering real
 * text: the cache key (node id) varies, the byte weight does not.
 */
const DIMS = { w: 2048, h: 2048 };
const ENTRY_BYTES = DIMS.w * DIMS.h * 4; // 16 MB

function makeNode(id: string): MindNode {
  return {
    id,
    type: "subtopic",
    parentId: "root",
    childrenIds: [],
    title: "Same title for every node",
    titleRuns: [{ text: "Same title for every node" }],
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: "",
    task: null,
    metadata: { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

/** A 2d context that accepts every call and answers measureText deterministically. */
function make2dCtx(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(_t, p) {
      if (p === "measureText") return (text: string) => ({ width: text.length * 8 });
      return () => {};
    },
    set(_t, p, v) {
      target[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function makeFakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    get width() {
      return DIMS.w;
    },
    set width(_v: number) {},
    get height() {
      return DIMS.h;
    },
    set height(_v: number) {},
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("text cache (T21-D)", () => {
  it("evicts by byte budget and refreshes recency on hit (true LRU)", () => {
    const ctx = make2dCtx();
    let created = 0;
    vi.stubGlobal("document", {
      createElement: () => {
        created += 1;
        return makeFakeCanvas(ctx);
      },
    });

    const renderer = new Renderer(makeFakeCanvas(ctx));
    created = 0; // the measurer's internal canvas is not cache accounting
    const r = renderer as unknown as {
      drawText: (
        _theme: unknown,
        p: { node: MindNode; x: number; y: number; w: number; h: number; visible: boolean },
        color: string
      ) => void;
      textCache: Map<string, { bytes: number }>;
      textBytes: number;
    };
    const draw = (id: string): void =>
      r.drawText(undefined, { node: makeNode(id), x: 0, y: 0, w: 120, h: 40, visible: true }, "#000");

    // A + B + C = 48 MB — under the 64 MB budget, nothing evicted.
    draw("A");
    draw("B");
    draw("C");
    expect(r.textCache.size).toBe(3);
    expect(created).toBe(3);

    // Hit A → recency refreshed: {B, C, A}. No new bitmap was rendered.
    draw("A");
    expect(created).toBe(3);
    expect(r.textCache.size).toBe(3);

    // D fits exactly (64 MB); E pushes to 80 MB → the LEAST RECENTLY USED
    // (B — A was refreshed) is evicted, not the first inserted.
    draw("D");
    draw("E");
    expect(r.textCache.size).toBe(4);
    expect(r.textBytes).toBe(64 * 1024 * 1024);
    expect(created).toBe(5);

    // A survived because its earlier hit refreshed it: still a cache hit.
    draw("A");
    expect(created).toBe(5);
    // B was evicted: re-drawing it renders a fresh bitmap.
    draw("B");
    expect(created).toBe(6);

    // Every insert stays within the byte budget.
    expect(r.textBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(r.textBytes).toBe(64 * 1024 * 1024); // exactly 4 entries after the eviction
    expect(ENTRY_BYTES).toBe(16 * 1024 * 1024);
  });
});
