/**
 * Diagram stress test — builds a heavy draw.io-style diagram through the same
 * paths the user takes, then measures what it costs to edit, lay out, paint
 * and keep it.
 *
 * Same rules as `stress.ts` (whose text and picture helpers it reuses):
 *  - Real paths only. Shapes and Tab arrows go through `execOps` (so the Tab
 *    tree layout, page fitting and canvas growth all run), galleries and
 *    charts through `createGalleryTopic` / `createChartTopic`, pictures through
 *    `addGalleryImageFiles` and `attachImageFile` (worker decode, three levels,
 *    asset store), long texts through the editor commit (reading width).
 *  - Every picture has DIFFERENT bytes (variantOf): assets are addressed by
 *    SHA-256, so copies would collapse into a handful of assets and the test
 *    would measure nothing while appearing to pass.
 *  - Titles vary in shape (short, long, paragraphs, lists) because wrapping
 *    cost is not linear in characters.
 *  - Per-step costs are reported as first half vs second half, not only as an
 *    average: a cost that grows with the document hides in a mean.
 *
 * From the console of the running app (dev server):
 *
 *   const built = await __rnode.stressDiagram()            // ~2000 pictures
 *   const numbers = await __rnode.measureDiagram()
 *   await __rnode.stressDiagram({ images: 500, trees: 10 }) // a lighter one
 */

import { uid } from "../core/doc";
import { makeOp, type Op } from "../core/ops";
import { FREEFORM_SHAPES, FREEFORM_SHAPE_SIZES, type FreeformShape } from "../core/freeform";
import type { MindNode, Style, TextRun } from "../core/types";
import type { EditorStore } from "../editor/store";
import { layoutSheet } from "../layout/mindmap";
import { encodeScene, makeTitle, seeded, variantOf, words } from "./stress";

export interface DiagramStressOptions {
  /** Separate Tab trees on the page. */
  trees?: number;
  /** Shapes per tree (its root included). */
  shapesPerTree?: number;
  /** Children per shape in a tree. */
  branch?: number;
  /** Pictures in total, spread over galleries, charts and loose pictures. */
  images?: number;
  /** Galleries (each takes an equal share of GALLERY_SHARE of the pictures). */
  galleries?: number;
  /** Charts (2x3, filled). */
  charts?: number;
  /** Shapes that get a long pasted paragraph (2-4k characters). */
  longTexts?: number;
  /** Share of shapes that carry notes. */
  notesShare?: number;
  /** Long side of each picture, px. */
  imageLongSide?: number;
  /** Distinct scenes to encode (pictures beyond reuse them with new bytes). */
  bases?: number;
  /** Noise 0..1: drives the FILE size of each picture. */
  noise?: number;
  onProgress?: (fraction: number, label: string) => void;
}

export interface DiagramStressReport {
  shapes: number;
  treeArrows: number;
  galleries: number;
  charts: number;
  galleryPictures: number;
  chartPictures: number;
  loosePictures: number;
  picturesRejected: number;
  distinctAssets: number;
  imageMB: number;
  textChars: number;
  longTexts: number;
  pages: string;
  shapesBatchMs: number;
  specialsMs: number;
  longTextMs: number;
  /** attachImageFile per loose picture: first half vs second half (ms, p50 / p95). */
  loosePictureMs: { firstHalf: Percentiles; secondHalf: Percentiles };
  galleryBatchMs: Percentiles;
  imagesTotalMs: number;
  totalMs: number;
}

export interface Percentiles { n: number; p50: number; p95: number; max: number; mean: number }

export interface DiagramMeasureReport {
  nodes: number;
  layoutMs: Percentiles;
  /** One edit of a shape's text, committed (execOps + tree relayout + page fit). */
  editTitleMs: Percentiles;
  /** One Tab on a shape deep inside a big tree. */
  tabMs: Percentiles;
  undoMs: Percentiles;
  /** Drag-onto re-parent of a shape with its subtree, and its undo. */
  reparentMs: Percentiles;
  /** Delete a tree root (cascades its whole Tab tree), and its undo. */
  deleteTreeMs: number;
  undoDeleteTreeMs: number;
  /** Real mouse-drag panning at each zoom (goes through CanvasView pan gesture
   *  and the scene-cache pixel copy), plus what the tracer reported. 16.7 ms = 60 fps. */
  paint: {
    zoom: string;
    visible: number | null;
    pictures: number | null;
    arrows: number | null;
    sceneBlit: string | null;
    renderMaxMs: number | null;
    frameMs: Percentiles;
  }[];
  /** Real wheel-zoom via WheelEvent (goes through wheelZoomFactor, motionQuality
   *  zoom blit, and the crisp settle repaint when the wheel stops). */
  wheelZoom: {
    steps: number;
    fromZoom: string;
    toZoom: string;
    sceneBlit: string | null;
    renderMaxMs: number | null;
    frameMs: Percentiles;
    settleMs: number;
  };
  longTasks: number;
  longTaskMs: number;
  serializeMs: number;
  sheetJsonMB: number;
  heapMB: number | null;
}

const GALLERY_SHARE = 0.3;

function pct(values: number[]): Percentiles {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const r = (v: number): number => Math.round(v * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

/** A long paragraph, the kind a paste brings (2-4k characters, a few paragraphs). */
function longParagraph(rnd: () => number): string {
  const paras = 3 + Math.floor(rnd() * 3);
  const out: string[] = [];
  for (let p = 0; p < paras; p++) out.push(words(rnd, 80 + Math.floor(rnd() * 70)) + ".");
  return out.join("\n");
}

/** The page of the open diagram, or throws: the measures need one. */
function pageOf(store: EditorStore): MindNode {
  const root = store.sheet.nodes[store.sheet.rootNodeId];
  if (store.sheet.structure.structureType !== "diagram" || !root?.style.freeform) {
    throw new Error("Open a diagram first (or run __rnode.stressDiagram()).");
  }
  return root;
}

export async function generateStressDiagram(store: EditorStore, opts: DiagramStressOptions = {}): Promise<DiagramStressReport> {
  const trees = opts.trees ?? 30;
  const perTree = opts.shapesPerTree ?? 40;
  const branch = opts.branch ?? 4;
  const images = opts.images ?? 2000;
  const galleryCount = opts.galleries ?? 20;
  const chartCount = opts.charts ?? 20;
  const longTexts = opts.longTexts ?? 60;
  const notesShare = opts.notesShare ?? 0.3;
  const progress = opts.onProgress ?? (() => {});
  const rnd = seeded(20261125);
  const t0 = performance.now();

  store.newDocument("diagram");
  const page = pageOf(store);
  // The starting empty shape stays: a loose shape on the page.

  // --- shapes and Tab arrows, ONE batch -------------------------------------
  // Tree roots sit on a grid far enough apart that their trees do not cross;
  // every other shape starts on its root and the Tab layout places it (that
  // relayout is part of what the batch costs).
  const ops: Op[] = [];
  const shapeIds: string[] = [];
  const treeRoots: string[] = [];
  let textChars = 0;
  let treeArrows = 0;
  const shapes = FREEFORM_SHAPES.map((s) => s.shape).filter((s) => s !== "actor");
  const pick = (): FreeformShape => shapes[Math.floor(rnd() * shapes.length)];
  const COLS = 6;
  for (let t = 0; t < trees; t++) {
    const origin = { x: 120 + (t % COLS) * 2200, y: 200 + Math.floor(t / COLS) * 3600 };
    const queue: string[] = [];
    for (let k = 0; k < perTree; k++) {
      const id = uid("n");
      const shape = pick();
      const size = FREEFORM_SHAPE_SIZES[shape];
      const { title, runs } = makeTitle(rnd, shapeIds.length);
      textChars += title.length;
      const style: Style = { shape, width: size.w, height: size.h, borderWidth: 1.5, align: "center", freeformPosition: { ...origin } };
      ops.push(makeOp<Op & { type: "createNode" }>("createNode", {
        id, nodeType: "subtopic", parentId: page.id, index: page.childrenIds.length + shapeIds.length,
        title, titleRuns: runs as TextRun[], style,
        position: { x: page.position.x + origin.x, y: page.position.y + origin.y, manual: false },
      }));
      if (rnd() < notesShare) {
        const notes = words(rnd, 30 + Math.floor(rnd() * 90));
        textChars += notes.length;
        ops.push(makeOp<Op & { type: "setNotes" }>("setNotes", { id, notes, prev: "" }));
      }
      if (k === 0) treeRoots.push(id);
      else {
        // Breadth-first: each parent takes `branch` children in turn.
        const parent = queue[Math.floor((k - 1) / branch)];
        ops.push(makeOp<Op & { type: "createRelationship" }>("createRelationship", {
          relationship: {
            id: uid("rel"), fromId: parent, toId: id, tree: true,
            connector: "elbow", lineStyle: "solid", endArrow: "triangle",
            fromAnchor: { x: 1, y: 0.5 }, toAnchor: { x: 0, y: 0.5 },
          },
        }));
        treeArrows++;
      }
      queue.push(id);
      shapeIds.push(id);
    }
  }
  progress(0.02, `${shapeIds.length} shapes, ${treeArrows} Tab arrows built, applying…`);
  const tShapes = performance.now();
  store.execOps(ops);
  const shapesBatchMs = performance.now() - tShapes;
  progress(0.05, `shapes applied in ${Math.round(shapesBatchMs)}ms`);

  // --- galleries and charts, as Tab children of tree shapes -----------------
  const tSpecial = performance.now();
  const hosts = (n: number, salt: number): string[] =>
    Array.from({ length: n }, (_, i) => shapeIds[(i * 7919 + salt) % shapeIds.length]);
  const before = new Set(store.sheet.nodes[page.id].childrenIds);
  for (const host of hosts(galleryCount, 11)) store.createGalleryTopic(host);
  const galleryIds = store.sheet.nodes[page.id].childrenIds.filter((id) => !before.has(id) && store.sheet.nodes[id].style.gallery);
  const before2 = new Set(store.sheet.nodes[page.id].childrenIds);
  for (const host of hosts(chartCount, 29)) store.createChartTopic(host);
  const chartIds = store.sheet.nodes[page.id].childrenIds.filter((id) => !before2.has(id) && store.sheet.nodes[id].style.gallery?.chart);
  const specialsMs = performance.now() - tSpecial;
  progress(0.08, `${galleryIds.length} galleries, ${chartIds.length} charts in ${Math.round(specialsMs)}ms`);

  // --- long pasted texts, through the editor commit -------------------------
  const tLong = performance.now();
  const longHosts = hosts(longTexts, 53);
  for (const id of longHosts) {
    const text = longParagraph(rnd);
    textChars += text.length;
    store.select(id);
    store.startEdit(id);
    store.setEditingDraft(text);
    store.commitEdit();
  }
  store.clearSelection();
  const longTextMs = performance.now() - tLong;
  progress(0.1, `${longHosts.length} long texts committed in ${Math.round(longTextMs)}ms`);

  // --- pictures -------------------------------------------------------------
  const tImg = performance.now();
  const sceneCount = Math.max(1, Math.min(opts.bases ?? 16, images));
  const scenes: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < sceneCount; i++) scenes.push(await encodeScene(rnd, opts.imageLongSide ?? 720, opts.noise ?? 0.3));
  let seq = 0;
  let imageBytes = 0;
  const nextFile = (): Blob & { name: string } => {
    const blob = variantOf(scenes[seq % sceneCount], seq);
    imageBytes += blob.size;
    return Object.assign(blob, { name: `diagram-stress-${seq++}.jpg` });
  };
  let rejected = 0;

  // Charts: every slot (2x3 = 6).
  let chartPictures = 0;
  for (const id of chartIds) {
    const slots = store.sheet.nodes[id].style.gallery?.items.length ?? 6;
    const res = await store.addGalleryImageFiles(id, Array.from({ length: slots }, nextFile));
    chartPictures += res.added;
    rejected += res.failed;
  }
  // Galleries: their share, in one batch each (the drop of several files).
  let galleryPictures = 0;
  const galleryBatch: number[] = [];
  const perGallery = galleryIds.length ? Math.floor((images * GALLERY_SHARE) / galleryIds.length) : 0;
  for (const id of galleryIds) {
    const t = performance.now();
    const res = await store.addGalleryImageFiles(id, Array.from({ length: perGallery }, nextFile));
    galleryBatch.push(performance.now() - t);
    galleryPictures += res.added;
    rejected += res.failed;
  }
  progress(0.3, `${chartPictures} chart + ${galleryPictures} gallery pictures`);
  // The rest: pasted on shapes, each a loose picture of the page beside it.
  const loose = Math.max(0, images - chartPictures - galleryPictures);
  const looseMs: number[] = [];
  let loosePictures = 0;
  for (let k = 0; k < loose; k++) {
    const host = shapeIds[(k * 104729) % shapeIds.length];
    const t = performance.now();
    const res = await store.attachImageFile(host, nextFile());
    looseMs.push(performance.now() - t);
    if (res.ok) loosePictures++;
    else rejected++;
    if (k % 50 === 0) progress(0.3 + (0.7 * k) / loose, `loose picture ${k}/${loose} (last ${Math.round(looseMs[looseMs.length - 1])}ms)`);
  }
  const imagesTotalMs = performance.now() - tImg;

  const p = store.sheet.nodes[page.id];
  const half = Math.floor(looseMs.length / 2);
  const report: DiagramStressReport = {
    shapes: p.childrenIds.length,
    treeArrows: store.sheet.relationships.filter((r) => r.tree).length,
    galleries: galleryIds.length,
    charts: chartIds.length,
    galleryPictures,
    chartPictures,
    loosePictures,
    picturesRejected: rejected,
    distinctAssets: new Set(store.sheet.attachments.map((a) => a.id)).size,
    imageMB: Math.round((imageBytes / 1048576) * 10) / 10,
    textChars,
    longTexts: longHosts.length,
    pages: `${Math.round((p.style.width ?? 0) / 827)} x ${Math.round((p.style.height ?? 0) / 1169)}`,
    shapesBatchMs: Math.round(shapesBatchMs),
    specialsMs: Math.round(specialsMs),
    longTextMs: Math.round(longTextMs),
    loosePictureMs: { firstHalf: pct(looseMs.slice(0, half)), secondHalf: pct(looseMs.slice(half)) },
    galleryBatchMs: pct(galleryBatch),
    imagesTotalMs: Math.round(imagesTotalMs),
    totalMs: Math.round(performance.now() - t0),
  };
  progress(1, "done");
  return report;
}

/**
 * Measure the open diagram: layout, edits, Tab, re-parent, delete + undo,
 * painting while panning at three zooms, serialisation and heap. Every edit
 * is undone, so the document ends as it started.
 */
export async function measureDiagram(store: EditorStore, opts: { samples?: number; panFrames?: number } = {}): Promise<DiagramMeasureReport> {
  const page = pageOf(store);
  const samples = opts.samples ?? 10;
  const panFrames = opts.panFrames ?? 12;
  const sheet = store.sheet;
  const timed = (f: () => void): number => { const t = performance.now(); f(); return performance.now() - t; };

  const longTasks: number[] = [];
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); });
    observer.observe({ type: "longtask", buffered: false });
  } catch { /* no long-task timing in this browser */ }

  // Each sample runs in a task of its own: back to back they would add up to
  // one long task that the app never has (a harness artefact, measured once
  // at 1.6 s).
  const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  // Layout of the whole sheet (what every relayout costs).
  const layoutMs: number[] = [];
  for (let i = 0; i < 5; i++) { layoutMs.push(timed(() => layoutSheet(store.sheet, true))); await breathe(); }

  // The shapes with the biggest Tab subtree, and a deep leaf-ish shape in it.
  const tab = sheet.relationships.filter((r) => r.tree);
  const kids = new Map<string, string[]>();
  for (const r of tab) kids.set(r.fromId, [...(kids.get(r.fromId) ?? []), r.toId]);
  const hasParent = new Set(tab.map((r) => r.toId));
  const roots = page.childrenIds.filter((id) => kids.has(id) && !hasParent.has(id));
  const sizeOf = (id: string): number => (store.diagramDescendants(id).length);
  roots.sort((a, b) => sizeOf(b) - sizeOf(a));
  const bigRoot = roots[0];
  if (!bigRoot) throw new Error("No Tab tree in this diagram to measure.");
  const deep = store.diagramDescendants(bigRoot).at(-1)!;
  const mid = kids.get(bigRoot)![0];

  // Edit a title, committed through the editor; then undo.
  const editTitleMs: number[] = [];
  const undoMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    editTitleMs.push(timed(() => {
      store.select(deep);
      store.startEdit(deep);
      store.setEditingDraft(`edited ${i} ` + "parola ".repeat(i % 5));
      store.commitEdit();
    }));
    undoMs.push(timed(() => store.undo()));
    await breathe();
  }
  // Tab on the deep shape; then undo.
  const tabMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    tabMs.push(timed(() => store.diagramTab(deep)));
    undoMs.push(timed(() => store.undo()));
    await breathe();
  }
  // Re-parent a branch (with its subtree) onto another tree's root; undo.
  const reparentMs: number[] = [];
  const other = roots[1] ?? roots[0];
  for (let i = 0; i < Math.min(samples, 5); i++) {
    reparentMs.push(timed(() => store.diagramReparent(mid, other)));
    undoMs.push(timed(() => store.undo()));
    await breathe();
  }
  // Delete the biggest tree (cascade) and bring it back.
  const deleteTreeMs = timed(() => store.deleteNodes([bigRoot]));
  await breathe();
  const undoDeleteTreeMs = timed(() => store.undo());
  await breathe();
  store.clearSelection();

  // Painting, read from the app's own tracer (render:frame: the real paint
  // time and how many topics, pictures and arrows it drew) plus the wall time
  // between animation frames. Patching Renderer.prototype here measured
  // nothing: after a hot update the app can hold a different copy of the
  // class than this module imports, and it reported 6 ms frames while the app
  // spent 600. Each zoom pans across the CENTRE of the drawing (a corner can
  // be empty paper and flatter the number).
  const paint: DiagramMeasureReport["paint"] = [];
  const p = store.sheet.nodes[page.id];
  const fit = Math.min(window.innerWidth / (p.style.width ?? 827), window.innerHeight / (p.style.height ?? 1169));
  // The store REPLACES its state object on every notify: read it afresh each
  // time. A reference kept across notify() wrote the camera into a discarded
  // copy, so the view never moved and every zoom "measured" the same frame.
  type Cam = { x: number; y: number; scale: number };
  const live = (): { camera: Cam } => (store as unknown as { state: { camera: Cam } }).state;
  const notify = (): void => (store as unknown as { notify(): void }).notify();
  const tracer = (window as unknown as { __rnodeTrace?: { capture(): { events: Record<string, unknown>[] } } }).__rnodeTrace;
  const saved = { ...live().camera };
  const canvas = document.querySelector("canvas");
  const wheelTarget = canvas?.parentElement ?? canvas;
  const rect = canvas?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  // Far out: the middle of the page. Close up: the biggest tree (the middle
  // of a page this size is often empty paper, which flatters the number).
  const middle = { x: p.position.x + (p.style.width ?? 0) / 2, y: p.position.y + (p.style.height ?? 0) / 2 };
  const treeAt = p.childrenIds.includes(bigRoot) ? store.sheet.nodes[bigRoot].style.freeformPosition : undefined;
  const tree = treeAt ? { x: p.position.x + treeAt.x + 300, y: p.position.y + treeAt.y } : middle;
  let wheelZoom: DiagramMeasureReport["wheelZoom"] = {
    steps: 0,
    fromZoom: "0%",
    toZoom: "0%",
    sceneBlit: null,
    renderMaxMs: null,
    frameMs: pct([]),
    settleMs: 0,
  };
  try {
    for (const scale of [1, 0.5, 0.25, 0.15, 0.1, 0.05, fit]) {
      const { x: cx, y: cy } = scale >= 0.5 ? tree : middle;
      // Land on the zoom and warm the scene cache with one full frame before
      // starting the real mouse-drag pan.
      live().camera = { scale, x: cx, y: cy };
      notify();
      await nextFrame();
      await nextFrame();

      const t0 = performance.now();
      const gaps: number[] = [];
      let ptrX = centerX;
      let ptrY = centerY;
      if (canvas) {
        canvas.dispatchEvent(new PointerEvent("pointerdown", {
          button: 1, buttons: 4, pointerId: 1, clientX: ptrX, clientY: ptrY, bubbles: true, cancelable: true,
        }));
      }
      let last = await nextFrame();
      for (let f = 0; f < panFrames; f++) {
        ptrX -= 40;
        ptrY -= 25;
        if (canvas) {
          canvas.dispatchEvent(new PointerEvent("pointermove", {
            buttons: 4, pointerId: 1, clientX: ptrX, clientY: ptrY, bubbles: true, cancelable: true,
          }));
        } else {
          store.panBy(-40, -25);
        }
        const now = await nextFrame();
        gaps.push(now - last);
        last = now;
      }
      if (canvas) {
        canvas.dispatchEvent(new PointerEvent("pointerup", {
          button: 1, buttons: 0, pointerId: 1, clientX: ptrX, clientY: ptrY, bubbles: true, cancelable: true,
        }));
      }
      const frames = (tracer?.capture().events ?? []).filter((e) => e.what === "render:frame" && (e.t as number) >= t0);
      const lastFrame = frames.at(-1) ?? {};
      paint.push({
        zoom: `${Math.round(scale * 1000) / 10}%`,
        visible: (lastFrame.visible as number) ?? null,
        pictures: (lastFrame.imgVisible as number) ?? null,
        arrows: (lastFrame.relsDrawn as number) ?? null,
        sceneBlit: (lastFrame.sceneBlit as string) ?? null,
        renderMaxMs: frames.length ? Math.round(Math.max(...frames.map((e) => e.maxMs as number))) : null,
        frameMs: pct(gaps.slice(1)), // the first gap includes pointerdown
      });
    }

    // Real wheel zoom: start at 50% over the middle, fire Ctrl+Wheel ticks
    // through CanvasView's real onWheel -> wheelZoomFactor -> store.zoomAt path,
    // then wait for the crisp post-wheel settle repaint.
    live().camera = { scale: 0.5, x: middle.x, y: middle.y };
    notify();
    await nextFrame();
    await nextFrame();
    const fromScale = live().camera.scale;
    const tWheel = performance.now();
    const wheelGaps: number[] = [];
    const wheelSteps = Math.max(8, panFrames);
    let lastW = await nextFrame();
    for (let f = 0; f < wheelSteps; f++) {
      if (wheelTarget) {
        wheelTarget.dispatchEvent(new WheelEvent("wheel", {
          ctrlKey: true, deltaY: 120, deltaMode: 0, clientX: centerX, clientY: centerY, bubbles: true, cancelable: true,
        }));
      }
      const now = await nextFrame();
      wheelGaps.push(now - lastW);
      lastW = now;
    }
    const wheelFrames = (tracer?.capture().events ?? []).filter((e) => e.what === "render:frame" && (e.t as number) >= tWheel);
    const lastWheelFrame = wheelFrames.at(-1) ?? {};
    const toScale = live().camera.scale;
    // Wait for CanvasView's 120ms wheel-zoom settle timer + repaint frame.
    const tSettle = performance.now();
    await new Promise((r) => setTimeout(r, 180));
    await nextFrame();
    const settleFrames = (tracer?.capture().events ?? []).filter((e) => e.what === "render:frame" && (e.t as number) >= tSettle);
    const settleMs = settleFrames.length ? Math.round(Math.max(...settleFrames.map((e) => e.maxMs as number))) : 0;
    wheelZoom = {
      steps: wheelSteps,
      fromZoom: `${Math.round(fromScale * 1000) / 10}%`,
      toZoom: `${Math.round(toScale * 1000) / 10}%`,
      sceneBlit: (lastWheelFrame.sceneBlit as string) ?? null,
      renderMaxMs: wheelFrames.length ? Math.round(Math.max(...wheelFrames.map((e) => e.maxMs as number))) : null,
      frameMs: pct(wheelGaps),
      settleMs,
    };
  } finally {
    live().camera = saved;
    notify();
  }

  let json = "";
  const serializeMs = timed(() => { json = JSON.stringify(store.sheet); });
  observer?.disconnect();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return {
    nodes: Object.keys(store.sheet.nodes).length,
    layoutMs: pct(layoutMs),
    editTitleMs: pct(editTitleMs),
    tabMs: pct(tabMs),
    undoMs: pct(undoMs),
    reparentMs: pct(reparentMs),
    deleteTreeMs: Math.round(deleteTreeMs),
    undoDeleteTreeMs: Math.round(undoDeleteTreeMs),
    paint,
    wheelZoom,
    longTasks: longTasks.length,
    longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
    serializeMs: Math.round(serializeMs),
    sheetJsonMB: Math.round((json.length / 1048576) * 10) / 10,
    heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
  };
}
