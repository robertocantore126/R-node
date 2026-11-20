import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { FREEFORM_HEADER, FREEFORM_PADDING, isFreeTransform } from "../src/core/freeform";
import { EditorStore } from "../src/editor/store";

function setup() {
  const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
  store.createFreeformTopic(store.sheet.rootNodeId);
  const board = store.doc.requireNode(store.getSnapshot().selection[0]);
  const a = store.createFreeformItem(board.id, board.position.x + 200, board.position.y + 150, "", undefined, "rect")!;
  store.cancelEdit?.();
  return { store, board, a };
}
const size = (store: EditorStore, id: string) => {
  const s = store.doc.requireNode(id).style;
  return [s.width ?? 720, s.height ?? 480];
};
/** Where a node sits on screen, in world units relative to the camera. */
const screen = (store: EditorStore, id: string) => {
  const n = store.doc.requireNode(id), cam = store.getSnapshot().camera;
  return [Math.round(n.position.x - cam.x), Math.round(n.position.y - cam.y)];
};
const drag = (store: EditorStore, id: string, corner: "nw" | "ne" | "sw" | "se", dx: number, dy: number) => {
  store.beginCanvasResize(id, corner);
  store.setCanvasResizeDraft(dx / 2, dy / 2); // a move on the way
  store.setCanvasResizeDraft(dx, dy);
  store.commitCanvasResize();
};

describe("canvas resize from every corner", () => {
  it("the bottom-right corner moves the right and bottom edges", () => {
    const { store, board } = setup();
    drag(store, board.id, "se", 100, 60);
    expect(size(store, board.id)).toEqual([820, 540]);
  });

  it("the top-left corner moves the left and top edges; the items stay where they are on screen", () => {
    const { store, board, a } = setup();
    const before = screen(store, a);
    drag(store, board.id, "nw", -100, -60);
    expect(size(store, board.id)).toEqual([820, 540]);
    expect(screen(store, a)).toEqual(before);
    store.undo();
    expect(size(store, board.id)).toEqual([720, 480]);
  });

  it("top-right and bottom-left mix the two", () => {
    const { store, board, a } = setup();
    const before = screen(store, a);
    drag(store, board.id, "ne", 40, -30);
    expect(size(store, board.id)).toEqual([760, 510]);
    drag(store, board.id, "sw", -50, 20);
    expect(size(store, board.id)).toEqual([810, 530]);
    expect(screen(store, a)).toEqual(before);
  });

  it("shrinking from the left or top stops at the content", () => {
    const { store, board, a } = setup();
    const at = store.doc.requireNode(a).style.freeformPosition!;
    drag(store, board.id, "nw", 5000, 5000);
    expect(store.doc.requireNode(a).style.freeformPosition).toEqual({ x: FREEFORM_PADDING, y: FREEFORM_HEADER + FREEFORM_PADDING });
    expect(size(store, board.id)).toEqual([720 - (at.x - FREEFORM_PADDING), 480 - (at.y - FREEFORM_HEADER - FREEFORM_PADDING)]);
  });

  it("an empty canvas shrinks to its smallest size from any corner", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const id = store.getSnapshot().selection[0];
    drag(store, id, "nw", 5000, 5000);
    expect(size(store, id)).toEqual([240, 160]);
  });

  it("Escape puts everything back, the view included", () => {
    const { store, board, a } = setup();
    const cam = { ...store.getSnapshot().camera }, pos = { ...store.doc.requireNode(a).style.freeformPosition! };
    store.beginCanvasResize(board.id, "nw");
    store.setCanvasResizeDraft(-120, -80);
    store.cancelCanvasResize();
    expect(size(store, board.id)).toEqual([720, 480]);
    expect(store.doc.requireNode(a).style.freeformPosition).toEqual(pos);
    expect(store.getSnapshot().camera).toMatchObject({ x: cam.x, y: cam.y });
  });

  it("a container inside a canvas grows left within it", () => {
    const { store, board } = setup();
    const c = store.createFreeformContainer(board.id, board.position.x + 450, board.position.y + 300)!;
    const at = { ...store.doc.requireNode(c).style.freeformPosition! };
    drag(store, c, "nw", -30, -20);
    expect(size(store, c)).toEqual([290, 190]);
    expect(store.doc.requireNode(c).style.freeformPosition).toEqual({ x: at.x - 30, y: at.y - 20 });
  });

  it("free-transform text resize scales fontSize and runs proportionally, anchoring the opposite corner, and undoes cleanly", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const textId = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 120, "Hello world")!;
    store.cancelEdit?.();
    store.setSelectionStyle({ freeTransform: true }, [textId]);

    const beforeGeo = store.itemGeometry(textId)!;
    const beforeFont = store.doc.requireNode(textId).style.fontSize ?? 14;
    expect(beforeFont).toBe(14);

    // Drag SE corner outward with Shift (keepRatio=true) -> ~1.5x proportional fontSize scale
    store.beginItemResize(textId, "se");
    store.setItemResizeDraft(beforeGeo.w * 0.5, beforeGeo.h * 0.5, true);
    store.commitItemResize();

    const after = store.doc.requireNode(textId);
    const afterGeo = store.itemGeometry(textId)!;
    expect(after.style.fontSize).toBe(21);
    expect(afterGeo.x).toBe(beforeGeo.x);
    expect(afterGeo.y).toBe(beforeGeo.y);
    expect(afterGeo.w).toBeGreaterThan(beforeGeo.w);

    // Drag NW corner outward with Shift -> SE corner stays anchored
    const seX = afterGeo.x + afterGeo.w;
    const seY = afterGeo.y + afterGeo.h;
    store.beginItemResize(textId, "nw");
    store.setItemResizeDraft(-afterGeo.w * 0.5, -afterGeo.h * 0.5, true);
    store.commitItemResize();

    const afterNw = store.itemGeometry(textId)!;
    expect(store.doc.requireNode(textId).style.fontSize).toBe(31.5);
    expect(Math.abs(afterNw.x + afterNw.w - seX)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterNw.y + afterNw.h - seY)).toBeLessThanOrEqual(2);

    // Undo restores previous size & position in one step
    store.undo();
    expect(store.doc.requireNode(textId).style.fontSize).toBe(21);
    expect(store.doc.requireNode(textId).style.freeformPosition).toEqual({ x: afterGeo.x, y: afterGeo.y });

    // Cancel restores pre-drag state
    store.beginItemResize(textId, "se");
    store.setItemResizeDraft(100, 100);
    store.cancelItemResize();
    expect(store.doc.requireNode(textId).style.fontSize).toBe(21);
  });

  it("stretching a width-only text box scales it once, not twice", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const id = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 120, "Hello world")!;
    store.cancelEdit?.();
    store.setNodeStyle(id, { width: 150 });
    const g0 = store.itemGeometry(id)!;
    store.beginItemResize(id, "e");
    store.setItemResizeDraft(g0.w, 0);
    store.commitItemResize();
    expect(store.doc.requireNode(id).style.textScaleX).toBe(2);
    expect(store.doc.requireNode(id).style.width).toBe(150); // the unstretched width
    expect(store.itemGeometry(id)!.w).toBe(300);
    // Shift-scaling a stretched box keeps the stretch applied once too.
    store.beginItemResize(id, "se");
    store.setItemResizeDraft(150, 0, true);
    store.commitItemResize();
    expect(store.doc.requireNode(id).style.width).toBe(225);
    expect(Math.abs(store.itemGeometry(id)!.w - 450)).toBeLessThanOrEqual(2);
  });

  it("a stretching edge lands on the canvas grid", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const id = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 120, "Hello world")!;
    store.cancelEdit?.();
    const g0 = store.itemGeometry(id)!;
    store.beginItemResize(id, "e");
    store.setItemResizeDraft(37, 0, false, 10);
    store.commitItemResize();
    const g1 = store.itemGeometry(id)!;
    const right = g1.x + g1.w;
    // On the 10 px grid, within the rounding of textScaleX to 1/100.
    expect(Math.abs(right - Math.round(right / 10) * 10)).toBeLessThanOrEqual(2);
    expect(g1.w).toBeGreaterThan(g0.w + 30);
  });

  it("free-transform edge handles stretch textScaleX/Y and rotation handle rotates with 15° snap and undo", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const textId = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 120, "Stretch me")!;
    store.cancelEdit?.();
    store.setSelectionStyle({ freeTransform: true }, [textId]);

    const beforeGeo = store.itemGeometry(textId)!;
    // Drag east edge outward by 100% of width -> textScaleX ≈ 2, fontSize unchanged
    store.beginItemResize(textId, "e");
    store.setItemResizeDraft(beforeGeo.w, 0);
    store.commitItemResize();

    const stretched = store.doc.requireNode(textId);
    expect(stretched.style.fontSize).toBeUndefined();
    expect(stretched.style.textScaleX).toBe(2);
    expect(store.itemGeometry(textId)!.w).toBeGreaterThanOrEqual(beforeGeo.w * 2 - 2);

    // Drag north edge upward by 50% of height -> 2× wide, 1.5× tall: the even
    // 1.5 goes into the font, the rest stays a stretch; bottom stays anchored.
    const geoBeforeN = store.itemGeometry(textId)!;
    const bottomY = geoBeforeN.y + geoBeforeN.h;
    store.beginItemResize(textId, "n");
    store.setItemResizeDraft(0, -geoBeforeN.h * 0.5);
    store.commitItemResize();

    expect(store.doc.requireNode(textId).style.fontSize).toBe(21);
    expect(store.doc.requireNode(textId).style.textScaleX).toBeCloseTo(4 / 3, 2);
    expect(store.doc.requireNode(textId).style.textScaleY).toBeUndefined();
    const geoAfterN = store.itemGeometry(textId)!;
    expect(Math.abs(geoAfterN.y + geoAfterN.h - bottomY)).toBeLessThanOrEqual(2);

    // Rotate with 15° snap
    store.beginItemRotate(textId);
    store.setItemRotateDraft(43, true);
    store.commitItemRotate();
    expect(store.doc.requireNode(textId).style.rotation).toBe(45);

    store.undo();
    expect(store.doc.requireNode(textId).style.rotation).toBeUndefined();

    // Cancel rotate restores previous rotation
    store.beginItemRotate(textId);
    store.setItemRotateDraft(30, false);
    store.cancelItemRotate();
    expect(store.doc.requireNode(textId).style.rotation).toBeUndefined();

    // Drag SE corner without Shift -> changes width and height independently (no ratio lock)
    // (compared as total scale per axis: font size × stretch).
    const total = (): [number, number] => {
      const s = store.doc.requireNode(textId).style, f = (s.fontSize ?? 14) / 14;
      return [f * (s.textScaleX ?? 1), f * (s.textScaleY ?? 1)];
    };
    const curGeo = store.itemGeometry(textId)!;
    const [cx0, cy0] = total();
    store.beginItemResize(textId, "se");
    store.setItemResizeDraft(curGeo.w * 0.5, curGeo.h * 0.25, false);
    store.commitItemResize();
    const [cx1, cy1] = total();
    expect(cx1).toBeCloseTo(cx0 * 1.5, 1);
    expect(cy1).toBeCloseTo(cy0 * 1.25, 1);
  });

  const freshItem = (shape?: "rect") => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const id = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 120, "Grow me", undefined, shape)!;
    store.cancelEdit?.();
    return { store, id };
  };

  it("keeps its line breaks when scaled far up or down (no re-wrap at 280 px)", () => {
    const store = new EditorStore({ label: "test", async load() { return []; }, async save() {} });
    store.createFreeformTopic(store.sheet.rootNodeId);
    const board = store.doc.requireNode(store.getSnapshot().selection[0]);
    const one = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 120, "digimon")!;
    const many = store.createFreeformItem(board.id, board.position.x + 120, board.position.y + 300, "A longer note that wraps over a few lines at the default size of fourteen pixels")!;
    store.cancelEdit?.();
    for (const id of [one, many]) {
      for (const k of [4, 0.5]) {
        const g0 = store.itemGeometry(id)!;
        store.beginItemResize(id, "se");
        store.setItemResizeDraft(g0.w * (k - 1), g0.h * (k - 1), true);
        store.commitItemResize();
        const g1 = store.itemGeometry(id)!;
        // Same lines: the height scales with the font. A re-wrap adds or
        // drops a whole line (font × ~1.2); fixed constants (the +4 px strut
        // margin) move it by far less than half of one.
        const line = (store.doc.requireNode(id).style.fontSize ?? 14) * 1.2;
        expect(Math.abs(g1.h - g0.h * k)).toBeLessThan(line * 0.4);
      }
    }
  });

  it("folds the even part of a stretch into the font size, with no 5× cap", () => {
    const { store, id } = freshItem();
    const g = store.itemGeometry(id)!;
    // Corner without Shift to 6× wide, 3× tall: font 3×, stretch 2× in X.
    store.beginItemResize(id, "se");
    store.setItemResizeDraft(g.w * 5, g.h * 2);
    store.commitItemResize();
    const s = store.doc.requireNode(id).style;
    expect(s.fontSize).toBe(42);
    expect(s.textScaleX).toBeCloseTo(2, 2);
    expect(s.textScaleY).toBeUndefined();
    // An edge alone goes past the old 5× limit.
    const g1 = store.itemGeometry(id)!;
    store.beginItemResize(id, "e");
    store.setItemResizeDraft(g1.w * 7, 0);
    store.commitItemResize();
    expect(store.doc.requireNode(id).style.textScaleX).toBeCloseTo(16, 1);
    expect(Math.abs(store.itemGeometry(id)!.w - g1.w * 8)).toBeLessThanOrEqual(8);
  });

  it("scales the text of a shape in a canvas with its box", () => {
    const { store, id } = freshItem("rect");
    const g = store.itemGeometry(id)!;
    store.beginItemResize(id, "se");
    store.setItemResizeDraft(g.w, g.h, true);
    store.commitItemResize();
    const s = store.doc.requireNode(id).style;
    expect(s.fontSize).toBe(28);
    expect([s.width, s.height]).toEqual([g.w * 2, g.h * 2]);
    // Opting out restores the plain box resize: the text keeps its size.
    store.setSelectionStyle({ freeTransform: false }, [id]);
    store.beginItemResize(id, "se");
    store.setItemResizeDraft(g.w, 0);
    store.commitItemResize();
    expect(store.doc.requireNode(id).style.fontSize).toBe(28);
    expect(store.doc.requireNode(id).style.width).toBe(g.w * 3);
  });

  it("only items of a canvas use free transform", () => {
    const { store, id } = freshItem("rect");
    expect(isFreeTransform(store.sheet, store.doc.requireNode(id))).toBe(true);
    const topic = store.doc.requireNode(store.sheet.rootNodeId);
    expect(isFreeTransform(store.sheet, { ...topic, style: { ...topic.style, freeTransform: true } })).toBe(false);
  });
});
