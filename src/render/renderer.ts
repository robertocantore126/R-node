/**
 * Canvas renderer — one <canvas>, no DOM/SVG nodes per topic.
 *
 * Paints relationships, connectors and nodes with viewport culling, then
 * provides hit testing over the same geometry. Text editing happens in an
 * HTML overlay (allowed by the architecture) — the renderer skips the title
 * of the node being edited so the overlay doesn't double-paint.
 */
import type { Group, ImageSlot, MindNode, Sheet, ConnectorStyle, ShapePart, StructureType, Orientation, Summary, TextRun } from "../core/types";
import { nodeImageIds } from "../core/ops";
import { nodeRuns } from "../core/text";
import { resolvePaint } from "../core/shapeArt";
import { asCodeLang, tokenize, type CodeLang } from "../core/codeHighlight";
import { ARROW_HALF_ANGLE, ARROW_LEN, bezierEnterRect, bezierExitRect, bezierSlice, CODE_FONT_STACK, CODE_TITLEBAR_H, createCanvasTextMeasurer, FONT_STACK, imageResolver, LINE_HEIGHT_FACTOR, MAX_IMAGE_W, measureNode, positionedImageSlots, segmentExitRect, TEXT_INSET, wrapRunLines, type Bezier3, type TextMeasurer } from "../layout/measure";
import { getAssetStore, type AssetLevel, type AssetStore } from "../persist/assets";
import { THEMES, lighten, type RenderTheme, type ThemeName } from "./theme";
import { trace } from "../dev/trace";
import type { Camera } from "./viewport";

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
   * Ghost preview of an image being dragged over the map (internal
   * reassignment): the image bitmap follows the cursor, semi-transparent,
   * until the drop lands. x/y are world coords of the cursor; `side` snaps
   * the ghost onto that slot of the target node instead of the cursor.
   */
  ghostImage?: { imageId: string; x: number; y: number; nodeId: string; side?: ImageSlot } | null;
  /**
   * Marquee drag preview: ids of the topics inside the drag box — they wear
   * the selection ring BEFORE the release commits them (the box itself is a
   * DOM overlay; this is the live "what will be selected" feedback).
   */
  marqueeSel?: Set<string> | null;
  showHidden?: boolean; // export: include collapsed subtrees
  /**
   * Store revision — the invalidation key for the placement cache. Omit it and
   * nothing is cached, which is the honest default for a state assembled by
   * hand (tests, exports): a wrong cache hit is a wrong picture.
   */
  rev?: number;
}

interface Placed {
  node: MindNode;
  x: number; // top-left in world coords
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/**
 * Geometry of every outline drawn around a topic. ONE distance from the box,
 * shared by selection, marquee preview and hover — see Renderer.strokeRing for
 * why they must not differ. The weights below are the only thing that may.
 */
const RING_PAD = 3;
const RING_W_SELECTED = 2.5;
const RING_W_HOVER = 1.5;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** Same measurer the layout engine uses — extents always agree. */
  private measurer: TextMeasurer = createCanvasTextMeasurer();
  /** Camera scale of the current frame (used to pick the text-cache resolution). */
  private curScale = 1;
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
  private imageFailed = new Set<string>();
  /** Decodes in flight, key → requesting nodeId (a finished one for a node
   * that scrolled off is closed immediately, never cached). */
  private inflight = new Map<string, string>();
  private inflightCount = 0;
  private readonly IMAGE_BUDGET = 128 * 1024 * 1024;
  private readonly MAX_INFLIGHT = 5;
  /** Decode-size buckets. The max is the width of the `large` level: decoding
   *  wider than the stored source costs memory and adds no detail. */
  private readonly IMAGE_BUCKET_MIN = 128;
  private readonly IMAGE_BUCKET_MAX = 1024;
  private assetStore: AssetStore;
  private onRepaint: (() => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    opts: { assetStore?: AssetStore; onRepaint?: () => void } = {}
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    // Resolved at construction, not at module scope: getAssetStore() is a
    // singleton that sticks on first call, and module init may run before
    // Tauri injects window.__TAURI__ — the backend must be picked when the
    // renderer is actually created, in the running environment.
    this.assetStore = opts.assetStore ?? getAssetStore();
    this.onRepaint = opts.onRepaint ?? null;
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
    if (canvas.width === w && canvas.height === h && this.dpr === dpr) return;
    this.dpr = dpr;
    canvas.width = w;
    canvas.height = h;
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
    value: Placed[];
    resolveImage: (id: string) => { w: number; h: number } | null;
  } | null = null;

  private placementKey(state: RenderState): string | null {
    if (state.rev === undefined) return null; // caller opted out
    // Visibility depends on the camera, so it belongs in the key alongside the
    // revision: a pan changes which nodes are visible without changing any box.
    return `${state.rev}|${state.camera.x}|${state.camera.y}|${state.camera.scale}|${state.viewW}|${state.viewH}|${state.showHidden === true ? 1 : 0}`;
  }

  private placedNodes(state: RenderState): Placed[] {
    const key = this.placementKey(state);
    if (key !== null && this.placedCache?.key === key) {
      // resolveImage is per-sheet state that callers read AFTER placing (every
      // image rect comes from it), so a cache hit has to restore it — but from
      // the entry, not by rebuilding: it walks every attachment, and rebuilding
      // it here would put an O(attachments) pass back on the path this cache
      // exists to empty.
      this.resolveImage = this.placedCache.resolveImage;
      return this.placedCache.value;
    }
    const out = this.computePlacement(state);
    if (key !== null && this.resolveImage) {
      this.placedCache = { key, value: out, resolveImage: this.resolveImage };
    }
    return out;
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
    for (const n of Object.values(sheet.nodes)) {
      if (n.type === "floating" && !seen.has(n.id)) add(n);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Main paint
  // -------------------------------------------------------------------------

  render(state: RenderState): void {
    const ctx = this.ctx;
    const theme = THEMES[state.themeName];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, state.viewW, state.viewH);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, state.viewW, state.viewH);

    const s = state.camera.scale;
    this.curScale = s;
    const ox = state.viewW / 2 - state.camera.x * s;
    const oy = state.viewH / 2 - state.camera.y * s;
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * ox, this.dpr * oy);

    this.drawGrid(theme, state);

    const tStart = typeof performance !== "undefined" ? performance.now() : 0;
    this.textHits = 0;
    this.textMisses = 0;

    const placed = this.placedNodes(state);
    // A node counts as "has an image" when ANY of its four slots is set — a
    // node with only side images must keep its decodes like the top one does.
    this.visibleImageNodes = new Set(placed.filter((p) => p.visible && nodeImageIds(p.node).length > 0).map((p) => p.node.id));
    const byId = new Map(placed.map((p) => [p.node.id, p]));

    // Viewport in world units, with the same 40px margin placedNodes uses.
    const vw = state.viewW / s;
    const vh = state.viewH / s;
    const viewMinX = state.camera.x - vw / 2 - 40;
    const viewMaxX = state.camera.x + vw / 2 + 40;
    const viewMinY = state.camera.y - vh / 2 - 40;
    const viewMaxY = state.camera.y + vh / 2 + 40;
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

    // 1) relationships
    let rels = 0;
    let relsDrawn = 0;
    for (const rel of state.sheet.relationships) {
      rels++;
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (a && b && linkVisible(a, b)) {
        relsDrawn++;
        this.drawRelationship(theme, a, b, rel.color ?? theme.selection, rel.lineStyle ?? "dashed", rel.label, rel.bidirectional, state.relSel === rel.id, rel.connector);
      }
    }

    // 2) connectors
    let links = 0;
    let linksDrawn = 0;
    for (const p of placed) {
      if (!p.node.parentId) continue;
      const parent = byId.get(p.node.parentId);
      if (!parent) continue;
      links++;
      if (!linkVisible(parent, p)) continue;
      linksDrawn++;
      this.drawConnector(
        parent,
        p,
        state.sheet.structure.structureType,
        state.sheet.structure.orientation,
        this.branchColor(theme, p.node, state.sheet)
      );
    }

    // 3) nodes
    for (const p of placed) {
      if (!p.visible) continue;
      this.drawNode(theme, p, state);
    }

    // 4) groups & summaries (drawn over the nodes, geometry derived from members)
    this.drawGroupsAndSummaries(theme, state, byId);

    // 5) drop indicator
    if (state.drop && state.drop.mode !== "none") {
      const target = byId.get(state.drop.nodeId);
      if (target) this.drawDropIndicator(theme, target, state.drop.mode);
    }

    // 6) ghost preview of an image being dragged (internal reassignment) —
    // on top of everything, centered on the cursor, before the drop lands.
    if (state.ghostImage) this.drawGhostImage(theme, state, state.ghostImage);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Evict only at the end of the frame: a closed bitmap still referenced by
    // the current paint would throw.
    this.evictToBudget();

    // Per-frame counters: they are what separates "not drawn" from "drawn but
    // invisible" when someone reports something missing on screen.
    trace.render(
      {
        scale: s,
        nodes: placed.length,
        visible: placed.reduce((a, p) => a + (p.visible ? 1 : 0), 0),
        rels,
        relsDrawn,
        links,
        linksDrawn,
        textHits: this.textHits,
        textMisses: this.textMisses,
        imgVisible: placed.filter(
          (p) => p.visible && nodeImageIds(p.node).some((id) => !!this.resolveImage?.(id))
        ).length,
        imgCached: this.imageCache.size,
        imgBytes: this.imageBytes,
        imgInflight: this.inflightCount,
      },
      (typeof performance !== "undefined" ? performance.now() : 0) - tStart
    );
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  private drawGrid(theme: RenderTheme, state: RenderState): void {
    const ctx = this.ctx;
    const s = state.camera.scale;
    const step = 40;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1 / s;
    ctx.beginPath();
    const x0 = state.camera.x - state.viewW / 2 / s;
    const x1 = state.camera.x + state.viewW / 2 / s;
    const y0 = state.camera.y - state.viewH / 2 / s;
    const y1 = state.camera.y + state.viewH / 2 / s;
    const startX = Math.floor(x0 / step) * step;
    const startY = Math.floor(y0 / step) * step;
    for (let gx = startX; gx <= x1; gx += step) {
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y1);
    }
    for (let gy = startY; gy <= y1; gy += step) {
      ctx.moveTo(x0, gy);
      ctx.lineTo(x1, gy);
    }
    ctx.stroke();
  }

  private drawConnector(
    parent: Placed,
    child: Placed,
    structure: StructureType,
    orientation: Orientation,
    color: string
  ): void {
    const ctx = this.ctx;
    void structure;
    const childLeft = child.x + child.w / 2 < parent.x + parent.w / 2;
    let sx: number, sy: number, ex: number, ey: number;
    // vertical connector when child is below parent and structure supports vertical layouts
    if (child.y > parent.y + parent.h - 1 && structure !== "mindmap" && !(structure === "logic" && orientation !== "vertical")) {
      // vertical tree: parent bottom -> child top
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
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(cp1x, sy, cp2x, ey, ex, ey);
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
    return { fill: this.resolveFill(theme, n, state.sheet), text: n.style.textColor ?? (n.type === "central" ? theme.rootText : theme.text) };
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
    const depth = this.depthOf(n, sheet);
    if (depth === 0) return theme.rootFill;
    if (depth === 1) {
      // Main topics are the dense step: the root's colour when the root is
      // painted, otherwise the palette vivid of their branch.
      const root = sheet.nodes[sheet.rootNodeId];
      if (root?.style.fill) return root.style.fill;
      return theme.branch[this.branchIndex(n, sheet)];
    }
    if (depth === 2) {
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

  private branchColor(theme: RenderTheme, n: MindNode, sheet: Sheet): string {
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
  private strokeRing(ctx: CanvasRenderingContext2D, p: { x: number; y: number; w: number; h: number }, lineWidth: number): void {
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);
    ctx.strokeRect(p.x - RING_PAD, p.y - RING_PAD, p.w + RING_PAD * 2, p.h + RING_PAD * 2);
  }

  private drawNode(theme: RenderTheme, p: Placed, state: RenderState): void {
    const ctx = this.ctx;
    const n = p.node;
    const editing = state.editingId === n.id;
    const selected = state.selection.has(n.id);
    // A code topic paints its own block (T22): the box wears the code surface
    // unless the user picked a fill of their own, and the rich-text/image
    // path below is skipped entirely.
    const isCode = !!n.style.code;
    const fill = isCode ? n.style.fill ?? theme.codeBg : this.nodeFill(theme, p, state);
    const textColor = n.style.textColor ?? (n.type === "central" ? theme.rootText : theme.text);
    const opacity = n.style.opacity ?? 1;

    ctx.save();
    ctx.globalAlpha = opacity;
    if (n.style.rotation) ctx.rotate((n.style.rotation * Math.PI) / 180);

    // shadow
    if (n.style.shadow) {
      ctx.shadowColor = theme.shadow;
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 4;
    }

    // Custom artwork (T24): a list of paths painted in order, silhouette first.
    // It replaces the box entirely — there is no rectangle underneath, or every
    // shape would sit on a visible slab.
    const art = !isCode && n.style.shape === "custom" ? n.style.shapeParts : undefined;
    if (art && art.length > 0) {
      this.paintShapeArt(ctx, theme, p, art, fill);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    } else {
      // A code block is always a rounded rectangle: shape styles (circle,
      // diamond…) describe presentational topics, and the chrome strip needs a
      // straight top edge to sit on.
      this.traceShape(ctx, p, isCode ? "rounded" : n.style.shape ?? "rounded", isCode ? 8 : n.style.cornerRadius ?? 10);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    if (n.style.borderWidth && n.style.stroke && n.style.stroke !== "transparent") {
      ctx.strokeStyle = n.style.stroke;
      ctx.lineWidth = n.style.borderWidth;
      ctx.setLineDash(n.style.borderStyle === "dashed" ? [6, 4] : n.style.borderStyle === "dotted" ? [2, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (theme.name === "light") {
      ctx.strokeStyle = theme.nodeBorder;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // selection ring
    if (selected) {
      ctx.strokeStyle = theme.selection;
      this.strokeRing(ctx, p, RING_W_SELECTED);

      // Xmind-style resize handles on BOTH edges (hidden while editing — the
      // HTML overlay owns the node then). Dragging changes the width and the
      // text re-wraps; see hitTestResize + store.setResizeDraft. Outline only
      // (a filled square reads as a purple blob on the node); a white
      // under-stroke keeps them visible on dark/same-colored fills (e.g. the
      // indigo central topic) without adding a fill.
      const hs = 9;
      const hy = p.y + p.h / 2 - hs / 2;
      for (const hx of [p.x - hs / 2, p.x + p.w - hs / 2]) {
        this.roundRect(ctx, hx, hy, hs, hs, 2);
        ctx.strokeStyle = theme.background;
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.strokeStyle = theme.selection;
        ctx.lineWidth = 1.6;
        ctx.stroke();
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
      ctx.strokeStyle = theme.selection;
      this.strokeRing(ctx, p, RING_W_SELECTED);
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
    if (state.hoverId === n.id && !selected) {
      ctx.strokeStyle = theme.selection;
      ctx.globalAlpha = opacity * 0.55;
      this.strokeRing(ctx, p, RING_W_HOVER);
      ctx.globalAlpha = opacity;
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
        this.drawText(theme, p, textColor);
      }
    }

    // collapsed badge (mirror to the left when the branch is left-side)
    if (n.collapsed && n.childrenIds.length > 0) {
      const count = this.hiddenCount(n, state.sheet);
      const centerX = p.x + p.w / 2;
      const isLeft = centerX < 0;
      const bx = isLeft ? p.x - 10 : p.x + p.w + 10;
      const by = p.y + p.h / 2;
      ctx.fillStyle = theme.collapsedBadge;
      ctx.beginPath();
      ctx.arc(bx, by, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = theme.collapsedBadgeText;
      ctx.font = `600 11px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(count), bx, by + 0.5);
    }

    ctx.restore();
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

  private traceShape(ctx: CanvasRenderingContext2D, p: Placed, shape: string, radius: number): void {
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
        this.roundRect(ctx, x, y, w, h, radius);
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

  private drawText(_theme: RenderTheme, p: Placed, color: string): void {
    const n = p.node;
    // The caller already skips this node entirely while it is being edited,
    // so an empty title here means an empty topic nobody is typing into.
    if (n.title.trim() === "") {
      this.drawPlaceholder(p, color);
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
    const slots = positionedImageSlots(p, n, this.resolveImage);
    const maxW = Math.max(20, p.w - pad * 2 - TEXT_INSET - slots.sidePadW);
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
      this.evictTextToBudget();
    }
    const totalH = entry.h;
    // The text lives in the middle column: below the top image, above the
    // bottom one, between the side ones — each separated by IMAGE_GAP. With
    // no images at all this reduces to the old vertical centering exactly
    // (p.y + pad + (p.h − pad·2 − totalH)/2 = p.y + (p.h − totalH)/2).
    // Read from the INSETS, not from the image slots. For images the two agree
    // exactly (an occupied slot's inset is its size plus one gap), but a custom
    // shape's text box only reaches this far through the insets — and reading
    // the slots meant the label of a shape node was drawn at the box's left
    // edge, outside the drawing entirely.
    const topBlock = slots.insets.top;
    const botBlock = slots.insets.bottom;
    const midH = topBlock + totalH + botBlock;
    const startY = p.y + pad + topBlock + Math.max(0, (p.h - pad * 2 - midH) / 2);
    const startX = p.x + pad + slots.insets.left;
    if (entry.w > 0 && entry.h > 0) this.ctx.drawImage(entry.canvas, startX, startY, entry.w, entry.h);
  }

  /**
   * Draw every image slot of the node into its reserved rect (cached
   * bitmaps), or start the decodes. Sync by design: no await inside the
   * paint path. The positions come from positionedImageSlots (I9) — the same
   * geometry the layout and the editing overlay use, so nothing can drift.
   */
  private drawImage(p: Placed): void {
    const { items } = positionedImageSlots(p, p.node, this.resolveImage);
    for (const it of items) this.paintSlot(p, it.id, it.size.w, it.size.h, it.x, it.y);
  }

  /** Decode (if needed) and blit one image slot at the given world rect. */
  private paintSlot(p: Placed, imageId: string, imgW: number, imgH: number, x: number, y: number): void {
    if (!this.resolveImage) return;
    // Decode at the size THIS image is painted at, not at the size it happens
    // to be stored at. Driving the choice from the global zoom alone put every
    // bitmap on the 1024px level above zoom 0.5 on a retina screen — 3MB each,
    // so fifty visible image nodes blew the budget and the cache thrashed.
    const neededPx = imgW * this.curScale * this.dpr;
    // Quantised to powers of two: an exact size would mint a new cache key on
    // every micro-change of zoom and nothing would ever hit.
    const bucket = Math.max(this.IMAGE_BUCKET_MIN, Math.min(this.IMAGE_BUCKET_MAX, 2 ** Math.ceil(Math.log2(Math.max(1, neededPx)))));
    // Smallest stored level that can serve the bucket. The original is never
    // decoded: the hard 1024px cap of ADR-001 §12 is enforced here.
    const level: AssetLevel = bucket <= 256 ? "small" : "large";
    // The BUCKET keys the cache, not the level — with a variable decode size,
    // keying by level would reuse a 384px bitmap when 900 are needed and leave
    // that image blurred with nothing to invalidate it.
    const key = `${imageId}@${bucket}`;

    const entry = this.imageCache.get(key);
    if (entry) {
      // LRU refresh (Map insertion order = recency).
      this.imageCache.delete(key);
      this.imageCache.set(key, entry);
      this.ctx.drawImage(entry.bitmap, x, y, imgW, imgH);
      return;
    }
    if (this.imageFailed.has(key)) return; // corrupt/unavailable: not per frame
    if (this.inflight.has(key) || this.inflightCount >= this.MAX_INFLIGHT) return;
    this.startDecode(key, imageId, p.node.id, level, bucket);
  }

  private async startDecode(key: string, assetId: string, nodeId: string, level: AssetLevel, bucket: number): Promise<void> {
    this.inflight.set(key, nodeId);
    this.inflightCount++;
    try {
      const blob = await this.assetStore.get(assetId, level);
      if (!blob) {
        this.imageFailed.add(key);
        return;
      }
      // resizeWidth downsamples DURING decode: the full-resolution surface is
      // never materialised. Height is omitted on purpose — the browser derives
      // it from the aspect ratio, and passing both risks distortion.
      const bitmap = await createImageBitmap(blob, { resizeWidth: bucket, resizeQuality: "high" });
      if (!this.visibleImageNodes.has(nodeId)) {
        // The requesting node scrolled off while decoding: close immediately,
        // never cache it.
        bitmap.close();
        return;
      }
      const bytes = bitmap.width * bitmap.height * 4;
      this.imageCache.set(key, { bitmap, bytes });
      this.imageBytes += bytes;
      this.evictToBudget();
      // A repaint lets the fresh bitmap appear without waiting for the next
      // user gesture (and starts the next pending decodes).
      this.onRepaint?.();
    } catch {
      this.imageFailed.add(key);
    } finally {
      if (this.inflight.delete(key)) this.inflightCount--;
    }
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
    const bucket = Math.max(this.IMAGE_BUCKET_MIN, Math.min(this.IMAGE_BUCKET_MAX, 2 ** Math.ceil(Math.log2(Math.max(1, neededPx)))));
    const level: AssetLevel = bucket <= 256 ? "small" : "large";
    const key = `${ghost.imageId}@${bucket}`;
    const entry = this.imageCache.get(key);
    if (!entry) {
      if (!this.inflight.has(key) && this.inflightCount < this.MAX_INFLIGHT) {
        this.startDecode(key, ghost.imageId, ghost.nodeId, level, bucket);
      }
      return;
    }
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
    ctx.drawImage(entry.bitmap, x, y, imgW, imgH);
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, imgW, imgH);
    ctx.restore();
  }

  /** Byte-budget LRU eviction for the text cache: same shape as evictToBudget
   *  (images), minus the bitmap close — canvas elements are plain JS memory. */
  private evictTextToBudget(): void {
    while (this.textBytes > this.TEXT_BUDGET && this.textCache.size > 0) {
      const first = this.textCache.entries().next().value;
      if (!first) break;
      const [k, v] = first as [string, { bytes: number }];
      this.textCache.delete(k);
      this.textBytes -= v.bytes;
    }
  }

  /** LRU eviction under the byte budget. Only ever called between frames. */
  private evictToBudget(): void {
    while (this.imageBytes > this.IMAGE_BUDGET && this.imageCache.size > 0) {
      const first = this.imageCache.entries().next().value;
      if (!first) break;
      const [k, v] = first as [string, { bitmap: ImageBitmap; bytes: number }];
      this.imageCache.delete(k);
      this.imageBytes -= v.bytes;
      v.bitmap.close();
    }
  }

  private textCacheKey(n: MindNode, color: string, maxW: number, res: number): string {
    const st = n.style;
    const runs = JSON.stringify(n.titleRuns ?? n.title);
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

    const family = n.style.fontFamily ?? FONT_STACK;
    const baseWeight = n.style.fontWeight ?? 400;
    const strike = (n.style.strikethrough ?? false);
    const fontOf = (seg: { run: TextRun }): string => {
      const runSize = seg.run.fontSize ?? size;
      const bold = (seg.run.bold ?? false) || baseWeight >= 700;
      const italic = (seg.run.italic ?? false) || (n.style.italic ?? false);
      return `${italic ? "italic " : ""}${bold ? 700 : baseWeight} ${runSize}px ${family}`;
    };
    let yCursor = 0;
    for (const line of lines) {
      const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
      yCursor += line.gapPx ?? 0;

      // The line box and its baseline come from wrapRunLines, which builds
      // them with the CSS rule (per-inline-box half-leading over every run
      // plus the strut). Recomputing them here — with ONE half-leading for the
      // whole line — is what used to drift from the editor on mixed sizes.
      const baselineY = yCursor + (line.baseline ?? lh * 0.8);

      // 2) draw the bullet in its own fixed-width column, then the text.
      //    List items are ALWAYS left-aligned (as in the overlay's CSS):
      //    centering a hanging indent is ill-defined and the two sides could
      //    never agree on it.
      const indent = line.indent ?? 0;
      if (line.bullet) {
        bctx.font = fontOf({ run: line.bullet.run });
        bctx.fillStyle = line.bullet.run.color ?? color;
        bctx.fillText(line.bullet.char, line.bullet.x, baselineY);
      }
      const isList = indent > 0 || !!line.bullet;
      let x = n.style.align === "left" || isList ? indent : (maxW - line.width) / 2;
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
          // underline ~0.1em below the baseline, strikethrough ~0.28em above
          const yy = underline ? baselineY + runSize * 0.1 : baselineY - runSize * 0.28;
          bctx.moveTo(x, yy);
          bctx.lineTo(x + w, yy);
          bctx.stroke();
        }
        x += w;
      }
      yCursor += lh;
    }
    return { canvas, w: maxW, h: totalH };
  }

  /** Draw a code topic (T22): the whole block — chrome and tokenized lines —
   *  rasterized once into a bitmap, exactly like drawText. The key carries
   *  the theme's palette id so two themes can never share entries (the
   *  tokenizer's own cache is keyed on the same id). */
  private drawCodeBlock(theme: RenderTheme, p: Placed): void {
    const n = p.node;
    const lang = asCodeLang(n.style.code?.lang);
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
    const n = p.node;
    const size = n.style.fontSize ?? 14;
    const pad = n.style.padding ?? 10;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(p.w * res));
    canvas.height = Math.max(1, Math.ceil(p.h * res));
    const bctx = canvas.getContext("2d");
    if (!bctx) return { canvas, w: p.w, h: p.h };
    bctx.scale(res, res);
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
    return { canvas, w: p.w, h: p.h };
  }

  private drawRelationship(theme: RenderTheme, a: Placed, b: Placed, color: string, style: string, label?: string, bidirectional?: boolean, selected?: boolean, connector?: ConnectorStyle): void {
    const ctx = this.ctx;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const curve: Bezier3 = {
      p0: { x: ax, y: ay },
      p1: { x: ax + (bx - ax) * 0.35, y: ay },
      p2: { x: bx - (bx - ax) * 0.35, y: by },
      p3: { x: bx, y: by },
    };
    // Truncate the curve exactly where it crosses each node's box, so the
    // visible line ends where the arrowhead sits. The old full curve ran on
    // under the head toward the centre, and the head's angle — computed on
    // the straight line to the centre — disagreed with the curve's real
    // tangent at the border on pronounced curves.
    // A straight relationship (T24, and what a saved structure asks for) is the
    // same drawing with the control points collapsed onto the border crossings:
    // the arrowhead code below then reads its angle off p2→p3 and gets the
    // segment's direction for free, instead of needing a second path.
    const straight = connector === "straight";
    const s0 = straight ? segmentExitRect(a, b) : null;
    const s1 = straight ? segmentExitRect(b, a) : null;
    const t0 = straight ? 0 : bezierExitRect(curve, a.x, a.y, a.w, a.h);
    const t1 = straight ? 1 : bezierEnterRect(curve, b.x, b.y, b.w, b.h);
    const drawn =
      straight && s0 && s1
        ? { p0: s0, p1: s0, p2: s1, p3: s1 }
        : t1 - t0 > 1e-6
          ? bezierSlice(curve, t0, t1)
          : curve;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.setLineDash(style === "dashed" ? [7, 5] : style === "dotted" ? [2, 4] : []);
    ctx.beginPath();
    ctx.moveTo(drawn.p0.x, drawn.p0.y);
    if (straight) ctx.lineTo(drawn.p3.x, drawn.p3.y);
    else ctx.bezierCurveTo(drawn.p1.x, drawn.p1.y, drawn.p2.x, drawn.p2.y, drawn.p3.x, drawn.p3.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Arrowheads: at the target, and at the source when bidirectional. The
    // head used to be painted at the node CENTRE and then covered by the
    // node's fill (nodes paint over relationships), so only the stub stuck
    // out. The tip now sits on the border crossing, and its angle is the
    // curve's exact tangent there — the slice's end segment.
    const arrow = (fromX: number, fromY: number, toX: number, toY: number): void => {
      const ang = Math.atan2(toY - fromY, toX - fromX);
      // Scale-compensated, like the groups and the drop indicator: the head
      // keeps its screen size at any zoom. Uncompensated it is 9 world units
      // — at scale 0.4 that is ~4 screen px, effectively invisible.
      const len = ARROW_LEN / this.curScale;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(toX - len * Math.cos(ang - ARROW_HALF_ANGLE), toY - len * Math.sin(ang - ARROW_HALF_ANGLE));
      ctx.lineTo(toX - len * Math.cos(ang + ARROW_HALF_ANGLE), toY - len * Math.sin(ang + ARROW_HALF_ANGLE));
      ctx.closePath();
      ctx.fill();
    };
    if (straight) {
      // The whole segment IS the tangent, so the head reads its angle from the
      // two endpoints. Using p2→p3 here would be atan2(0, 0): the collapsed
      // control points coincide with the end.
      arrow(drawn.p0.x, drawn.p0.y, drawn.p3.x, drawn.p3.y);
      if (bidirectional) arrow(drawn.p3.x, drawn.p3.y, drawn.p0.x, drawn.p0.y);
    } else {
      arrow(drawn.p2.x, drawn.p2.y, drawn.p3.x, drawn.p3.y);
      if (bidirectional) {
        // Source head: tip at the exit crossing, pointing back INTO node a
        // (opposite of the start tangent).
        arrow(drawn.p1.x, drawn.p1.y, drawn.p0.x, drawn.p0.y);
      }
    }
    if (label) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      ctx.font = `600 12px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.background;
      const w = ctx.measureText(label).width + 10;
      ctx.fillRect(mx - w / 2, my - 10, w, 20);
      ctx.fillStyle = color;
      ctx.fillText(label, mx, my + 0.5);
    }
  }

  // -------------------------------------------------------------------------
  // Groups & summaries
  // -------------------------------------------------------------------------

  /** Union rect (padded) of the member topics, in world coords. */
  private membersBounds(state: RenderState, memberIds: string[], byId?: Map<string, Placed>): { x: number; y: number; w: number; h: number } | null {
    const placed = byId ?? new Map(this.placedNodes(state).map((p) => [p.node.id, p]));
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

  private drawGroupsAndSummaries(theme: RenderTheme, state: RenderState, byId: Map<string, Placed>): void {
    const s = state.camera.scale;
    for (const g of state.sheet.boundaries) {
      const b = this.membersBounds(state, g.memberIds, byId);
      if (!b) continue;
      // cull: skip if the whole box is off-screen
      if (b.x + b.w < state.camera.x - state.viewW / 2 / s - 40 || b.x > state.camera.x + state.viewW / 2 / s + 40) continue;
      if (b.y + b.h < state.camera.y - state.viewH / 2 / s - 40 || b.y > state.camera.y + state.viewH / 2 / s + 40) continue;
      const pad = 16;
      const selected = state.groupSel === g.id;
      this.drawGroup(theme, g, b, pad, selected, s);
    }
    for (const sum of state.sheet.summaries) {
      const b = this.membersBounds(state, sum.memberIds, byId);
      if (!b) continue;
      if (b.y + b.h < state.camera.y - state.viewH / 2 / s - 40 || b.y > state.camera.y + state.viewH / 2 / s + 40) continue;
      const selected = state.summarySel === sum.id;
      this.drawSummary(theme, sum, b, selected, s, this.summaryFacingLeft(state, b, byId));
    }
  }

  private drawGroup(theme: RenderTheme, _g: Group, b: { x: number; y: number; w: number; h: number }, pad: number, selected: boolean, s: number): void {
    // Just the dashed boundary — no fill, no label tag (per the XMind-style
    // look: the box only "encapsulates" the topics visually).
    const ctx = this.ctx;
    const x = b.x - pad, y = b.y - pad, w = b.w + pad * 2, h = b.h + pad * 2;
    ctx.strokeStyle = selected ? theme.selection : theme.textMuted;
    ctx.lineWidth = selected ? 2.5 / s : 1.5 / s;
    ctx.setLineDash([7 / s, 5 / s]);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10 / s);
    ctx.stroke();
    ctx.setLineDash([]);
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
    const byId = new Map(this.placedNodes(state).map((p) => [p.node.id, p]));
    const threshold = 8 / state.camera.scale;
    for (const rel of state.sheet.relationships) {
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (!a || !b) continue;
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2, by = b.y + b.h / 2;
      const c1x = ax + (bx - ax) * 0.35, c1y = ay;
      const c2x = bx - (bx - ax) * 0.35, c2y = by;
      let prevX = ax, prevY = ay;
      for (let t = 0.05; t <= 1.0; t += 0.05) {
        const mt = 1 - t;
        const px = mt * mt * mt * ax + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * bx;
        const py = mt * mt * mt * ay + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * by;
        const dx = px - prevX, dy = py - prevY;
        const len = Math.hypot(dx, dy) || 1e-6;
        const dist = Math.abs((wx - prevX) * dy - (wy - prevY) * dx) / len;
        if (dist < threshold) return rel.id;
        prevX = px;
        prevY = py;
      }
    }
    return null;
  }

  hitTestGroup(state: RenderState, wx: number, wy: number): string | null {
    const placed = new Map(this.placedNodes(state).map((p) => [p.node.id, p]));
    for (const g of state.sheet.boundaries) {
      const b = this.membersBounds(state, g.memberIds, placed);
      if (!b) continue;
      const pad = 16;
      if (wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad) return g.id;
    }
    return null;
  }

  hitTestSummary(state: RenderState, wx: number, wy: number): string | null {
    const placed = new Map(this.placedNodes(state).map((p) => [p.node.id, p]));
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

  hitTest(state: RenderState, worldX: number, worldY: number): string | null {
    const placed = this.placedNodes(state).filter((p) => p.visible);
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i];
      if (worldX >= p.x && worldX <= p.x + p.w && worldY >= p.y && worldY <= p.y + p.h) return p.node.id;
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
    const placed = new Map(this.placedNodes(state).map((p) => [p.node.id, p]));
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
    const it = positionedImageSlots(p, p.node, this.resolveImage).items[0];
    return it ? { x: it.x, y: it.y, w: it.size.w, h: it.size.h } : null;
  }

  /** Rect of the SELECTED image slot (falling back to the first present). */
  private selectedImageRect(state: RenderState, p: Placed): { x: number; y: number; w: number; h: number } | null {
    const items = positionedImageSlots(p, p.node, this.resolveImage).items;
    const slot = state.imageSlot ?? "top";
    const it = items.find((i) => i.slot === slot) ?? items[0];
    return it ? { x: it.x, y: it.y, w: it.size.w, h: it.size.h } : null;
  }

  /** World-space rect of one image slot of an already-placed node, or null. */
  imageSlotWorldRect(state: RenderState, id: string, slot: ImageSlot): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    if (!p) return null;
    const it = positionedImageSlots(p, p.node, this.resolveImage).items.find((i) => i.slot === slot);
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
    const placed = this.placedNodes(state).filter((p) => p.visible);
    for (let i = placed.length - 1; i >= 0; i--) {
      const items = positionedImageSlots(placed[i], placed[i].node, this.resolveImage).items;
      for (const it of items) {
        if (worldX >= it.x && worldX <= it.x + it.size.w && worldY >= it.y && worldY <= it.y + it.size.h) {
          return { nodeId: placed[i].node.id, slot: it.slot, rect: { x: it.x, y: it.y, w: it.size.w, h: it.size.h } };
        }
      }
    }
    return null;
  }

  hitTestResize(state: RenderState, worldX: number, worldY: number): { id: string; side: "left" | "right" } | null {
    const hs = 12; // grab box slightly larger than the drawn 9px handle
    // Placed once, for the same reason as hitTestImageResize above.
    const placed = new Map(this.placedNodes(state).map((p) => [p.node.id, p]));
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

  /** Visible node ids whose box intersects the given world-space rectangle (marquee). */
  nodesInRect(state: RenderState, wx0: number, wy0: number, wx1: number, wy1: number): string[] {
    const minX = Math.min(wx0, wx1), maxX = Math.max(wx0, wx1);
    const minY = Math.min(wy0, wy1), maxY = Math.max(wy0, wy1);
    return this.placedNodes(state)
      .filter((p) => p.visible && p.x < maxX && p.x + p.w > minX && p.y < maxY && p.y + p.h > minY)
      .map((p) => p.node.id);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

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
    this.curScale = scale;
    ctx.setTransform(scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale);
    this.paintFull(ctx, state, theme);
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
    for (const rel of state.sheet.relationships) {
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (a && b) this.drawRelationship(theme, a, b, rel.color ?? theme.selection, rel.lineStyle ?? "dashed", rel.label, rel.bidirectional, false, rel.connector);
    }
    for (const p of all) {
      if (p.node.parentId) {
        const parent = byId.get(p.node.parentId);
        if (parent)
          this.drawConnector(
            parent,
            p,
            state.sheet.structure.structureType,
            state.sheet.structure.orientation,
            this.branchColor(theme, p.node, state.sheet)
          );
      }
    }
    for (const p of all) this.drawNode(theme, p, { ...state, showHidden: true });
    // export with a fixed 1px-ish stroke scale
    this.drawGroupsAndSummaries(theme, { ...state, showHidden: true, camera: { ...state.camera, scale: 1 } }, byId);
  }
}
