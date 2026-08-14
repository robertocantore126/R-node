import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { MindNode } from "../src/core/types";
import { guessCodeLang } from "../src/core/codeHighlight";
import { EditorStore } from "../src/editor/store";
import {
  CODE_TITLEBAR_H,
  HEURISTIC_MEASURER,
  LINE_HEIGHT_FACTOR,
  MAX_CODE_W,
  MAX_TOPIC_W,
  measureNode,
} from "../src/layout/measure";
import { trace } from "../src/dev/trace";
import type { StorageAdapter } from "../src/persist/storage";

const memoryAdapter: StorageAdapter = {
  label: "test",
  async load() {
    return [];
  },
  async save() {
    /* no-op */
  },
};

function makeNode(id: string, type: MindNode["type"], parentId: string | null): MindNode {
  return {
    id,
    type,
    parentId,
    childrenIds: [],
    title: id,
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

// ---------------------------------------------------------------------------
// Measurement (src/layout/measure.ts) — the "fails without the code path" set
// ---------------------------------------------------------------------------

describe("code topic — measure", () => {
  it("keeps leading whitespace: indentation counts toward the width", () => {
    const n = makeNode("n1", "subtopic", "root");
    n.title = "  const a = 1;"; // two leading spaces are the indentation
    n.style.code = { lang: "ts" };
    const codeW = measureNode(n, HEURISTIC_MEASURER).w;
    const plain = makeNode("n2", "subtopic", "root");
    plain.title = "  const a = 1;"; // the same text, as a normal topic
    const plainW = measureNode(plain, HEURISTIC_MEASURER).w;
    // A normal topic skips leading whitespace when wrapping; a code topic
    // must not, or the indented line would be measured too narrow and clip.
    expect(codeW).toBeGreaterThan(plainW);
  });

  it("one line per \\n, never re-wrapped; a long line is not clamped to MAX_TOPIC_W", () => {
    const n = makeNode("n1", "subtopic", "root");
    n.title = "x".repeat(300) + "\n  y = 1;";
    n.style.code = { lang: "ts" };
    const ext = measureNode(n, HEURISTIC_MEASURER);
    // Two source lines → two box lines: the width breaks the topic cap (code
    // decides its own width) but stays under the sane ceiling, and the height
    // is exactly two lines + padding + the title bar, never the wrapped mess.
    expect(ext.w).toBeGreaterThan(MAX_TOPIC_W);
    expect(ext.w).toBeLessThanOrEqual(MAX_CODE_W);
    const lineH = 14 * LINE_HEIGHT_FACTOR;
    expect(ext.h).toBe(2 * lineH + 10 * 2 + 4 + CODE_TITLEBAR_H);
  });

  it("the code flag is part of the extent key", () => {
    const n = makeNode("n1", "subtopic", "root");
    n.title = "x".repeat(300);
    n.style.code = { lang: "ts" };
    const asCode = measureNode(n, HEURISTIC_MEASURER);
    delete n.style.code;
    const asPlain = measureNode(n, HEURISTIC_MEASURER);
    // A stale cache hit would return the code extent for the plain topic
    // (wrapped, clamped) — the flag must invalidate the entry.
    expect(asPlain.w).not.toBe(asCode.w);
    n.style.code = { lang: "ts" };
    expect(measureNode(n, HEURISTIC_MEASURER).w).toBe(asCode.w);
  });

  it("an explicit width still caps the box like any other topic", () => {
    const n = makeNode("n1", "subtopic", "root");
    n.title = "x".repeat(300);
    n.style.code = { lang: "ts" };
    n.style.width = 400;
    const ext = measureNode(n, HEURISTIC_MEASURER);
    expect(ext.w).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Read-only (src/editor/store.ts) — the "fails without the guards" set
// ---------------------------------------------------------------------------

describe("code topic — read-only", () => {
  it("startEdit and typeToEdit refuse a code topic, and say why", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.nodes[store.sheet.rootNodeId]!;
    store.select(root.id);
    store.createChild();
    const main = store.sheet.nodes[root.childrenIds[0]]!;
    store.setNodeStyle(main.id, { code: { lang: "ts" } });
    store.select(main.id);

    trace.enable(true);
    trace.clear();
    store.startEdit(main.id);
    let cap = trace.capture() as { events: { what: string; outcome: string; reason?: string }[] };
    // The refusal still selects the topic (feedback), but never opens the
    // overlay — and the tracer must carry the reason, not silence (§4bis).
    expect(store.getSnapshot().editingId).toBeNull();
    expect(store.getSnapshot().selection).toEqual([main.id]);
    expect(
      cap.events.some((e) => e.what === "edit:start" && e.outcome === "ignored" && e.reason === "code topic is read-only"),
    ).toBe(true);

    trace.clear();
    store.typeToEdit("hello");
    cap = trace.capture() as { events: { what: string; outcome: string; reason?: string }[] };
    expect(store.getSnapshot().editingId).toBeNull();
    expect(
      cap.events.some(
        (e) => e.what === "paste-to-edit:trigger" && e.outcome === "ignored" && e.reason === "code topic is read-only",
      ),
    ).toBe(true);
    trace.enable(false);
    trace.clear();
  });

  it("a normal topic still opens the editor", () => {
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.nodes[store.sheet.rootNodeId]!;
    store.select(root.id);
    store.createChild();
    const main = store.sheet.nodes[root.childrenIds[0]]!;
    store.select(main.id);
    store.startEdit(main.id);
    expect(store.getSnapshot().editingId).toBe(main.id);
    store.cancelEdit();
  });
});

// ---------------------------------------------------------------------------
// Creation from the clipboard (T22 palette command)
// ---------------------------------------------------------------------------

describe("code topic — creation from clipboard", () => {
  it("pasteCodeFromClipboard stores the source verbatim under the selection", async () => {
    const src = "#include <iostream>\nint main() { return 0; }";
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: async () => src },
      configurable: true,
    });
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.nodes[store.sheet.rootNodeId]!;
    store.select(root.id);
    await store.pasteCodeFromClipboard();
    const code = Object.values(store.sheet.nodes).find((n) => n.style.code);
    expect(code).toBeDefined();
    expect(code!.title).toBe(src); // newlines kept, I5 intact
    expect(code!.style.code!.lang).toBe("cpp"); // sniffed, not defaulted
    expect(code!.type).toBe("main"); // child of the central topic
    expect(store.getSnapshot().selection).toContain(code!.id);
  });

  it("an empty clipboard refuses and says why", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: async () => "" },
      configurable: true,
    });
    const store = new EditorStore(memoryAdapter);
    const root = store.sheet.nodes[store.sheet.rootNodeId]!;
    store.select(root.id);
    trace.enable(true);
    trace.clear();
    await store.pasteCodeFromClipboard();
    const cap = trace.capture() as { events: { what: string; outcome: string; reason?: string }[] };
    expect(Object.values(store.sheet.nodes).filter((n) => n.style.code)).toHaveLength(0);
    expect(cap.events.some((e) => e.what === "paste:code" && e.outcome === "ignored")).toBe(true);
    trace.enable(false);
    trace.clear();
  });
});

// ---------------------------------------------------------------------------
// Language sniffing (src/core/codeHighlight.ts)
// ---------------------------------------------------------------------------

describe("guessCodeLang", () => {
  it("recognises the three grammars and falls back to text", () => {
    expect(guessCodeLang("#include <vector>\nint main() {}")).toBe("cpp");
    expect(guessCodeLang("#define MAX 10")).toBe("cpp");
    expect(guessCodeLang("const x: number = 1;")).toBe("ts");
    expect(guessCodeLang("import { a } from \"./b\";")).toBe("ts");
    expect(guessCodeLang("function foo() { return 1; }")).toBe("js");
    expect(guessCodeLang("const xs = [1, 2];")).toBe("js");
    expect(guessCodeLang("Ciao mondo")).toBe("text");
  });
});


