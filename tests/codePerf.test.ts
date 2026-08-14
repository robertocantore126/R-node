import { describe, expect, it } from "vitest";
import { tokenize, type CodePalette } from "../src/core/codeHighlight";
import type { TextRun } from "../src/core/types";

/**
 * The number T22 exists to find out: what a visible code topic costs PER FRAME,
 * against a normal one.
 *
 * The suspicion was T6 — `Renderer.textCacheKey` runs
 * `JSON.stringify(n.titleRuns)` for every visible node on every frame. A normal
 * topic stringifies one short run; a code topic stringifies its whole source.
 * That cost scales with the text, not with the pixels, so unlike everything
 * else in the renderer it does NOT shrink as you zoom out.
 *
 * Printed, not asserted tightly: a threshold that fails on a busy machine gets
 * disabled within a week (ROADMAP T5's own warning).
 */

const P: CodePalette = { id: "t", plain: "#a", keyword: "#b", string: "#c", number: "#d", comment: "#e", fn: "#f", punct: "#g" };

const LINE = `  const value${"x".repeat(4)} = compute(alpha, beta) + 42; // note here`;
const SOURCE_40 = Array.from({ length: 40 }, (_, i) => LINE.replace("42", String(i))).join("\n");

/** What the model stores for a code topic: ONE run holding the whole source. */
const codeRuns: TextRun[] = [{ text: SOURCE_40 }];
/** What a normal topic stores: a short title, here in three emphasis runs. */
const topicRuns: TextRun[] = [{ text: "Quarterly " }, { text: "revenue", bold: true }, { text: " plan" }];

function perCall(fn: () => void, iterations: number): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - t0) / iterations;
}

describe("code topic — cost per frame", () => {
  it("measures the key-building cost against a normal topic", () => {
    const N = 20000;
    const codeKey = perCall(() => void JSON.stringify(codeRuns), N);
    const topicKey = perCall(() => void JSON.stringify(topicRuns), N);
    const hit = perCall(() => void tokenize(SOURCE_40, "ts", P), N);

    const runs = tokenize(SOURCE_40, "ts", P);
    const frame = (perNode: number, n: number): number => perNode * n * 60;

    console.log(
      [
        ``,
        `[code topic] source ${SOURCE_40.length} chars, 40 lines → ${runs.length} runs after tokenizing`,
        `  JSON.stringify(titleRuns)   code ${codeKey.toFixed(4)}ms   topic ${topicKey.toFixed(4)}ms   ratio ${(codeKey / topicKey).toFixed(1)}x`,
        `  tokenize() cache hit        ${hit.toFixed(5)}ms`,
        `  at 60fps: 10 code topics    ${frame(codeKey, 10).toFixed(1)}ms/s of key building`,
        `  at 60fps: 100 normal topics ${frame(topicKey, 100).toFixed(1)}ms/s of key building`,
        ``,
      ].join("\n"),
    );

    // The cache must be effectively free — that is what makes deriving the
    // colours at paint time viable at all.
    expect(hit).toBeLessThan(codeKey);
    expect(runs.length).toBeGreaterThan(100);
  });
});
