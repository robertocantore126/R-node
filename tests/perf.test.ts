/**
 * Performance spike (Phase 1 validation).
 *
 * Generates balanced trees of 1k / 5k / 10k topics through the real op
 * system and measures the hot paths the editor hits on every edit:
 *   - op application (applyWithInverse)
 *   - layout (layoutSheet) and layout write-back (applyLayout)
 *   - tree walks (subtreeIds / visibleIds)
 *
 * Bounds are deliberately generous — this file exists to catch algorithmic
 * blowups (O(n²) insertions, layout regressions), not micro-timings. Run with
 * `npx vitest run tests/perf.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { DocumentModel, uid } from "../src/core/doc";
import { applyWithInverse, makeOp, type Op } from "../src/core/ops";
import { applyLayout, layoutSheet } from "../src/layout/mindmap";

function generate(model: DocumentModel, count: number): Op[] {
  const sheet = model.sheet;
  const rootId = sheet.rootNodeId;
  const ops: Op[] = [];
  const queue: string[] = [rootId];
  const BRANCH = 8;
  let created = 0;
  while (created < count && queue.length > 0) {
    const parentId = queue.shift()!;
    const isRoot = parentId === rootId;
    for (let i = 0; i < BRANCH && created < count; i++) {
      const id = uid("n");
      ops.push(
        makeOp<Op & { type: "createNode" }>("createNode", {
          id,
          nodeType: isRoot ? "main" : "subtopic",
          parentId,
          index: 0, // branch factor is 8, so sibling arrays stay tiny — O(1) inserts
          title: `Topic ${created}`,
        })
      );
      queue.push(id);
      created++;
    }
  }
  return ops;
}

function time<T>(_label: string, fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

describe("perf spike", () => {
  const sizes = [1_000, 5_000, 10_000];

  for (const size of sizes) {
    it(`handles ${size.toLocaleString()} topics through the op system`, { timeout: 60_000 }, () => {
      const model = new DocumentModel(DocumentModel.blank("Perf"));
      const rootId = model.sheet.rootNodeId;
      const ops = generate(model, size);
      expect(ops.length).toBe(size);
      const apply = time("apply", () => {
        for (const op of ops) applyWithInverse(model.sheet, op);
      });
      expect(model.sheet.nodes).toHaveProperty(rootId);
      expect(Object.keys(model.sheet.nodes).length).toBe(size + 1);

      const layout = time("layoutSheet", () => layoutSheet(model.sheet));
      expect(layout.result.positions.size).toBeGreaterThanOrEqual(size * 0.9);

      const writeback = time("applyLayout", () => applyLayout(model.sheet, false));

      const walks = time("tree walks", () => {
        const a = model.subtreeIds(rootId).length;
        const b = model.visibleIds(rootId).length;
        return { a, b };
      });

      // report
      console.log(
        `[perf ${size.toLocaleString()}] applyOps=${apply.ms.toFixed(1)}ms ` +
          `layout=${layout.ms.toFixed(1)}ms writeback=${writeback.ms.toFixed(1)}ms walks=${walks.ms.toFixed(1)}ms ` +
          `(${(apply.ms / size).toFixed(4)}ms/op)`
      );

      // sanity ceilings — generous, catch blowups only
      expect(apply.ms).toBeLessThan(10_000);
      expect(layout.ms).toBeLessThan(5_000);
      expect(writeback.ms).toBeLessThan(5_000);
      expect(walks.result.a).toBe(size + 1);
      expect(walks.result.b).toBe(size + 1);
    });
  }
});
