/**
 * Standalone map viewer — the shell of a self-contained HTML export.
 *
 * Why this exists: reading a whole map on screen is what R-node's canvas is
 * already good at (8,000 topics at 6-8ms a frame, with viewport culling and
 * bitmap caches), and every document format we tried was a worse version of
 * it — SVG loses the culling and stalls at 95,000 DOM nodes, PDF loses the
 * zoom range and squeezes 470,000 units into a 14,400-unit page, PNG loses the
 * resolution. So the export carries the RENDERER instead of a picture of its
 * output.
 *
 * The consequence worth stating: fidelity is not implemented here, it is
 * inherited. Relationships, boundaries, summaries, opacity, rotation, shadow
 * and borders all appear because this is the same drawing code, not a second
 * one chasing it. There is also no fourth text layout to keep aligned with the
 * canvas, the editor and the SVG exporter.
 *
 * Deliberately not included: the store, Lexical, editing, persistence. This
 * reads a document and draws it.
 */
import { Renderer, type RenderState } from "../render/renderer";
import type { AssetLevel, AssetStore } from "../persist/assets";
import { measureNode, imageResolver } from "../layout/measure";
import type { Sheet } from "../core/types";
import type { ThemeName } from "../render/theme";

interface ViewerDoc {
  title: string;
  sheet: Sheet;
  theme: ThemeName;
  /** assetId → data: URI, one entry per referenced image. */
  images: Record<string, string>;
}

declare global {
  interface Window {
    __RNODE_DOC?: ViewerDoc;
  }
}

/**
 * Serves the embedded images. Only `get` is ever called by the renderer; the
 * rest of the AssetStore surface exists to store things, which a viewer never
 * does. Each data URI is decoded once and kept as a Blob.
 */
function embeddedAssets(images: Record<string, string>): AssetStore {
  const cache = new Map<string, Blob | null>();
  const get = async (id: string, _level: AssetLevel): Promise<Blob | null> => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const uri = images[id];
    if (!uri) {
      cache.set(id, null);
      return null;
    }
    const blob = await (await fetch(uri)).blob();
    cache.set(id, blob);
    return blob;
  };
  const nope = (): never => {
    throw new Error("read-only viewer");
  };
  return { get, meta: async () => null, put: nope, putUnderId: nope, size: async () => 0, list: async () => [], delete: nope } as unknown as AssetStore;
}

function boundsOf(sheet: Sheet): { minX: number; minY: number; maxX: number; maxY: number } {
  const resolve = imageResolver(sheet);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of Object.values(sheet.nodes)) {
    const m = measureNode(n, undefined, resolve);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + m.w);
    maxY = Math.max(maxY, n.position.y + m.h);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

function start(): void {
  const loaded = window.__RNODE_DOC;
  const root = document.getElementById("app");
  if (!loaded || !root) return;
  // Bound after the guard: the closures below outlive this scope, and TS will
  // not carry a narrowing on a mutable global into them.
  const doc: ViewerDoc = loaded;
  document.title = doc.title;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;cursor:grab";
  root.appendChild(canvas);

  const hud = document.createElement("div");
  hud.className = "hud";
  root.appendChild(hud);

  const renderer = new Renderer(canvas, { assetStore: embeddedAssets(doc.images), onRepaint: () => schedule() });
  const camera = { x: 0, y: 0, scale: 1 };
  let size = { w: window.innerWidth, h: window.innerHeight };

  const state = (): RenderState => ({
    sheet: doc.sheet,
    camera,
    selection: new Set<string>(),
    editingId: null,
    hoverId: null,
    drop: null,
    themeName: doc.theme,
    viewW: size.w,
    viewH: size.h,
  });

  let raf: number | null = null;
  function schedule(): void {
    if (raf !== null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      renderer.render(state());
      hud.textContent = `${Object.keys(doc.sheet.nodes).length} topics · ${Math.round(camera.scale * 100)}%`;
    });
  }

  function resize(): void {
    size = { w: window.innerWidth, h: window.innerHeight };
    renderer.resize(canvas, size.w, size.h);
    schedule();
  }

  /** Everything on screen at once. Useful to see the shape, not to read. */
  function fit(): void {
    const b = boundsOf(doc.sheet);
    const pad = 60;
    const sx = size.w / Math.max(1, b.maxX - b.minX + pad * 2);
    const sy = size.h / Math.max(1, b.maxY - b.minY + pad * 2);
    camera.scale = Math.max(0.02, Math.min(2, Math.min(sx, sy)));
    camera.x = (b.minX + b.maxX) / 2;
    camera.y = (b.minY + b.maxY) / 2;
    schedule();
  }

  /**
   * The opening view: the root, readable.
   *
   * Fitting the whole map is the wrong first frame. A mind map is typically a
   * ribbon — a 400-topic one already runs 1:15 — so "everything at once" put
   * this viewer at 5% zoom, where nothing can be read and the map is a smear
   * in the middle of an empty screen. It is the same mistake the PNG and PDF
   * exports made, and the only reason it is recoverable here is that zooming
   * in costs nothing. So it starts where reading starts, and F still fits.
   */
  function home(): void {
    const b = boundsOf(doc.sheet);
    const root = doc.sheet.nodes[doc.sheet.rootNodeId];
    const sx = size.w / Math.max(1, b.maxX - b.minX + 120);
    const sy = size.h / Math.max(1, b.maxY - b.minY + 120);
    // Fit the WIDTH, not the whole map. Branches run left and right of the
    // root, so width is the dimension that carries a level of structure; the
    // height is just how many topics there are, and fitting it is what put the
    // first frame at 5%. Floor at 25% so a very wide map still opens legibly,
    // ceiling at 1:1 so a small one is not blown up.
    camera.scale = Math.max(0.25, Math.min(1, sx));
    if (Math.min(sx, sy) >= 0.6) camera.scale = Math.min(Math.min(sx, sy), 2); // it all fits: show it all
    camera.x = (b.minX + b.maxX) / 2;
    camera.y = root ? root.position.y : (b.minY + b.maxY) / 2;
    schedule();
  }

  // Wheel zooms toward the cursor; shift+wheel and drag pan. Same gestures as
  // the app, so nothing has to be relearned to read your own map.
  canvas.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        camera.x += e.deltaX / camera.scale;
        camera.y += e.deltaY / camera.scale;
      } else {
        const before = { x: camera.x + (e.clientX - size.w / 2) / camera.scale, y: camera.y + (e.clientY - size.h / 2) / camera.scale };
        camera.scale = Math.max(0.02, Math.min(8, camera.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        camera.x = before.x - (e.clientX - size.w / 2) / camera.scale;
        camera.y = before.y - (e.clientY - size.h / 2) / camera.scale;
      }
      schedule();
    },
    { passive: false }
  );

  let dragging: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e: PointerEvent) => {
    dragging = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    camera.x -= (e.clientX - dragging.x) / camera.scale;
    camera.y -= (e.clientY - dragging.y) / camera.scale;
    dragging = { x: e.clientX, y: e.clientY };
    schedule();
  });
  const endDrag = (): void => {
    dragging = null;
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "f") fit();
    else if (e.key === "+" || e.key === "=") { camera.scale = Math.min(8, camera.scale * 1.2); schedule(); }
    else if (e.key === "-") { camera.scale = Math.max(0.02, camera.scale / 1.2); schedule(); }
    else return;
    e.preventDefault();
  });

  window.addEventListener("resize", resize);
  resize();
  home();
}

start();
