import { describe, expect, it } from "vitest";
import { DocumentModel, uid } from "../src/core/doc";
import { applyOp, makeOp, type Op } from "../src/core/ops";
import { applyLayout, layoutSheet, measureNode } from "../src/layout/mindmap";

function makeMap(): DocumentModel {
  const model = new DocumentModel(DocumentModel.blank("Layout test"));
  return model;
}

function addChild(model: DocumentModel, parentId: string, title: string): string {
  const id = uid("n");
  applyOp(model.sheet, makeOp<Op & { type: "createNode" }>("createNode", { id, nodeType: "subtopic", parentId, index: model.node(parentId)!.childrenIds.length, title }));
  return id;
}

describe("mindmap layout", () => {
  it("positions the root at the origin and alternates branch sides", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    const a = addChild(model, root.id, "Alpha");
    const b = addChild(model, root.id, "Beta");
    const c = addChild(model, root.id, "Gamma");

    const res = layoutSheet(sheet);
    const pRoot = res.positions.get(root.id)!;
    const pA = res.positions.get(a)!;
    const pB = res.positions.get(b)!;
    const pC = res.positions.get(c)!;

    // root centered at origin (top-left of root box at -w/2,-h/2)
    expect(pRoot.x).toBeCloseTo(-measureNode(root).w / 2, 5);
    expect(pRoot.y).toBeCloseTo(-measureNode(root).h / 2, 5);

    // autoBalance splits by subtree height: equal branches → 1 right, 2 left
    expect(pA.x).toBeGreaterThan(pRoot.x + measureNode(root).w);
    expect(pB.x).toBeLessThan(pRoot.x);
    expect(pC.x).toBeLessThan(pRoot.x);
  });

  it("never overlaps siblings on the same side", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(addChild(model, root.id, `Topic ${i}`));
    for (const id of ids) {
      addChild(model, id, `${id}-c1`);
      addChild(model, id, `${id}-c2`);
    }
    const res = layoutSheet(sheet);
    const rootBox = measureNode(root);
    const sideOf = (id: string) => (res.positions.get(id)!.x > res.positions.get(root.id)!.x + rootBox.w ? 1 : -1);
    const bySide = (s: number) => ids.filter((id) => sideOf(id) === s);
    const checkNoVerticalOverlap = (group: string[]) => {
      const rects = group.map((id) => {
        const p = res.positions.get(id)!;
        const m = measureNode(model.node(id)!);
        return { y0: p.y, y1: p.y + m.h };
      });
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(rects[i].y0 < rects[j].y1 && rects[j].y0 < rects[i].y1).toBe(false);
        }
      }
    };
    checkNoVerticalOverlap(bySide(1));
    checkNoVerticalOverlap(bySide(-1));
  });

  it("collapsed nodes hide their subtree from layout", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    const big = addChild(model, root.id, "Big branch");
    const hidden = [0, 1, 2, 3, 4].map((i) => addChild(model, big, `child-${i}`));
    const other = addChild(model, root.id, "Other");
    model.node(big)!.collapsed = true;

    const res = layoutSheet(sheet);
    // hidden children are not placed at all
    for (const h of hidden) expect(res.positions.has(h)).toBe(false);
    // and the collapsed branch's block is exactly its own height
    const pBig = res.positions.get(big)!;
    const hBig = measureNode(model.node(big)!).h;
    const pOther = res.positions.get(other)!;
    expect(Math.abs(pBig.y - pOther.y)).toBeLessThan(hBig + measureNode(model.node(other)!).h + 40);
  });

  it("applyLayout preserves manual positions", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const floatingId = uid("n");
    applyOp(sheet, makeOp<Op & { type: "createNode" }>("createNode", { id: floatingId, nodeType: "floating", parentId: null, index: 0, title: "Free", position: { x: 1234, y: 567, manual: true } }));
    applyLayout(sheet, false);
    const f = model.node(floatingId)!;
    expect(f.position.x).toBe(1234);
    expect(f.position.y).toBe(567);
  });

  it("includes manual main topics and separates automatic siblings around them", () => {
    const model = makeMap();
    const root = model.rootNode;
    const anchored = addChild(model, root.id, "Anchored");
    const automatic = addChild(model, root.id, "Automatic");
    model.node(anchored)!.position = { x: 160, y: 30, manual: true };

    const res = layoutSheet(model.sheet);
    expect(res.positions.has(anchored)).toBe(true);

    const a = res.positions.get(anchored)!;
    const b = res.positions.get(automatic)!;
    const ah = measureNode(model.node(anchored)!).h;
    expect(a.y + ah + model.sheet.structure.branchSpacing).toBeLessThanOrEqual(b.y + 0.001);
  });

  it("preserves major side assignment for manual root children when an auto subtopic is added", () => {
    const model = makeMap();
    const root = model.rootNode;
    const main1 = addChild(model, root.id, "Main 1");
    const main2 = addChild(model, root.id, "Main 2");
    const main3 = addChild(model, root.id, "Main 3");
    model.node(main2)!.position = { x: 240, y: 70, manual: true };
    model.node(main3)!.position = { x: -260, y: 80, manual: true };
    model.node(main2)!.style.fill = "#ff646b";
    model.node(main3)!.style.fill = "#4eb5e8";

    const before = layoutSheet(model.sheet);
    const side2Before = before.positions.get(main2)!.x > before.positions.get(root.id)!.x + measureNode(root).w ? 1 : -1;
    const side3Before = before.positions.get(main3)!.x > before.positions.get(root.id)!.x + measureNode(root).w ? 1 : -1;

    addChild(model, main1, "Subtopic 1");
    const after = layoutSheet(model.sheet);
    const side2After = after.positions.get(main2)!.x > after.positions.get(root.id)!.x + measureNode(root).w ? 1 : -1;
    const side3After = after.positions.get(main3)!.x > after.positions.get(root.id)!.x + measureNode(root).w ? 1 : -1;

    expect(side2After).toBe(side2Before);
    expect(side3After).toBe(side3Before);
    expect(model.node(main2)!.style.fill).toBe("#ff646b");
    expect(model.node(main3)!.style.fill).toBe("#4eb5e8");
  });

  it("keeps subtopic colors stable when a different main topic is moved", () => {
    const model = makeMap();
    const root = model.rootNode;
    const main1 = addChild(model, root.id, "Main 1");
    const main2 = addChild(model, root.id, "Main 2");
    const sub = addChild(model, main2, "Subtopic A");
    model.node(main2)!.style.fill = "#ff646b";
    model.node(sub)!.style.fill = "#ffe8dc";

    const before = model.node(sub)!.style.fill;
    model.node(main1)!.position = { x: 200, y: 0, manual: true };
    applyLayout(model.sheet, false);
    expect(model.node(sub)!.style.fill).toBe(before);
  });

  it("keeps a manually positioned branch fixed while laying out its descendants", () => {
    const model = makeMap();
    const root = model.rootNode;
    const branch = addChild(model, root.id, "Dragged branch");
    const child = addChild(model, branch, "Child");
    model.node(branch)!.position = {
      x: 240,
      y: 70,
      manual: true,
    };
    applyLayout(model.sheet, false);

    const firstChildPosition = { ...model.node(child)!.position };
    model.node(branch)!.title = "Dragged branch with a much longer title that changes its measured width";
    applyLayout(model.sheet, false);

    const branchPosition = model.node(branch)!.position;
    const childPosition = model.node(child)!.position;
    expect(branchPosition.x).toBe(240);
    expect(branchPosition.y).toBe(70);
    expect(childPosition.x).not.toBe(firstChildPosition.x);
  });

  it("moves auto subtopics relative to a manually pinned main topic", () => {
    const model = makeMap();
    const root = model.rootNode;
    const main = addChild(model, root.id, "Main branch");
    const child = addChild(model, main, "Subtopic");
    model.node(main)!.position = {
      x: 240,
      y: 70,
      manual: true,
    };
    applyLayout(model.sheet, false);

    const before = { ...model.node(child)!.position };
    model.node(main)!.position = {
      x: 340,
      y: 170,
      manual: true,
    };
    applyLayout(model.sheet, false);

    const after = model.node(child)!.position;
    expect(model.node(main)!.position.x).toBe(340);
    expect(model.node(main)!.position.y).toBe(170);
    expect(after.x - before.x).toBeCloseTo(100, 1);
    expect(after.y - before.y).toBeCloseTo(100, 1);
  });

  it("force layout also moves manual nodes", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    root.position = { x: 5000, y: 5000, manual: true };
    applyLayout(sheet, true);
    const r = model.rootNode;
    expect(r.position.x).not.toBe(5000);
  });

  it("children straddle the parent box and never overlap it", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    const a = addChild(model, root.id, "A");
    const b = addChild(model, root.id, "B");
    const c = addChild(model, root.id, "C");
    const res = layoutSheet(sheet);
    const gap = Math.max(6, sheet.structure.branchSpacing);
    const centerY = (id: string) => {
      const p = res.positions.get(id)!;
      return p.y + measureNode(model.node(id)!).h / 2;
    };
    const yA = centerY(a);
    const yB = centerY(b);
    const yC = centerY(c);
    const centers = [yA, yB, yC];
    // balanced straddle: one child above the root, two below
    const above = centers.filter((y) => y < 0).length;
    const below = centers.filter((y) => y > 0).length;
    expect(above).toBe(1);
    expect(below).toBe(2);
    // no child box may intersect the root box [-rootH/2, +rootH/2] minus the gap
    for (const y of centers) {
      const nearestEdge = Math.abs(y) - measureNode(root).h / 2; // approx
      expect(nearestEdge).toBeGreaterThan(gap - 1);
    }
  });
});

describe("size-aware balance", () => {
  it("splits root children by subtree height, not raw count", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    // A is much taller than B, C, D
    const a = addChild(model, root.id, "A tall branch");
    for (let i = 0; i < 30; i++) addChild(model, a, `deep ${i} with a long wrapping title that spans lines`);
    const b = addChild(model, root.id, "B");
    const c = addChild(model, root.id, "C");
    const d = addChild(model, root.id, "D");

    const res = layoutSheet(sheet);
    const p = (id: string) => res.positions.get(id)!;
    const rootBox = measureNode(model.node(root.id)!);
    const isRight = (id: string) => p(id).x > p(root.id).x + rootBox.w;

    // A alone carries most of the height → it gets the right side to itself
    expect(isRight(a)).toBe(true);
    // B, C, D (small) balance the left side
    expect(isRight(b)).toBe(false);
    expect(isRight(c)).toBe(false);
    expect(isRight(d)).toBe(false);
  });

  it("equal-height branches split evenly", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    const ids = ["A", "B", "C", "D"].map((t) => addChild(model, root.id, t));
    const res = layoutSheet(sheet);
    const rootBox = measureNode(model.node(root.id)!);
    const right = ids.filter((id) => res.positions.get(id)!.x > res.positions.get(root.id)!.x + rootBox.w);
    expect(right.length).toBe(2);
  });
});

describe("upward propagation", () => {
  it("a deep change grows the branch and redistributes siblings without overlap", () => {
    const model = makeMap();
    const sheet = model.sheet;
    const root = model.rootNode;
    const m1 = addChild(model, root.id, "M1");
    const m2 = addChild(model, root.id, "M2");
    const s1 = addChild(model, m1, "S1");
    const s2 = addChild(model, m1, "S2");

    const before = layoutSheet(sheet);
    expect(before.positions.has(m2)).toBe(true);
    const yBefore = before.positions.get(s2)!.y;

    // grow the S1 subtree (long wrapping titles make every node taller)
    for (let i = 0; i < 5; i++) addChild(model, s1, `deep ${i} ` + "word ".repeat(24));

    const after = layoutSheet(sheet);
    const yAfter = after.positions.get(s2)!.y;
    // the deep change propagated up: S2 moved (growth pushes the branch apart)
    expect(yAfter).not.toBe(yBefore);

    // and the S1 subtree never overlaps S2
    const s1BlockBottom = model.subtreeIds(s1).reduce((max, id) => {
      const p = after.positions.get(id);
      if (!p) return max;
      return Math.max(max, p.y + measureNode(model.node(id)!).h);
    }, -Infinity);
    expect(s1BlockBottom).toBeLessThanOrEqual(yAfter + 0.5);
  });
});

describe("structures", () => {
  it("tree layout stacks children horizontally below the parent", () => {
    const model = makeMap();
    const sheet = model.sheet;
    sheet.structure.structureType = "tree";
    sheet.structure.orientation = "vertical";
    const root = model.rootNode;
    const a = addChild(model, root.id, "A");
    const b = addChild(model, root.id, "B");
    const res = layoutSheet(sheet);
    const pA = res.positions.get(a)!;
    const pB = res.positions.get(b)!;
    const pRoot = res.positions.get(root.id)!;
    expect(pA.y).toBeGreaterThan(pRoot.y + measureNode(root).h); // below root
    expect(Math.abs(pA.y - pB.y)).toBeLessThan(2); // same row
    expect(pB.x).toBeGreaterThan(pA.x); // side by side
  });
});
