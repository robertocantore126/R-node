/**
 * Stress-map generator — builds a deliberately punishing document so the app
 * can be measured under load instead of guessed about.
 *
 * It drives the SAME public paths the user does: `createNode` ops through
 * `execOps`, and `attachImageFile` for every picture, so the worker, the three
 * decode levels and the asset store all get exercised. A generator that wrote
 * straight into the sheet would produce a map the real code has never built
 * and would hide exactly the costs we are hunting.
 *
 * Run it from the console:
 *
 *   await window.__rnode.stress()                       // defaults
 *   await window.__rnode.stress({ nodes: 20000, images: 800 })
 */

import { uid } from "../core/doc";
import { makeOp } from "../core/ops";
import type { Op } from "../core/ops";
import type { TextRun } from "../core/types";
import type { EditorStore } from "../editor/store";

export interface StressOptions {
  /** Topics to create (the root is extra). */
  nodes?: number;
  /** How many of them get a picture. */
  images?: number;
  /** Long side of each generated picture, in pixels. */
  imageLongSide?: number;
  /** Distinct scenes to encode. Pictures beyond this reuse them (see variantOf). */
  bases?: number;
  /** Noise strength 0..1. Drives FILE SIZE — 0 gives ~30KB, 0.45 gives ~1MB. */
  noise?: number;
  /** Children per topic. Lower = deeper and narrower. */
  branch?: number;
  /** Called with a 0..1 fraction and a label, for a console heartbeat. */
  onProgress?: (fraction: number, label: string) => void;
}

export interface StressReport {
  nodes: number;
  images: number;
  imageBytes: number;
  distinctAssets: number;
  textChars: number;
  opsMs: number;
  imagesMs: number;
  totalMs: number;
}

// --------------------------------------------------------------------------
// Text
// --------------------------------------------------------------------------

const WORDS =
  "sistema modulo canvas nodo layout misura vincolo confine indice traccia sorgente struttura progetto verifica ipotesi risultato memoria formato immagine documento superficie proporzione linea blocco radice ramo foglia dettaglio sintesi".split(
    " "
  );

function words(rnd: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += (i ? " " : "") + WORDS[Math.floor(rnd() * WORDS.length)];
  return out;
}

/**
 * A realistic spread of title shapes. Wrapping cost is not linear in character
 * count — a two-paragraph title with a bullet list runs through far more of
 * `wrapRunLines` than one long line does — so a corpus of uniform labels would
 * flatter the layout and tell us nothing.
 */
function makeTitle(rnd: () => number, i: number): { title: string; runs: TextRun[] } {
  const roll = rnd();
  if (roll < 0.4) {
    const t = `${words(rnd, 2 + Math.floor(rnd() * 3))} ${i}`;
    return { title: t, runs: [{ text: t }] };
  }
  if (roll < 0.75) {
    const t = words(rnd, 10 + Math.floor(rnd() * 8));
    return { title: t, runs: [{ text: t }] };
  }
  if (roll < 0.95) {
    const a = words(rnd, 12);
    const b = words(rnd, 10);
    const c = words(rnd, 14);
    const runs: TextRun[] = [
      { text: a + " " },
      { text: b, bold: true },
      { text: "\n" + c, paraGap: true },
    ];
    return { title: a + " " + b + "\n" + c, runs };
  }
  const head = words(rnd, 6);
  const items = [0, 1, 2, 3, 4].map(() => words(rnd, 8 + Math.floor(rnd() * 6)));
  const runs: TextRun[] = [{ text: head, bold: true }];
  let plain = head;
  for (const it of items) {
    runs.push({ text: "\n" + it, listIndent: 1, paraGap: true });
    plain += "\n" + it;
  }
  runs.push({ text: "\n" + words(rnd, 12), paraGap: true, italic: true });
  plain += "\n" + runs[runs.length - 1].text.slice(1);
  return { title: plain, runs };
}

// --------------------------------------------------------------------------
// Images
// --------------------------------------------------------------------------

/**
 * Draws one high-resolution scene and encodes it as a JPEG.
 *
 * The noise overlay is there to make the FILE big, not to look interesting.
 * Flat gradients and rectangles compress to about 30KB at 2400px, twenty times
 * smaller than a real photograph, so a map built from them would exercise the
 * node and decode paths honestly while quietly understating every byte figure
 * — storage, save time, transfer. High-frequency noise defeats the DCT and
 * lands in the megabyte range, where real pictures live.
 */
async function encodeScene(rnd: () => number, longSide: number, noise: number): Promise<Uint8Array<ArrayBuffer>> {
  const w = longSide;
  const h = Math.round(longSide * (0.6 + rnd() * 0.15));
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

  const hue = Math.floor(rnd() * 360);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 70% 60%)`);
  g.addColorStop(1, `hsl(${(hue + 90) % 360} 60% 30%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)} 65% ${30 + rnd() * 45}% / 0.55)`;
    const bw = w * (0.05 + rnd() * 0.3);
    const bh = h * (0.05 + rnd() * 0.3);
    ctx.fillRect(rnd() * (w - bw), rnd() * (h - bh), bw, bh);
  }

  if (noise > 0) {
    // One small tile, tiled over the frame: full-frame createImageData at this
    // resolution means a 15MB typed array per scene for no extra realism.
    const tile = new OffscreenCanvas(256, 256);
    const tctx = tile.getContext("2d") as unknown as CanvasRenderingContext2D;
    const px = tctx.createImageData(256, 256);
    for (let i = 0; i < px.data.length; i += 4) {
      px.data[i] = rnd() * 255;
      px.data[i + 1] = rnd() * 255;
      px.data[i + 2] = rnd() * 255;
      px.data[i + 3] = 255;
    }
    tctx.putImageData(px, 0, 0);
    const pattern = ctx.createPattern(tile as unknown as CanvasImageSource, "repeat");
    if (pattern) {
      ctx.globalAlpha = noise;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }

  const blob =
    "convertToBlob" in canvas
      ? await (canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: 0.85 })
      : await new Promise<Blob>((resolve, reject) => {
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
            "image/jpeg",
            0.85
          );
        });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Makes a UNIQUE picture out of an already-encoded scene, for free.
 *
 * Encoding is the entire cost of generating an image — measured at ~1050ms for
 * 2400px, against 1-6ms to draw it and ~60ms for the app to import it. Paying
 * that per picture puts four hundred images seven minutes away, which is not a
 * tool anyone runs twice.
 *
 * So each scene is encoded once and varied by appending random bytes AFTER the
 * JPEG end-of-image marker, which decoders skip. Verified in the browser: the
 * result still decodes at full size and the app's own import path accepts it.
 *
 * The bytes must differ, and not for tidiness. Assets are content-addressed by
 * SHA-256, so identical bytes collapse into ONE asset: four hundred copies of
 * one scene would be stored as a single image, and the whole test would
 * measure nothing while appearing to pass.
 */
function variantOf(scene: Uint8Array<ArrayBuffer>, seq: number): Blob {
  const tail = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tail[i] = (Math.random() * 256) | 0;
  tail[0] = seq & 0xff;
  tail[1] = (seq >> 8) & 0xff;
  return new Blob([scene, tail], { type: "image/jpeg" });
}

// --------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32), so two runs produce the same map. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function generateStressMap(store: EditorStore, opts: StressOptions = {}): Promise<StressReport> {
  const nodes = opts.nodes ?? 8000;
  const images = opts.images ?? 400;
  const longSide = opts.imageLongSide ?? 2400;
  const branch = opts.branch ?? 6;
  const progress = opts.onProgress ?? (() => {});
  const rnd = seeded(20260813);
  const t0 = performance.now();

  // --- topics, in ONE op batch -------------------------------------------
  const sheet = store.sheet;
  const ops: Op[] = [];
  const created: string[] = [];
  const queue: string[] = [sheet.rootNodeId];
  let textChars = 0;
  while (created.length < nodes && queue.length > 0) {
    const parentId = queue.shift()!;
    const isRoot = parentId === sheet.rootNodeId;
    for (let i = 0; i < branch && created.length < nodes; i++) {
      const id = uid("n");
      const { title, runs } = makeTitle(rnd, created.length);
      textChars += title.length;
      ops.push(
        makeOp<Op & { type: "createNode" }>("createNode", {
          id,
          nodeType: isRoot ? "main" : "subtopic",
          parentId,
          index: 0,
          title,
          titleRuns: runs,
        })
      );
      queue.push(id);
      created.push(id);
    }
  }
  progress(0.05, `${ops.length} topics built, applying…`);
  const tOps = performance.now();
  store.execOps(ops);
  const opsMs = performance.now() - tOps;
  progress(0.15, `topics applied in ${Math.round(opsMs)}ms`);

  // --- scenes, encoded once each -----------------------------------------
  const tImg = performance.now();
  const sceneCount = Math.max(1, Math.min(opts.bases ?? 12, images));
  const scenes: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < sceneCount; i++) {
    scenes.push(await encodeScene(rnd, longSide, opts.noise ?? 0.45));
    progress(0.15 + (0.15 * (i + 1)) / sceneCount, `scene ${i + 1}/${sceneCount} encoded`);
  }
  const perImage = scenes.reduce((s, b) => s + b.byteLength, 0) / scenes.length;
  console.info(
    `[stress] ${sceneCount} scenes, ~${Math.round(perImage / 1024)}KB each → ` +
      `${images} pictures will store roughly ${Math.round((perImage * images) / 1048576)}MB of originals`
  );

  // --- pictures, through the real attach path ----------------------------
  let imageBytes = 0;
  let attached = 0;
  const stride = Math.max(1, Math.floor(created.length / Math.max(1, images)));
  for (let k = 0; k < images && k * stride < created.length; k++) {
    const blob = variantOf(scenes[k % sceneCount], k);
    imageBytes += blob.size;
    const file = Object.assign(blob, { name: `stress-${k}.jpg` });
    const res = await store.attachImageFile(created[k * stride], file as Blob & { name: string });
    if (res.ok) attached++;
    else console.warn(`[stress] image ${k} rejected: ${res.reason}`);
    if (k % 20 === 0) progress(0.3 + (0.7 * k) / images, `image ${k}/${images}`);
  }
  const imagesMs = performance.now() - tImg;

  const distinctAssets = new Set(store.sheet.attachments.map((a) => a.id)).size;
  const report: StressReport = {
    nodes: Object.keys(store.sheet.nodes).length,
    images: attached,
    imageBytes,
    distinctAssets,
    textChars,
    opsMs: Math.round(opsMs),
    imagesMs: Math.round(imagesMs),
    totalMs: Math.round(performance.now() - t0),
  };
  progress(1, "done");
  return report;
}
