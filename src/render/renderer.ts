import { freeformOwner, FREEFORM_HEADER, isBarePicture, isDiagramPage, isFreeTransform } from "../core/freeform";
import { diagramShapePath, isDiagramShape, tracePath } from "../core/diagramShapes";
import { inkPolyline, inkStrokes } from "../core/ink";
import type { InkStroke } from "../core/types";
import { quizMistakeNodeIds } from "../core/quiz";
import { chartNoteRoot, chartSlotNote, freeformNote, isChartNote, openChartNote } from "../core/chartNotes";
import { displayedMistakeNodes, drawQuizMistakeArrow } from "./quizMarkers";
/**
 * Canvas renderer — one <canvas>, no DOM/SVG nodes per topic.
 *
 * Paints relationships, connectors and nodes with viewport culling, then
 * provides hit testing over the same geometry. Text editing happens in an
 * HTML overlay (allowed by the architecture) — the renderer skips the title
 * of the node being edited so the overlay doesn't double-paint.
 */
import type { Group, ImageSlot, MindNode, RelAnchor, Relationship, ResolvedBorder, Sheet, ShapePart, StructureType, Orientation, Summary, TextRun } from "../core/types";
import { connectHandles, headLen, headShape, REL_END_R, relationshipRoute, relHeads, relWidth, routeDistance, routeEnv, bendHandles, boxesMid, worldWaypoints, type RouteEnv, type HeadShape, type Rect, type RelRoute, type BendHandle } from "../layout/relationship";
import { borderDash, BRANCH_STROKE, DEFAULT_GROUP_BORDER_WIDTH, DEFAULT_NODE_BORDER_WIDTH, GROUP_FILL_ALPHA, groupDash, groupLabel } from "../core/types";
import { groupBoxes, groupRadius, wavePoints, type Box, type GroupBox } from "../layout/groups";
import { nodeImageIds } from "../core/ops";
import { nodeRuns, OWN_LABEL_LINE, OWN_LABEL_PAD, wrapPlainLines } from "../core/text";
import { resolvePaint } from "../core/shapeArt";
import { asCodeLang, tokenize, type CodeLang } from "../core/codeHighlight";
import { GROUP_LABEL_FONT, GROUP_LABEL_H, GROUP_LABEL_INSET, CODE_FONT_STACK, CODE_TITLEBAR_H, captionLines, createCanvasTextMeasurer, FONT_STACK, GALLERY_CAPTION_LINE_H, GALLERY_CAPTION_SIZE, GALLERY_GAP, CHART_NOTE_MARK, CHART_SLOT_ALPHA, chartGrowHandles, chartGrowPitch, CHART_COLS, imageResolver, LINE_HEIGHT_FACTOR, MAX_IMAGE_W, measureNode, positionedImageSlots, TEXT_INSET, wrapRunLines, type TextMeasurer } from "../layout/measure";
import { fetchAssetBlobs, getAssetStore, type AssetLevel, type AssetStore } from "../persist/assets";
import { THEMES, darken, defaultGridPattern, gridInk, lighten, readableOn, type GridPattern, type RenderTheme, type ThemeName } from "./theme";
import { connectorRibbon, taperWidthsForDepth } from "../layout/connectorRibbon";
import { getVisualFlags, LOD_BARE, type VisualFlags } from "./visualFlags";
import { trace } from "../dev/trace";
import type { Camera } from "./viewport";

/** From this zoom up (50%) titles and code are drawn as vectors every frame;
 *  below it they come from the per-node bitmap cache, rescaled. */
export const VECTOR_TEXT_MIN_SCALE = 0.5;

/** A draw.io page (A4 portrait at 96 dpi, draw.io's default), in world units. */
export const DIAGRAM_PAGE = { w: 827, h: 1169 };

/**
 * The block of pages a diagram occupies: every page any shape touches, and
 * always the first one (at the origin), as whole-page columns and rows.
 */
export function diagramPages(placed: readonly { x: number; y: number; w: number; h: number }[]): { col0: number; row0: number; cols: number; rows: number } {
  let c0 = 0, c1 = 0, r0 = 0, r1 = 0;
  for (const p of placed) {
    c0 = Math.min(c0, Math.floor(p.x / DIAGRAM_PAGE.w));
    c1 = Math.max(c1, Math.floor((p.x + p.w - 0.01) / DIAGRAM_PAGE.w));
    r0 = Math.min(r0, Math.floor(p.y / DIAGRAM_PAGE.h));
    r1 = Math.max(r1, Math.floor((p.y + p.h - 0.01) / DIAGRAM_PAGE.h));
  }
  return { col0: c0, row0: r0, cols: c1 - c0 + 1, rows: r1 - r0 + 1 };
}

export interface DropIndicator {
  mode: "child" | "before" | "after" | "floating" | "none";
  nodeId: string;
}

export interface RenderState {
  sheet: Sheet;
  camera: Camera;
  selection: Set<string>;
  editingId: string | null;
  hoverId: string | null;
  drop: DropIndicator | null;
  themeName: ThemeName;
  /** Optional document-level canvas background override. */
  background?: string;
  /** Optional document-level background pattern (unset = theme default). */
  grid?: GridPattern;
  viewW: number;
  viewH: number;
  relSel?: string | null;
  groupSel?: string | null;
  summarySel?: string | null;
  /** Node whose image is selected (mutually exclusive with node selection). */
  imageSel?: string | null;
  /** Which slot of `imageSel` was clicked (defaults to "top"). */
  imageSlot?: ImageSlot | null;
  /**
   * The selected CELL of a gallery topic (T25) — drawn with the same ring an
   * image slot gets, around the picture AND its caption band, because both
   * are the cell. Unlike `imageSel` this does not replace the node selection:
   * the topic wears its own ring at the same time.
   */
  gallerySel?: { nodeId: string; index: number } | null;
  /**
   * Ghost preview of an image being dragged over the map (internal
   * reassignment): the image bitmap follows the cursor, semi-transparent,
   * until the drop lands. x/y are world coords of the cursor; `side` snaps
   * the ghost onto that slot of the target node instead of the cursor.
   */
  ghostImage?: { imageId: string; x: number; y: number; nodeId: string; side?: ImageSlot } | null;
  /**
   * Where a dragged gallery cell would land: a caret drawn in the gap it
   * would be inserted into (T25). `index` counts the gaps, so it runs from 0
   * to the cell count inclusive — `cells.length` is "after the last one".
   */
  galleryDrop?: { nodeId: string; index: number } | null;
  /**
   * Marquee drag preview: ids of the topics inside the drag box — they wear
   * the selection ring BEFORE the release commits them (the box itself is a
   * DOM overlay; this is the live "what will be selected" feedback).
   */
  marqueeSel?: Set<string> | null;
  /**
   * A relationship being drawn from a connection arrow, or an end of the
   * selected one being dragged to another topic. An empty `fromId`/`toId`
   * is the end that follows the pointer; `replaces` hides the original while
   * its end is in flight; `target` wears a ring.
   */
  relDraft?: { rel: Relationship; pointer: { x: number; y: number }; replaces?: string; target?: string | null } | null;
  /** A chart grow slider in flight: how far it moved (world) and what it adds. */
  chartGrow?: { id: string; grow: "row" | "col"; offset: number; delta: number } | null;
  /** The freeform canvas whose note is on screen (Show notes), or null. */
  shownCanvasNote?: string | null;
  /** The pen stroke being written (not in the document until released). */
  inkDraft?: { canvasId: string; stroke: InkStroke } | null;
  /** Strokes the eraser has touched: hidden now, removed on release. */
  inkErased?: ReadonlySet<InkStroke> | null;
  /**
   * In-map search (Ctrl+F): ids of topics whose title/notes match the query —
   * each wears a dashed ring — and the one currently walked to, which wears a
   * solid, heavier ring. Purely presentational: it never touches measure.ts or
   * the runs, so it stays outside the §3 parity contract.
   */
  searchMatches?: Set<string> | null;
  searchCurrent?: string | null;
  showHidden?: boolean; // export: include collapsed subtrees
  /** Study annotations are editor overlays, omitted from document exports. */
  hideStudyMarkers?: boolean;
  /**
   * Store revision — the invalidation key for the placement cache. Omit it and
   * nothing is cached, which is the honest default for a state assembled by
   * hand (tests, exports): a wrong cache hit is a wrong picture.
   */
  rev?: number;
  /** E5: True during pan/zoom gesture or collapse tween for reduced motion quality. */
  moving?: boolean;
  /** E2: Scene cache invalidation key (everything except camera). */
  sceneContentKey?: string;
  /** E2: True while a wheel/pinch zoom gesture is in progress. */
  zooming?: boolean;
  /** V9: Optional per-node position & alpha override during collapse/expand tween. */
  tween?: Map<string, { x: number; y: number; alpha: number; w?: number; h?: number }> | null;
  /** V10: Force flat opaque background (used by PNG/PDF exports). */
  opaque?: boolean;
}

interface Placed {
  node: MindNode;
  x: number; // top-left in world coords
  y: number;
  w: number;
  h: number;
  visible: boolean;
  order?: number;
  visStamp?: number;
}

const GRID_CELL = 1024;

interface PlacedGrid {
  cells: Map<number, Placed[]>;
  alwaysCheck: Placed[];
  stamp: number;
}

function gridKey(gx: number, gy: number): number {
  return gx * 67108864 + gy;
}

function buildPlacedGrid(placed: Placed[]): PlacedGrid | null {
  if (placed.length <= 128) return null;
  const cells = new Map<number, Placed[]>();
  const alwaysCheck: Placed[] = [];
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    p.order = i;
    const gx0 = Math.floor(p.x / GRID_CELL);
    const gx1 = Math.floor((p.x + p.w) / GRID_CELL);
    const gy0 = Math.floor(p.y / GRID_CELL);
    const gy1 = Math.floor((p.y + p.h) / GRID_CELL);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 64) {
      alwaysCheck.push(p);
      continue;
    }
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = gridKey(gx, gy);
        let bucket = cells.get(k);
        if (!bucket) {
          bucket = [];
          cells.set(k, bucket);
        }
        bucket.push(p);
      }
    }
  }
  return { cells, alwaysCheck, stamp: 0 };
}

/**
 * Geometry of every outline drawn around a topic. ONE distance from the box,
 * shared by selection, marquee preview and hover — see Renderer.strokeRing for
 * why they must not differ. The weights below are the only thing that may.
 */
const RING_PAD = 3;
/** V3 topic shadow, in world units: blur (canvas shadowBlur semantics,
 *  sigma = blur / 2), how far it reaches past the box (~3 sigma) and how far
 *  it drops. They scale with the zoom like the boxes do. */
const SHADOW_BLUR = 10;
const SHADOW_PAD = 15;
const SHADOW_DY = 3;
const CONNECTOR_SHADOW_DY = 2.5;
/** E2 wheel-zoom shortcut (stretched cached scene). Off: it blurred text and images. */
const ZOOM_BLIT = false;
const RING_W_SELECTED = 2.5;
const RING_W_HOVER = 1.5;

/** The axis-aligned box a rectangle covers once turned `deg` degrees about its centre. */
export function rotatedBox(r: { x: number; y: number; w: number; h: number }, deg?: number): { x: number; y: number; w: number; h: number } {
  if (!deg) return r;
  const t = (deg * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const w = r.w * c + r.h * s, h = r.w * s + r.h * c;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

/** On a frame's border or in its title strip, where a frame takes the pointer. */
export function onFrameEdge(p: { x: number; y: number; w: number; h: number; node: MindNode }, wx: number, wy: number, scale: number): boolean {
  const band = 8 / scale;
  const strip = OWN_LABEL_PAD * 2 + (p.node.style.fontSize ?? 14) * OWN_LABEL_LINE;
  return wx - p.x < band || p.x + p.w - wx < band || wy - p.y < Math.max(band, strip) || p.y + p.h - wy < band;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private quizMarkerCache: { sheet: Sheet; rev: number; targets: Set<string> } | null = null;
  /** Same measurer the layout engine uses — extents always agree. */
  private measurer: TextMeasurer = createCanvasTextMeasurer();
  /** Camera scale and viewport of the current frame (used for text/image cache resolution and decode priority). */
  private curScale = 1;
  private curCamX = 0;
  private curCamY = 0;
  private curViewW = 1;
  private curViewH = 1;
  /** Where each relationship's label chip was last painted (world), for dragging it. */
  private relLabelRects = new Map<string, Rect>();
  /**
   * Bitmap cache for node titles: the styled text of a node is rendered once
   * into an offscreen canvas and blitted with drawImage during pan/zoom — the
   * text layout is NOT recomputed every frame. The cache key covers the runs,
   * style, resolved color and a scale bucket, so it is invalidated only when
   * the title/content actually changes (or the zoom crosses a power-of-two
   * boundary, where the bitmap is re-rendered sharper).
   */
  private textCache = new Map<string, { canvas: HTMLCanvasElement; w: number; h: number; bytes: number }>();
  private textBytes = 0;
  private textHits = 0;
  private textMisses = 0;
  /**
   * Byte budget for the text cache (T21-D). The bitmaps differ wildly in
   * size (node width × height × resolution²), so a fixed ENTRY COUNT let
   * five thousand big offscreen canvases reach hundreds of MB unnoticed.
   * w×h×4 per entry, same accounting as IMAGE_BUDGET below.
   */
  private readonly TEXT_BUDGET = 64 * 1024 * 1024;

  /** Per-frame attachment resolver (invariant I9): set from state.sheet. */
  private resolveImage: ((id: string) => { w: number; h: number } | null) | null = null;
  /** Node ids with an image that were visible in the last painted frame. */
  private visibleImageNodes = new Set<string>();
  /**
   * Image bitmap cache (ADR-001 §12): decoded at the level closest to the
   * current zoom, LRU with a byte budget (w×h×4 per bitmap, 128MB cap).
   * Evicted bitmaps are closed — ImageBitmap memory is not JS heap and the
   * GC cannot free it predictably.
   */
  private imageCache = new Map<string, { bitmap: ImageBitmap; bytes: number }>();
  private imageBytes = 0;
  /** Per-image index of cached bucket widths for O(buckets) fallback lookup. */
  private imageBuckets = new Map<string, Set<number>>();
  /** Cache keys drawn (or freshly decoded) in the current frame — never evicted while visible. */
  private frameKeys = new Set<string>();
  /** Images with any bucket >= 1448 drawn this frame; their largest original-derived bitmap stays protected. */
  private frameOriginalImages = new Set<string>();
  /** Memoised positionedImageSlots per Placed object. */
  private slotsCache = new WeakMap<Placed, { style: MindNode["style"]; w: number; h: number; slots: ReturnType<typeof positionedImageSlots> }>();
  /** E3: Memoised branch colour per placement key + theme. */
  private branchColorCache: { key: string; map: Map<string, string> } | null = null;
  private curBranchCacheKey: string | null = null;
  /** E3: Cached Path2D per Placed for traceShape (reused for shadow, fill, border, selection, hover). */
  private nodeShapePaths = new WeakMap<Placed, { key: string; path: Path2D }>();
  /** E3: Cached per-colour connector Path2D batches for the current visible set. */
  private connectorBatchCache: {
    key: string;
    visibleRef: Placed[];
    batches: Array<{ color: string; stroke?: Path2D; fill?: Path2D }>;
    shadowStrokes?: Path2D;
    shadowRibbons?: Path2D;
  } | null = null;
  /** E4: Cheap canvas state tracking (reset per frame and after ctx.restore()). */
  private curFont = "";
  private curTextAlign: CanvasTextAlign | "" = "";
  private curTextBaseline: CanvasTextBaseline | "" = "";
  private curLineDashSet = false;
  /** V5: Cached root gradient keyed on theme.name|y|h. */
  private rootGradCache: { key: string; grad: CanvasGradient } | null = null;
  /** V7: Memoised hover fill tint per theme|fill. */
  private hoverFillCache = new Map<string, string>();
  /** V3: pre-blurred rounded-square shadows, by colour|radius|resolution.
   *  A handful exist at once (one per corner radius in use). */
  private shadowSprites = new Map<string, HTMLCanvasElement>();
  /** E6: Count of topics drawn as greeking bars this frame. */
  private greekedCount = 0;
  /**
   * The on-screen canvas is opaque (`alpha: false`). Chrome only gives canvas
   * text subpixel (ClearType) antialiasing on an opaque context; on a
   * transparent one every glyph is grey-scale, thinner and softer than the
   * same text in the DOM editor — it read like a JPEG next to a PNG the moment
   * editing ended. The scene cache it is blitted from is opaque too, and the
   * CSS vignette that showed through the transparent canvas is gone (the
   * background is filled flat).
   */
  private readonly opaqueCanvas: boolean;
  /** The sheet being painted is in diagram mode (set per paint pass). */
  private curDiagram = false;
  /** E2: Offscreen scene cache for pan/zoom. */
  private sceneCacheCanvas: HTMLCanvasElement | null = null;
  private sceneCacheBuf: HTMLCanvasElement | null = null;
  private sceneCacheKey: string | null = null;
  private sceneCacheCam: { x: number; y: number; scale: number } | null = null;
  private sceneCacheQuality: "full" | "moving" = "full";
  /** Decode failures by key, with when they happened: retried after IMAGE_RETRY_MS
   *  instead of never (a transient read error used to break a picture until restart). */
  private imageFailed = new Map<string, number>();
  private readonly IMAGE_RETRY_MS = 10_000;
  private failedRecently(key: string): boolean {
    const at = this.imageFailed.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < this.IMAGE_RETRY_MS) return true;
    this.imageFailed.delete(key);
    return false;
  }
  /** Decodes in flight, key → bucket width (used to separate small vs large concurrency). */
  private inflight = new Map<string, number>();
  private inflightSmall = 0;
  private inflightLarge = 0;
  private get inflightCount(): number {
    return this.inflightSmall + this.inflightLarge;
  }
  /** Prioritized decode queue populated during render(), flushed at frame end. */
  private decodeQueue = new Map<
    string,
    { key: string; imageId: string; nodeId: string; level: AssetLevel; bucket: number; priority: number }
  >();
  private static computeImageBudget(): number {
    const dm =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
        : undefined;
    if (typeof dm === "number" && Number.isFinite(dm) && dm > 0) {
      const gb = Math.min(dm, 8);
      return Math.min(512 * 1024 * 1024, Math.max(128 * 1024 * 1024, gb * 48 * 1024 * 1024));
    }
    return 128 * 1024 * 1024;
  }
  private readonly IMAGE_BUDGET = Renderer.computeImageBudget();
  private readonly MAX_INFLIGHT_SMALL = 8;
  private readonly MAX_INFLIGHT_LARGE = 2;
  /** Decode-size buckets. The max is the width of the `large` level: decoding
   *  wider than the stored source costs memory and adds no detail. */
  private readonly IMAGE_BUCKET_MIN = 32;
  private readonly IMAGE_BUCKET_MAX = 1024;
  private readonly IMAGE_ORIGINAL_PROTECT_MIN = 1448;
  /** Above the `large` level a picture is decoded from the ORIGINAL, at most
   *  this many pixels (32 MB): one picture never shows more on any screen, and
   *  the cap keeps a few big pictures inside IMAGE_BUDGET. */
  private readonly IMAGE_ORIGINAL_MAX_PIXELS = 8 * 1024 * 1024;

  /**
   * Decode width and stored level for an image painted `neededPx` device
   * pixels wide. Powers of two up to the 1024px `large` level (as before);
   * past it, half-octave steps decoded from the original — a full octave
   * could decode four times the pixels needed — never wider than the source
   * has pixels, nor past the area cap.
   */
  private imageDecodeSize(imageId: string, neededPx: number): { bucket: number; level: AssetLevel } {
    const need = Math.max(1, neededPx);
    let bucket = 2 ** Math.ceil(Math.log2(need));
    if (bucket > this.IMAGE_BUCKET_MAX) {
      const nat = this.resolveImage?.(imageId);
      bucket = this.IMAGE_BUCKET_MAX;
      if (nat && nat.w > 0 && nat.h > 0) {
        const step = Math.round(2 ** (Math.ceil(Math.log2(need) * 2) / 2));
        const areaW = Math.floor(Math.sqrt((this.IMAGE_ORIGINAL_MAX_PIXELS * nat.w) / nat.h));
        const w = Math.min(step, nat.w, areaW);
        if (w > this.IMAGE_BUCKET_MAX) return { bucket: w, level: "original" };
      }
    }
    bucket = Math.max(this.IMAGE_BUCKET_MIN, bucket);
    return { bucket, level: bucket <= 256 ? "small" : "large" };
  }
  private assetStore: AssetStore;
  private onRepaint: (() => void) | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    opts: { assetStore?: AssetStore; onRepaint?: () => void; overlayCanvas?: HTMLCanvasElement | null; opaque?: boolean } = {}
  ) {
    this.opaqueCanvas = !!opts.opaque;
    const ctx = canvas.getContext("2d", this.opaqueCanvas ? { alpha: false } : undefined);
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    if (opts.overlayCanvas) {
      this.overlayCanvas = opts.overlayCanvas;
      this.overlayCtx = opts.overlayCanvas.getContext("2d");
    }
    // Resolved at construction, not at module scope: getAssetStore() is a
    // singleton that sticks on first call, and module init may run before
    // Tauri injects window.__TAURI__ — the backend must be picked when the
    // renderer is actually created, in the running environment.
    this.assetStore = opts.assetStore ?? getAssetStore();
    this.onRepaint = opts.onRepaint ?? null;
  }

  setOverlayCanvas(canvas: HTMLCanvasElement | null): void {
    this.overlayCanvas = canvas;
    this.overlayCtx = canvas ? canvas.getContext("2d") : null;
  }

  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    // Assigning width or height RESETS the canvas — the backing store is
    // cleared and the 2d context state goes back to its defaults — and the
    // spec does that even when the value assigned is the one already there.
    // The ResizeObserver on .canvas-area fires on layout passes that leave the
    // box exactly as it was (the Inspector swapping its empty state for a
    // selected topic's controls is one), so an unconditional assignment blanked
    // the map and left it blank until the next animation frame repainted it:
    // one empty frame, on every selection, with nothing in any counter to show
    // for it.
    if (canvas.width === w && canvas.height === h && this.dpr === dpr) {
      if (this.overlayCanvas && (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h)) {
        this.overlayCanvas.width = w;
        this.overlayCanvas.height = h;
      }
      return;
    }
    this.dpr = dpr;
    canvas.width = w;
    canvas.height = h;
    if (this.overlayCanvas) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
    // Assigning width/height (re)allocates the backing store — a GPU surface
    // (tracer 2.0 render:gpu-alloc).
    trace.mark("render", "render:gpu-alloc", { w, h });
  }

  // -------------------------------------------------------------------------
  // Placement + culling
  // -------------------------------------------------------------------------

  /**
   * Placements for the current turn.
   *
   * placedNodes measures every node in the sheet and allocates an object for
   * each — 8.7ms and 8,000 objects on a large map — and it reads as if it were
   * free. One hover fired it three times (hitTestResize, hitTestImageResize,
   * hitTest) for 35ms per mouse move, against a 9.8ms frame; one click fired it
   * seven times. Worse, nodeWorldRect and imageWorldRect run it to find ONE
   * node, so any loop over them multiplies the whole sheet by the loop — which
   * is precisely the bug that made selecting many topics unusable.
   *
   * Caching it turns the second and later calls of a turn into a Map lookup, so
   * those call sites become honest without a single one of them changing.
   */
  private placedCache: {
    key: string;
    sheet: Sheet;
    value: Placed[];
    /** The same placements by id — kept with them so it is one Map per
     *  placement, not one per frame (groupGeometry caches on its identity). */
    byId: Map<string, Placed>;
    /** Camera + viewport the `visible` flags were computed for. */
    viewKey: string;
    visiblePlaced: Placed[];
    visibleImageNodes: Set<string>;
    grid: PlacedGrid | null;
    resolveImage: (id: string) => { w: number; h: number } | null;
  } | null = null;

  /**
   * What the BOXES depend on. The camera is deliberately absent: it used to be
   * in this key, so every pan frame re-walked and re-measured the whole sheet
   * (10–18 ms at 5k topics with one node on screen, 400+ ms past 20k). A pan
   * changes only which boxes are visible — `viewKey` — and that is refreshed
   * in place by `refreshVisibility`. The open chart note follows the
   * selection, not the revision.
   */
  private placementKey(state: RenderState): string | null {
    if (state.rev === undefined) return null; // caller opted out
    return `${state.rev}|${state.showHidden === true ? 1 : 0}|${this.openNote(state) ?? ""}`;
  }

  private viewKey(state: RenderState): string {
    return `${state.camera.x}|${state.camera.y}|${state.camera.scale}|${state.viewW}|${state.viewH}`;
  }

  /** Recompute `visible` on cached placements for the current camera using the
   *  spatial grid when available so pan/zoom stays O(visible). */
  private refreshVisibility(
    state: RenderState,
    placed: Placed[],
    grid: PlacedGrid | null,
    prevVisible: Placed[],
  ): { visiblePlaced: Placed[]; visibleImageNodes: Set<string> } {
    const { camera } = state;
    const vw = state.viewW / camera.scale;
    const vh = state.viewH / camera.scale;
    const minX = camera.x - vw / 2 - 40, maxX = camera.x + vw / 2 + 40;
    const minY = camera.y - vh / 2 - 40, maxY = camera.y + vh / 2 + 40;
    const all = state.showHidden === true;
    const visImg = new Set<string>();
    const visiblePlaced: Placed[] = [];

    if (!all && grid) {
      const gx0 = Math.floor(minX / GRID_CELL);
      const gx1 = Math.floor(maxX / GRID_CELL);
      const gy0 = Math.floor(minY / GRID_CELL);
      const gy1 = Math.floor(maxY / GRID_CELL);
      const cellCount = (gx1 - gx0 + 1) * (gy1 - gy0 + 1);
      if (cellCount <= placed.length) {
        for (const p of prevVisible) p.visible = false;
        const stamp = ++grid.stamp;
        const check = (p: Placed) => {
          if (p.visStamp === stamp) return;
          p.visStamp = stamp;
          if (p.x + p.w >= minX && p.x <= maxX && p.y + p.h >= minY && p.y <= maxY) {
            p.visible = true;
            visiblePlaced.push(p);
            if (nodeImageIds(p.node).length > 0) visImg.add(p.node.id);
          }
        };
        for (const p of grid.alwaysCheck) check(p);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) {
            const bucket = grid.cells.get(gridKey(gx, gy));
            if (bucket) for (const p of bucket) check(p);
          }
        }
        visiblePlaced.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return { visiblePlaced, visibleImageNodes: visImg };
      }
    }

    for (const p of placed) {
      p.visible = all || (p.x + p.w >= minX && p.x <= maxX && p.y + p.h >= minY && p.y <= maxY);
      if (p.visible) {
        visiblePlaced.push(p);
        if (nodeImageIds(p.node).length > 0) visImg.add(p.node.id);
      }
    }
    return { visiblePlaced, visibleImageNodes: visImg };
  }

  /** Placements by id for this turn (cached with the placement). */
  private placedById(state: RenderState): Map<string, Placed> {
    const placed = this.placedNodes(state);
    const c = this.placedCache;
    if (c && c.value === placed) return c.byId;
    return new Map(placed.map((p) => [p.node.id, p]));
  }

  /** The chart note on screen. None while a picture is aimed at a chart (a
   *  box being dragged, or a picture over a grid): the note would cover the
   *  boxes the user is aiming at. Anywhere else it stays open, so a picture
   *  can be dropped on the note or on one of its subtopics. */
  private openNote(state: RenderState): string | null {
    if (state.galleryDrop) return null;
    const ghost = state.ghostImage;
    if (ghost && state.sheet.nodes[ghost.nodeId]?.style.gallery?.chart) return null;
    return openChartNote(state.sheet, state);
  }

  private placedNodes(state: RenderState): Placed[] {
    const key = this.placementKey(state);
    const c = this.placedCache;
    if (key !== null && c?.key === key && c.sheet === state.sheet) {
      // resolveImage is per-sheet state that callers read AFTER placing (every
      // image rect comes from it), so a cache hit has to restore it — but from
      // the entry, not by rebuilding: it walks every attachment, and rebuilding
      // it here would put an O(attachments) pass back on the path this cache
      // exists to empty.
      this.resolveImage = c.resolveImage;
      const vk = this.viewKey(state);
      if (c.viewKey !== vk) {
        const res = this.refreshVisibility(state, c.value, c.grid, c.visiblePlaced);
        c.visiblePlaced = res.visiblePlaced;
        c.visibleImageNodes = res.visibleImageNodes;
        c.viewKey = vk;
      }
      this.visibleImageNodes = c.visibleImageNodes;
      return c.value;
    }
    const out = this.computePlacement(state);
    const visPlaced: Placed[] = [];
    const visImg = new Set<string>();
    for (const p of out) {
      if (p.visible) {
        visPlaced.push(p);
        if (nodeImageIds(p.node).length > 0) visImg.add(p.node.id);
      }
    }
    this.visibleImageNodes = visImg;
    if (key !== null && this.resolveImage) {
      this.placedCache = {
        key,
        sheet: state.sheet,
        value: out,
        byId: new Map(out.map((p) => [p.node.id, p])),
        viewKey: this.viewKey(state),
        visiblePlaced: visPlaced,
        visibleImageNodes: visImg,
        grid: buildPlacedGrid(out),
        resolveImage: this.resolveImage,
      };
    }
    return out;
  }

  /** Only the visible placements for `state` (O(visible) when spatial grid is active). */
  private visiblePlacedList(state: RenderState): Placed[] {
    const placed = this.placedNodes(state);
    const c = this.placedCache;
    if (c && c.value === placed) return c.visiblePlaced;
    return placed.filter((p) => p.visible);
  }

  private computePlacement(state: RenderState): Placed[] {
    const { sheet, camera } = state;
    const vw = state.viewW / camera.scale;
    const vh = state.viewH / camera.scale;
    const cx = camera.x, cy = camera.y;
    const out: Placed[] = [];

    // Nodes with images must be measured with the sheet's attachment cards
    // (invariant I9): the layout, the renderer and the overlay all agree.
    this.resolveImage = imageResolver(state.sheet);
    const add = (n: MindNode): void => {
      const m = measureNode(n, this.measurer, this.resolveImage ?? undefined);
      const x = n.position.x;
      const y = n.position.y;
      const visible =
        state.showHidden === true ||
        (x + m.w >= cx - vw / 2 - 40 && x <= cx + vw / 2 + 40 && y + m.h >= cy - vh / 2 - 40 && y <= cy + vh / 2 + 40);
      out.push({ node: n, x, y, w: m.w, h: m.h, visible });
    };

    // BFS from root, then floating nodes on top.
    const seen = new Set<string>();
    const queue = [sheet.rootNodeId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const n = sheet.nodes[id];
      if (!n || seen.has(id)) continue;
      seen.add(id);
      add(n);
      if (state.showHidden === true || !n.collapsed) queue.push(...n.childrenIds);
    }
    // A chart slot's note is a floating topic drawn only while open (see
    // openChartNote); a closed one is neither painted nor hit.
    const openNote = this.openNote(state);
    let closedNotes = 0;
    for (const n of Object.values(sheet.nodes)) {
      if (n.type !== "floating" || seen.has(n.id)) continue;
      if (isChartNote(n) && n.id !== openNote) { closedNotes++; continue; }
      add(n);
      // An open note brings its subtopics along (the layout put them in a
      // column beside it); a closed one hides them with it. In diagram mode
      // every top-level shape brings the tree Tab grew from it (the layout
      // placed it too).
      const bringsTree = isChartNote(n) || sheet.structure.structureType === "diagram";
      if (bringsTree && (state.showHidden === true || !n.collapsed)) {
        const stack = [...n.childrenIds];
        while (stack.length > 0) {
          const k = sheet.nodes[stack.shift()!];
          if (!k || seen.has(k.id)) continue;
          seen.add(k.id);
          add(k);
          if (state.showHidden === true || !k.collapsed) stack.push(...k.childrenIds);
        }
      }
    }
    if (closedNotes > 0) trace.mark("render", "render:chart-notes", { closed: closedNotes, open: openNote ? 1 : 0 });
    return out;
  }

  // -------------------------------------------------------------------------
  // Main paint
  // -------------------------------------------------------------------------

  render(state: RenderState): void {
    const flags = getVisualFlags();
    const useOverlay = flags.overlayLayer && this.overlayCtx !== null;
    if (!useOverlay && this.overlayCtx && this.overlayCanvas) {
      this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
    this.renderScene(state, flags, useOverlay);
    if (useOverlay) this.renderOverlay(state, flags);
  }

  renderOverlayOnly(state: RenderState): void {
    const flags = getVisualFlags();
    if (!flags.overlayLayer || !this.overlayCtx) {
      this.render(state);
      return;
    }
    const tStart = typeof performance !== "undefined" ? performance.now() : 0;
    this.curScale = state.camera.scale;
    this.curCamX = state.camera.x;
    this.curCamY = state.camera.y;
    this.curViewW = state.viewW;
    this.curViewH = state.viewH;
    this.renderOverlay(state, flags);
    trace.render(
      {
        scale: state.camera.scale,
        nodes: 0,
        visible: 0,
        rels: 0,
        relsDrawn: 0,
        links: 0,
        linksDrawn: 0,
        textHits: 0,
        textMisses: 0,
        imgVisible: 0,
        imgCached: this.imageCache.size,
        imgBytes: this.imageBytes,
        imgInflight: this.inflightCount,
        overlayOnly: true,
        sceneBlit: "none",
      },
      (typeof performance !== "undefined" ? performance.now() : 0) - tStart
    );
  }

  private ensureSceneCache(w: number, h: number): { main: HTMLCanvasElement; buf: HTMLCanvasElement } | null {
    if (typeof document === "undefined") return null;
    // The first getContext call fixes a canvas's attributes for good, so the
    // opaque ones are requested right where the canvases are made.
    const make = (): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      if (this.opaqueCanvas) c.getContext("2d", { alpha: false });
      return c;
    };
    if (!this.sceneCacheCanvas) this.sceneCacheCanvas = make();
    if (!this.sceneCacheBuf) this.sceneCacheBuf = make();
    if (this.sceneCacheCanvas.width !== w || this.sceneCacheCanvas.height !== h) {
      this.sceneCacheCanvas.width = w;
      this.sceneCacheCanvas.height = h;
      this.sceneCacheKey = null;
      this.sceneCacheCam = null;
    }
    if (this.sceneCacheBuf.width !== w || this.sceneCacheBuf.height !== h) {
      this.sceneCacheBuf.width = w;
      this.sceneCacheBuf.height = h;
    }
    return { main: this.sceneCacheCanvas, buf: this.sceneCacheBuf };
  }

  renderScene(state: RenderState, flags: VisualFlags = getVisualFlags(), skipOverlays = false): void {
    const tStart = typeof performance !== "undefined" ? performance.now() : 0;
    const devW = Math.max(1, Math.round(state.viewW * this.dpr));
    const devH = Math.max(1, Math.round(state.viewH * this.dpr));
    const canCache = flags.sceneCache && state.sceneContentKey !== undefined && typeof document !== "undefined";

    if (canCache) {
      const cache = this.ensureSceneCache(devW, devH);
      if (cache && this.sceneCacheKey === state.sceneContentKey && this.sceneCacheCam) {
        const s = state.camera.scale;
        const c0 = this.sceneCacheCam;
        const wantFull = !(flags.motionQuality && state.moving);
        // Wheel zoom used to blit the cached scene stretched, which blurred
        // every text and picture until the gesture ended. Text and images must
        // look exactly as before E2, so each zoom frame is painted for real;
        // the stretched blit stays off. Only pan reuses the cache (pixel copy).
        if (state.zooming && ZOOM_BLIT) {
          const ctx = this.ctx;
          const baseTheme = THEMES[state.themeName];
          const theme = state.background ? { ...baseTheme, background: state.background } : baseTheme;
          const transparentVignette = !this.opaqueCanvas && flags.vignette && !state.opaque && !state.background && !state.grid;
          ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
          ctx.clearRect(0, 0, state.viewW, state.viewH);
          if (!transparentVignette) {
            ctx.fillStyle = theme.background;
            ctx.fillRect(0, 0, state.viewW, state.viewH);
          }
          const dx = state.viewW / 2 + (c0.x - state.viewW / (2 * c0.scale) - state.camera.x) * s;
          const dy = state.viewH / 2 + (c0.y - state.viewH / (2 * c0.scale) - state.camera.y) * s;
          const dw = state.viewW * (s / c0.scale);
          const dh = state.viewH * (s / c0.scale);
          ctx.drawImage(cache.main, dx, dy, dw, dh);
          trace.render(
            {
              scale: s,
              nodes: 0,
              visible: 0,
              rels: 0,
              relsDrawn: 0,
              links: 0,
              linksDrawn: 0,
              textHits: 0,
              textMisses: 0,
              imgVisible: 0,
              imgCached: this.imageCache.size,
              imgBytes: this.imageBytes,
              imgInflight: this.inflightCount,
              overlayOnly: false,
              sceneBlit: "zoom",
              pathBatches: 0,
              greeked: 0,
            },
            (typeof performance !== "undefined" ? performance.now() : 0) - tStart
          );
          return;
        }
        if (c0.scale === s && !(wantFull && this.sceneCacheQuality === "moving")) {
          const shiftDx = Math.round((c0.x - state.camera.x) * s * this.dpr);
          const shiftDy = Math.round((c0.y - state.camera.y) * s * this.dpr);
          if (shiftDx === 0 && shiftDy === 0) {
            const ctx = this.ctx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, devW, devH);
            ctx.drawImage(cache.main, 0, 0);
            ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            trace.render(
              {
                scale: s,
                nodes: 0,
                visible: 0,
                rels: 0,
                relsDrawn: 0,
                links: 0,
                linksDrawn: 0,
                textHits: 0,
                textMisses: 0,
                imgVisible: 0,
                imgCached: this.imageCache.size,
                imgBytes: this.imageBytes,
                imgInflight: this.inflightCount,
                overlayOnly: false,
                sceneBlit: "pan",
                pathBatches: 0,
                greeked: 0,
              },
              (typeof performance !== "undefined" ? performance.now() : 0) - tStart
            );
            return;
          }
          const shiftX = shiftDx / this.dpr;
          const shiftY = shiftDy / this.dpr;
          if (Math.abs(shiftX) <= state.viewW * 0.5 && Math.abs(shiftY) <= state.viewH * 0.5) {
            const cacheCtx = cache.main.getContext("2d");
            const bufCtx = cache.buf.getContext("2d");
            if (cacheCtx && bufCtx) {
              bufCtx.setTransform(1, 0, 0, 1, 0, 0);
              bufCtx.clearRect(0, 0, devW, devH);
              bufCtx.drawImage(cache.main, 0, 0);
              cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
              cacheCtx.clearRect(0, 0, devW, devH);
              cacheCtx.drawImage(cache.buf, shiftDx, shiftDy);

              // The uncovered strips, from the WHOLE device-pixel shift and the
              // real buffer size (paintScenePass snaps them back to device px).
              const d = this.dpr;
              const strips: Array<{ x: number; y: number; w: number; h: number }> = [];
              if (shiftDx !== 0) {
                strips.push({
                  x: (shiftDx > 0 ? 0 : devW + shiftDx) / d,
                  y: 0,
                  w: Math.abs(shiftDx) / d,
                  h: devH / d,
                });
              }
              if (shiftDy !== 0) {
                strips.push({
                  x: (shiftDx > 0 ? shiftDx : 0) / d,
                  y: (shiftDy > 0 ? 0 : devH + shiftDy) / d,
                  w: (devW - Math.abs(shiftDx)) / d,
                  h: Math.abs(shiftDy) / d,
                });
              }
              const alignedState: RenderState = {
                ...state,
                camera: {
                  x: c0.x - shiftX / s,
                  y: c0.y - shiftY / s,
                  scale: s,
                },
              };
              const liveCtx = this.ctx;
              this.ctx = cacheCtx;
              let stats = { nodes: 0, visible: 0, rels: 0, relsDrawn: 0, links: 0, linksDrawn: 0, pathBatches: 0, imgVisible: 0 };
              try {
                for (const strip of strips) {
                  stats = this.paintScenePass(alignedState, flags, skipOverlays, strip);
                }
              } finally {
                this.ctx = liveCtx;
              }
              this.sceneCacheCam = { ...alignedState.camera };
              if (!wantFull) this.sceneCacheQuality = "moving";
              liveCtx.setTransform(1, 0, 0, 1, 0, 0);
              liveCtx.clearRect(0, 0, devW, devH);
              liveCtx.drawImage(cache.main, 0, 0);
              liveCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
              trace.render(
                {
                  scale: s,
                  nodes: stats.nodes,
                  visible: stats.visible,
                  rels: stats.rels,
                  relsDrawn: stats.relsDrawn,
                  links: stats.links,
                  linksDrawn: stats.linksDrawn,
                  textHits: this.textHits,
                  textMisses: this.textMisses,
                  imgVisible: stats.imgVisible,
                  imgCached: this.imageCache.size,
                  imgBytes: this.imageBytes,
                  imgInflight: this.inflightCount,
                  overlayOnly: false,
                  sceneBlit: "pan",
                  pathBatches: stats.pathBatches,
                  greeked: this.greekedCount,
                },
                (typeof performance !== "undefined" ? performance.now() : 0) - tStart
              );
              return;
            }
          }
        }
      }
    }

    const stats = this.paintScenePass(state, flags, skipOverlays);
    if (canCache && !state.zooming) {
      const cache = this.ensureSceneCache(devW, devH);
      const cacheCtx = cache?.main.getContext("2d");
      if (cache && cacheCtx) {
        cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
        cacheCtx.clearRect(0, 0, devW, devH);
        cacheCtx.drawImage(this.ctx.canvas, 0, 0);
        this.sceneCacheKey = state.sceneContentKey!;
        this.sceneCacheCam = { ...state.camera };
        this.sceneCacheQuality = flags.motionQuality && state.moving ? "moving" : "full";
      }
    }

    trace.render(
      {
        scale: state.camera.scale,
        nodes: stats.nodes,
        visible: stats.visible,
        rels: stats.rels,
        relsDrawn: stats.relsDrawn,
        links: stats.links,
        linksDrawn: stats.linksDrawn,
        textHits: this.textHits,
        textMisses: this.textMisses,
        imgVisible: stats.imgVisible,
        imgCached: this.imageCache.size,
        imgBytes: this.imageBytes,
        imgInflight: this.inflightCount,
        overlayOnly: false,
        sceneBlit: "none",
        pathBatches: stats.pathBatches,
        greeked: this.greekedCount,
      },
      (typeof performance !== "undefined" ? performance.now() : 0) - tStart
    );
  }

  private paintScenePass(
    state: RenderState,
    flags: VisualFlags,
    skipOverlays: boolean,
    clipCss?: { x: number; y: number; w: number; h: number }
  ): { nodes: number; visible: number; rels: number; relsDrawn: number; links: number; linksDrawn: number; pathBatches: number; imgVisible: number } {
    const ctx = this.ctx;
    const baseTheme = THEMES[state.themeName];
    const theme = state.background ? { ...baseTheme, background: state.background } : baseTheme;
    this.curBranchCacheKey = null;
    // Clip, clear and background are done in whole DEVICE pixels. In CSS
    // units a strip edge lands mid-pixel whenever the display scale is not an
    // integer (125%, 150%): the anti-aliased clip then cleared that pixel only
    // partly, the pan blit carried the residue along, and every pan frame
    // left one more line stacked along the right and bottom edges. The same
    // holds for the canvas edge itself (viewW × dpr is rarely whole).
    const devW = ctx.canvas.width;
    const devH = ctx.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let dev = { x: 0, y: 0, w: devW, h: devH };
    if (clipCss) {
      const x0 = Math.max(0, Math.round(clipCss.x * this.dpr));
      const y0 = Math.max(0, Math.round(clipCss.y * this.dpr));
      const xr = Math.round((clipCss.x + clipCss.w) * this.dpr);
      const yb = Math.round((clipCss.y + clipCss.h) * this.dpr);
      const x1 = xr >= devW - 1 ? devW : xr;
      const y1 = yb >= devH - 1 ? devH : yb;
      dev = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      ctx.save();
      ctx.beginPath();
      ctx.rect(dev.x, dev.y, dev.w, dev.h);
      ctx.clip();
    }
    ctx.clearRect(dev.x, dev.y, dev.w, dev.h);
    const transparentVignette = !this.opaqueCanvas && flags.vignette && !state.opaque && !state.background && !state.grid;
    if (!transparentVignette) {
      ctx.fillStyle = theme.background;
      ctx.fillRect(dev.x, dev.y, dev.w, dev.h);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.resetCanvasState();

    const s = state.camera.scale;
    this.curScale = s;
    this.curDiagram = state.sheet.structure.structureType === "diagram";
    this.curCamX = state.camera.x;
    this.curCamY = state.camera.y;
    this.curViewW = state.viewW;
    this.curViewH = state.viewH;
    this.frameKeys.clear();
    this.frameOriginalImages.clear();
    this.decodeQueue.clear();
    const ox = state.viewW / 2 - state.camera.x * s;
    const oy = state.viewH / 2 - state.camera.y * s;
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * ox, this.dpr * oy);

    if (state.sheet.structure.structureType === "diagram") this.drawDiagramPages(theme, state);
    else this.drawGrid(theme, state);

    this.textHits = 0;
    this.textMisses = 0;
    this.greekedCount = 0;

    const pk = this.placementKey(state);
    this.curBranchCacheKey = flags.batchedPaths && pk !== null ? `${theme.name}|${pk}` : null;

    const basePlaced = this.placedNodes(state);
    const baseVisiblePlaced = this.visiblePlacedList(state);
    const baseById = this.placedById(state);

    let placed = basePlaced;
    let visiblePlaced = baseVisiblePlaced;
    let byId = baseById;
    if (state.tween && state.tween.size > 0) {
      const tw = state.tween;
      const ovById = new Map<string, Placed>();
      placed = basePlaced.map((p) => {
        const o = tw.get(p.node.id);
        const np = o ? { ...p, x: o.x, y: o.y } : p;
        ovById.set(np.node.id, np);
        return np;
      });
      visiblePlaced = baseVisiblePlaced.map((p) => ovById.get(p.node.id) ?? p);
      for (const [id, o] of tw) {
        if (ovById.has(id) || o.alpha <= 0.01) continue;
        const node = state.sheet.nodes[id];
        if (!node || !o.w || !o.h) continue;
        const ghost: Placed = { node, x: o.x, y: o.y, w: o.w, h: o.h, visible: true };
        ovById.set(id, ghost);
        placed.push(ghost);
        visiblePlaced.push(ghost);
      }
      byId = ovById;
    }

    // Viewport in world units (limited to clipCss when repainting pan strips).
    const vw = state.viewW / s;
    const vh = state.viewH / s;
    const viewMinX = clipCss ? (clipCss.x - ox) / s - 40 : state.camera.x - vw / 2 - 40;
    const viewMaxX = clipCss ? (clipCss.x + clipCss.w - ox) / s + 40 : state.camera.x + vw / 2 + 40;
    const viewMinY = clipCss ? (clipCss.y - oy) / s - 40 : state.camera.y - vh / 2 - 40;
    const viewMaxY = clipCss ? (clipCss.y + clipCss.h - oy) / s + 40 : state.camera.y + vh / 2 + 40;
    if (clipCss) {
      visiblePlaced = visiblePlaced.filter(
        (p) => p.x + p.w >= viewMinX && p.x <= viewMaxX && p.y + p.h >= viewMinY && p.y <= viewMaxY
      );
    }
    /**
     * A line between two boxes is on screen whenever the box that CONTAINS
     * both of them is — not only when both endpoints are individually visible.
     * Requiring both is what made a connector vanish as soon as its parent
     * scrolled off, while the child was still in view.
     */
    const linkVisible = (a: Placed, b: Placed): boolean =>
      state.showHidden === true ||
      (Math.max(a.x + a.w, b.x + b.w) >= viewMinX &&
        Math.min(a.x, b.x) <= viewMaxX &&
        Math.max(a.y + a.h, b.y + b.h) >= viewMinY &&
        Math.min(a.y, b.y) <= viewMaxY);

    // V3: soft shadows under every topic and canvas, before anything else so
    // connectors and arrows lie on top of them. Each one is a 9-slice of a
    // pre-blurred sprite (see drawShadowSprite): no shadowBlur per node.
    const shadowsOn = flags.flatShadow && !(flags.lod && s < LOD_BARE);
    if (shadowsOn) {
      for (const p of visiblePlaced) {
        const sh = this.spriteShadowOf(p, state.sheet, flags);
        if (sh === null) continue;
        const alpha = (p.node.style.opacity ?? 1) * (state.tween?.get(p.node.id)?.alpha ?? 1);
        if (alpha > 0.01) this.drawShadowSprite(ctx, theme.shadow, p, sh, alpha);
      }
    }

    for (const p of visiblePlaced) if (p.node.style.freeform) this.drawFreeform(theme, p, state);

    // 0) group fills, under everything they enclose
    this.drawGroupFills(state, byId);

    // 1) relationships
    // An arrow between two items of a freeform canvas is a diagram edge: it is
    // painted over the boxes (draw.io), or a filled container would hide every
    // arrow inside it. Arrows on the map stay under the topics, as always.
    let rels = 0;
    let relsDrawn = 0;
    const overRels: [Placed, Placed, Relationship][] = [];
    for (const rel of state.sheet.relationships) {
      rels++;
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (state.relDraft?.replaces === rel.id) continue;
      if (a && b && linkVisible(a, b)) {
        relsDrawn++;
        if (freeformOwner(state.sheet, rel.fromId) && freeformOwner(state.sheet, rel.toId)) overRels.push([a, b, rel]);
        else this.drawRelationshipShadowed(theme, a, b, rel, state, shadowsOn);
      }
    }

    // 2) connectors (+ V6 junction dots)
    let links = 0;
    let linksDrawn = 0;
    let pathBatches = 0;
    // An open chart note's branch floats over the map (over its own chart,
    // first of all): its connectors are painted with it, in step 3, or the
    // chart box would cover the stretch next to the note.
    const noteLinks: [Placed, Placed][] = [];
    const structure = state.sheet.structure.structureType;
    const orientation = state.sheet.structure.orientation;
    const motionReduced = flags.motionQuality && !!state.moving;
    const lodBare = flags.lod && s < LOD_BARE;
    const useTaper = flags.taper && !lodBare;
    const showJunctions = flags.junctions && !motionReduced && !lodBare;
    const taperBucket = !useTaper
      ? 0
      : s >= 0.75 / 1.6
        ? 4
        : s >= 0.75 / 2
          ? 3
          : s >= 0.75 / 3.2
            ? 2
            : s >= 0.75 / 7
              ? 1
              : 0;
    const junctionDots: Array<{ x: number; y: number; color: string }> = [];
    const seenJunctions = showJunctions ? new Set<string>() : null;
    // Diagram mode draws parent → child as draw.io arrows, after the loops.
    const diagramEdges: [Placed, Placed][] = [];

    const tweenActive = !!(state.tween && state.tween.size > 0);
    if (flags.batchedPaths && !tweenActive && typeof Path2D !== "undefined") {
      const batchKey = pk !== null ? `${pk}|${theme.name}|${structure}|${orientation}|t${taperBucket}` : null;
      let cachedEntry =
        batchKey !== null && this.connectorBatchCache?.key === batchKey && this.connectorBatchCache.visibleRef === visiblePlaced
          ? this.connectorBatchCache
          : null;
      let batches: Array<{ color: string; stroke?: Path2D; fill?: Path2D }> | null = cachedEntry ? cachedEntry.batches : null;
      const byColor = batches ? null : new Map<string, { color: string; stroke?: Path2D; fill?: Path2D }>();
      for (const p of placed) {
        if (!p.node.parentId) continue;
        const parent = byId.get(p.node.parentId);
        if (!parent || parent.node.style.freeform) continue;
        links++;
        if (!linkVisible(parent, p)) continue;
        linksDrawn++;
        if (structure === "diagram") {
          diagramEdges.push([parent, p]);
          continue;
        }
        if (chartNoteRoot(state.sheet, parent.node.id)) {
          noteLinks.push([parent, p]);
          continue;
        }
        const color = this.branchColor(theme, p.node, state.sheet);
        const depth = flags.taper || flags.junctions ? this.depthOf(p.node, state.sheet) : 0;
        if (seenJunctions && depth >= 2 && parent.visible) {
          const ep = this.connectorEndpoints(parent, p, structure, orientation);
          const side = ep.vertical ? "v" : p.x + p.w / 2 < parent.x + parent.w / 2 ? "l" : "r";
          const jKey = `${parent.node.id}|${side}`;
          if (!seenJunctions.has(jKey)) {
            seenJunctions.add(jKey);
            junctionDots.push({ x: ep.sx, y: ep.sy, color });
          }
        }
        if (byColor) {
          let entry = byColor.get(color);
          if (!entry) {
            entry = { color };
            byColor.set(color, entry);
          }
          if (useTaper && taperWidthsForDepth(depth)[0] * s >= 0.75) {
            if (!entry.fill) entry.fill = new Path2D();
            this.appendConnectorRibbon(entry.fill, parent, p, structure, orientation, depth);
          } else {
            if (!entry.stroke) entry.stroke = new Path2D();
            this.appendConnectorStroke(entry.stroke, parent, p, structure, orientation);
          }
        }
      }
      if (byColor) {
        batches = Array.from(byColor.values());
        if (batchKey !== null) {
          cachedEntry = { key: batchKey, visibleRef: visiblePlaced, batches };
          this.connectorBatchCache = cachedEntry;
        }
      }
      if (batches) {
        // V3: connector shadows. All colours merged into one stroke path and
        // one ribbon path (cached across pan/zoom frames so shadows stay steady
        // without flickering); a wide faint pass then a narrow one fake the blur.
        if (shadowsOn) {
          let strokes = cachedEntry?.shadowStrokes;
          let ribbons = cachedEntry?.shadowRibbons;
          if (!strokes || !ribbons) {
            strokes = new Path2D();
            ribbons = new Path2D();
            for (const b of batches) {
              if (b.stroke) strokes.addPath(b.stroke);
              if (b.fill) ribbons.addPath(b.fill);
            }
            if (cachedEntry) {
              cachedEntry.shadowStrokes = strokes;
              cachedEntry.shadowRibbons = ribbons;
            }
          }
          ctx.save();
          ctx.translate(0, CONNECTOR_SHADOW_DY);
          ctx.strokeStyle = theme.shadow;
          ctx.fillStyle = theme.shadow;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 6;
          ctx.stroke(strokes);
          ctx.stroke(ribbons);
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 2.5;
          ctx.stroke(strokes);
          ctx.fill(ribbons);
          ctx.restore();
          pathBatches += 4;
        }
        ctx.lineWidth = lodBare ? 1 / s : 1.7;
        for (const b of batches) {
          if (b.fill) {
            ctx.fillStyle = b.color;
            ctx.fill(b.fill);
            pathBatches++;
          }
          if (b.stroke) {
            ctx.strokeStyle = b.color;
            ctx.stroke(b.stroke);
            pathBatches++;
          }
        }
      }
    } else {
      for (const p of placed) {
        if (!p.node.parentId) continue;
        const parent = byId.get(p.node.parentId);
        if (!parent || parent.node.style.freeform) continue;
        links++;
        if (!linkVisible(parent, p)) continue;
        linksDrawn++;
        if (structure === "diagram") {
          diagramEdges.push([parent, p]);
          continue;
        }
        if (chartNoteRoot(state.sheet, parent.node.id)) {
          noteLinks.push([parent, p]);
          continue;
        }
        const color = this.branchColor(theme, p.node, state.sheet);
        const depth = flags.taper || flags.junctions ? this.depthOf(p.node, state.sheet) : 0;
        if (seenJunctions && depth >= 2 && parent.visible) {
          const ep = this.connectorEndpoints(parent, p, structure, orientation);
          const side = ep.vertical ? "v" : p.x + p.w / 2 < parent.x + parent.w / 2 ? "l" : "r";
          const jKey = `${parent.node.id}|${side}`;
          if (!seenJunctions.has(jKey)) {
            seenJunctions.add(jKey);
            junctionDots.push({ x: ep.sx, y: ep.sy, color });
          }
        }
        const linkAlpha = tweenActive ? (state.tween?.get(p.node.id)?.alpha ?? 1) : 1;
        if (linkAlpha !== 1) ctx.globalAlpha = linkAlpha;
        this.drawConnector(parent, p, structure, orientation, color, useTaper ? depth : 0, s, lodBare);
        if (linkAlpha !== 1) ctx.globalAlpha = 1;
        pathBatches++;
      }
    }

    // V6: Junction dots (batched by colour when batchedPaths is on)
    if (junctionDots.length > 0) {
      const tweenActive = !!(state.tween && state.tween.size > 0);
    if (flags.batchedPaths && !tweenActive && typeof Path2D !== "undefined") {
        const jBatches = new Map<string, Path2D>();
        for (const d of junctionDots) {
          let path = jBatches.get(d.color);
          if (!path) {
            path = new Path2D();
            jBatches.set(d.color, path);
          }
          path.moveTo(d.x + 3, d.y);
          path.arc(d.x, d.y, 3, 0, Math.PI * 2);
        }
        for (const [color, path] of jBatches) {
          ctx.fillStyle = color;
          ctx.fill(path);
        }
      } else {
        for (const d of junctionDots) {
          ctx.fillStyle = d.color;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    for (const [parent, kid] of diagramEdges) this.drawDiagramEdge(theme, parent, kid, s);

    // 3) nodes
    for (const p of visiblePlaced) {
      if (noteLinks.length > 0 && isChartNote(p.node)) {
        for (const [parent, kid] of noteLinks) {
          // Mind-map style whatever the sheet's structure: the branch runs
          // to the right of the note, which is what the layout placed.
          const kd = useTaper ? this.depthOf(kid.node, state.sheet) : 0;
          this.drawConnector(parent, kid, "mindmap", "horizontal", this.branchColor(theme, kid.node, state.sheet), kd, s, lodBare);
        }
        noteLinks.length = 0;
      }
      this.drawNode(theme, p, state, false, flags, byId, !skipOverlays);
    }
    for (const [a, b, rel] of overRels) this.drawRelationshipShadowed(theme, a, b, rel, state, shadowsOn);
    // Handwriting goes over the items on its canvas, to annotate them.
    for (const p of visiblePlaced) if (p.node.style.freeform) this.drawInk(theme, p, state);

    // 4) groups & summaries (drawn over the nodes, geometry derived from members)
    this.drawGroupsAndSummaries(theme, state, byId);

    if (!skipOverlays) {
      this.drawOverlayElements(ctx, theme, state, visiblePlaced, byId);
    }

    this.curBranchCacheKey = null;
    if (clipCss) {
      ctx.restore();
      this.resetCanvasState();
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Evict only at the end of the frame: a closed bitmap still referenced by
    // the current paint would throw.
    this.evictToBudget();
    this.flushDecodeQueue();

    return {
      nodes: placed.length,
      visible: visiblePlaced.length,
      rels,
      relsDrawn,
      links,
      linksDrawn,
      pathBatches,
      imgVisible: placed.filter(
        (p) => p.visible && nodeImageIds(p.node).some((id) => !!this.resolveImage?.(id))
      ).length,
    };
  }

  private drawOverlayElements(
    ctx: CanvasRenderingContext2D,
    theme: RenderTheme,
    state: RenderState,
    visiblePlaced: Placed[],
    byId: Map<string, Placed>
  ): void {
    const s = state.camera.scale;
    // 3b) in-map search highlights. Drawn from the placed list, so only VISIBLE
    // matches are ringed — a match inside a collapsed branch is not on screen,
    // and the bar's count is what reports how many exist in total. The current
    // match is solid and heavier; the rest are dashed.
    if (state.searchMatches && state.searchMatches.size > 0) {
      for (const p of visiblePlaced) {
        if (!state.searchMatches.has(p.node.id)) continue;
        const isCurrent = state.searchCurrent === p.node.id;
        const pad = RING_PAD + (isCurrent ? 1 : 0);
        ctx.setLineDash(isCurrent ? [] : [5, 3]);
        ctx.strokeStyle = isCurrent ? theme.searchMatchActive : theme.searchMatch;
        ctx.lineWidth = isCurrent ? 3 : 1.5;
        ctx.strokeRect(p.x - pad, p.y - pad, p.w + pad * 2, p.h + pad * 2);
        ctx.setLineDash([]);
      }
    }

    if (!state.hideStudyMarkers) {
      let targets = this.quizMarkerCache?.sheet === state.sheet && state.rev !== undefined && this.quizMarkerCache.rev === state.rev
        ? this.quizMarkerCache.targets : null;
      if (!targets) {
        targets = displayedMistakeNodes(state.sheet,new Set(byId.keys()),quizMistakeNodeIds(state.sheet));
        if (state.rev !== undefined) this.quizMarkerCache = { sheet: state.sheet, rev: state.rev, targets };
      }
      for (const id of targets) {
        const p = byId.get(id);
        if (p) drawQuizMistakeArrow(ctx,p,s);
      }
    }

    // 5) drop indicator
    if (state.drop && state.drop.mode !== "none") {
      const target = byId.get(state.drop.nodeId);
      if (target) this.drawDropIndicator(theme, target, state.drop.mode);
    }

    // 6) ghost preview of an image being dragged (internal reassignment) —
    // on top of everything, centered on the cursor, before the drop lands.
    if (state.galleryDrop) this.drawGalleryDrop(theme, state);
    if (state.ghostImage) this.drawGhostImage(theme, state, state.ghostImage);

    // 7) relationship editing: connection arrows, endpoint handles, the line
    // being drawn, and the chart slider's preview.
    this.drawRelEditing(theme, state, byId);
    if (state.chartGrow) {
      const p = byId.get(state.chartGrow.id);
      if (p) this.drawChartGrowPreview(theme, p, state.chartGrow);
    }
  }

  renderOverlay(state: RenderState, flags: VisualFlags = getVisualFlags()): void {
    const octx = this.overlayCtx;
    if (!octx) return;
    const baseTheme = THEMES[state.themeName];
    const theme = state.background ? { ...baseTheme, background: state.background } : baseTheme;
    const s = state.camera.scale;
    octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    octx.clearRect(0, 0, state.viewW, state.viewH);
    const ox = state.viewW / 2 - state.camera.x * s;
    const oy = state.viewH / 2 - state.camera.y * s;
    octx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * ox, this.dpr * oy);

    const visiblePlaced = this.visiblePlacedList(state);
    const byId = this.placedById(state);

    const liveCtx = this.ctx;
    this.ctx = octx;
    this.resetCanvasState();
    try {
      for (const p of visiblePlaced) {
        const id = p.node.id;
        const needsOverlay =
          state.selection.has(id) ||
          state.hoverId === id ||
          !!state.marqueeSel?.has(id) ||
          state.imageSel === id ||
          state.gallerySel?.nodeId === id;
        if (needsOverlay) {
          this.drawNodeOverlay(octx, theme, p, state, flags);
        }
      }
      this.drawOverlayElements(octx, theme, state, visiblePlaced, byId);
    } finally {
      this.ctx = liveCtx;
      this.resetCanvasState();
    }
    octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  /**
   * The canvas pattern. Marks are inked from the background (see `gridInk`)
   * at a few percent alpha, so they are felt rather than seen; the theme's
   * own `grid` colour is kept only for its default lines on its own colour.
   *
   * - lines: one square grid, 40 units, doubled when cells get under 14 px.
   * - dots:  a dot per 20-unit cell, ~1 px radius on screen whatever the zoom.
   * - graph: graph paper, minor every 10 units and major every 5 minors.
   *          Zooming out, the minor lines fade to nothing by 6 px apart and
   *          then hand over to the old majors (which reach the minor alpha
   *          just as they become minors), so the paper never pops.
   * - fine:  draw.io's grid: 10-unit squares, a stronger line every 4, kept
   *          down to 4 px apart before it coarsens (by 4, the same handover).
   */
  /**
   * Diagram mode: draw.io's paper. Pages of DIAGRAM_PAGE size tile the world
   * from the origin; as many are shown as the drawing covers (at least the
   * first), so the sheet grows by whole pages in any direction the shapes go.
   * The desk around them is a shade darker, the grid is drawn on the pages
   * only, and the joins between pages are faint dashed lines.
   */
  private drawDiagramPages(theme: RenderTheme, state: RenderState): void {
    const ctx = this.ctx;
    const s = state.camera.scale;
    const vx0 = state.camera.x - state.viewW / 2 / s;
    const vy0 = state.camera.y - state.viewH / 2 / s;
    const vw = state.viewW / s, vh = state.viewH / s;
    const { w: PW, h: PH } = DIAGRAM_PAGE;
    // The page canvas (the diagram's root) grows with its content; the paper
    // is that canvas rounded UP to whole pages from its top-left corner.
    const pageNode = isDiagramPage(state.sheet, state.sheet.rootNodeId) ? state.sheet.rootNodeId : null;
    const pageRect = pageNode ? this.placedById(state).get(pageNode) : undefined;
    const pages = pageRect
      ? { col0: 0, row0: 0, cols: Math.max(1, Math.ceil((pageRect.w - 0.5) / PW)), rows: Math.max(1, Math.ceil((pageRect.h - 0.5) / PH)) }
      : diagramPages(this.placedNodes(state));
    const px = pageRect ? pageRect.x : pages.col0 * PW, py = pageRect ? pageRect.y : pages.row0 * PH;
    const pw = pages.cols * PW, ph = pages.rows * PH;

    const base = state.background ?? theme.background;
    const m = /^#([0-9a-f]{6})$/i.exec(base.trim());
    const n = m ? parseInt(m[1], 16) : 0xf3f4f6;
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    const light = lum >= 0.4;
    const paper = light && !state.background ? "#ffffff" : base;
    const desk = light ? darken(paper === "#ffffff" ? "#f1f2f5" : base, 0.06) : darken(base, 0.35);

    ctx.save();
    ctx.fillStyle = desk;
    ctx.fillRect(vx0, vy0, vw, vh);
    // A soft drop shadow under the paper, then the paper.
    ctx.fillStyle = light ? "rgba(0,0,0,0.10)" : "rgba(0,0,0,0.35)";
    ctx.fillRect(px + 2 / s, py + 3 / s, pw, ph);
    ctx.fillStyle = paper;
    ctx.fillRect(px, py, pw, ph);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();
    this.drawGrid({ ...theme, background: paper }, { ...state, background: paper });
    if (pages.cols > 1 || pages.rows > 1) {
      ctx.strokeStyle = gridInk(paper, 0.22);
      ctx.lineWidth = 1 / s;
      ctx.setLineDash([6 / s, 6 / s]);
      ctx.beginPath();
      for (let c = 1; c < pages.cols; c++) { ctx.moveTo(px + c * PW, py); ctx.lineTo(px + c * PW, py + ph); }
      for (let r = 1; r < pages.rows; r++) { ctx.moveTo(px, py + r * PH); ctx.lineTo(px + pw, py + r * PH); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  private drawGrid(theme: RenderTheme, state: RenderState): void {
    const pattern = state.grid ?? defaultGridPattern(theme);
    if (pattern === "none") return;
    const ctx = this.ctx;
    const s = state.camera.scale;
    const x0 = state.camera.x - state.viewW / 2 / s;
    const x1 = state.camera.x + state.viewW / 2 / s;
    const y0 = state.camera.y - state.viewH / 2 / s;
    const y1 = state.camera.y + state.viewH / 2 / s;
    const custom = state.background !== undefined;

    const strokeLines = (step: number, color: string, skipEvery = 0): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / s;
      ctx.beginPath();
      const sx = Math.floor(x0 / step), sy = Math.floor(y0 / step);
      for (let i = sx; i * step <= x1; i++) {
        if (skipEvery && i % skipEvery === 0) continue;
        ctx.moveTo(i * step, y0);
        ctx.lineTo(i * step, y1);
      }
      for (let j = sy; j * step <= y1; j++) {
        if (skipEvery && j % skipEvery === 0) continue;
        ctx.moveTo(x0, j * step);
        ctx.lineTo(x1, j * step);
      }
      ctx.stroke();
    };

    if (pattern === "lines") {
      let step = 40;
      while (step * s < 14) step *= 2;
      strokeLines(step, custom || theme.noGrid ? gridInk(theme.background, 0.1) : theme.grid);
      return;
    }

    if (pattern === "dots") {
      let step = 20;
      while (step * s < 12) step *= 2;
      const r = 1.1 / s;
      ctx.fillStyle = gridInk(theme.background, 0.22);
      ctx.beginPath();
      const sx = Math.floor(x0 / step), sy = Math.floor(y0 / step);
      for (let i = sx; i * step <= x1 + step; i++) {
        for (let j = sy; j * step <= y1 + step; j++) {
          ctx.moveTo(i * step + r, j * step);
          ctx.arc(i * step, j * step, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
      return;
    }

    // graph paper / fine (draw.io)
    const fine = pattern === "fine";
    const MAJOR_EVERY = fine ? 4 : 5;
    const MAJOR_A = 0.13, MINOR_A = fine ? 0.075 : 0.06;
    const MIN_PX = fine ? 4 : 6; // closest the minor lines get on screen
    const TOP_PX = MIN_PX * MAJOR_EVERY; // where a minor line becomes the old major
    let minor = 10;
    while (minor * s < MIN_PX) minor *= MAJOR_EVERY;
    const px = minor * s; // minor spacing on screen, in [MIN_PX, TOP_PX)
    const fadeIn = Math.min(1, (px - MIN_PX) / (fine ? 2 : 4));
    const toMajor = Math.max(0, Math.min(1, (px - TOP_PX * 0.6) / (TOP_PX * 0.4))); // reaches the major alpha at TOP_PX
    const minorA = fadeIn * (MINOR_A + (MAJOR_A - MINOR_A) * toMajor);
    if (minorA > 0.004) strokeLines(minor, gridInk(theme.background, minorA), MAJOR_EVERY);
    strokeLines(minor * MAJOR_EVERY, gridInk(theme.background, MAJOR_A));
  }

  private connectorEndpoints(
    parent: Placed,
    child: Placed,
    structure: StructureType,
    orientation: Orientation
  ): { sx: number; sy: number; cp1x: number; cp1y: number; cp2x: number; cp2y: number; ex: number; ey: number; vertical: boolean } {
    const childLeft = child.x + child.w / 2 < parent.x + parent.w / 2;
    const vertical = child.y > parent.y + parent.h - 1 && structure !== "mindmap" && !(structure === "logic" && orientation !== "vertical");
    let sx: number, sy: number, ex: number, ey: number;
    if (vertical) {
      sx = parent.x + parent.w / 2;
      sy = parent.y + parent.h;
      ex = child.x + child.w / 2;
      ey = child.y;
    } else {
      sx = childLeft ? parent.x : parent.x + parent.w;
      sy = parent.y + parent.h / 2;
      ex = childLeft ? child.x + child.w : child.x;
      ey = child.y + child.h / 2;
    }
    const dx = Math.abs(ex - sx);
    const cp1x = sx + (childLeft ? -dx * 0.45 : dx * 0.45);
    const cp2x = ex + (childLeft ? dx * 0.45 : -dx * 0.45);
    return { sx, sy, cp1x, cp1y: sy, cp2x, cp2y: ey, ex, ey, vertical };
  }

  private appendConnectorStroke(
    path: Path2D,
    parent: Placed,
    child: Placed,
    structure: StructureType,
    orientation: Orientation
  ): void {
    const { sx, sy, cp1x, cp1y, cp2x, cp2y, ex, ey } = this.connectorEndpoints(parent, child, structure, orientation);
    path.moveTo(sx, sy);
    path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
  }

  private appendConnectorRibbon(
    path: Path2D,
    parent: Placed,
    child: Placed,
    structure: StructureType,
    orientation: Orientation,
    depth: number
  ): void {
    const { sx, sy, cp1x, cp1y, cp2x, cp2y, ex, ey, vertical } = this.connectorEndpoints(parent, child, structure, orientation);
    const { forward: f, backward: b } = connectorRibbon(sx, sy, cp1x, cp1y, cp2x, cp2y, ex, ey, depth, vertical);
    path.moveTo(f.x0, f.y0);
    path.bezierCurveTo(f.cp1x, f.cp1y, f.cp2x, f.cp2y, f.x1, f.y1);
    path.lineTo(b.x0, b.y0);
    path.bezierCurveTo(b.cp1x, b.cp1y, b.cp2x, b.cp2y, b.x1, b.y1);
    path.closePath();
  }

  /**
   * Diagram mode: parent → child as a draw.io orthogonal arrow. It leaves the
   * parent on the side facing the child and enters the child on the opposite
   * side — right/left when the child is beside the parent, bottom/top when it
   * is above or below — with one bend pair at the midpoint and a filled head.
   */
  private drawDiagramEdge(theme: RenderTheme, parent: Placed, child: Placed, scale: number): void {
    const ctx = this.ctx;
    const pcx = parent.x + parent.w / 2, pcy = parent.y + parent.h / 2;
    const ccx = child.x + child.w / 2, ccy = child.y + child.h / 2;
    const beside = child.x >= parent.x + parent.w || child.x + child.w <= parent.x;
    const pts: { x: number; y: number }[] = [];
    let dir: { x: number; y: number };
    if (beside) {
      const right = ccx > pcx;
      const sx = right ? parent.x + parent.w : parent.x;
      const ex = right ? child.x : child.x + child.w;
      const mx = (sx + ex) / 2;
      pts.push({ x: sx, y: pcy }, { x: mx, y: pcy }, { x: mx, y: ccy }, { x: ex, y: ccy });
      dir = { x: right ? 1 : -1, y: 0 };
    } else {
      const down = ccy > pcy;
      const sy = down ? parent.y + parent.h : parent.y;
      const ey = down ? child.y : child.y + child.h;
      const my = (sy + ey) / 2;
      pts.push({ x: pcx, y: sy }, { x: pcx, y: my }, { x: ccx, y: my }, { x: ccx, y: ey });
      dir = { x: 0, y: down ? 1 : -1 };
    }
    const width = Math.max(1.25, 1 / scale);
    const head = 8;
    const end = pts[pts.length - 1];
    // The line stops where the head begins, so the head's tip is sharp.
    const lineEnd = { x: end.x - dir.x * head * 0.8, y: end.y - dir.y * head * 0.8 };
    ctx.save();
    ctx.strokeStyle = theme.text;
    ctx.fillStyle = theme.text;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(lineEnd.x, lineEnd.y);
    ctx.stroke();
    const nx = -dir.y, ny = dir.x;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - dir.x * head + nx * head * 0.45, end.y - dir.y * head + ny * head * 0.45);
    ctx.lineTo(end.x - dir.x * head * 0.7, end.y - dir.y * head * 0.7);
    ctx.lineTo(end.x - dir.x * head - nx * head * 0.45, end.y - dir.y * head - ny * head * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawConnector(
    parent: Placed,
    child: Placed,
    structure: StructureType,
    orientation: Orientation,
    color: string,
    taperDepth = 0,
    scale = 1,
    lodBare = false
  ): void {
    const ctx = this.ctx;
    const { sx, sy, cp1x, cp1y, cp2x, cp2y, ex, ey, vertical } = this.connectorEndpoints(parent, child, structure, orientation);
    if (!lodBare && taperDepth > 0 && taperWidthsForDepth(taperDepth)[0] * scale >= 0.75) {
      const { forward: f, backward: b } = connectorRibbon(sx, sy, cp1x, cp1y, cp2x, cp2y, ex, ey, taperDepth, vertical);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(f.x0, f.y0);
      ctx.bezierCurveTo(f.cp1x, f.cp1y, f.cp2x, f.cp2y, f.x1, f.y1);
      ctx.lineTo(b.x0, b.y0);
      ctx.bezierCurveTo(b.cp1x, b.cp1y, b.cp2x, b.cp2y, b.x1, b.y1);
      ctx.closePath();
      ctx.fill();
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lodBare ? 1 / scale : 1.7;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
    ctx.stroke();
  }

  private nodeFill(theme: RenderTheme, p: Placed, state: RenderState): string {
    return this.resolveFill(theme, p.node, state.sheet);
  }

  /**
   * The fill and text color a node is actually painted with. The editing
   * overlay wears these so the box does not change appearance the moment you
   * double-click it — resolving branch palettes here keeps the one source of
   * truth in the renderer.
   */
  nodeColors(state: RenderState, id: string): { fill: string; text: string } | null {
    const n = state.sheet.nodes[id];
    if (!n) return null;
    const theme = THEMES[state.themeName];
    const flags = getVisualFlags();
    const depth = this.depthOf(n, state.sheet);
    const boxShape = n.style.code ? "rounded" : isBarePicture(n) ? "none" : n.style.shape ?? "rounded";
    const accent =
      flags.accentStrip &&
      !theme.tintedTopics &&
      state.sheet.structure.structureType !== "diagram" &&
      depth >= 2 &&
      !n.style.fill &&
      !n.style.code &&
      !isBarePicture(n) &&
      // Pictures and galleries are framed by their image: a bar down one
      // side of a photo reads as a misplaced drop shadow, not as a colour cue.
      !n.style.gallery &&
      nodeImageIds(n).length === 0 &&
      (boxShape === "rounded" || boxShape === "rect") &&
      !freeformOwner(state.sheet, n.id);
    const fill = accent ? theme.deepFill : this.resolveFill(theme, n, state.sheet);
    const text = this.defaultTextColor(theme, n, depth, fill);
    return { fill, text };
  }

  /**
   * The one place that decides a node's fill. The canvas, the editing overlay
   * and both exports all resolve through here (nodeFill / nodeColors), so a
   * topic cannot wear one colour on the map and another the moment it is
   * double-clicked or exported — that happened while the logic was split
   * across two methods that had drifted apart.
   *
   * Depth, not type, picks the default, and the ladder is fixed: the root,
   * then "denso" main topics, then one "schiarito" step for their children,
   * then white from the grandchildren down. An explicit style.fill always
   * wins; it is the user's own choice.
   *
   * A topic painted by hand is a statement about its branch: main topics wear
   * the root's chosen colour instead of the palette default, and their
   * children take a lightened version of it (the generated subtopics used to
   * come out in the palette colour of their branch index — red for the first
   * branch — no matter what the parent wore). Inheritance stops after one
   * step: grandchildren and deeper are always white, never a tint of a
   * distant ancestor.
   */
  private resolveFill(theme: RenderTheme, n: MindNode, sheet: Sheet): string {
    if (n.style.fill) return n.style.fill;
    // Diagram: draw.io shapes are white boxes on the paper; plain text stays
    // transparent, and so do containers.
    if (sheet.structure.structureType === "diagram") {
      if (n.style.freeform) return "transparent";
      return n.style.shape && n.style.shape !== "none" ? theme.deepFill : "transparent";
    }
    if (!n.style.freeform && freeformOwner(sheet, n.id)) return "transparent";
    const depth = this.depthOf(n, sheet);
    if (depth === 0) return theme.rootFill;
    if (depth === 1) {
      // Main topics are the dense step: the root's colour when the root is
      // painted, otherwise the palette vivid of their branch.
      const root = sheet.nodes[sheet.rootNodeId];
      if (root?.style.fill) return root.style.fill;
      return theme.branch[this.branchIndex(n, sheet)];
    }
    if (depth === 2 || (theme.tintedTopics && depth > 2)) {
      // Their children are the lightened step, derived from the main topic's
      // colour — which may itself be the root's colour, inherited. Uncoloured
      // branches keep the palette soft tint, as before.
      const branchRoot = this.branchRoot(n, sheet);
      const main = sheet.nodes[branchRoot];
      const source = main?.style.fill ?? sheet.nodes[sheet.rootNodeId]?.style.fill;
      if (source) return lighten(source, 0.3);
      return theme.branchSoft[this.branchIndex(n, sheet)];
    }
    return theme.deepFill;
  }

  /** A topic's text colour when it has none of its own. */
  private defaultTextColor(theme: RenderTheme, n: MindNode, depth: number, fill: string): string {
    if (n.style.textColor) return n.style.textColor;
    const boxed = fill && fill !== "transparent" && n.style.shape !== "none";
    if (n.type === "central") {
      // A root drawn without a box sits on the paper: its text must read on
      // the background, whatever the root fill would have been.
      if (theme.contrastMainText) return boxed ? readableOn(fill) : theme.rootText;
      return theme.rootText;
    }
    if (theme.contrastMainText && depth === 1 && boxed) return readableOn(fill);
    return theme.text;
  }

  /**
   * How many hops from the root. The cap makes a cycle or a missing parent
   * terminate: 64 is far deeper than any real map, and an unresolved walk (a
   * floating node, a broken parentId) reads as depth 3+.
   */
  private depthOf(n: MindNode, sheet: Sheet): number {
    let depth = 0;
    let cur: string | null = n.id;
    while (cur && cur !== sheet.rootNodeId && depth < 64) {
      cur = sheet.nodes[cur]?.parentId ?? null;
      depth++;
    }
    return cur === sheet.rootNodeId ? depth : 3;
  }

  /**
   * The colour a node's incoming connector is drawn with. Public for the SVG
   * export, which must not re-derive branch palettes: they live here, and a
   * second copy would disagree the first time a theme changes.
   */
  branchColorOf(state: RenderState, id: string): string {
    const n = state.sheet.nodes[id];
    const theme = THEMES[state.themeName];
    return n ? this.branchColor(theme, n, state.sheet) : theme.connector;
  }

  /**
   * The outline a topic is drawn with, or null for none. Public and
   * value-returning like `nodeColors`: the SVG and PDF exports paint what
   * this returns instead of re-deriving the rule, and tests assert it without
   * a canvas.
   */
  nodeBorder(state: RenderState, id: string): ResolvedBorder | null {
    const n = state.sheet.nodes[id];
    return n ? this.resolveBorder(THEMES[state.themeName], n, state.sheet) : null;
  }

  /**
   * The rule documented on `Style.stroke`. Setting any one of the three
   * outline fields makes the outline the topic's own — the bug this replaces
   * drew a custom outline only when colour AND width were both present, so
   * picking a dash style or a colour alone silently did nothing.
   */
  private resolveBorder(theme: RenderTheme, n: MindNode, sheet: Sheet): ResolvedBorder | null {
    const { stroke, borderWidth, borderStyle } = n.style;
    if (borderStyle === "none" || stroke === "transparent") return null;
    // Diagram mode: draw.io's dark outline, not the branch colour.
    if (sheet.structure.structureType === "diagram" && (stroke === undefined || stroke === BRANCH_STROKE)
      && !!n.style.shape && n.style.shape !== "none" && !n.style.freeform && !isBarePicture(n)) {
      const width = Math.max(borderStyle === "double" ? 3 : 0.5, borderWidth ?? 1.5);
      return { color: theme.text, width, ...borderDash(borderStyle, width), double: borderStyle === "double" };
    }
    if (stroke === undefined && borderWidth === undefined && borderStyle === undefined) {
      // A text-only topic (or an image item inside a freeform canvas with no explicit shape) has no box for the hairline to trace.
      const freeformImageOnly = !n.style.shape && !n.style.fill && !n.style.code && !!(n.style.image || n.style.imageBottom || n.style.imageLeft || n.style.imageRight) && !!freeformOwner(sheet, n.id);
      if (theme.nodeBorder === "transparent" || (n.style.shape === "none" && !n.style.code) || freeformImageOnly || isBarePicture(n)) return null;
      return { color: theme.nodeBorder, width: 1, dash: [], cap: "butt", double: false };
    }
    const color = stroke === undefined || stroke === BRANCH_STROKE ? this.branchColor(theme, n, sheet) : stroke;
    // A double line is two strokes and the gap between them: under 3 units
    // the three thirds blur into one line, so it never goes thinner.
    const width = Math.max(borderStyle === "double" ? 3 : 0.5, borderWidth ?? DEFAULT_NODE_BORDER_WIDTH);
    return { color, width, ...borderDash(borderStyle, width), double: borderStyle === "double" };
  }

  private branchColor(theme: RenderTheme, n: MindNode, sheet: Sheet): string {
    if (this.curBranchCacheKey !== null) {
      if (this.branchColorCache?.key !== this.curBranchCacheKey) {
        this.branchColorCache = { key: this.curBranchCacheKey, map: new Map() };
      }
      const cached = this.branchColorCache.map.get(n.id);
      if (cached !== undefined) return cached;
      const branchRootId = this.branchRoot(n, sheet);
      const branchRoot = sheet.nodes[branchRootId];
      const color = branchRoot?.style.fill ?? theme.branch[this.branchIndex(n, sheet)];
      this.branchColorCache.map.set(n.id, color);
      return color;
    }
    const branchRootId = this.branchRoot(n, sheet);
    const branchRoot = sheet.nodes[branchRootId];
    return branchRoot?.style.fill ?? theme.branch[this.branchIndex(n, sheet)];
  }

  /**
   * The colour a relationship is drawn with (its own, else the theme's
   * selection accent). Public for the SVG export, which must not re-derive
   * theme colours: they live here, and a second copy would disagree the
   * first time a theme changes.
   */
  relationshipColorOf(state: RenderState, relId: string): string {
    const rel = state.sheet.relationships.find((r) => r.id === relId);
    return rel?.color ?? THEMES[state.themeName].selection;
  }

  private branchIndex(n: MindNode, sheet: Sheet): number {
    const branchRootId = this.branchRoot(n, sheet);
    const root = sheet.nodes[sheet.rootNodeId];
    const index = root?.childrenIds.indexOf(branchRootId) ?? -1;
    return (index >= 0 ? index : 0) % 8;
  }

  private branchRoot(n: MindNode, sheet: Sheet): string {
    let cur: string | null = n.id;
    let prev: string | null = null;
    while (cur && cur !== sheet.rootNodeId) {
      prev = cur;
      cur = sheet.nodes[cur]?.parentId ?? null;
    }
    return prev ?? n.id;
  }

  /**
   * The outline drawn around a topic — selection, marquee preview, hover.
   *
   * One geometry for all three, on purpose. They used to differ: hover sat at
   * pad 2 with a 1.5px stroke, selection at pad 3 with 2.5px, so the ring
   * jumped a pixel outward at the exact moment a hovered topic was clicked.
   * Nothing in the document changed there — no op, no reflow, not even a text
   * bitmap — which is why the flicker was invisible to every measurement until
   * it was looked for in the painting. Only the WEIGHT may distinguish these
   * states; a ring that also moves reads as the node itself twitching.
   */
  private resetCanvasState(): void {
    this.curFont = "";
    this.curTextAlign = "";
    this.curTextBaseline = "";
    this.curLineDashSet = false;
  }

  private setFont(ctx: CanvasRenderingContext2D, font: string): void {
    if (this.curFont !== font) {
      ctx.font = font;
      this.curFont = font;
    }
  }

  private setTextAlign(ctx: CanvasRenderingContext2D, align: CanvasTextAlign): void {
    if (this.curTextAlign !== align) {
      ctx.textAlign = align;
      this.curTextAlign = align;
    }
  }

  private setTextBaseline(ctx: CanvasRenderingContext2D, baseline: CanvasTextBaseline): void {
    if (this.curTextBaseline !== baseline) {
      ctx.textBaseline = baseline;
      this.curTextBaseline = baseline;
    }
  }

  private setDash(ctx: CanvasRenderingContext2D, dash: number[]): void {
    if (dash.length === 0) {
      if (this.curLineDashSet) {
        ctx.setLineDash([]);
        this.curLineDashSet = false;
      }
    } else {
      ctx.setLineDash(dash);
      this.curLineDashSet = true;
    }
  }

  private strokeRing(ctx: CanvasRenderingContext2D, p: { x: number; y: number; w: number; h: number }, lineWidth: number): void {
    ctx.lineWidth = lineWidth;
    this.setDash(ctx, []);
    ctx.strokeRect(p.x - RING_PAD, p.y - RING_PAD, p.w + RING_PAD * 2, p.h + RING_PAD * 2);
  }

  /** Built once per stroke: strokes are immutable and canvas-local, so neither
   *  a repaint nor moving the canvas has to rebuild thousands of points. */
  private inkPaths = new WeakMap<InkStroke, Path2D>();

  private strokeInk(stroke: InkStroke, color: string): void {
    const ctx = this.ctx;
    let path = this.inkPaths.get(stroke);
    if (!path) {
      path = new Path2D();
      const line = inkPolyline(stroke);
      path.moveTo(line[0], line[1]);
      for (let i = 2; i < line.length; i += 2) path.lineTo(line[i], line[i + 1]);
      this.inkPaths.set(stroke, path);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = stroke.width;
    ctx.stroke(path);
  }

  private drawInk(theme: RenderTheme, p: Placed, state: RenderState): void {
    const strokes = inkStrokes(p.node.style);
    const draft = state.inkDraft?.canvasId === p.node.id && state.inkDraft.stroke.path.length >= 2 ? state.inkDraft.stroke : null;
    if (strokes.length === 0 && !draft) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (!state.inkErased?.has(stroke)) this.strokeInk(stroke, stroke.color ?? theme.text);
    }
    if (draft) {
      this.strokeInk(draft, draft.color ?? theme.text);
      // Still growing: the path just built must not outlive this frame.
      this.inkPaths.delete(draft);
    }
    ctx.restore();
  }

  private drawFreeform(theme: RenderTheme, p: Placed, state?: RenderState): void {
    // A diagram's page is painted as draw.io paper under everything
    // (drawDiagramPages), not as a canvas box with a title band.
    if (state && isDiagramPage(state.sheet, p.node.id)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = p.node.style.fill ?? theme.freeformFill ?? theme.background;
    ctx.strokeStyle = p.node.style.stroke ?? theme.nodeBorder;
    ctx.lineWidth = p.node.style.borderWidth ?? 1;
    const box = p.node.style.container;
    if (box) {
      // A diagram container: its own corners, a header band, no grid or hint.
      const radius = p.node.style.shape === "rect" ? 0 : 8;
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, radius);
      ctx.fill();
      if (box.headerFill) {
        ctx.save(); ctx.clip();
        ctx.fillStyle = box.headerFill;
        ctx.fillRect(p.x, p.y, p.w, FREEFORM_HEADER);
        ctx.beginPath(); ctx.moveTo(p.x, p.y + FREEFORM_HEADER); ctx.lineTo(p.x + p.w, p.y + FREEFORM_HEADER); ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, radius);
      ctx.setLineDash(p.node.style.borderStyle === "dashed" ? [6, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = p.node.style.textColor ?? theme.text;
      ctx.font = `600 ${p.node.style.fontSize ?? 13}px ${FONT_STACK}`;
      ctx.textAlign = p.node.style.align === "left" ? "left" : "center"; ctx.textBaseline = "middle";
      ctx.fillText(p.node.title, p.node.style.align === "left" ? p.x + 10 : p.x + p.w / 2, p.y + FREEFORM_HEADER / 2, p.w - 20);
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.roundRect(p.x, p.y, p.w, p.h, 12);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.font = `600 13px ${FONT_STACK}`;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(p.node.title || "Freeform", p.x + 14, p.y + FREEFORM_HEADER / 2, p.w - 28);
    // The first pen stroke removes the hint as it is written, not when it ends.
    const written = inkStrokes(p.node.style).length > 0 || state?.inkDraft?.canvasId === p.node.id;
    if (p.node.childrenIds.length === 0 && !written) {
      ctx.fillStyle = theme.textMuted; ctx.font = `13px ${FONT_STACK}`;
      ctx.fillText("Double-click to add text or a shape. Drop nodes, text or images here.", p.x + 18, p.y + FREEFORM_HEADER + 28, p.w - 36);
    }
    // The same corner mark as a chart box that has a note.
    if (state && freeformNote(state.sheet, p.node.id)) {
      ctx.fillStyle = theme.selection;
      ctx.beginPath();
      ctx.moveTo(p.x + p.w - 26, p.y);
      ctx.arcTo(p.x + p.w, p.y, p.x + p.w, p.y + 12, 12);
      ctx.lineTo(p.x + p.w, p.y + 26);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private hoverFill(fill: string, themeName: ThemeName): string {
    if (fill === "transparent") return fill;
    const key = `${themeName}|${fill}`;
    let out = this.hoverFillCache.get(key);
    if (out !== undefined) return out;
    out = themeName === "dark" ? lighten(fill, 0.1) : darken(fill, 0.05);
    this.hoverFillCache.set(key, out);
    return out;
  }

  private strokeSoftRing(
    ctx: CanvasRenderingContext2D,
    p: { x: number; y: number; w: number; h: number },
    shape: string,
    radius: number,
    color: string,
    baseAlpha: number
  ): void {
    const ringShape = shape === "none" ? "rounded" : shape;
    const baseRadius = shape === "none" ? 10 : radius;
    this.setDash(ctx, []);
    ctx.strokeStyle = color;
    ctx.globalAlpha = baseAlpha * 0.22;
    ctx.lineWidth = 6;
    this.traceShape(ctx, { ...p, x: p.x - 3, y: p.y - 3, w: p.w + 6, h: p.h + 6 }, ringShape, baseRadius + 3);
    ctx.stroke();
    ctx.globalAlpha = baseAlpha;
    ctx.lineWidth = 2;
    this.traceShape(ctx, { ...p, x: p.x - 1.5, y: p.y - 1.5, w: p.w + 3, h: p.h + 3 }, ringShape, baseRadius + 1.5);
    ctx.stroke();
  }

  /** V6: Shared geometry for the collapsed pill badge (used by both draw and hit-test). */
  collapsedBadgeRect(
    ctx: CanvasRenderingContext2D,
    p: { x: number; y: number; w: number; h: number },
    count: number
  ): { x: number; y: number; w: number; h: number; r: number; label: string } {
    const label = `+${count}`;
    this.setFont(ctx, `600 11px system-ui, sans-serif`);
    const w = Math.ceil(ctx.measureText(label).width + 12);
    const h = 18;
    const isLeft = p.x + p.w / 2 < 0;
    const x = isLeft ? p.x - 6 - w : p.x + p.w + 6;
    const y = p.y + p.h / 2 - h / 2;
    return { x, y, w, h, r: 9, label };
  }

  private drawNodeOverlay(
    ctx: CanvasRenderingContext2D,
    theme: RenderTheme,
    p: Placed,
    state: RenderState,
    flags: VisualFlags
  ): void {
    const n = p.node;
    const selected = state.selection.has(n.id);
    if (n.style.freeform) {
      if (selected || state.hoverId === n.id) {
        ctx.save();
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, p, selected ? RING_W_SELECTED : RING_W_HOVER);
        if (selected) {
          ctx.fillStyle = theme.selection;
          const hs = 8 / state.camera.scale;
          for (const [cx, cy] of [[p.x, p.y], [p.x + p.w, p.y], [p.x, p.y + p.h], [p.x + p.w, p.y + p.h]]) {
            ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
          }
        }
        ctx.restore();
        this.resetCanvasState();
      }
      return;
    }

    const isCode = !!n.style.code;
    const isTopic = !n.style.freeform && !freeformOwner(state.sheet, n.id);
    const boxShape = isCode ? "rounded" : isBarePicture(n) ? "none" : n.style.shape ?? "rounded";
    let boxRadius = isCode ? 8 : n.style.cornerRadius ?? 10;
    if (flags.rootPolish && n.type === "central" && boxShape !== "none" && !isCode) boxRadius += 4;
    const tweenAlpha = state.tween?.get(n.id)?.alpha ?? 1;
    const opacity = (n.style.opacity ?? 1) * tweenAlpha;
    const rotated = !!n.style.rotation;

    if (rotated) {
      ctx.save();
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate((n.style.rotation! * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    if (opacity !== 1) ctx.globalAlpha = opacity;

    // E1 + V7: hover tint on the overlay instead of repainting the scene
    if (flags.softSelect && isTopic && state.hoverId === n.id && !selected) {
      const tint = theme.name === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
      const cachedPath = this.getNodeShapePath(p, boxShape, boxRadius);
      ctx.fillStyle = tint;
      if (cachedPath) {
        ctx.fill(cachedPath);
      } else if (boxShape !== "none") {
        this.traceShape(ctx, p, boxShape, boxRadius);
        ctx.fill();
      }
    }

    if (selected) {
      if (flags.softSelect && isTopic) {
        this.strokeSoftRing(ctx, p, boxShape, boxRadius, theme.selection, opacity);
      } else {
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, p, RING_W_SELECTED);
      }

      const hs = 9;
      const hy = p.y + p.h / 2 - hs / 2;
      for (const hx of [p.x - hs / 2, p.x + p.w - hs / 2]) {
        ctx.beginPath();
        this.roundRect(ctx, hx, hy, hs, hs, 2);
        ctx.strokeStyle = theme.background;
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      if (freeformOwner(state.sheet, n.id) && !n.style.chartNote) {
        const s = state.camera.scale;
        const cs = 8 / s;
        if (isFreeTransform(state.sheet, n)) {
          const mx = p.x + p.w / 2, my = p.y + p.h / 2;
          const rotStem = 22 / s;
          ctx.beginPath();
          ctx.moveTo(mx, p.y);
          ctx.lineTo(mx, p.y - rotStem);
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.5 / s;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(mx, p.y - rotStem, 4.5 / s, 0, Math.PI * 2);
          ctx.fillStyle = theme.background;
          ctx.fill();
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.6 / s;
          ctx.stroke();

          const handles: [number, number][] = [
            [p.x, p.y], [mx, p.y], [p.x + p.w, p.y],
            [p.x, my], [p.x + p.w, my],
            [p.x, p.y + p.h], [mx, p.y + p.h], [p.x + p.w, p.y + p.h],
          ];
          ctx.fillStyle = theme.background;
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.6 / s;
          for (const [cx, cy] of handles) {
            ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
            ctx.strokeRect(cx - cs / 2, cy - cs / 2, cs, cs);
          }
        } else {
          ctx.fillStyle = theme.selection;
          for (const [cx, cy] of [[p.x, p.y], [p.x + p.w, p.y], [p.x, p.y + p.h], [p.x + p.w, p.y + p.h]]) {
            ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
          }
        }
      }

      for (const hnd of chartGrowHandles(p, this.curScale)) {
        const live = state.chartGrow?.id === n.id && state.chartGrow.grow === hnd.grow ? state.chartGrow : null;
        const off = live?.offset ?? 0;
        const x = hnd.x + (hnd.grow === "col" ? off : 0);
        const y = hnd.y + (hnd.grow === "row" ? off : 0);
        const thick = Math.min(hnd.w, hnd.h);
        ctx.beginPath();
        this.roundRect(ctx, x, y, hnd.w, hnd.h, thick / 2);
        ctx.fillStyle = live ? theme.selection : theme.background;
        ctx.fill();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = thick / 12;
        ctx.stroke();
        const fg = live ? theme.background : theme.selection;
        const cx = x + hnd.w / 2;
        const cy = y + hnd.h / 2;
        const arm = thick / 4.5;
        const ax = hnd.grow === "col" ? 1 : 0;
        const ay = 1 - ax;
        ctx.strokeStyle = fg;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = thick / 10;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy);
        ctx.lineTo(cx + arm, cy);
        ctx.moveTo(cx, cy - arm);
        ctx.lineTo(cx, cy + arm);
        ctx.stroke();
        const reach = Math.max(hnd.w, hnd.h) / 2 - thick * 0.32;
        const chev = thick * 0.16;
        ctx.lineWidth = thick / 13;
        ctx.beginPath();
        for (const sgn of [-1, 1]) {
          const tx = cx + ax * sgn * reach;
          const ty = cy + ay * sgn * reach;
          ctx.moveTo(tx - ax * sgn * chev + ay * chev, ty - ay * sgn * chev + ax * chev);
          ctx.lineTo(tx, ty);
          ctx.lineTo(tx - ax * sgn * chev - ay * chev, ty - ay * sgn * chev - ax * chev);
        }
        ctx.stroke();
        ctx.lineCap = "butt";
      }
    }

    if (selected || state.imageSel === n.id) {
      const hs = 9;
      const ir = this.selectedImageRect(state, p);
      if (ir) {
        const hx = ir.x + ir.w - hs / 2;
        const hy = ir.y + ir.h - hs / 2;
        ctx.beginPath();
        this.roundRect(ctx, hx, hy, hs, hs, 2);
        ctx.strokeStyle = theme.background;
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }

    if (!selected && state.marqueeSel?.has(n.id)) {
      if (flags.softSelect && isTopic) {
        this.strokeSoftRing(ctx, p, boxShape, boxRadius, theme.selection, opacity);
      } else {
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, p, RING_W_SELECTED);
      }
    }

    if (state.imageSel === n.id) {
      const ir = this.selectedImageRect(state, p);
      if (ir) {
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, ir, RING_W_SELECTED);
      }
    }

    if (state.gallerySel?.nodeId === n.id) {
      const { cells, gallery } = this.imageSlots(p);
      const c = cells[state.gallerySel.index];
      if (c) {
        const h = c.h + (gallery && gallery.captionH > 0 ? gallery.captionH : 0);
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, { x: c.x, y: c.y, w: c.w, h }, RING_W_SELECTED);
      }
    }

    if (state.hoverId === n.id && !selected && !(flags.softSelect && isTopic)) {
      ctx.strokeStyle = theme.selection;
      ctx.globalAlpha = opacity * 0.55;
      this.strokeRing(ctx, p, RING_W_HOVER);
      ctx.globalAlpha = opacity;
    }

    if (rotated) {
      ctx.restore();
      this.resetCanvasState();
    } else if (opacity !== 1) {
      ctx.globalAlpha = 1;
    }
  }

  private drawNode(
    theme: RenderTheme,
    p: Placed,
    state: RenderState,
    paintBackground = true,
    flags: VisualFlags = getVisualFlags(),
    byId?: Map<string, Placed>,
    drawOverlays = true
  ): void {
    const ctx = this.ctx;
    const n = p.node;
    const editing = state.editingId === n.id;
    const selected = state.selection.has(n.id);
    if (n.style.freeform) {
      // The diagram page has no frame, ring or handles: it is the paper.
      if (isDiagramPage(state.sheet, n.id)) return;
      if (paintBackground) this.drawFreeform(theme, p);
      if (drawOverlays && (selected || state.hoverId === n.id)) {
        ctx.save(); ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, p, selected ? RING_W_SELECTED : RING_W_HOVER);
        // A resize handle on every corner (draw.io): any edge can move.
        if (selected) {
          ctx.fillStyle = theme.selection;
          const hs = 8 / state.camera.scale;
          for (const [cx, cy] of [[p.x, p.y], [p.x + p.w, p.y], [p.x, p.y + p.h], [p.x + p.w, p.y + p.h]]) ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
        }
        ctx.restore();
        this.resetCanvasState();
      }
      return;
    }
    // A code topic paints its own block (T22): the box wears the code surface
    // unless the user picked a fill of their own, and the rich-text/image
    // path below is skipped entirely.
    const isCode = !!n.style.code;
    const depth = this.depthOf(n, state.sheet);
    const isTopic = !n.style.freeform && !freeformOwner(state.sheet, n.id);
    const boxShape = isCode ? "rounded" : isBarePicture(n) ? "none" : n.style.shape ?? "rounded";
    let boxRadius = isCode ? 8 : n.style.cornerRadius ?? 10;
    const rootPolishActive = flags.rootPolish && n.type === "central" && boxShape !== "none" && !isCode;
    if (rootPolishActive) boxRadius += 4;

    const accentStripActive =
      flags.accentStrip &&
      !theme.tintedTopics &&
      state.sheet.structure.structureType !== "diagram" &&
      depth >= 2 &&
      !n.style.fill &&
      !isCode &&
      !isBarePicture(n) &&
      // Pictures and galleries are framed by their image: a bar down one
      // side of a photo reads as a misplaced drop shadow, not as a colour cue.
      !n.style.gallery &&
      nodeImageIds(n).length === 0 &&
      (boxShape === "rounded" || boxShape === "rect") &&
      !freeformOwner(state.sheet, n.id);

    let fill = isCode ? n.style.fill ?? theme.codeBg : accentStripActive ? theme.deepFill : this.nodeFill(theme, p, state);
    if (drawOverlays && flags.softSelect && isTopic && state.hoverId === n.id && !selected) {
      fill = this.hoverFill(fill, theme.name);
    }

    const textColor = this.defaultTextColor(theme, n, depth, fill);
    const tweenAlpha = state.tween?.get(n.id)?.alpha ?? 1;
    const opacity = (n.style.opacity ?? 1) * tweenAlpha;
    const rotated = !!n.style.rotation;

    if (rotated) ctx.save();
    if (opacity !== 1) ctx.globalAlpha = opacity;
    // Rotation turns the item around its own centre (draw.io's rotation).
    if (rotated) {
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate((n.style.rotation! * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }

    const art = !isCode && n.style.shape === "custom" ? n.style.shapeParts : undefined;
    const lodBare = flags.lod && state.camera.scale < LOD_BARE;

    // shadow. With V3 on, every topic casts one: rounded boxes got theirs from
    // the sprite pass in render(); the shapes a 9-slice cannot follow
    // (circle, diamond, artwork, rotated items) fall back to a real blur, on
    // those few nodes only. With V3 off, only `style.shadow` topics, as before.
    const blurShadow = !lodBare && (flags.flatShadow
      ? this.castsShadow(n, state.sheet, art && art.length > 0 ? "custom" : boxShape) &&
        this.spriteShadowOf(p, state.sheet, flags) === null
      : !!n.style.shadow);
    if (blurShadow) {
      ctx.shadowColor = theme.shadow;
      ctx.shadowBlur = Math.min(24, (flags.flatShadow ? SHADOW_BLUR : 12) * (flags.flatShadow ? state.camera.scale * this.dpr : 1));
      ctx.shadowOffsetY = flags.flatShadow ? SHADOW_DY * state.camera.scale * this.dpr : 4;
    }

    // Custom artwork (T24): a list of paths painted in order, silhouette first.
    // It replaces the box entirely — there is no rectangle underneath, or every
    // shape would sit on a visible slab.
    const cachedPath = art && art.length > 0 ? null : this.getNodeShapePath(p, boxShape, boxRadius);
    let fillPaint: string | CanvasGradient = fill;
    if (rootPolishActive && !n.style.fill && !(drawOverlays && flags.softSelect && isTopic && state.hoverId === n.id && !selected)) {
      const gKey = `${theme.name}|${p.y}|${p.h}`;
      if (this.rootGradCache?.key !== gKey) {
        const grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
        grad.addColorStop(0, theme.rootFill);
        grad.addColorStop(1, darken(theme.rootFill, 0.04));
        this.rootGradCache = { key: gKey, grad };
      }
      fillPaint = this.rootGradCache.grad;
    }

    if (art && art.length > 0) {
      this.paintShapeArt(ctx, theme, p, art, fill);
      if (blurShadow) {
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
    } else if (cachedPath) {
      ctx.fillStyle = fillPaint;
      ctx.fill(cachedPath);
      if (blurShadow) {
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
    } else {
      // A code block is always a rounded rectangle: shape styles (circle,
      // diamond…) describe presentational topics, and the chrome strip needs a
      // straight top edge to sit on.
      // A bare picture has no box under it: a transparent PNG shows the canvas.
      this.traceShape(ctx, p, boxShape, boxRadius);
      ctx.fillStyle = fillPaint;
      ctx.fill();
      if (blurShadow) {
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }
    }

    // V4: Accent strip on subtopics (no clip()!)
    if (accentStripActive && !lodBare) {
      const parent = n.parentId && byId ? byId.get(n.parentId) : undefined;
      const onRight = parent ? p.x + p.w / 2 >= parent.x + parent.w / 2 : p.x + p.w / 2 >= 0;
      // An inset pill, clear of the box edge. Flush against the edge, a 4-unit
      // bar in a dark branch colour on the right of every left-side topic
      // looked exactly like a hard shadow cast sideways. It sits inside the
      // topic's padding (subtopics: 7) so the text keeps its original place.
      const inset = 2, barW = 3, vPad = Math.min(6, p.h * 0.25);
      const stripX = onRight ? p.x + inset : p.x + p.w - inset - barW;
      ctx.fillStyle = this.branchColor(theme, n, state.sheet);
      ctx.beginPath();
      ctx.roundRect(stripX, p.y + vPad, barW, p.h - vPad * 2, barW / 2);
      ctx.fill();
    }

    // Custom artwork carries its own strokes; an outline over it would trace
    // whatever path the last part left behind.
    const border = lodBare || (art && art.length > 0) ? null : this.resolveBorder(theme, n, state.sheet);
    if (rootPolishActive && !lodBare && !art?.length && n.style.borderStyle !== "none" && n.style.stroke !== "transparent") {
      ctx.strokeStyle = theme.selection;
      ctx.globalAlpha = opacity * 0.55;
      ctx.lineWidth = 1.5;
      this.setDash(ctx, []);
      if (cachedPath) ctx.stroke(cachedPath);
      else {
        this.traceShape(ctx, p, boxShape, boxRadius);
        ctx.stroke();
      }
      ctx.globalAlpha = opacity;
    } else if (border) {
      // A text-only topic ("none") traces no path, so an outline chosen for it
      // would vanish: it gets the default rounded box to sit on.
      const shape = isCode ? "rounded" : n.style.shape === "none" ? "rounded" : n.style.shape ?? "rounded";
      const radius = isCode ? 8 : (n.style.cornerRadius ?? 10) + (rootPolishActive ? 4 : 0);
      ctx.strokeStyle = border.color;
      ctx.lineCap = border.cap;
      this.setDash(ctx, border.dash);
      if (border.double) {
        const t = border.width / 3;
        ctx.lineWidth = t;
        for (const d of [t, -t]) {
          this.traceShape(ctx, { ...p, x: p.x - d, y: p.y - d, w: p.w + d * 2, h: p.h + d * 2 }, shape, Math.max(0, radius + d));
          ctx.stroke();
        }
      } else if (cachedPath && shape === boxShape && radius === boxRadius) {
        ctx.lineWidth = border.width;
        ctx.stroke(cachedPath);
      } else {
        const borderPath = this.getNodeShapePath(p, shape, radius);
        ctx.lineWidth = border.width;
        if (borderPath) {
          ctx.stroke(borderPath);
        } else {
          this.traceShape(ctx, p, shape, radius);
          ctx.stroke();
        }
      }
      // A diagram shape's inner linework (cylinder rim, process bars, note fold).
      if (!isCode && isDiagramShape(shape)) {
        const detail = diagramShapePath(shape, p.x, p.y, p.w, p.h).detail;
        if (detail.length) {
          ctx.beginPath();
          tracePath(ctx, detail);
          ctx.lineWidth = border.double ? border.width / 3 : border.width;
          ctx.stroke();
        }
      }
      this.setDash(ctx, []);
      ctx.lineCap = "butt";
    }

    // selection ring & overlays (skipped in scene pass when overlayLayer is active)
    if (drawOverlays) {
      if (selected) {
      if (flags.softSelect && isTopic) {
        this.strokeSoftRing(ctx, p, boxShape, boxRadius, theme.selection, opacity);
      } else {
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, p, RING_W_SELECTED);
      }

      // Xmind-style resize handles on BOTH edges (hidden while editing — the
      // HTML overlay owns the node then). Dragging changes the width and the
      // text re-wraps; see hitTestResize + store.setResizeDraft. Outline only
      // (a filled square reads as a purple blob on the node); a white
      // under-stroke keeps them visible on dark/same-colored fills (e.g. the
      // indigo central topic) without adding a fill.
      const hs = 9;
      const hy = p.y + p.h / 2 - hs / 2;
      for (const hx of [p.x - hs / 2, p.x + p.w - hs / 2]) {
        // roundRect only appends: without a fresh path the box's own outline
        // is still in it, and the pill fill below repainted the whole chart.
        ctx.beginPath();
        this.roundRect(ctx, hx, hy, hs, hs, 2);
        ctx.strokeStyle = theme.background;
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      // An item of a canvas also resizes from its corners (width AND height).
      if (freeformOwner(state.sheet, n.id) && !n.style.chartNote) {
        const s = state.camera.scale;
        const cs = 8 / s;
        if (isFreeTransform(state.sheet, n)) {
          // Photoshop-style free-transform box: 8 resize handles + top rotation handle.
          const mx = p.x + p.w / 2, my = p.y + p.h / 2;
          const rotStem = 22 / s;
          ctx.beginPath();
          ctx.moveTo(mx, p.y);
          ctx.lineTo(mx, p.y - rotStem);
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.5 / s;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(mx, p.y - rotStem, 4.5 / s, 0, Math.PI * 2);
          ctx.fillStyle = theme.background;
          ctx.fill();
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.6 / s;
          ctx.stroke();

          const handles: [number, number][] = [
            [p.x, p.y], [mx, p.y], [p.x + p.w, p.y],
            [p.x, my], [p.x + p.w, my],
            [p.x, p.y + p.h], [mx, p.y + p.h], [p.x + p.w, p.y + p.h],
          ];
          ctx.fillStyle = theme.background;
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.6 / s;
          for (const [cx, cy] of handles) {
            ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
            ctx.strokeRect(cx - cs / 2, cy - cs / 2, cs, cs);
          }
        } else {
          ctx.fillStyle = theme.selection;
          for (const [cx, cy] of [[p.x, p.y], [p.x + p.w, p.y], [p.x, p.y + p.h], [p.x + p.w, p.y + p.h]]) ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
        }
      }
      // A selected chart grows from its edges: "+" pills just outside the box,
      // to the right (a column) and underneath (a row). Same outline style as
      // the width handles; the rects come from chartGrowHandles, which the hit
      // test reads too.
      // They are sliders: the one being dragged rides along with the pointer.
      for (const hnd of chartGrowHandles(p, this.curScale)) {
        const live = state.chartGrow?.id === n.id && state.chartGrow.grow === hnd.grow ? state.chartGrow : null;
        const off = live?.offset ?? 0;
        const x = hnd.x + (hnd.grow === "col" ? off : 0);
        const y = hnd.y + (hnd.grow === "row" ? off : 0);
        const thick = Math.min(hnd.w, hnd.h);
        ctx.beginPath();
        this.roundRect(ctx, x, y, hnd.w, hnd.h, thick / 2);
        ctx.fillStyle = live ? theme.selection : theme.background;
        ctx.fill();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = thick / 12;
        ctx.stroke();
        const fg = live ? theme.background : theme.selection;
        const cx = x + hnd.w / 2;
        const cy = y + hnd.h / 2;
        const arm = thick / 4.5;
        // Along = the axis it slides on; across = the other one.
        const ax = hnd.grow === "col" ? 1 : 0;
        const ay = 1 - ax;
        ctx.strokeStyle = fg;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = thick / 10;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy);
        ctx.lineTo(cx + arm, cy);
        ctx.moveTo(cx, cy - arm);
        ctx.lineTo(cx, cy + arm);
        ctx.stroke();
        // Two chevrons at the ends: "slide me either way".
        const reach = Math.max(hnd.w, hnd.h) / 2 - thick * 0.32;
        const chev = thick * 0.16;
        ctx.lineWidth = thick / 13;
        ctx.beginPath();
        for (const sgn of [-1, 1]) {
          const tx = cx + ax * sgn * reach;
          const ty = cy + ay * sgn * reach;
          ctx.moveTo(tx - ax * sgn * chev + ay * chev, ty - ay * sgn * chev + ax * chev);
          ctx.lineTo(tx, ty);
          ctx.lineTo(tx - ax * sgn * chev - ay * chev, ty - ay * sgn * chev - ax * chev);
        }
        ctx.stroke();
        ctx.lineCap = "butt";
      }
    }
    // Image resize handle (T14): bottom-right corner of the image, same
    // outline style as the width handles. Same rect as imageWorldRect. Drawn
    // for a selected node OR a selected IMAGE (the image is then the focus —
    // resize must stay reachable without reselecting the node).
    if (selected || state.imageSel === n.id) {
      const hs = 9;
      // selectedImageRect, NOT imageWorldRect: the placed node is already in
      // hand. imageWorldRect re-places and re-measures the WHOLE sheet to find
      // one node — 8.7ms on an 8,000-node map — and this runs per selected
      // node per frame, so selecting fifty topics cost 434ms a frame. That is
      // the "everything crawls once I select a lot" report.
      const ir = this.selectedImageRect(state, p);
      if (ir) {
        const hx = ir.x + ir.w - hs / 2;
        const hy = ir.y + ir.h - hs / 2;
        this.roundRect(ctx, hx, hy, hs, hs, 2);
        ctx.strokeStyle = theme.background;
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    // Marquee preview ring: the topic is inside the drag box but not yet
    // committed — same ring as selection, no resize handles (it is not
    // really selected until the release).
    if (!selected && state.marqueeSel?.has(n.id)) {
      if (flags.softSelect && isTopic) {
        this.strokeSoftRing(ctx, p, boxShape, boxRadius, theme.selection, opacity);
      } else {
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, p, RING_W_SELECTED);
      }
    }
    // Image selection ring: the image is selected (not the node) — outline
    // around the SELECTED slot so Backspace/Delete knows what it will remove.
    if (state.imageSel === n.id) {
      const ir = this.selectedImageRect(state, p); // same reason as above
      if (ir) {
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, ir, RING_W_SELECTED);
      }
    }
    // Gallery cell selection ring (T25): a cell is a target of its own, so it
    // says so the same way a selected image does. Drawn from the same
    // positioned cells the painter and the hit test use, so the ring cannot
    // land anywhere but on the picture the keys will act on.
    if (state.gallerySel?.nodeId === n.id) {
      const { cells, gallery } = this.imageSlots(p);
      const c = cells[state.gallerySel.index];
      if (c) {
        const h = c.h + (gallery && gallery.captionH > 0 ? gallery.captionH : 0);
        ctx.strokeStyle = theme.selection;
        this.strokeRing(ctx, { x: c.x, y: c.y, w: c.w, h }, RING_W_SELECTED);
      }
    }
    if (state.hoverId === n.id && !selected && !(flags.softSelect && isTopic)) {
      ctx.strokeStyle = theme.selection;
      ctx.globalAlpha = opacity * 0.55;
      this.strokeRing(ctx, p, RING_W_HOVER);
      ctx.globalAlpha = opacity;
    }
    }

    // task ribbon
    if (n.task && n.task.status === "completed") {
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(p.x, p.y, p.w, 3);
    } else if (n.task && n.task.priority && n.task.priority !== "none") {
      ctx.fillStyle = n.task.priority === "high" || n.task.priority === "urgent" ? "#f87171" : n.task.priority === "medium" ? "#fbbf24" : "#a3e635";
      ctx.beginPath();
      ctx.arc(p.x + p.w - 8, p.y + p.h - 8, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // images between shape and text (ADR-001 §12); skipped while editing —
    // the HTML overlay owns it, no double-render (same rule as the text).
    if (!editing) {
      if (isCode) {
        // A code block paints its own chrome and tokenized lines; the images
        // and the rich-text path are skipped because code has neither, and
        // staying off the rich-text path keeps this out of the §3 parity
        // contract entirely (T22).
        this.drawCodeBlock(theme, p);
      } else {
        this.drawImage(p);
        this.drawGallery(theme, p, state.sheet);
        const sx = n.style.textScaleX ?? 1;
        const sy = n.style.textScaleY ?? 1;
        // Free-transform text is painted as vectors, never from the bitmap
        // cache, so it stays sharp at any size and stretch.
        const vector = sx !== 1 || sy !== 1 || isFreeTransform(state.sheet, n);
        if (sx !== 1 || sy !== 1) {
          const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
          const uw = p.w / sx, uh = p.h / sy;
          const unstretched: Placed = { ...p, x: cx - uw / 2, y: cy - uh / 2, w: uw, h: uh };
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(sx, sy);
          ctx.translate(-cx, -cy);
          if (n.style.titleAt) this.drawOwnLabel(unstretched, textColor);
          else this.drawText(theme, unstretched, textColor, vector);
          ctx.restore();
          this.resetCanvasState();
        } else {
          if (n.style.titleAt) this.drawOwnLabel(p, textColor);
          else this.drawText(theme, p, textColor, vector);
        }
      }
    }

    // collapsed badge (mirror to the left when the branch is left-side)
    if (!lodBare && n.collapsed && n.childrenIds.length > 0) {
      const count = this.hiddenCount(n, state.sheet);
      if (flags.junctions) {
        const badge = this.collapsedBadgeRect(ctx, p, count);
        ctx.fillStyle = this.branchColor(theme, n, state.sheet);
        ctx.beginPath();
        ctx.roundRect(badge.x, badge.y, badge.w, badge.h, badge.r);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        this.setFont(ctx, `600 11px system-ui, sans-serif`);
        this.setTextAlign(ctx, "center");
        this.setTextBaseline(ctx, "middle");
        ctx.fillText(badge.label, badge.x + badge.w / 2, badge.y + badge.h / 2 + 0.5);
      } else {
        const centerX = p.x + p.w / 2;
        const isLeft = centerX < 0;
        const bx = isLeft ? p.x - 10 : p.x + p.w + 10;
        const by = p.y + p.h / 2;
        ctx.fillStyle = theme.collapsedBadge;
        ctx.beginPath();
        ctx.arc(bx, by, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.collapsedBadgeText;
        this.setFont(ctx, `600 11px system-ui, sans-serif`);
        this.setTextAlign(ctx, "center");
        this.setTextBaseline(ctx, "middle");
        ctx.fillText(String(count), bx, by + 0.5);
      }
    }

    if (rotated) {
      ctx.restore();
      this.resetCanvasState();
    } else if (opacity !== 1) {
      ctx.globalAlpha = 1;
    }
  }

  private hiddenCount(n: MindNode, sheet: Sheet): number {
    let count = 0;
    const queue = [...n.childrenIds];
    while (queue.length) {
      const id = queue.shift()!;
      const c = sheet.nodes[id];
      if (!c) continue;
      count++;
      if (!c.collapsed) queue.push(...c.childrenIds);
    }
    return count;
  }

  /** V3: does this topic cast a shadow at all? Map topics and canvases do;
   *  items inside a canvas (diagrams) and text-only shapes do not. */
  private castsShadow(n: MindNode, sheet: Sheet, shape: string): boolean {
    if (shape === "none" || shape === "underline") return false;
    if (!n.style.freeform && freeformOwner(sheet, n.id)) return false;
    return true;
  }

  /** V3: the corner radius the sprite pass should draw this topic's shadow
   *  with, or null when the sprite cannot follow its outline (drawNode then
   *  blurs it for real) or it casts none. */
  private spriteShadowOf(p: Placed, sheet: Sheet, flags: VisualFlags): number | null {
    const n = p.node;
    if (n.style.rotation) return null;
    const isCode = !!n.style.code;
    if (!isCode && n.style.shape === "custom" && n.style.shapeParts?.length) return null;
    const shape = isCode ? "rounded" : isBarePicture(n) ? "none" : n.style.shape ?? "rounded";
    if (!this.castsShadow(n, sheet, shape)) return null;
    if (shape === "rect") return 0;
    if (shape === "capsule") return Math.min(p.w, p.h) / 2;
    if (shape !== "rounded") return null;
    let r = n.style.freeform ? 12 : isCode ? 8 : n.style.cornerRadius ?? 10;
    if (flags.rootPolish && n.type === "central" && !isCode) r += 4;
    return Math.min(r, p.w / 2, p.h / 2);
  }

  /**
   * V3: a soft drop shadow for a rounded box, as a 9-slice of a sprite that
   * was blurred once: corners copied, edges and middle stretched. Nine
   * drawImage calls instead of one shadowBlur per node, which is the most
   * expensive thing Canvas2D does.
   */
  private drawShadowSprite(ctx: CanvasRenderingContext2D, color: string, p: Placed, radius: number, alpha: number): void {
    const res = Math.max(1, Math.min(3, Math.ceil(this.curScale * this.dpr)));
    const r = Math.round(radius);
    const key = `${color}|${r}|${res}`;
    let sprite = this.shadowSprites.get(key);
    if (!sprite) {
      if (this.shadowSprites.size >= 48) this.freeShadowSprites();
      const core = 2 * r + 2;
      const size = Math.round((2 * SHADOW_PAD + core) * res);
      sprite = document.createElement("canvas");
      sprite.width = size;
      sprite.height = size;
      const g = sprite.getContext("2d");
      if (!g) return;
      // Draw the box off-canvas and let only its shadow land: the sprite holds
      // the shadow alone, so a translucent topic does not show a slab.
      const off = size + 64;
      g.shadowColor = color;
      g.shadowBlur = SHADOW_BLUR * res;
      g.shadowOffsetX = off;
      g.fillStyle = "#000";
      g.beginPath();
      g.roundRect(SHADOW_PAD * res - off, SHADOW_PAD * res, core * res, core * res, r * res);
      g.fill();
      this.shadowSprites.set(key, sprite);
    }
    const S = sprite.width;
    const c = Math.round((SHADOW_PAD + r) * res); // source corner, px
    const X = p.x - SHADOW_PAD, Y = p.y + SHADOW_DY - SHADOW_PAD;
    const W = p.w + 2 * SHADOW_PAD, H = p.h + 2 * SHADOW_PAD;
    const k = Math.min(SHADOW_PAD + r, W / 2, H / 2); // dest corner, world
    const sxs = [0, c, S - c], sws = [c, S - 2 * c, c];
    const dxs = [X, X + k, X + W - k], dws = [k, W - 2 * k, k];
    const dys = [Y, Y + k, Y + H - k], dhs = [k, H - 2 * k, k];
    if (alpha !== 1) ctx.globalAlpha = alpha;
    for (let j = 0; j < 3; j++) {
      if (dhs[j] <= 0) continue;
      for (let i = 0; i < 3; i++) {
        if (dws[i] <= 0) continue;
        ctx.drawImage(sprite, sxs[i], sxs[j], sws[i], sws[j], dxs[i], dys[j], dws[i], dhs[j]);
      }
    }
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  private freeShadowSprites(): void {
    for (const c of this.shadowSprites.values()) { c.width = 0; c.height = 0; }
    this.shadowSprites.clear();
  }

  /** A relationship arrow, with a real blurred shadow when V3 is on. Arrows
   *  are few, so shadowBlur is affordable here; it is skipped while moving. */
  private drawRelationshipShadowed(theme: RenderTheme, a: Placed, b: Placed, rel: Relationship, state: RenderState, shadow: boolean): void {
    const ctx = this.ctx;
    if (shadow) {
      const k = state.camera.scale * this.dpr; // shadow* ignore the transform
      ctx.shadowColor = theme.shadow;
      ctx.shadowBlur = Math.min(24, 8 * k);
      ctx.shadowOffsetY = CONNECTOR_SHADOW_DY * k;
    }
    this.drawRelationship(theme, a, b, rel, rel.color ?? (rel.tree || state.sheet.structure.structureType === "diagram" ? theme.text : theme.selection), state.relSel === rel.id, this.relEnv(state, rel));
    if (shadow) {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
  }

  /**
   * Paint a custom shape's parts (T24), scaled from their 0..1 box onto the
   * node's rect and drawn in order.
   *
   * `Path2D` cannot be appended to the context's current path, so this branch
   * fills its own paths rather than going through traceShape — the built-in
   * shapes keep the existing route untouched.
   */
  private paintShapeArt(ctx: CanvasRenderingContext2D, theme: RenderTheme, p: Placed, parts: ShapePart[], fallbackFill: string): void {
    if (typeof Path2D === "undefined") return;
    const m = new DOMMatrix().translateSelf(p.x, p.y).scaleSelf(p.w, p.h);
    for (const part of parts) {
      let path: Path2D;
      try {
        path = new Path2D();
        path.addPath(new Path2D(part.d), m);
      } catch {
        continue; // a path the engine refuses is skipped, never fatal
      }
      ctx.fillStyle = resolvePaint(part.fill, theme, fallbackFill);
      ctx.fill(path, part.rule ?? "nonzero");
      if (part.stroke) {
        ctx.strokeStyle = resolvePaint(part.stroke, theme, theme.text);
        // strokeWidth is in the same 0..1 units as the path, so it scales with
        // the node instead of thinning out as the shape grows.
        ctx.lineWidth = Math.max(0.5, (part.strokeWidth ?? 0.01) * p.w);
        ctx.setLineDash([]);
        ctx.stroke(path);
      }
    }
  }

  private getNodeShapePath(p: Placed, shape: string, radius: number): Path2D | null {
    if (typeof Path2D === "undefined" || shape === "none") return null;
    const key = `${p.x}|${p.y}|${p.w}|${p.h}|${shape}|${radius}`;
    const cached = this.nodeShapePaths.get(p);
    if (cached && cached.key === key) return cached.path;
    const path = new Path2D();
    this.traceShapeToPath(path, p.x, p.y, p.w, p.h, shape, radius);
    this.nodeShapePaths.set(p, { key, path });
    return path;
  }

  private traceShapeToPath(path: Path2D, x: number, y: number, w: number, h: number, shape: string, radius: number): void {
    switch (shape) {
      case "rect":
        path.rect(x, y, w, h);
        break;
      case "capsule":
        this.roundRectPath(path, x, y, w, h, h / 2);
        break;
      case "circle": {
        const r = Math.max(w, h) / 2;
        path.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
        break;
      }
      case "diamond":
        path.moveTo(x + w / 2, y);
        path.lineTo(x + w, y + h / 2);
        path.lineTo(x + w / 2, y + h);
        path.lineTo(x, y + h / 2);
        path.closePath();
        break;
      case "hexagon":
        path.moveTo(x + w * 0.25, y);
        path.lineTo(x + w * 0.75, y);
        path.lineTo(x + w, y + h / 2);
        path.lineTo(x + w * 0.75, y + h);
        path.lineTo(x + w * 0.25, y + h);
        path.lineTo(x, y + h / 2);
        path.closePath();
        break;
      case "underline":
        this.roundRectPath(path, x, y, w, h, radius);
        break;
      case "none":
        break;
      default:
        if (isDiagramShape(shape)) {
          for (const seg of diagramShapePath(shape, x, y, w, h).outline) {
            if (seg[0] === "M") path.moveTo(seg[1], seg[2]);
            else if (seg[0] === "L") path.lineTo(seg[1], seg[2]);
            else if (seg[0] === "C") path.bezierCurveTo(seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]);
            else path.closePath();
          }
        } else {
          this.roundRectPath(path, x, y, w, h, radius);
        }
    }
  }

  private roundRectPath(path: Path2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    path.moveTo(x + rr, y);
    path.arcTo(x + w, y, x + w, y + h, rr);
    path.arcTo(x + w, y + h, x, y + h, rr);
    path.arcTo(x, y + h, x, y, rr);
    path.arcTo(x, y, x + w, y, rr);
    path.closePath();
  }

  private traceShape(ctx: CanvasRenderingContext2D, p: { x: number; y: number; w: number; h: number }, shape: string, radius: number): void {
    const { x, y, w, h } = p;
    ctx.beginPath();
    switch (shape) {
      case "rect":
        ctx.rect(x, y, w, h);
        break;
      case "capsule":
        this.roundRect(ctx, x, y, w, h, h / 2);
        break;
      case "circle": {
        const r = Math.max(w, h) / 2;
        ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
        break;
      }
      case "diamond":
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w / 2, y + h);
        ctx.lineTo(x, y + h / 2);
        ctx.closePath();
        break;
      case "hexagon":
        ctx.moveTo(x + w * 0.25, y);
        ctx.lineTo(x + w * 0.75, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.lineTo(x + w * 0.75, y + h);
        ctx.lineTo(x + w * 0.25, y + h);
        ctx.lineTo(x, y + h / 2);
        ctx.closePath();
        break;
      case "underline":
        this.roundRect(ctx, x, y, w, h, radius);
        break;
      case "none":
        // Text-only topics (the central topic in the XMind-inspired theme).
        break;
      default:
        if (isDiagramShape(shape)) tracePath(ctx, diagramShapePath(shape, x, y, w, h).outline);
        else this.roundRect(ctx, x, y, w, h, radius);
    }
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * What an empty topic shows instead of nothing.
   *
   * New topics used to be born holding the words "Subtopic 1", which every
   * user then had to select and delete before writing anything. The title is
   * now genuinely empty and this is drawn in its place: it is a hint, not
   * content, so it never enters the document, never exports, and disappears
   * the moment a character is typed.
   */
  private placeholderFor(n: MindNode): string {
    if (n.type === "central") return "Central Topic";
    if (n.type === "main") return "Main Topic";
    if (n.type === "floating") return "New Idea";
    return "Subtopic";
  }

  /**
   * A topic carrying pictures is not an empty text box: the "Subtopic" hint
   * would be painted straight over the image (the layout reserves the picture's
   * rect but still centres the text block in what is left). The hint belongs to
   * a topic with nothing to show, so pictures — in any slot or a gallery —
   * suppress it.
   */
  private hasPictures(n: MindNode): boolean {
    return !!(n.style.image || n.style.imageBottom || n.style.imageLeft || n.style.imageRight || n.style.gallery?.items.length);
  }

  /** The hint, drawn faint and centred. Not cached: an empty topic is rare and
   *  becomes non-empty the moment anyone types. */
  private drawPlaceholder(p: Placed, color: string): void {
    const n = p.node;
    const ctx = this.ctx;
    const size = n.style.fontSize ?? 14;
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = color;
    ctx.font = `${n.style.italic ? "italic " : ""}${n.style.fontWeight ?? 400} ${size}px ${n.style.fontFamily ?? FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.placeholderFor(n), p.x + p.w / 2, p.y + p.h / 2 + 0.5);
    ctx.restore();
  }

  /** A label R-node paints itself, at the top or bottom of the box (Style.titleAt). */
  private drawOwnLabel(p: Placed, color: string): void {
    const n = p.node, ctx = this.ctx;
    if (!n.title.trim()) return;
    const size = n.style.fontSize ?? 14;
    ctx.save();
    ctx.font = `${n.style.italic ? "italic " : ""}${n.style.fontWeight ?? 400} ${size}px ${FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    const left = n.style.align === "left";
    ctx.textAlign = left ? "left" : "center";
    const lines = wrapPlainLines(n.title, Math.max(20, p.w - OWN_LABEL_PAD * 2), (t) => ctx.measureText(t).width);
    const lh = size * OWN_LABEL_LINE;
    let y = n.style.titleAt === "bottom" ? p.y + p.h - OWN_LABEL_PAD - lines.length * lh : p.y + OWN_LABEL_PAD;
    const x = left ? p.x + OWN_LABEL_PAD : p.x + p.w / 2;
    for (const line of lines) { ctx.fillText(line, x, y); y += lh; }
    ctx.restore();
  }

  private drawText(_theme: RenderTheme, p: Placed, color: string, vector = false): void {
    const n = p.node;
    // The caller already skips this node entirely while it is being edited,
    // so an empty title here means an empty topic nobody is typing into.
    // Pictures are content too: an empty title on a topic that owns an image
    // must not grow a hint on top of it.
    if (n.title.trim() === "") {
      // A draw.io shape is allowed to be empty: no hint inside it.
      if (!this.hasPictures(n) && !(this.curDiagram && n.style.shape && n.style.shape !== "none")) this.drawPlaceholder(p, color);
      return;
    }
    const pad = n.style.padding ?? 10;
    // Side images reserve their columns; the wrap width shrinks by the same
    // amount measureTopic uses, so the bitmap (keyed on this width) is
    // invalidated exactly when a side image appears or disappears.
    //
    // A custom shape does NOT narrow this. Its drawing is a BACKGROUND and the
    // label lays out across the whole box exactly as it would on a rectangular
    // topic. Confining the text to the silhouette's interior — which is what
    // this did first — wrapped it one word per line and made the drawing read
    // as a container it is not.
    const slots = this.imageSlots(p);
    const maxW = Math.max(20, p.w - pad * 2 - TEXT_INSET - slots.sidePadW);
    const topBlock = slots.insets.top;
    const botBlock = slots.insets.bottom;
    const startX = p.x + pad + slots.insets.left;
    // From 50% up the text is drawn as vectors, every frame: a cached bitmap
    // is a picture of the text, rescaled between its resolution steps, so it
    // read soft (at DPR 1 everything below 100% was a 1× bitmap shrunk). Below
    // 50% — where a whole map can be visible — the bitmap cache stays.
    if (vector || this.curScale >= VECTOR_TEXT_MIN_SCALE) {
      const size = n.style.fontSize ?? 14;
      const lines = wrapRunLines(nodeRuns(n.title, n.titleRuns), maxW, this.measurer, n.style);
      let totalH = 0;
      for (const line of lines) totalH += (line.height ?? size * LINE_HEIGHT_FACTOR) + (line.gapPx ?? 0);
      const midH = topBlock + totalH + botBlock;
      const startY = p.y + pad + topBlock + Math.max(0, (p.h - pad * 2 - midH) / 2);
      this.ctx.save();
      this.ctx.textBaseline = "alphabetic";
      this.paintRunLines(this.ctx, n, color, maxW, lines, startX, startY);
      this.ctx.restore();
      return;
    }
    // Resolution bucket: re-render the bitmap only when the zoom crosses a
    // power-of-two boundary; between boundaries pan/zoom just blits.
    const res = Math.max(1, Math.min(4, Math.ceil(this.curScale * this.dpr)));
    const key = this.textCacheKey(n, color, maxW, res);
    let entry = this.textCache.get(key);
    if (entry) {
      this.textHits++;
      // LRU refresh (Map insertion order = recency), exactly like imageCache:
      // without it the FIFO eviction could throw away the node the user is
      // looking at while keeping one that scrolled off long ago.
      this.textCache.delete(key);
      this.textCache.set(key, entry);
    } else {
      this.textMisses++;
      const bitmap = this.renderTextBitmap(n, color, maxW, res);
      const bytes = bitmap.canvas.width * bitmap.canvas.height * 4;
      entry = { ...bitmap, bytes };
      this.textCache.set(key, entry);
      this.textBytes += bytes;
      trace.mark("render", "render:text-cache", { bytes, kind: "insert" });
      this.evictTextToBudget();
    }
    const totalH = entry.h;
    const midH = topBlock + totalH + botBlock;
    const startY = p.y + pad + topBlock + Math.max(0, (p.h - pad * 2 - midH) / 2);
    if (entry.w > 0 && entry.h > 0) this.ctx.drawImage(entry.canvas, startX, startY, entry.w, entry.h);
  }

  /**
   * Draw every image slot of the node into its reserved rect (cached
   * bitmaps), or start the decodes. Sync by design: no await inside the
   * paint path. The positions come from positionedImageSlots (I9) — the same
   * geometry the layout and the editing overlay use, so nothing can drift.
   */
  private drawImage(p: Placed): void {
    const { items } = this.imageSlots(p);
    for (const it of items) this.paintSlot(p, it.id, it.size.w, it.size.h, it.x, it.y);
  }

  /**
   * The grid of a gallery topic (T25): each cell's picture cropped to cover
   * its square, with its caption underneath.
   *
   * The cells come from positionedImageSlots (I9) like every other image, so
   * the measure, this painter and the two exports cannot disagree on where a
   * picture lands. Captions are drawn straight from the string: they are plain
   * text by construction (see `GalleryItem`), never runs, so none of the §3
   * parity machinery is involved and none of it needs to be. `captionLines`
   * decides the wrap, and the exports call the same function.
   */
  private drawGallery(theme: RenderTheme, p: Placed, sheet: Sheet): void {
    const { cells, gallery } = this.imageSlots(p);
    if (!gallery) return;
    const ctx = this.ctx;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (gallery.chart) {
        // A chart slot is a frame first: filled or empty, it is there, and
        // the empty ones are what invite the next picture.
        ctx.save();
        ctx.fillStyle = theme.textMuted;
        ctx.globalAlpha = CHART_SLOT_ALPHA;
        ctx.fillRect(c.x, c.y, c.w, c.h);
        ctx.restore();
        if (c.crop) this.paintSlot(p, c.id, c.pic.w, c.pic.h, c.pic.x, c.pic.y, null);
        // A slot with a note says so with a folded corner, top right: the
        // note itself is only drawn while the slot is selected.
        if (chartSlotNote(sheet, p.node.id, i)) {
          const k = Math.min(CHART_NOTE_MARK, c.w / 3);
          ctx.save();
          ctx.fillStyle = theme.selection;
          ctx.beginPath();
          ctx.moveTo(c.x + c.w - k, c.y);
          ctx.lineTo(c.x + c.w, c.y);
          ctx.lineTo(c.x + c.w, c.y + k);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        continue;
      }
      if (c.crop) {
        this.paintSlot(p, c.id, c.pic.w, c.pic.h, c.pic.x, c.pic.y, c.crop);
      } else {
        // The card is missing (a document opened without its assets). The cell
        // keeps its space — the layout already paid for it — and says so,
        // rather than leaving a hole nothing explains.
        ctx.save();
        ctx.strokeStyle = theme.textMuted;
        ctx.globalAlpha = 0.4;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
        ctx.restore();
      }
    }
    if (gallery.captionH <= 0) return;
    ctx.save();
    ctx.fillStyle = theme.textMuted;
    ctx.font = `${GALLERY_CAPTION_SIZE}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const c of cells) {
      if (!c.caption) continue;
      // ctx.font is already the caption font — set once for the whole pass
      // rather than per cell, so this measures in the right face.
      const lines = captionLines(c.caption, c.w, (s) => ctx.measureText(s).width);
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], c.x + c.w / 2, c.captionY + i * GALLERY_CAPTION_LINE_H);
      }
    }
    ctx.restore();
  }

  /**
   * Decode (if needed) and blit one image slot at the given world rect.
   *
   * `crop` (normalised 0..1) shows only part of the source, scaled to fill the
   * rect — how a gallery cell covers its square. It also raises the resolution
   * asked for: a third of a bitmap stretched over the cell needs three times
   * the pixels, and driving the bucket from the destination width alone left
   * wide pictures visibly soft in a tier list while the slots looked fine.
   */
  /** Memoised positionedImageSlots per Placed object (invalidates on style/size change). */
  private imageSlots(p: Placed): ReturnType<typeof positionedImageSlots> {
    const cached = this.slotsCache.get(p);
    if (cached && cached.style === p.node.style && cached.w === p.w && cached.h === p.h) {
      return cached.slots;
    }
    const slots = positionedImageSlots(p, p.node, this.resolveImage);
    this.slotsCache.set(p, { style: p.node.style, w: p.w, h: p.h, slots });
    return slots;
  }

  /** Record a decoded bitmap in the cache and its per-image bucket index. */
  private cacheImageBitmap(key: string, imageId: string, bucket: number, bitmap: ImageBitmap): number {
    const existing = this.imageCache.get(key);
    if (existing) {
      this.imageCache.delete(key);
      this.imageBytes -= existing.bytes;
      existing.bitmap.close();
    }
    const bytes = bitmap.width * bitmap.height * 4;
    this.imageCache.set(key, { bitmap, bytes });
    this.imageBytes += bytes;
    let buckets = this.imageBuckets.get(imageId);
    if (!buckets) {
      buckets = new Set();
      this.imageBuckets.set(imageId, buckets);
    }
    buckets.add(bucket);
    return bytes;
  }

  /** Find the nearest cached bucket for `imageId`: smallest > target, else largest < target. */
  private findFallbackBitmap(
    imageId: string,
    targetBucket: number,
  ): { key: string; entry: { bitmap: ImageBitmap; bytes: number } } | null {
    const buckets = this.imageBuckets.get(imageId);
    if (!buckets || buckets.size === 0) return null;
    let larger = Infinity;
    let smaller = -1;
    for (const b of buckets) {
      if (b > targetBucket && b < larger) larger = b;
      else if (b < targetBucket && b > smaller) smaller = b;
    }
    const pick = larger < Infinity ? larger : smaller;
    if (pick < 0) return null;
    const key = `${imageId}@${pick}`;
    const entry = this.imageCache.get(key);
    return entry ? { key, entry } : null;
  }

  /** Find a cached bitmap for `imageId` at least `minBucket` wide (for Step 9 downscaling). */
  private findLargerCachedBitmap(imageId: string, minBucket: number): ImageBitmap | null {
    const buckets = this.imageBuckets.get(imageId);
    if (!buckets || buckets.size === 0) return null;
    let best = Infinity;
    for (const b of buckets) {
      if (b >= minBucket && b < best) best = b;
    }
    if (best === Infinity) return null;
    return this.imageCache.get(`${imageId}@${best}`)?.bitmap ?? null;
  }

  private drawBitmapSlot(
    bitmap: ImageBitmap,
    imgW: number,
    imgH: number,
    x: number,
    y: number,
    crop?: { sx: number; sy: number; sw: number; sh: number } | null,
  ): void {
    // Smoothing stays the context default, as it always was: switching the
    // quality per image changed how pictures look, and the setting outlived
    // the call, so the cached text bitmaps blitted after it changed too.
    if (crop) {
      const bw = bitmap.width;
      const bh = bitmap.height;
      this.ctx.drawImage(bitmap, crop.sx * bw, crop.sy * bh, crop.sw * bw, crop.sh * bh, x, y, imgW, imgH);
    } else {
      this.ctx.drawImage(bitmap, x, y, imgW, imgH);
    }
  }

  private slotPriority(x: number, y: number, imgW: number, imgH: number, noFallback: boolean): number {
    const area = Math.max(1, imgW * this.curScale * (imgH * this.curScale));
    const cx = x + imgW / 2;
    const cy = y + imgH / 2;
    const dx = ((cx - this.curCamX) * this.curScale) / Math.max(1, this.curViewW / 2);
    const dy = ((cy - this.curCamY) * this.curScale) / Math.max(1, this.curViewH / 2);
    const centreBoost = 1 + 2 / (1 + dx * dx + dy * dy);
    return (noFallback ? 1e12 : 0) + area * centreBoost;
  }

  private enqueueDecode(
    key: string,
    imageId: string,
    nodeId: string,
    level: AssetLevel,
    bucket: number,
    priority: number,
  ): void {
    if (this.failedRecently(key) || this.inflight.has(key) || this.imageCache.has(key)) return;
    const prev = this.decodeQueue.get(key);
    if (!prev || priority > prev.priority) {
      this.decodeQueue.set(key, { key, imageId, nodeId, level, bucket, priority });
    }
  }

  private paintSlot(
    p: Placed,
    imageId: string,
    imgW: number,
    imgH: number,
    x: number,
    y: number,
    crop?: { sx: number; sy: number; sw: number; sh: number } | null,
  ): void {
    if (!this.resolveImage) return;
    // Decode at the size THIS image is painted at, not at the size it happens
    // to be stored at. Driving the choice from the global zoom alone put every
    // bitmap on the 1024px level above zoom 0.5 on a retina screen — 3MB each,
    // so fifty visible image nodes blew the budget and the cache thrashed.
    const neededPx = (imgW * this.curScale * this.dpr) / (crop && crop.sw > 0 ? crop.sw : 1);
    // Quantised (imageDecodeSize): an exact size would mint a new cache key on
    // every micro-change of zoom and nothing would ever hit. Pictures shown
    // wider than the 1024px level decode from the original, so a big picture
    // or a deep zoom stays sharp instead of upscaling the large level.
    const { bucket, level } = this.imageDecodeSize(imageId, neededPx);
    // The BUCKET keys the cache, not the level — with a variable decode size,
    // keying by level would reuse a 384px bitmap when 900 are needed and leave
    // that image blurred with nothing to invalidate it.
    const key = `${imageId}@${bucket}`;
    if (bucket >= this.IMAGE_ORIGINAL_PROTECT_MIN) this.frameOriginalImages.add(imageId);

    const entry = this.imageCache.get(key);
    if (entry) {
      // LRU refresh (Map insertion order = recency).
      this.imageCache.delete(key);
      this.imageCache.set(key, entry);
      this.frameKeys.add(key);
      this.drawBitmapSlot(entry.bitmap, imgW, imgH, x, y, crop);
      return;
    }

    const fb = this.findFallbackBitmap(imageId, bucket);
    if (fb) {
      this.imageCache.delete(fb.key);
      this.imageCache.set(fb.key, fb.entry);
      this.frameKeys.add(fb.key);
      this.drawBitmapSlot(fb.entry.bitmap, imgW, imgH, x, y, crop);
    }

    this.enqueueDecode(key, imageId, p.node.id, level, bucket, this.slotPriority(x, y, imgW, imgH, fb === null));
  }

  /** The blob of a level; an original that is gone (a compact .rnode.zip
   *  carries only the display levels) falls back to the large one. */
  private async storedLevel(assetId: string, level: AssetLevel): Promise<Blob | null> {
    const blob = await this.assetStore.get(assetId, level);
    return blob ?? (level === "original" ? await this.assetStore.get(assetId, "large") : null);
  }

  private flushDecodeQueue(): void {
    if (this.decodeQueue.size === 0) return;
    if (this.inflightSmall >= this.MAX_INFLIGHT_SMALL && this.inflightLarge >= this.MAX_INFLIGHT_LARGE) return;

    const candidates = Array.from(this.decodeQueue.values()).sort((a, b) => b.priority - a.priority);
    const picked: typeof candidates = [];
    for (const item of candidates) {
      // Stale entries leave the queue: off screen, already cached or running,
      // or broken. One that only waits for a free slot STAYS: decodeBatch
      // flushes again when its batch ends, and it must find the rest there —
      // dropping it left the picture blank or soft until the next repaint,
      // which never comes when the running decodes fail or land off screen.
      if (!this.visibleImageNodes.has(item.nodeId) || this.inflight.has(item.key) || this.imageCache.has(item.key) || this.failedRecently(item.key)) {
        this.decodeQueue.delete(item.key);
        continue;
      }
      const isSmall = item.bucket <= 256;
      if (isSmall) {
        if (this.inflightSmall >= this.MAX_INFLIGHT_SMALL) continue;
        this.inflightSmall++;
      } else {
        if (this.inflightLarge >= this.MAX_INFLIGHT_LARGE) continue;
        this.inflightLarge++;
      }
      this.decodeQueue.delete(item.key);
      this.inflight.set(item.key, item.bucket);
      picked.push(item);
      if (this.inflightSmall >= this.MAX_INFLIGHT_SMALL && this.inflightLarge >= this.MAX_INFLIGHT_LARGE) break;
    }

    if (picked.length > 0) void this.decodeBatch(picked);
  }

  private async decodeBatch(
    items: { key: string; imageId: string; nodeId: string; level: AssetLevel; bucket: number; priority: number }[],
  ): Promise<void> {
    // Step 9: derive original-level buckets by downscaling an already-cached larger bitmap when possible.
    const needFetch: typeof items = [];
    const derivedPromises: Promise<void>[] = [];
    for (const item of items) {
      if (item.bucket > this.IMAGE_BUCKET_MAX) {
        const src = this.findLargerCachedBitmap(item.imageId, item.bucket);
        if (src) {
          derivedPromises.push(this.decodeOneFromSource(item, src));
          continue;
        }
      }
      needFetch.push(item);
    }

    // Group remaining items by level for batched IndexedDB reads (Step 5).
    const byLevel = new Map<AssetLevel, typeof items>();
    for (const item of needFetch) {
      let list = byLevel.get(item.level);
      if (!list) {
        list = [];
        byLevel.set(item.level, list);
      }
      list.push(item);
    }

    const fetchPromises = Array.from(byLevel.entries()).map(async ([level, group]) => {
      try {
        // Above 1024 px the ORIGINAL is decoded, never a re-encoded copy: a
        // deep zoom shows the user's own pixels.
        const ids = group.map((g) => g.imageId);
        const blobs = await fetchAssetBlobs(this.assetStore, ids, level);
        if (level === "original") {
          // A compact .rnode.zip carries no originals: the large level stands in.
          const missingIds = ids.filter((id) => !blobs.has(id));
          if (missingIds.length > 0) {
            const fallbackBlobs = await fetchAssetBlobs(this.assetStore, missingIds, "large");
            for (const [id, b] of fallbackBlobs) blobs.set(id, b);
          }
        }
        await Promise.all(group.map((item) => this.decodeOneFromBlob(item, blobs.get(item.imageId) ?? null)));
      } catch (e) {
        for (const item of group) {
          this.imageFailed.set(item.key, Date.now());
          trace.mark("render", "render:image-decode", { assetId: item.imageId, level: item.level, bucket: item.bucket, error: String(e) });
          this.releaseInflight(item.key);
        }
      }
    });

    await Promise.all([...derivedPromises, ...fetchPromises]);
    this.flushDecodeQueue();
  }

  private releaseInflight(key: string): void {
    const bucket = this.inflight.get(key);
    if (bucket === undefined) return;
    this.inflight.delete(key);
    if (bucket <= 256) this.inflightSmall = Math.max(0, this.inflightSmall - 1);
    else this.inflightLarge = Math.max(0, this.inflightLarge - 1);
  }

  private async decodeOneFromSource(
    item: { key: string; imageId: string; nodeId: string; level: AssetLevel; bucket: number },
    source: ImageBitmap,
  ): Promise<void> {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    try {
      const bitmap = await createImageBitmap(source, { resizeWidth: item.bucket, resizeQuality: "high" });
      this.finishDecode(item, bitmap, t0);
    } catch (e) {
      this.imageFailed.set(item.key, Date.now());
      trace.mark("render", "render:image-decode", { assetId: item.imageId, level: item.level, bucket: item.bucket, error: String(e) });
    } finally {
      this.releaseInflight(item.key);
    }
  }

  private async decodeOneFromBlob(
    item: { key: string; imageId: string; nodeId: string; level: AssetLevel; bucket: number },
    blob: Blob | null,
  ): Promise<void> {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    try {
      if (!blob) {
        this.imageFailed.set(item.key, Date.now());
        trace.mark("render", "render:image-decode", { assetId: item.imageId, level: item.level, bucket: item.bucket, error: "missing" });
        return;
      }
      // resizeWidth downsamples DURING decode: the full-resolution surface is
      // never materialised. Height is omitted on purpose — the browser derives
      // it from the aspect ratio, and passing both risks distortion.
      const bitmap = await createImageBitmap(blob, { resizeWidth: item.bucket, resizeQuality: "high" });
      this.finishDecode(item, bitmap, t0);
    } catch (e) {
      this.imageFailed.set(item.key, Date.now());
      trace.mark("render", "render:image-decode", { assetId: item.imageId, level: item.level, bucket: item.bucket, error: String(e) });
    } finally {
      this.releaseInflight(item.key);
    }
  }

  private finishDecode(
    item: { key: string; imageId: string; nodeId: string; level: AssetLevel; bucket: number },
    bitmap: ImageBitmap,
    t0: number,
  ): void {
    if (!this.visibleImageNodes.has(item.nodeId)) {
      bitmap.close();
      return;
    }
    const bytes = this.cacheImageBitmap(item.key, item.imageId, item.bucket, bitmap);
    this.frameKeys.add(item.key);
    if (item.bucket >= this.IMAGE_ORIGINAL_PROTECT_MIN) this.frameOriginalImages.add(item.imageId);
    trace.mark("render", "render:image-decode", {
      assetId: item.imageId,
      level: item.level,
      bucket: item.bucket,
      bytes,
      ms: Math.round(((typeof performance !== "undefined" ? performance.now() : 0) - t0) * 100) / 100,
    });
    trace.mark("render", "render:image-cache", { kind: "insert", bytes });
    this.evictToBudget();
    // The cached scene (E2) still holds the fallback this picture was drawn
    // with while it decoded. Without dropping it, the repaint below re-blits
    // that blurred frame (the camera has not moved, so renderScene takes the
    // "nothing changed" path) and every pan copies it on: zoomed-in pictures
    // stayed soft until the next edit.
    this.sceneCacheKey = null;
    this.onRepaint?.();
  }

  /**
   * Ghost of the image being dragged to another node: the already-cached
   * bitmap, semi-transparent, centered on the cursor with a dashed outline.
   * When the drag hovers a target node, `ghost.side` snaps the preview onto
   * that node's slot — the exact rect the image will occupy on drop.
   * Reuses the same bucket/level logic as drawImage so the preview is sharp
   * at the current zoom; if the bitmap isn't decoded yet, starts a decode
   * and draws nothing (a repaint brings it in when ready).
   */
  private drawGhostImage(theme: RenderTheme, state: RenderState, ghost: { imageId: string; x: number; y: number; nodeId: string; side?: ImageSlot }): void {
    const ctx = this.ctx;
    if (!this.resolveImage) return;
    const att = this.resolveImage(ghost.imageId);
    if (!att || att.w <= 0) return;
    const imgW = Math.min(att.w, MAX_IMAGE_W);
    const imgH = (imgW * att.h) / att.w;
    const neededPx = imgW * this.curScale * this.dpr;
    const { bucket, level } = this.imageDecodeSize(ghost.imageId, neededPx);
    const key = `${ghost.imageId}@${bucket}`;
    const entry = this.imageCache.get(key);
    const fb = entry ? null : this.findFallbackBitmap(ghost.imageId, bucket);
    const drawEntry = entry ?? fb?.entry ?? null;
    if (entry) this.frameKeys.add(key);
    else if (fb) this.frameKeys.add(fb.key);
    if (!entry) {
      this.enqueueDecode(key, ghost.imageId, ghost.nodeId, level, bucket, 1e13);
    }
    if (!drawEntry) return;
    // Snapped to a slot of the target node when the cursor is over one.
    let x = ghost.x - imgW / 2;
    let y = ghost.y - imgH / 2;
    if (ghost.side && ghost.nodeId) {
      const rect = this.imageSlotWorldRect(state, ghost.nodeId, ghost.side);
      if (rect) {
        x = rect.x;
        y = rect.y;
      }
    }
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.drawImage(drawEntry.bitmap, x, y, imgW, imgH);
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, imgW, imgH);
    ctx.restore();
  }

  /** Byte-budget LRU eviction for the text cache: same shape as evictToBudget
   *  (images), minus the bitmap close — canvas elements are plain JS memory. */
  private evictTextToBudget(): void {
    let freed = 0;
    let count = 0;
    while (this.textBytes > this.TEXT_BUDGET && this.textCache.size > 0) {
      const first = this.textCache.entries().next().value;
      if (!first) break;
      const [k, v] = first as [string, { bytes: number }];
      this.textCache.delete(k);
      this.textBytes -= v.bytes;
      freed += v.bytes;
      count++;
    }
    if (count > 0) trace.mark("render", "render:cache-evict", { kind: "text", entries: count, freed });
  }

  /** Delete one image cache entry and close its bitmap. */
  private evictImageKey(k: string, v: { bitmap: ImageBitmap; bytes: number }): void {
    this.imageCache.delete(k);
    this.imageBytes -= v.bytes;
    v.bitmap.close();
    const at = k.lastIndexOf("@");
    if (at > 0) {
      const imageId = k.slice(0, at);
      const bucket = Number(k.slice(at + 1));
      const set = this.imageBuckets.get(imageId);
      if (set) {
        set.delete(bucket);
        if (set.size === 0) this.imageBuckets.delete(imageId);
      }
    }
    // A closed ImageBitmap is GPU memory returned to the system (tracer 2.0).
    trace.mark("render", "render:gpu-free", { bytes: v.bytes });
  }

  /**
   * LRU eviction under the byte budget. Only ever called between frames.
   * Evicts off-screen keys first; never evicts keys drawn this frame unless
   * total memory exceeds the hard ceiling (2× budget).
   */
  private evictToBudget(): void {
    if (this.imageBytes <= this.IMAGE_BUDGET) return;
    // Step 9: protect the largest cached >= 1448 bucket for any image currently shown >= 1448.
    const protectedKeys = new Set(this.frameKeys);
    for (const imageId of this.frameOriginalImages) {
      const buckets = this.imageBuckets.get(imageId);
      if (!buckets) continue;
      let maxB = -1;
      for (const b of buckets) {
        if (b >= this.IMAGE_ORIGINAL_PROTECT_MIN && b > maxB) maxB = b;
      }
      if (maxB >= 0) protectedKeys.add(`${imageId}@${maxB}`);
    }

    let freed = 0;
    let count = 0;
    // Pass 1: evict off-screen entries in LRU order down to IMAGE_BUDGET.
    for (const [k, v] of Array.from(this.imageCache.entries())) {
      if (this.imageBytes <= this.IMAGE_BUDGET) break;
      if (protectedKeys.has(k)) continue;
      this.evictImageKey(k, v);
      freed += v.bytes;
      count++;
    }
    // Pass 2: if still above hard ceiling (2× budget), evict even on-screen entries.
    const hardCeiling = this.IMAGE_BUDGET * 2;
    for (const [k, v] of Array.from(this.imageCache.entries())) {
      if (this.imageBytes <= hardCeiling) break;
      this.evictImageKey(k, v);
      freed += v.bytes;
      count++;
    }
    if (count > 0) trace.mark("render", "render:cache-evict", { kind: "image", entries: count, freed });
  }

  /** Serialized title runs by array identity. Every title change installs a
   *  NEW runs array (setTitle, the edit draft, restore), so the identity is
   *  the version — and stringifying the runs of every visible topic on every
   *  frame was the most expensive part of building this key. */
  private runsKeys = new WeakMap<object, string>();

  private textCacheKey(n: MindNode, color: string, maxW: number, res: number): string {
    const st = n.style;
    let runs: string;
    if (n.titleRuns) {
      runs = this.runsKeys.get(n.titleRuns) ?? JSON.stringify(n.titleRuns);
      this.runsKeys.set(n.titleRuns, runs);
    } else {
      runs = JSON.stringify(n.title);
    }
    return `${n.id}|${runs}|${st.fontSize ?? 14}|${st.fontFamily ?? ""}|${st.fontWeight ?? 400}|${st.italic ? 1 : 0}|${st.align ?? "center"}|${st.padding ?? 10}|${st.underline ? 1 : 0}|${st.strikethrough ? 1 : 0}|${color}|${maxW}|${res}`;
  }

  /** Render the styled title once into an offscreen canvas (world-unit sized, `res` pixels per unit). */
  private renderTextBitmap(n: MindNode, color: string, maxW: number, res: number): { canvas: HTMLCanvasElement; w: number; h: number } {
    const size = n.style.fontSize ?? 14;
    const lines = wrapRunLines(nodeRuns(n.title, n.titleRuns), maxW, this.measurer, n.style);
    let totalH = 0;
    for (const line of lines) {
      const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
      totalH += lh + (line.gapPx ?? 0);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(maxW * res));
    canvas.height = Math.max(1, Math.ceil(totalH * res));
    const bctx = canvas.getContext("2d");
    if (!bctx) return { canvas, w: maxW, h: totalH };
    bctx.scale(res, res);
    bctx.textBaseline = "alphabetic";
    this.paintRunLines(bctx, n, color, maxW, lines, 0, 0);
    return { canvas, w: maxW, h: totalH };
  }

  private paintRunLines(
    bctx: CanvasRenderingContext2D,
    n: MindNode,
    color: string,
    maxW: number,
    lines: ReturnType<typeof wrapRunLines>,
    ox: number,
    oy: number,
  ): void {
    const size = n.style.fontSize ?? 14;
    const family = n.style.fontFamily ?? FONT_STACK;
    const baseWeight = n.style.fontWeight ?? 400;
    const strike = (n.style.strikethrough ?? false);
    const fontOf = (seg: { run: TextRun }): string => {
      const runSize = seg.run.fontSize ?? size;
      const bold = (seg.run.bold ?? false) || baseWeight >= 700;
      const italic = (seg.run.italic ?? false) || (n.style.italic ?? false);
      return `${italic ? "italic " : ""}${bold ? 700 : baseWeight} ${runSize}px ${family}`;
    };
    let yCursor = oy;
    for (const line of lines) {
      const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
      yCursor += line.gapPx ?? 0;
      const baselineY = yCursor + (line.baseline ?? lh * 0.8);
      const indent = line.indent ?? 0;
      if (line.bullet) {
        bctx.font = fontOf({ run: line.bullet.run });
        bctx.fillStyle = line.bullet.run.color ?? color;
        bctx.fillText(line.bullet.char, ox + line.bullet.x, baselineY);
      }
      const isList = indent > 0 || !!line.bullet;
      let x = ox + (n.style.align === "left" || isList ? indent : (maxW - line.width) / 2);
      for (const seg of line.segments) {
        const runSize = seg.run.fontSize ?? size;
        const bold = (seg.run.bold ?? false) || baseWeight >= 700;
        bctx.font = fontOf(seg);
        bctx.fillStyle = seg.run.color ?? color;
        const w = this.measurer.measure(seg.text, { fontSize: runSize, fontFamily: family, fontWeight: bold ? 700 : baseWeight, italic: (seg.run.italic ?? false) || (n.style.italic ?? false) }).width;
        bctx.fillText(seg.text, x, baselineY);
        const underline = (seg.run.underline ?? false) || (n.style.underline ?? false);
        if (underline || strike) {
          bctx.strokeStyle = seg.run.color ?? color;
          bctx.lineWidth = 1;
          bctx.beginPath();
          const yy = underline ? baselineY + runSize * 0.1 : baselineY - runSize * 0.28;
          bctx.moveTo(x, yy);
          bctx.lineTo(x + w, yy);
          bctx.stroke();
        }
        x += w;
      }
      yCursor += lh;
    }
  }

  /** Draw a code topic (T22): the whole block — chrome and tokenized lines —
   *  rasterized once into a bitmap, exactly like drawText. The key carries
   *  the theme's palette id so two themes can never share entries (the
   *  tokenizer's own cache is keyed on the same id). */
  private drawCodeBlock(theme: RenderTheme, p: Placed): void {
    const n = p.node;
    const lang = asCodeLang(n.style.code?.lang);
    // From 50% up, vectors (see drawText): no rescaled bitmap.
    if (this.curScale >= VECTOR_TEXT_MIN_SCALE) {
      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.paintCodeBlock(this.ctx, theme, p, lang);
      this.ctx.restore();
      return;
    }
    const res = Math.max(1, Math.min(4, Math.ceil(this.curScale * this.dpr)));
    const key = `code:${n.id}|${JSON.stringify(n.titleRuns ?? n.title)}|${lang}|${theme.code.id}|${p.w}|${p.h}|${res}|${n.style.fontSize ?? 14}|${n.style.padding ?? 10}`;
    let entry = this.textCache.get(key);
    if (entry) {
      this.textHits++;
      // LRU refresh, same as the rich-text path: without it the FIFO eviction
      // could throw away the node the user is looking at.
      this.textCache.delete(key);
      this.textCache.set(key, entry);
    } else {
      this.textMisses++;
      const bitmap = this.renderCodeBitmap(theme, p, lang, res);
      const bytes = bitmap.canvas.width * bitmap.canvas.height * 4;
      entry = { ...bitmap, bytes };
      this.textCache.set(key, entry);
      this.textBytes += bytes;
      this.evictTextToBudget();
    }
    if (entry.w > 0 && entry.h > 0) this.ctx.drawImage(entry.canvas, p.x, p.y, entry.w, entry.h);
  }

  /** Render the code block into an offscreen canvas sized to the box (world
   *  units, `res` pixels per unit). The box background is painted by drawNode
   *  (the codeBg fill) — this bitmap is transparent there, like the rich-text
   *  bitmaps, so a user-chosen fill shows through. */
  private renderCodeBitmap(theme: RenderTheme, p: Placed, lang: CodeLang, res: number): { canvas: HTMLCanvasElement; w: number; h: number } {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(p.w * res));
    canvas.height = Math.max(1, Math.ceil(p.h * res));
    const bctx = canvas.getContext("2d");
    if (!bctx) return { canvas, w: p.w, h: p.h };
    bctx.scale(res, res);
    this.paintCodeBlock(bctx, theme, p, lang);
    return { canvas, w: p.w, h: p.h };
  }

  /** The code block's chrome and lines, in box-local units (origin = the
   *  box's top-left): into the cached bitmap, or straight onto the canvas. */
  private paintCodeBlock(bctx: CanvasRenderingContext2D, theme: RenderTheme, p: Placed, lang: CodeLang): void {
    const n = p.node;
    const size = n.style.fontSize ?? 14;
    const pad = n.style.padding ?? 10;
    bctx.textBaseline = "alphabetic";

    // Window chrome: a strip with the language — the part that makes the
    // block read as code at a glance. The three Mac-style dots were removed
    // on request; the strip keeps only the language label, which is also the
    // only part that can change (a code block that changed its colours would
    // look wrong anyway).
    bctx.fillStyle = theme.codeBar;
    bctx.fillRect(0, 0, p.w, CODE_TITLEBAR_H);
    bctx.fillStyle = theme.textMuted;
    bctx.font = `600 11px ${FONT_STACK}`;
    bctx.textAlign = "left";
    bctx.textBaseline = "middle";
    bctx.fillText(lang === "text" ? "code" : lang, pad, CODE_TITLEBAR_H / 2);

    // The tokenized source, run by run. The runs are lossless (concatenation
    // equals the source), so splitting them on "\n" and walking the pieces
    // redraws the source exactly one line at a time, with no wrap and the
    // leading whitespace intact — the same two properties the measure
    // promises, so the painted text fits the box it was measured for.
    const lineH = size * LINE_HEIGHT_FACTOR;
    const met = this.measurer.metrics?.({ fontSize: size, fontFamily: CODE_FONT_STACK });
    const ascent = met ? met.ascent : size * 0.8;
    const runs = tokenize(n.title, lang, theme.code);
    bctx.font = `${size}px ${CODE_FONT_STACK}`;
    bctx.textBaseline = "alphabetic";
    let x = pad;
    let y = CODE_TITLEBAR_H + pad + ascent;
    for (const run of runs) {
      const parts = run.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) {
          bctx.fillStyle = run.color ?? theme.code.plain;
          bctx.fillText(parts[i], x, y);
          x += this.measurer.measure(parts[i], { fontSize: size, fontFamily: CODE_FONT_STACK }).width;
        }
        if (i < parts.length - 1) {
          x = pad;
          y += lineH;
        }
      }
    }
  }

  /** The boxes an elbow arrow routes around (none for the other line styles). */
  private relEnv(state: RenderState, rel: Relationship): RouteEnv {
    return routeEnv(state.sheet, this.placedNodes(state), rel);
  }

  /** The world point a relationship's waypoints are measured from. */
  relOrigin(state: RenderState, rel: Relationship): { x: number; y: number } {
    const o = this.relEnv(state, rel).origin;
    if (o) return o;
    const a = this.nodeWorldRect(state, rel.fromId), b = this.nodeWorldRect(state, rel.toId);
    return a && b ? boxesMid(a, b) : { x: 0, y: 0 };
  }

  /** The drawn route of a relationship, as every painter and hit test sees it. */
  relRoute(state: RenderState, rel: Relationship, a: Rect, b: Rect): RelRoute {
    const env = this.relEnv(state, rel);
    return relationshipRoute(rel, a, b, env.obstacles, env.origin);
  }

  private drawRelationship(theme: RenderTheme, a: Box, b: Box, rel: Relationship, color: string, selected?: boolean, env: RouteEnv = {}): void {
    const ctx = this.ctx;
    // The route (curve or polyline, cut at the borders or pinned to anchors)
    // is shared with both exports — see layout/relationship.ts.
    const route = relationshipRoute(rel, a, b, env.obstacles, env.origin);
    const style = rel.lineStyle ?? "dashed";
    const width = relWidth(rel);
    ctx.strokeStyle = color;
    ctx.lineWidth = width + (selected ? 1 : 0);
    ctx.lineJoin = "round";
    ctx.setLineDash(style === "dashed" ? [7, 5] : style === "dotted" ? [2, 4] : []);
    this.traceRoute(route);
    ctx.stroke();
    ctx.setLineDash([]);
    // Heads: the tip sits on the border and the angle is the line's real
    // direction there. Scale-compensated, like the groups and the drop
    // indicator: the head keeps its screen size at any zoom.
    const heads = relHeads(rel);
    const len = headLen(width) / this.curScale;
    this.drawHead(headShape(heads.end, route.end.from, route.end.tip, len), color, width);
    this.drawHead(headShape(heads.start, route.start.from, route.start.tip, len), color, width);
    const label = rel.label;
    if (label) {
      const mx = route.mid.x, my = route.mid.y;
      ctx.font = `600 12px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.background;
      const w = ctx.measureText(label).width + 10;
      ctx.fillRect(mx - w / 2, my - 10, w, 20);
      if (rel.id) this.relLabelRects.set(rel.id, { x: mx - w / 2, y: my - 10, w, h: 20 });
      ctx.fillStyle = color;
      ctx.fillText(label, mx, my + 0.5);
    }
  }

  /**
   * Editing affordances for relationships, over everything else: the four
   * connection arrows of a selected freeform item, the two end handles of the
   * selected relationship, and the line being dragged out (with a ring on
   * the topic it would land on).
   */
  private drawRelEditing(theme: RenderTheme, state: RenderState, byId: Map<string, Placed>): void {
    const ctx = this.ctx;
    const k = 1 / this.curScale;
    const draft = state.relDraft;
    if (draft) {
      const pt = { x: draft.pointer.x, y: draft.pointer.y, w: 0, h: 0 };
      const a = draft.rel.fromId ? byId.get(draft.rel.fromId) : undefined;
      const b = draft.rel.toId ? byId.get(draft.rel.toId) : undefined;
      const target = draft.target ? byId.get(draft.target) : undefined;
      if (target) {
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = 2 * k;
        ctx.strokeRect(target.x - RING_PAD * k, target.y - RING_PAD * k, target.w + 2 * RING_PAD * k, target.h + 2 * RING_PAD * k);
      }
      this.drawRelationship(theme, a ?? pt, b ?? pt, draft.rel, theme.selection, true, a && b ? this.relEnv(state, draft.rel) : {});
      return;
    }
    if (state.relSel) {
      const rel = state.sheet.relationships.find((r) => r.id === state.relSel);
      const a = rel && byId.get(rel.fromId);
      const b = rel && byId.get(rel.toId);
      if (rel && a && b) {
        const route = this.relRoute(state, rel, a, b);
        for (const p of [route.start.tip, route.end.tip]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, REL_END_R * k, 0, Math.PI * 2);
          ctx.fillStyle = theme.background;
          ctx.fill();
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 2 * k;
          ctx.stroke();
        }
        // Bends (draw.io): solid handles on the waypoints and on an elbow
        // line's movable segments, faint ones where a new bend can be pulled out.
        for (const h of this.relBendHandles(state, rel, a, b, route)) {
          const r = (h.kind === "insert" ? REL_END_R - 1.5 : REL_END_R - 0.5) * k;
          ctx.beginPath();
          if (h.kind === "segment") {
            const lw = (h.horizontal ? 5 : 2.5) * r / 2, lh = (h.horizontal ? 2.5 : 5) * r / 2;
            ctx.rect(h.at.x - lw, h.at.y - lh, lw * 2, lh * 2);
          } else ctx.arc(h.at.x, h.at.y, r, 0, Math.PI * 2);
          ctx.globalAlpha = h.kind === "insert" ? 0.55 : 1;
          ctx.fillStyle = h.kind === "insert" ? theme.background : theme.selection;
          ctx.fill();
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 1.5 * k;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      return;
    }
    if (state.selection.size !== 1 || state.editingId) return;
    const [id] = state.selection;
    const p = byId.get(id);
    if (!p || !freeformOwner(state.sheet, id)) return;
    for (const h of connectHandles(p, this.curScale)) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
      ctx.fillStyle = theme.selection;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      // A small arrow pointing away from the box.
      const L = h.r * 0.55;
      const px = -h.dir.y;
      const py = h.dir.x;
      ctx.beginPath();
      ctx.moveTo(h.x - h.dir.x * L, h.y - h.dir.y * L);
      ctx.lineTo(h.x + h.dir.x * L, h.y + h.dir.y * L);
      ctx.moveTo(h.x + h.dir.x * L - h.dir.x * L * 0.7 + px * L * 0.6, h.y + h.dir.y * L - h.dir.y * L * 0.7 + py * L * 0.6);
      ctx.lineTo(h.x + h.dir.x * L, h.y + h.dir.y * L);
      ctx.lineTo(h.x + h.dir.x * L - h.dir.x * L * 0.7 - px * L * 0.6, h.y + h.dir.y * L - h.dir.y * L * 0.7 - py * L * 0.6);
      ctx.strokeStyle = theme.background;
      ctx.lineWidth = 1.8 * k;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineCap = "butt";
    }
  }

  /**
   * What a chart slider drag will do, before it is released: the board's new
   * outline (dashed) and, when shrinking, the strip that will go tinted red,
   * plus a chip with the resulting size.
   */
  private drawChartGrowPreview(theme: RenderTheme, p: Placed, live: { grow: "row" | "col"; delta: number; offset: number }): void {
    const ctx = this.ctx;
    const k = 1 / this.curScale;
    const g = p.node.style.gallery;
    if (!g?.chart) return;
    const pitch = chartGrowPitch(p);
    const cols = Math.max(1, Math.floor(g.cols ?? CHART_COLS));
    const rows = Math.max(1, Math.ceil(g.items.length / cols));
    const isCol = live.grow === "col";
    const step = (isCol ? pitch.col : pitch.row) * live.delta;
    const w = p.w + (isCol ? step : 0);
    const h = p.h + (isCol ? 0 : step);
    if (live.delta < 0) {
      ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
      if (isCol) ctx.fillRect(p.x + w, p.y, -step, p.h);
      else ctx.fillRect(p.x, p.y + h, p.w, -step);
    }
    if (live.delta !== 0) {
      ctx.setLineDash([6 * k, 4 * k]);
      ctx.strokeStyle = live.delta < 0 ? "#dc2626" : theme.selection;
      ctx.lineWidth = 2 * k;
      ctx.strokeRect(p.x, p.y, w, h);
      ctx.setLineDash([]);
    }
    const label = isCol
      ? `${cols + live.delta} cols${live.delta ? ` (${live.delta > 0 ? "+" : "−"}${Math.abs(live.delta)})` : ""}`
      : `${rows + live.delta} rows${live.delta ? ` (${live.delta > 0 ? "+" : "−"}${Math.abs(live.delta)})` : ""}`;
    // The chip rides with the slider: above the column one, beside the row one.
    ctx.font = `600 ${13 * k}px system-ui, sans-serif`;
    const tw = ctx.measureText(label).width + 14 * k;
    const hnd = chartGrowHandles(p, this.curScale).find((x) => x.grow === live.grow);
    if (!hnd) return;
    const sx = hnd.x + (isCol ? live.offset : 0);
    const sy = hnd.y + (isCol ? 0 : live.offset);
    const bx = isCol ? sx + hnd.w / 2 - tw / 2 : sx + hnd.w + 8 * k;
    const by = isCol ? sy - 30 * k : sy + hnd.h / 2 - 11 * k;
    ctx.beginPath();
    this.roundRect(ctx, bx, by, tw, 22 * k, 11 * k);
    ctx.fillStyle = live.delta < 0 ? "#dc2626" : theme.selection;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + tw / 2, by + 11 * k);
  }

  /** Begin a path along a relationship route (the caller strokes it). */
  private traceRoute(route: RelRoute): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (route.path.kind === "curve") {
      const b = route.path.b;
      ctx.moveTo(b.p0.x, b.p0.y);
      ctx.bezierCurveTo(b.p1.x, b.p1.y, b.p2.x, b.p2.y, b.p3.x, b.p3.y);
    } else {
      const pts = route.path.pts;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
  }

  private drawHead(shape: HeadShape | null, color: string, width: number): void {
    if (!shape) return;
    const ctx = this.ctx;
    ctx.beginPath();
    if (shape.kind === "circle") {
      ctx.arc(shape.c.x, shape.c.y, shape.r, 0, Math.PI * 2);
    } else {
      ctx.moveTo(shape.pts[0].x, shape.pts[0].y);
      for (let i = 1; i < shape.pts.length; i++) ctx.lineTo(shape.pts[i].x, shape.pts[i].y);
      if (shape.closed) ctx.closePath();
    }
    if (shape.kind === "circle" || shape.fill) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.lineCap = "butt";
    }
  }

  // -------------------------------------------------------------------------
  // Groups & summaries
  // -------------------------------------------------------------------------

  /** Union rect (padded) of the member topics, in world coords. */
  private membersBounds(state: RenderState, memberIds: string[], byId?: Map<string, Placed>): { x: number; y: number; w: number; h: number } | null {
    const placed = byId ?? this.placedById(state);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;
    for (const m of memberIds) {
      const p = placed.get(m);
      if (!p) continue;
      found = true;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }
    if (!found) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /**
   * Every group's box for this placement, computed once per `byId` map: the
   * fill pass, the line pass and the hit test of one frame all ask, and each
   * walks every member's branch.
   */
  private groupGeometry(state: RenderState, byId: Map<string, Placed>): Map<string, GroupBox> {
    const c = this.groupGeoCache;
    if (c && c.byId === byId && c.sheet === state.sheet) return c.boxes;
    const boxes = groupBoxes(state.sheet, byId);
    this.groupGeoCache = { byId, sheet: state.sheet, boxes };
    return boxes;
  }
  private groupGeoCache: { byId: Map<string, Placed>; sheet: Sheet; boxes: Map<string, GroupBox> } | null = null;

  /** The title tab of a group, or null when it has none. World units. */
  private groupTab(g: Group, box: Box): (Box & { text: string }) | null {
    const text = groupLabel(g);
    if (!text) return null;
    this.ctx.font = `600 ${GROUP_LABEL_FONT}px ${FONT_STACK}`;
    const w = Math.min(this.ctx.measureText(text).width + 16, Math.max(40, box.w - GROUP_LABEL_INSET * 2));
    return { x: box.x + GROUP_LABEL_INSET, y: box.y - GROUP_LABEL_H / 2, w, h: GROUP_LABEL_H, text };
  }

  private groupOnScreen(state: RenderState, b: Box): boolean {
    const s = state.camera.scale;
    if (b.x + b.w < state.camera.x - state.viewW / 2 / s - 40 || b.x > state.camera.x + state.viewW / 2 / s + 40) return false;
    if (b.y + b.h < state.camera.y - state.viewH / 2 / s - 40 || b.y > state.camera.y + state.viewH / 2 / s + 40) return false;
    return true;
  }

  /** Trace a group's outline (rounded, square or wavy) as the current path. */
  private traceGroup(ctx: CanvasRenderingContext2D, g: Group, b: Box): void {
    ctx.beginPath();
    if (g.shape === "wave") {
      const pts = wavePoints(b);
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    } else {
      ctx.roundRect(b.x, b.y, b.w, b.h, groupRadius(g.shape));
    }
  }

  /** Group fills go UNDER connectors and topics: a tint behind the branch,
   *  never a film over it. */
  private drawGroupFills(state: RenderState, byId: Map<string, Placed>): void {
    if (!state.sheet.boundaries.some((g) => g.fill)) return;
    const ctx = this.ctx;
    const geo = this.groupGeometry(state, byId);
    // Outer groups first, so a nested tint shows on top of its parent's.
    const order = [...state.sheet.boundaries].sort((a, b) => (geo.get(b.id)?.covered.size ?? 0) - (geo.get(a.id)?.covered.size ?? 0));
    for (const g of order) {
      const gb = geo.get(g.id);
      if (!g.fill || !gb || !this.groupOnScreen(state, gb.box)) continue;
      ctx.save();
      ctx.globalAlpha = GROUP_FILL_ALPHA;
      ctx.fillStyle = g.fill;
      this.traceGroup(ctx, g, gb.box);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawGroupsAndSummaries(theme: RenderTheme, state: RenderState, byId: Map<string, Placed>): void {
    const s = state.camera.scale;
    const geo = this.groupGeometry(state, byId);
    for (const g of state.sheet.boundaries) {
      const gb = geo.get(g.id);
      if (!gb || !this.groupOnScreen(state, gb.occupied)) continue;
      this.drawGroup(theme, g, gb.box, state.groupSel === g.id, s);
    }
    for (const sum of state.sheet.summaries) {
      const b = this.membersBounds(state, sum.memberIds, byId);
      if (!b) continue;
      if (b.y + b.h < state.camera.y - state.viewH / 2 / s - 40 || b.y > state.camera.y + state.viewH / 2 / s + 40) continue;
      const selected = state.summarySel === sum.id;
      this.drawSummary(theme, sum, b, selected, s, this.summaryFacingLeft(state, b, byId));
    }
  }

  /**
   * The stroke a boundary is painted with. Public and value-returning, like
   * `nodeColors`, so the rule can be asserted without a canvas.
   *
   * Selection does NOT take a chosen colour away — the rule relationships
   * already follow — it adds a pixel of thickness instead. Bumping rather
   * than pinning it to 2.5 is what keeps a group drawn thick from getting
   * THINNER the moment you click it.
   *
   * The dash grows with the line: a 6px stroke under the fixed 7/5 pattern
   * reads as a chain of blobs, not as a dashed box.
   */
  groupStroke(theme: RenderTheme, g: Group, selected: boolean): { color: string; width: number; dash: number[]; cap: "butt" | "round"; double: boolean; none: boolean } {
    const width = g.borderWidth ?? DEFAULT_GROUP_BORDER_WIDTH;
    const style = g.lineStyle ?? "dashed";
    const pattern = groupDash(style, width);
    return {
      color: g.color ?? (selected ? theme.selection : theme.textMuted),
      width: selected ? width + 1 : width,
      ...pattern,
      double: style === "double",
      // A group with no line is still selectable by its tab; selecting it
      // shows the line so the user can see what they picked.
      none: style === "none" && !selected,
    };
  }

  private drawGroup(theme: RenderTheme, g: Group, b: Box, selected: boolean, s: number): void {
    const ctx = this.ctx;
    const stroke = this.groupStroke(theme, g, selected);
    if (!stroke.none) {
      ctx.save();
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = stroke.cap;
      // Widths and dashes are SCREEN pixels: divided by the zoom so the line
      // weighs the same at every zoom level.
      ctx.setLineDash(stroke.dash.map((d) => d / s));
      if (stroke.double) {
        const t = Math.max(1, stroke.width / 3) / s;
        ctx.lineWidth = t;
        for (const d of [t, -t]) {
          this.traceGroup(ctx, g, { x: b.x - d, y: b.y - d, w: b.w + d * 2, h: b.h + d * 2 });
          ctx.stroke();
        }
      } else {
        ctx.lineWidth = stroke.width / s;
        this.traceGroup(ctx, g, b);
        ctx.stroke();
      }
      ctx.restore();
    }
    const tab = this.groupTab(g, b);
    if (tab) {
      ctx.save();
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.roundRect(tab.x, tab.y, tab.w, tab.h, 5);
      ctx.fill();
      ctx.fillStyle = readableOn(stroke.color);
      ctx.font = `600 ${GROUP_LABEL_FONT}px ${FONT_STACK}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(tab.text, tab.x + 8, tab.y + tab.h / 2, tab.w - 16);
      ctx.restore();
    }
  }

  /** Which side of the root the summary members sit on: a summary on a left
   *  branch opens its brace to the LEFT (facing the tree direction), one on
   *  the right opens to the RIGHT. */
  private summaryFacingLeft(state: RenderState, b: { x: number; y: number; w: number; h: number }, byId: Map<string, Placed>): boolean {
    const root = byId.get(state.sheet.rootNodeId);
    if (!root) return false;
    return b.x + b.w / 2 < root.x + root.w / 2;
  }

  private drawSummary(theme: RenderTheme, sum: Summary, b: { x: number; y: number; w: number; h: number }, selected: boolean, s: number, facingLeft: boolean): void {
    const ctx = this.ctx;
    const y0 = b.y, y1 = b.y + b.h;
    const gap = 22 / s;
    const braceX = facingLeft ? b.x - gap : b.x + b.w + gap;
    const label = sum.label ?? "Summary";
    ctx.font = `600 ${12 / s}px system-ui, sans-serif`;
    const tw = ctx.measureText(label).width;
    const labelW = tw + 16, labelH = 22 / s;
    const midY = (y0 + y1) / 2;
    // brace: ends at the member column, middle vertex pointing away from the
    // tree (right on a right branch, left on a left branch)
    ctx.strokeStyle = selected ? theme.selection : theme.textMuted;
    ctx.lineWidth = selected ? 2.5 / s : 1.5 / s;
    ctx.beginPath();
    this.bracePath(ctx, braceX, y0, y1, (facingLeft ? -1 : 1) * (9 / s));
    ctx.stroke();
    // label box on the far side of the brace
    const bx = facingLeft ? braceX - 16 / s - labelW : braceX + 16 / s;
    const by = midY - labelH / 2;
    ctx.fillStyle = theme.background;
    ctx.strokeStyle = selected ? theme.selection : theme.nodeBorder;
    ctx.lineWidth = 1.2 / s;
    ctx.beginPath();
    ctx.roundRect(bx, by, labelW, labelH, 5 / s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = selected ? theme.selection : theme.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + labelW / 2, by + labelH / 2 + 0.5);
  }

  /** A curly-brace path: ends at (x, y0/y1) tucked left, vertex pointing right. */
  private bracePath(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, depth: number): void {
    const span = y1 - y0;
    const gap = Math.min(10, Math.max(4, span / 8));
    const d = depth;
    const mid = (y0 + y1) / 2;
    ctx.moveTo(x, y0);
    ctx.bezierCurveTo(x + d, y0, x + d, y0 + gap, x, y0 + gap);
    ctx.bezierCurveTo(x - d, y0 + gap * 2, x - d, mid - gap, x + d, mid);
    ctx.bezierCurveTo(x - d, mid + gap, x - d, y1 - gap * 2, x, y1 - gap);
    ctx.bezierCurveTo(x + d, y1 - gap, x + d, y1, x, y1);
  }

  // -------------------------------------------------------------------------
  // Overlay hit testing (relationships, groups, summaries)
  // -------------------------------------------------------------------------

  /** Distance from a point to the relationship bezier, in world units. */
  hitTestRelationship(state: RenderState, wx: number, wy: number): string | null {
    const byId = this.placedById(state);
    const threshold = 8 / state.camera.scale;
    let best: string | null = null;
    let bestD = Infinity;
    for (const rel of state.sheet.relationships) {
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (!a || !b) continue;
      // The drawn route, not the old centre-to-centre curve: an elbow or an
      // anchored line runs somewhere else entirely.
      const d = routeDistance(this.relRoute(state, rel, a, b), { x: wx, y: wy }) - relWidth(rel) / 2;
      if (d < threshold && d < bestD) {
        bestD = d;
        best = rel.id;
      }
    }
    return best;
  }

  /** World rect of a placed topic plus its route endpoints for a relationship. */
  relationshipEnds(state: RenderState, relId: string): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
    const rel = state.sheet.relationships.find((r) => r.id === relId);
    if (!rel) return null;
    const a = this.nodeWorldRect(state, rel.fromId);
    const b = this.nodeWorldRect(state, rel.toId);
    if (!a || !b) return null;
    const route = this.relRoute(state, rel, a, b);
    return { from: route.start.tip, to: route.end.tip };
  }

  /** The bend handles of a relationship (see layout/relationship.ts bendHandles). */
  private relBendHandles(state: RenderState, rel: Relationship, a: Rect, b: Rect, route: RelRoute): BendHandle[] {
    return bendHandles(rel, route, worldWaypoints(rel, a, b, this.relEnv(state, rel).origin));
  }

  /** The bend handle of the selected relationship under the pointer. */
  hitTestBend(state: RenderState, wx: number, wy: number, reach = REL_END_R + 3): BendHandle | null {
    if (!state.relSel) return null;
    const rel = state.sheet.relationships.find((r) => r.id === state.relSel);
    const a = rel && this.nodeWorldRect(state, rel.fromId);
    const b = rel && this.nodeWorldRect(state, rel.toId);
    if (!rel || !a || !b) return null;
    const tol = reach / state.camera.scale;
    let best: BendHandle | null = null, bestD = Infinity;
    for (const h of this.relBendHandles(state, rel, a, b, this.relRoute(state, rel, a, b))) {
      const d = Math.hypot(wx - h.at.x, wy - h.at.y);
      // A real bend wins over a faint "add one" handle at the same spot.
      const score = d + (h.kind === "insert" ? 0.5 / state.camera.scale : 0);
      if (d <= tol && score < bestD) { bestD = score; best = h; }
    }
    return best;
  }

  /** Is the pointer on the label chip of the selected relationship? */
  hitTestRelLabel(state: RenderState, wx: number, wy: number): boolean {
    const r = state.relSel ? this.relLabelRects.get(state.relSel) : undefined;
    const rel = state.relSel ? state.sheet.relationships.find((x) => x.id === state.relSel) : undefined;
    return !!r && !!rel?.label && wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h;
  }

  /** The endpoint handle of the selected relationship under the pointer. */
  hitTestRelEnd(state: RenderState, wx: number, wy: number): "from" | "to" | null {
    if (!state.relSel) return null;
    const ends = this.relationshipEnds(state, state.relSel);
    if (!ends) return null;
    const tol = REL_END_R * 2 / state.camera.scale;
    const dTo = Math.hypot(wx - ends.to.x, wy - ends.to.y);
    const dFrom = Math.hypot(wx - ends.from.x, wy - ends.from.y);
    if (dTo <= tol && dTo <= dFrom) return "to";
    if (dFrom <= tol) return "from";
    return null;
  }

  /** The connection arrow of a selected freeform item under the pointer. */
  hitTestConnectHandle(state: RenderState, wx: number, wy: number): { id: string; anchor: RelAnchor } | null {
    if (state.relSel || state.selection.size !== 1) return null;
    const [id] = state.selection;
    if (!freeformOwner(state.sheet, id)) return null;
    const r = this.nodeWorldRect(state, id);
    if (!r) return null;
    for (const h of connectHandles(r, state.camera.scale)) {
      if (Math.hypot(wx - h.x, wy - h.y) <= h.r * 1.4) return { id, anchor: h.anchor };
    }
    return null;
  }

  /**
   * A group is hit on its LINE (a band a few screen pixels wide) or its title
   * tab — not anywhere inside the box (G4). The whole interior used to count,
   * which made a marquee started inside a group impossible and let the first
   * of two overlapping groups win every click. Among several hits the smallest
   * box wins: a click on a nested group's line means that group.
   */
  hitTestGroup(state: RenderState, wx: number, wy: number): string | null {
    const placed = this.placedById(state);
    const geo = groupBoxes(state.sheet, placed);
    const s = state.camera.scale;
    let best: string | null = null;
    let bestArea = Infinity;
    for (const g of state.sheet.boundaries) {
      const gb = geo.get(g.id);
      if (!gb) continue;
      const b = gb.box;
      const tol = Math.max(6, (g.borderWidth ?? DEFAULT_GROUP_BORDER_WIDTH) / 2 + 3) / s + (g.shape === "wave" ? 3 : 0);
      const inOuter = wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol;
      const inInner = wx > b.x + tol && wx < b.x + b.w - tol && wy > b.y + tol && wy < b.y + b.h - tol;
      const tab = this.groupTab(g, b);
      const onTab = !!tab && wx >= tab.x && wx <= tab.x + tab.w && wy >= tab.y && wy <= tab.y + tab.h;
      if (!onTab && !(inOuter && !inInner)) continue;
      const area = b.w * b.h;
      if (area < bestArea) {
        bestArea = area;
        best = g.id;
      }
    }
    return best;
  }
  hitTestSummary(state: RenderState, wx: number, wy: number): string | null {
    const placed = this.placedById(state);
    for (const sum of state.sheet.summaries) {
      const b = this.membersBounds(state, sum.memberIds, placed);
      if (!b) continue;
      const s = state.camera.scale;
      const facingLeft = this.summaryFacingLeft(state, b, placed);
      const gap = 22 / s;
      const braceX = facingLeft ? b.x - gap : b.x + b.w + gap;
      // approximate: a box around the brace + label, on the correct side
      const lo = facingLeft ? braceX - 90 / s : braceX - 8 / s;
      const hi = facingLeft ? braceX + 8 / s : braceX + 90 / s;
      if (wx >= lo && wx <= hi && wy >= b.y - 6 && wy <= b.y + b.h + 6) return sum.id;
    }
    return null;
  }

  /**
   * One topic as an image: redraw the node into an offscreen canvas of the
   * node's own size at 2x and hand back the blob. No DOM rasteriser — I1
   * means the topic is already pixels, so this is a replay, not a capture.
   *
   * The live paint path is deliberately fire-and-forget (a frame that misses
   * its decode just paints late); an export cannot inherit that, or the
   * picture comes out full of holes — hence the preload below.
   */
  async renderNodeImage(
    state: RenderState,
    nodeId: string,
    opts: { scale?: number; type?: "image/png" | "image/jpeg"; quality?: number; background?: string | null } = {},
  ): Promise<Blob | null> {
    const scale = Math.max(0.1, Math.min(8, opts.scale ?? 2));
    const type = opts.type ?? "image/png";
    const placed = this.placedNodes(state).find((q) => q.node.id === nodeId);
    if (!placed) return null;

    this.resolveImage = imageResolver(state.sheet);
    await this.preloadNodeImages(placed, scale);

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(placed.w * scale));
    out.height = Math.max(1, Math.round(placed.h * scale));
    const target = out.getContext("2d");
    if (!target) return null;

    // JPEG has no alpha: without a ground it composites onto black, which is
    // never what someone exporting a chart meant.
    const ground = opts.background ?? (type === "image/jpeg" ? "#ffffff" : null);
    if (ground) {
      target.fillStyle = ground;
      target.fillRect(0, 0, out.width, out.height);
    }

    // Swap the painter onto the offscreen surface for the duration of one
    // synchronous draw, then put it back. drawNode reads this.ctx/curScale/dpr,
    // and nothing else in the class holds a reference to the live context.
    const savedCtx = this.ctx;
    const savedScale = this.curScale;
    const savedDpr = this.dpr;
    const savedVisible = this.visibleImageNodes;
    this.ctx = target;
    this.curScale = scale;
    this.dpr = 1;
    // The eviction pass keys off this: without the node in it, every bitmap we
    // just awaited would be closed as "off screen" while the export runs.
    this.visibleImageNodes = new Set([nodeId]);
    try {
      target.save();
      target.scale(scale, scale);
      target.translate(-placed.x, -placed.y);
      // A clean copy: no selection ring, no hover, no drop caret, no ghost —
      // the picture is of the topic, not of the editor looking at it.
      this.drawNode(THEMES[state.themeName], placed, {
        ...state,
        selection: new Set<string>(),
        hoverId: null,
        editingId: null,
        drop: null,
        imageSel: null,
        marqueeSel: null,
        ghostImage: null,
        galleryDrop: null,
      });
      if (placed.node.style.freeform) this.drawInk(THEMES[state.themeName], placed, state);
      target.restore();
    } finally {
      this.ctx = savedCtx;
      this.curScale = savedScale;
      this.dpr = savedDpr;
      this.visibleImageNodes = savedVisible;
    }

    return await new Promise<Blob | null>((resolve) =>
      out.toBlob((b) => resolve(b), type, opts.quality ?? 0.92)
    );
  }

  /** Decode every picture this node uses, at the size the export will draw it. */
  private async preloadNodeImages(placed: Placed, scale: number, strict = false): Promise<void> {
    const wanted: { id: string; w: number; crop?: { sw: number } | null }[] = [];
    const pos = this.imageSlots(placed);
    for (const it of pos.items) wanted.push({ id: it.id, w: it.size.w });
    for (const c of pos.cells) wanted.push({ id: c.id, w: c.w, crop: c.crop });
    const results = await Promise.allSettled(
      wanted.map(async ({ id, w, crop }) => {
        // Same bucket arithmetic paintSlot uses, so the draw finds these
        // entries instead of missing and starting its own decode.
        const neededPx = (w * scale) / (crop && crop.sw > 0 ? crop.sw : 1);
        const { bucket, level } = this.imageDecodeSize(id, neededPx);
        const key = `${id}@${bucket}`;
        if (this.imageCache.has(key)) return;
        if (this.failedRecently(key)) {
          if (strict) throw new Error(`Cannot print image ${id}`);
          return;
        }
        try {
          const blob = await this.storedLevel(id, level);
          if (!blob) {
            this.imageFailed.set(key, Date.now());
            if (strict) throw new Error(`Missing image ${id}`);
            return;
          }
          const bitmap = await createImageBitmap(blob, { resizeWidth: bucket, resizeQuality: "high" });
          this.cacheImageBitmap(key, id, bucket, bitmap);
        } catch (error) {
          this.imageFailed.set(key, Date.now());
          if (strict) throw error;
        }
      })
    );
    // Finish every decode before the print renderer can be disposed on failure.
    if (strict) for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  /**
   * The caret showing where a dragged cell would be inserted (T25): a bar in
   * the gap between two cells, or hugging the first/last one at the ends.
   *
   * A caret rather than a highlighted cell, because the drop lands BETWEEN
   * pictures — highlighting the neighbour would leave "before it or after it"
   * unanswered, which is the whole question when reordering a tier.
   */
  private drawGalleryDrop(theme: RenderTheme, state: RenderState): void {
    const target = state.galleryDrop;
    if (!target) return;
    const p = this.placedNodes(state).find((q) => q.node.id === target.nodeId);
    if (!p) return;
    const { cells, gallery } = positionedImageSlots(p, p.node, this.resolveImage);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = theme.dropIndicator;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    if (cells.length === 0 || !gallery) {
      // An empty (or brand-new) gallery: mark the whole body instead, so a
      // drop onto a topic that has no grid yet still says where it will go.
      ctx.strokeRect(p.x - 3, p.y - 3, p.w + 6, p.h + 6);
      ctx.restore();
      return;
    }
    if (gallery.chart) {
      // A chart drop lands IN a slot, not between two: ring that slot.
      const c = cells[Math.max(0, Math.min(cells.length - 1, target.index))];
      ctx.strokeRect(c.x - 2, c.y - 2, c.w + 4, c.h + gallery.captionH + 4);
      ctx.restore();
      return;
    }
    const i = Math.max(0, Math.min(cells.length, target.index));
    const at = i < cells.length ? cells[i] : cells[cells.length - 1];
    const x = i < cells.length ? at.x - GALLERY_GAP / 2 : at.x + at.w + GALLERY_GAP / 2;
    ctx.beginPath();
    ctx.moveTo(x, at.y - 2);
    ctx.lineTo(x, at.y + at.h + 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawDropIndicator(theme: RenderTheme, target: Placed, mode: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = theme.dropIndicator;
    ctx.fillStyle = theme.dropIndicator;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    if (mode === "child") {
      ctx.strokeRect(target.x - 3, target.y - 3, target.w + 6, target.h + 6);
    } else if (mode === "before" || mode === "after") {
      const y = mode === "before" ? target.y : target.y + target.h;
      ctx.fillRect(target.x - 4, y - 2, target.w + 8, 4);
    }
  }

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  /**
   * The topmost visible topic under the point, or null.
   *
   * `skip` drops candidates before the box test, so the topic *behind* an
   * excluded one can win. A drag passes the node it is moving: that node
   * tracks the cursor, so without this it answers its own hit test and hides
   * whatever it is being dragged onto.
   */
  /**
   * Uniform grid over the cached placements: cell → indices into `placed`,
   * ascending. hitTest runs on every pointer move, and it used to filter and
   * scan every topic of the sheet each time. Built lazily, once per placement
   * (it follows the placement cache's identity, so pans reuse it).
   */
  private hitGrid: { placed: Placed[]; cells: Map<string, number[]> } | null = null;
  private static readonly HIT_CELL = 512;

  private hitCandidates(placed: Placed[], wx: number, wy: number): number[] | null {
    if (this.placedCache?.value !== placed) return null; // uncached turn: plain scan
    if (this.hitGrid?.placed !== placed) {
      const S = Renderer.HIT_CELL;
      const cells = new Map<string, number[]>();
      placed.forEach((p, i) => {
        for (let cx = Math.floor(p.x / S); cx <= Math.floor((p.x + p.w) / S); cx++) {
          for (let cy = Math.floor(p.y / S); cy <= Math.floor((p.y + p.h) / S); cy++) {
            const k = `${cx},${cy}`;
            const list = cells.get(k);
            if (list) list.push(i);
            else cells.set(k, [i]);
          }
        }
      });
      this.hitGrid = { placed, cells };
    }
    return this.hitGrid.cells.get(`${Math.floor(wx / Renderer.HIT_CELL)},${Math.floor(wy / Renderer.HIT_CELL)}`) ?? [];
  }

  snapshotPlacements(state: RenderState): Map<string, { x: number; y: number; w: number; h: number }> {
    const out = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const p of this.visiblePlacedList(state)) {
      out.set(p.node.id, { x: p.x, y: p.y, w: p.w, h: p.h });
    }
    return out;
  }

  hitTest(state: RenderState, worldX: number, worldY: number, skip?: (id: string) => boolean): string | null {
    const placed = this.placedNodes(state);
    const candidates = this.hitCandidates(placed, worldX, worldY);
    const count = candidates ? candidates.length : placed.length;
    // Board backgrounds are painted before all ordinary topics. Use that
    // same two-layer order here, including nested/overlapping canvases.
    for (const background of [false, true]) {
      for (let k = count - 1; k >= 0; k--) {
        const p = placed[candidates ? candidates[k] : k];
        if (!p.visible || !!p.node.style.freeform !== background || skip?.(p.node.id)) continue;
        if (worldX >= p.x && worldX <= p.x + p.w && worldY >= p.y && worldY <= p.y + p.h) {
          // A frame takes the pointer only on its border and title strip; inside,
          // the canvas and the items under it answer.
          if (p.node.style.frame && !onFrameEdge(p, worldX, worldY, state.camera.scale)) continue;
          return p.node.id;
        }
      }
    }
    return null;
  }

  nodeScreenBounds(state: RenderState, id: string): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    if (!p) return null;
    const s = state.camera.scale;
    const ox = state.viewW / 2 - state.camera.x * s;
    const oy = state.viewH / 2 - state.camera.y * s;
    return { x: p.x * s + ox, y: p.y * s + oy, w: p.w * s, h: p.h * s };
  }

  /**
   * Hit test for the resize handles: small squares centered on the left and
   * right edges of any SELECTED node (the node being edited is excluded).
   * Returns { id, side } or null. Checked before the body hit test so the
   * handles win even where they overlap the node edge.
   */
  /**
   * Hit test for the image resize handle (T14): a small square on the
   * bottom-right corner of the node's image, same grab-box style as
   * hitTestResize. Only when the node has an image and is selected.
   */
  hitTestImageResize(state: RenderState, worldX: number, worldY: number): string | null {
    const hs = 12;
    const ids = new Set(state.selection);
    if (state.imageSel) ids.add(state.imageSel);
    // Place ONCE for the whole loop. Calling imageWorldRect per id re-placed
    // and re-measured every node in the sheet each time, and this runs on
    // pointermove: with a large selection the cost was the selection size
    // times the map size, on every mouse move.
    const placed = this.placedById(state);
    for (const id of ids) {
      if (state.editingId === id) continue;
      const p = placed.get(id);
      const rect = p ? this.selectedImageRect(state, p) : null;
      if (!rect) continue;
      // The whole BORDER resizes, not just the bottom-right square. A 12-unit
      // corner is a hard target at any zoom, and the selected image already
      // draws a ring all the way round — so the ring is what the pointer can
      // grab, which is what it looked like it meant.
      const band = hs / 2;
      const outside =
        worldX < rect.x - band || worldX > rect.x + rect.w + band ||
        worldY < rect.y - band || worldY > rect.y + rect.h + band;
      if (outside) continue;
      const inInterior =
        worldX > rect.x + band && worldX < rect.x + rect.w - band &&
        worldY > rect.y + band && worldY < rect.y + rect.h - band;
      if (!inInterior) return id;
    }
    return null;
  }

  /** World-space rect of the node's image (same formula as drawImage), or null. */
  imageWorldRect(state: RenderState, id: string): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    if (!p) return null;
    return this.imageRectForPlaced(p);
  }

  /** World-space rect of the image of an already-placed node, or null. */
  private imageRectForPlaced(p: Placed): { x: number; y: number; w: number; h: number } | null {
    // First PRESENT slot: the drag offset, the resize handle and the ring all
    // target whichever image exists. The EXACT slot for the ring and handle
    // comes from selectedImageRect, which has `state`.
    const it = this.imageSlots(p).items[0];
    return it ? { x: it.x, y: it.y, w: it.size.w, h: it.size.h } : null;
  }

  /** Rect of the SELECTED image slot (falling back to the first present). */
  private selectedImageRect(state: RenderState, p: Placed): { x: number; y: number; w: number; h: number } | null {
    // A bare picture has no image "inside" it to select or resize apart: the
    // item's own free-transform handles are the picture's.
    if (isBarePicture(p.node)) return null;
    const items = this.imageSlots(p).items;
    const slot = state.imageSlot ?? "top";
    const it = items.find((i) => i.slot === slot) ?? items[0];
    return it ? { x: it.x, y: it.y, w: it.size.w, h: it.size.h } : null;
  }

  /** World-space rect of one image slot of an already-placed node, or null. */
  imageSlotWorldRect(state: RenderState, id: string, slot: ImageSlot): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    if (!p) return null;
    const it = this.imageSlots(p).items.find((i) => i.slot === slot);
    return it ? { x: it.x, y: it.y, w: it.size.w, h: it.size.h } : null;
  }

  /**
   * Hit test for the images INSIDE a node: every slot is a selectable
   * target of its own (select → Backspace deletes only that image; drag
   * moves it to another node). Checked before the node-body hit test so the
   * images win inside their own rects. Returns the node id of a hit slot.
   */
  hitTestImage(state: RenderState, worldX: number, worldY: number): string | null {
    return this.hitTestImageSlot(state, worldX, worldY)?.nodeId ?? null;
  }

  /** Like hitTestImage, but also reports WHICH slot was hit and its rect. */
  hitTestImageSlot(
    state: RenderState,
    worldX: number,
    worldY: number,
  ): { nodeId: string; slot: ImageSlot; rect: { x: number; y: number; w: number; h: number } } | null {
    const placed = this.visiblePlacedList(state);
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i];
      if (isBarePicture(p.node)) continue;
      if (worldX < p.x || worldX > p.x + p.w || worldY < p.y || worldY > p.y + p.h) continue;
      const items = this.imageSlots(p).items;
      for (const it of items) {
        if (worldX >= it.x && worldX <= it.x + it.size.w && worldY >= it.y && worldY <= it.y + it.size.h) {
          return { nodeId: p.node.id, slot: it.slot, rect: { x: it.x, y: it.y, w: it.size.w, h: it.size.h } };
        }
      }
    }
    return null;
  }

  /**
   * The gallery cell under the point (T25), or null.
   *
   * Checked BEFORE the slot and body tests: a cell sits inside its topic's
   * box, so whichever test runs first wins, and the specific target has to be
   * the one that answers.
   *
   * The caption band under a picture is a target of its own — `part` says
   * which one was hit. Both still select the topic and start the same cell
   * drag; the caption variant additionally tells the caller the user aimed
   * at the label, so it can focus the caption field in the Inspector.
   */
  hitTestGalleryCell(
    state: RenderState,
    worldX: number,
    worldY: number,
  ): { nodeId: string; index: number; part: "picture" | "caption"; rect: { x: number; y: number; w: number; h: number } } | null {
    const placed = this.visiblePlacedList(state);
    for (let i = placed.length - 1; i >= 0; i--) {
      // A topic painted OVER a grid (an open chart note does exactly that)
      // owns the point: the cell under it is hidden, so it is not a target.
      const p = placed[i];
      if (worldX < p.x || worldX > p.x + p.w || worldY < p.y || worldY > p.y + p.h) continue;
      if (!p.node.style.gallery && !p.node.style.freeform) return null;
      const { cells } = this.imageSlots(p);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        if (worldX >= c.x && worldX <= c.x + c.w && worldY >= c.y && worldY <= c.y + c.h) {
          return { nodeId: p.node.id, index: k, part: "picture", rect: { x: c.x, y: c.y, w: c.w, h: c.h } };
        }
        // The caption band only exists when some cell in the grid is
        // captioned — a bandless grid has nothing to hit.
        if (c.captionH > 0 && worldX >= c.x && worldX <= c.x + c.w && worldY >= c.captionY && worldY <= c.captionY + c.captionH) {
          return { nodeId: p.node.id, index: k, part: "caption", rect: { x: c.x, y: c.captionY, w: c.w, h: c.captionH } };
        }
      }
    }
    return null;
  }

  /**
   * World-space rects of a node's gallery cells — what `galleryInsertIndex`
   * needs to turn a cursor position into a drop position. Empty for a topic
   * with no gallery, which the caller reads as "insert at 0".
   */
  galleryCellRects(state: RenderState, nodeId: string): { x: number; y: number; w: number; h: number }[] {
    const p = this.placedNodes(state).find((q) => q.node.id === nodeId);
    if (!p) return [];
    return this.imageSlots(p).cells.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));
  }

  /**
   * World rect of one cell's title band — where the inline caption field sits.
   * A gallery with no caption yet has no band, so the field takes the last
   * line's worth of the picture instead: there must be somewhere to type the
   * first one. Null when the cell is gone (undo, another delete).
   */
  galleryCaptionRect(state: RenderState, nodeId: string, index: number): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((q) => q.node.id === nodeId);
    if (!p) return null;
    const c = this.imageSlots(p).cells[index];
    if (!c) return null;
    if (c.captionH > 0) return { x: c.x, y: c.captionY, w: c.w, h: c.captionH };
    return { x: c.x, y: c.y + c.h - GALLERY_CAPTION_LINE_H, w: c.w, h: GALLERY_CAPTION_LINE_H };
  }

  /** The "+ column" / "+ row" pill of a selected chart under the point, or null. */
  hitTestChartGrow(state: RenderState, worldX: number, worldY: number): { id: string; grow: "row" | "col" } | null {
    if (state.selection.size !== 1) return null;
    const placed = this.placedById(state);
    for (const id of state.selection) {
      if (state.editingId === id) continue;
      const p = placed.get(id);
      if (!p) continue;
      for (const h of chartGrowHandles(p, state.camera.scale)) {
        if (worldX >= h.x && worldX <= h.x + h.w && worldY >= h.y && worldY <= h.y + h.h) return { id, grow: h.grow };
      }
    }
    return null;
  }

  hitTestResize(state: RenderState, worldX: number, worldY: number): { id: string; side: "left" | "right" } | null {
    const hs = 12; // grab box slightly larger than the drawn 9px handle
    // Placed once, for the same reason as hitTestImageResize above.
    const placed = this.placedById(state);
    for (const id of state.selection) {
      if (state.editingId === id) continue;
      const p = placed.get(id);
      const rect = p ? { x: p.x, y: p.y, w: p.w, h: p.h } : null;
      if (!rect) continue;
      const hy = rect.y + rect.h / 2 - hs / 2;
      for (const side of ["left", "right"] as const) {
        const hx = (side === "left" ? rect.x : rect.x + rect.w) - hs / 2;
        if (worldX >= hx && worldX <= hx + hs && worldY >= hy && worldY <= hy + hs) return { id, side };
      }
    }
    return null;
  }

  nodeWorldRect(state: RenderState, id: string): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    if (!p) return null;
    return { x: p.x, y: p.y, w: p.w, h: p.h };
  }

  /** The placed box of a topic, node included (what chart geometry reads). */
  placedNode(state: RenderState, id: string): { x: number; y: number; w: number; h: number; node: MindNode } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    return p ? { x: p.x, y: p.y, w: p.w, h: p.h, node: p.node } : null;
  }

  /**
   * Visible node ids whose box intersects the given world-space rectangle
   * (marquee). With `contain`, only boxes lying wholly inside it — the
   * draw.io rule a freeform canvas's marquee follows.
   */
  nodesInRect(state: RenderState, wx0: number, wy0: number, wx1: number, wy1: number, contain = false): string[] {
    const minX = Math.min(wx0, wx1), maxX = Math.max(wx0, wx1);
    const minY = Math.min(wy0, wy1), maxY = Math.max(wy0, wy1);
    return this.placedNodes(state)
      .filter((p) => {
        if (!p.visible) return false;
        // Canvases and their items always follow draw.io's rule: picked only
        // when wholly inside, whichever surface the box was started on (a box
        // that merely clips a canvas does not grab it with its items). A
        // rotated item is measured by the box it really covers.
        const item = !!p.node.style.freeform || !!freeformOwner(state.sheet, p.node.id);
        const b = item ? rotatedBox(p, p.node.style.rotation) : p;
        return contain || item
          ? b.x >= minX && b.x + b.w <= maxX && b.y >= minY && b.y + b.h <= maxY
          : b.x < maxX && b.x + b.w > minX && b.y < maxY && b.y + b.h > minY;
      })
      .map((p) => p.node.id);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /** Bounds of the same expanded/collapsed content that is present in the editor. */
  printBounds(state: RenderState): { minX: number; minY: number; maxX: number; maxY: number } {
    const all = this.placedNodes(state);
    if (!all.length) return { minX:0,minY:0,maxX:100,maxY:100 };
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for (const p of all) { minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x+p.w);maxY=Math.max(maxY,p.y+p.h); }
    return {minX:minX-20,minY:minY-20,maxX:maxX+20,maxY:maxY+20};
  }

  /** Used on a dedicated offscreen renderer so printing cannot disturb the editor. */
  async renderForPrint(state: RenderState, pixelRatio = 1): Promise<void> {
    if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new Error("Invalid print pixel ratio");
    this.dpr = pixelRatio;
    this.resolveImage = imageResolver(state.sheet);
    for (const placed of this.placedNodes(state)) if (placed.visible) await this.preloadNodeImages(placed,state.camera.scale*this.dpr,true);
    this.render({...state,opaque:true,hideStudyMarkers:true,selection:new Set(),editingId:null,hoverId:null,drop:null,imageSel:null,gallerySel:null,relSel:null,groupSel:null,summarySel:null,searchMatches:undefined,searchCurrent:undefined,marqueeSel:null,ghostImage:null,galleryDrop:null});
  }

  dispose(): void {
    this.quizMarkerCache=null;
    this.connectorBatchCache = null;
    this.branchColorCache = null;
    this.rootGradCache = null;
    if (this.sceneCacheCanvas) {
      this.sceneCacheCanvas.width = 0;
      this.sceneCacheCanvas.height = 0;
      this.sceneCacheCanvas = null;
    }
    if (this.sceneCacheBuf) {
      this.sceneCacheBuf.width = 0;
      this.sceneCacheBuf.height = 0;
      this.sceneCacheBuf = null;
    }
    this.sceneCacheKey = null;
    this.sceneCacheCam = null;
    for (const item of this.imageCache.values()) item.bitmap.close();
    for (const item of this.textCache.values()) { item.canvas.width=0;item.canvas.height=0; }
    this.freeShadowSprites();
    this.imageCache.clear();
    this.imageBuckets.clear();
    this.frameKeys.clear();
    this.frameOriginalImages.clear();
    this.decodeQueue.clear();
    this.textCache.clear();
    this.imageBytes = 0;
    this.textBytes = 0;
  }

  exportPng(state: RenderState, transparent = false, maxSize = 8192): HTMLCanvasElement {
    const bounds = this.exportBounds(state);
    const bw = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
    const bh = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
    const scale = Math.min(1, maxSize / Math.max(bw, bh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(bw * scale));
    canvas.height = Math.max(1, Math.ceil(bh * scale));
    const ctx = canvas.getContext("2d")!;
    const theme = THEMES[state.themeName];
    if (!transparent) {
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
    // Every draw* method paints on `this.ctx`. Without the swap the whole map
    // went onto the LIVE canvas (repainted a frame later) and the exported PNG
    // came out as a blank background — the same swap renderNodeImage does.
    const liveCtx = this.ctx;
    const liveScale = this.curScale;
    const liveDpr = this.dpr;
    this.ctx = ctx;
    this.curScale = scale;
    this.dpr = 1;
    try {
      this.paintFull(ctx, state, theme);
    } finally {
      this.ctx = liveCtx;
      this.curScale = liveScale;
      this.dpr = liveDpr;
    }
    return canvas;
  }

  private exportBounds(state: RenderState): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.placedNodes({ ...state, showHidden: true })) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + p.w > maxX) maxX = p.x + p.w;
      if (p.y + p.h > maxY) maxY = p.y + p.h;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const pad = 30;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  private paintFull(_ctx: CanvasRenderingContext2D, state: RenderState, theme: RenderTheme): void {
    const all = this.placedNodes({ ...state, showHidden: true });
    const byId = new Map(all.map((p) => [p.node.id, p]));
    for (const p of all) if (p.node.style.freeform) this.drawFreeform(theme, p);
    this.drawGroupFills({ ...state, showHidden: true, camera: { ...state.camera, scale: 1 } }, byId);
    // Diagram arrows (both ends in a canvas) go over the boxes, as on screen.
    const inCanvas = (rel: Relationship): boolean => !!freeformOwner(state.sheet, rel.fromId) && !!freeformOwner(state.sheet, rel.toId);
    const paintRels = (over: boolean): void => {
      for (const rel of state.sheet.relationships) {
        if (inCanvas(rel) !== over) continue;
        const a = byId.get(rel.fromId);
        const b = byId.get(rel.toId);
        if (a && b) this.drawRelationship(theme, a, b, rel, rel.color ?? (rel.tree || state.sheet.structure.structureType === "diagram" ? theme.text : theme.selection), false, this.relEnv(state, rel));
      }
    };
    paintRels(false);
    for (const p of all) {
      if (p.node.parentId) {
        const parent = byId.get(p.node.parentId);
        if (parent && !parent.node.style.freeform)
          this.drawConnector(
            parent,
            p,
            state.sheet.structure.structureType,
            state.sheet.structure.orientation,
            this.branchColor(theme, p.node, state.sheet)
          );
      }
    }
    for (const p of all) this.drawNode(theme, p, { ...state, showHidden: true }, false);
    paintRels(true);
    for (const p of all) if (p.node.style.freeform) this.drawInk(theme, p, state);
    // export with a fixed 1px-ish stroke scale
    this.drawGroupsAndSummaries(theme, { ...state, showHidden: true, camera: { ...state.camera, scale: 1 } }, byId);
  }
}
