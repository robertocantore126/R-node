import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { quizSearchTiers } from "../src/core/quiz";
import { EditorStore } from "../src/editor/store";

const store = () => new EditorStore({ label: "test", async load() { return []; }, async save() {} });

const q = {
  q: "In RDS Multi-AZ, cosa succede se la AZ del primary cade?",
  answers: ["Il DNS dell'endpoint punta al standby con failover automatico", "b", "c", "d"],
  correct: 0,
};

it("keeps the answer out of the query until the question is answered", () => {
  const before = quizSearchTiers(q, false);
  expect(before[0]).toEqual([]);
  expect(before[1]).toEqual(["RDS", "Multi-AZ", "AZ"]);
  expect(before.flat()).not.toContain("failover");
  const after = quizSearchTiers(q, true);
  expect(after[0]).toEqual([q.answers[0]]);
  expect(after[1]).toContain("DNS");
  expect(after[2]).toEqual(expect.arrayContaining(["primary", "endpoint", "failover"]));
});

it("searchBest opens the search on the most specific matching candidate", () => {
  const s = store();
  const root = s.sheet.rootNodeId;
  for (const title of ["RDS overview", "RDS Multi-AZ failover", "RDS pricing"]) {
    s.createChildOf(root); // opens the title editor on the new topic
    s.setEditingDraft(title);
    s.commitEdit();
  }
  const chosen = s.searchBest(quizSearchTiers(q, false));
  expect(chosen).toBe("Multi-AZ");
  const snap = s.getSnapshot();
  expect(snap.searchOpen).toBe(true);
  expect(snap.searchResults).toHaveLength(1);
  expect(s.doc.node(snap.selection[0])?.title).toBe("RDS Multi-AZ failover");
});

it("falls back to typing the first candidate when nothing matches", () => {
  const s = store();
  expect(s.searchBest(quizSearchTiers(q, false))).toBe("RDS");
  expect(s.getSnapshot().searchResults).toEqual([]);
});
