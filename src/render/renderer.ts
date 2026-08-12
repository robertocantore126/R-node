/**
 * Canvas renderer — one <canvas>, no DOM/SVG nodes per topic.
 *
 * Paints relationships, connectors and nodes with viewport culling, then
 * provides hit testing over the same geometry. Text editing happens in an
 * HTML overlay (allowed by the architecture) — the renderer skips the title
 * of the node being edited so the overlay doesn't double-paint.
 */
import type { Group, MindNode, Sheet, StructureType, Orientation, Summary, TextRun } from "../core/types";
import { nodeRuns } from "../core/text";
import { createCanvasTextMeasurer, FONT_STACK, IMAGE_GAP, imageResolver, LINE_HEIGHT_FACTOR, MAX_IMAGE_W, measureNode, TEXT_INSET, wrapRunLines, type TextMeasurer } from "../layout/measure";
import { IndexedDbAssetStore, type AssetLevel, type AssetStore } from "../persist/assets";
import { THEMES, type RenderTheme, type ThemeName } from "./theme";
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
  showHidden?: boolean; // export: include collapsed subtrees
}

interface Placed {
  node: MindNode;
  x: number; // top-left in world coords
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/** One asset store for the whole app; overridable per-Renderer in tests. */
const sharedAssetStore: AssetStore = new IndexedDbAssetStore();

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
  private textCache = new Map<string, { canvas: HTMLCanvasElement; w: number; h: number }>();
  private textHits = 0;
  private textMisses = 0;

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
  private assetStore: AssetStore;
  private onRepaint: (() => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    opts: { assetStore?: AssetStore; onRepaint?: () => void } = {}
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.assetStore = opts.assetStore ?? sharedAssetStore;
    this.onRepaint = opts.onRepaint ?? null;
  }

  resize(canvas: HTMLCanvasElement, cssW: number, cssH: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
  }

  // -------------------------------------------------------------------------
  // Placement + culling
  // -------------------------------------------------------------------------

  private placedNodes(state: RenderState): Placed[] {
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
    this.visibleImageNodes = new Set(
      placed.filter((p) => p.visible && !!p.node.style.image).map((p) => p.node.id)
    );
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
        this.drawRelationship(theme, a, b, rel.color ?? theme.selection, rel.lineStyle ?? "dashed", rel.label, rel.bidirectional, state.relSel === rel.id);
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
          (p) => p.visible && !!p.node.style.image && !!this.resolveImage?.(p.node.style.image)
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
    const n = p.node;
    if (n.style.fill) return n.style.fill;
    if (n.type === "central") return theme.rootFill;
    const color = this.branchColor(theme, n, state.sheet);
    return n.type === "subtopic" ? theme.branchSoft[this.branchIndex(n, state.sheet)] : color;
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
    const fill =
      n.style.fill ??
      (n.type === "central"
        ? theme.rootFill
        : n.type === "subtopic"
          ? theme.branchSoft[this.branchIndex(n, state.sheet)]
          : this.branchColor(theme, n, state.sheet));
    return { fill, text: n.style.textColor ?? (n.type === "central" ? theme.rootText : theme.text) };
  }

  private branchColor(theme: RenderTheme, n: MindNode, sheet: Sheet): string {
    const branchRootId = this.branchRoot(n, sheet);
    const branchRoot = sheet.nodes[branchRootId];
    return branchRoot?.style.fill ?? theme.branch[this.branchIndex(n, sheet)];
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

  private drawNode(theme: RenderTheme, p: Placed, state: RenderState): void {
    const ctx = this.ctx;
    const n = p.node;
    const editing = state.editingId === n.id;
    const selected = state.selection.has(n.id);
    const fill = this.nodeFill(theme, p, state);
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

    this.traceShape(ctx, p, n.style.shape ?? "rounded", n.style.cornerRadius ?? 10);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
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
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      const pad = 3;
      ctx.strokeRect(p.x - pad, p.y - pad, p.w + pad * 2, p.h + pad * 2);

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
    if (state.hoverId === n.id && !selected) {
      ctx.strokeStyle = theme.selection;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = opacity * 0.55;
      ctx.strokeRect(p.x - 2, p.y - 2, p.w + 4, p.h + 4);
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

    // image between shape and text (ADR-001 §12); skipped while editing —
    // the HTML overlay owns it, no double-render (same rule as the text).
    const imgH = this.imageH(p);
    if (!editing) {
      this.drawImage(p);
      this.drawText(theme, p, textColor, imgH);
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

  /** Height of the node's image in world units (0 = none), matching measureTopic. */
  private imageH(p: Placed): number {
    const n = p.node;
    if (!n.style.image || !this.resolveImage) return 0;
    const att = this.resolveImage(n.style.image);
    if (!att || att.w <= 0) return 0;
    const imgW = n.style.imageWidth ?? Math.min(att.w, MAX_IMAGE_W);
    return (imgW * att.h) / att.w;
  }

  private drawText(_theme: RenderTheme, p: Placed, color: string, imgH = 0): void {
    const n = p.node;
    const pad = n.style.padding ?? 10;
    const maxW = Math.max(20, p.w - pad * 2 - TEXT_INSET);
    // Resolution bucket: re-render the bitmap only when the zoom crosses a
    // power-of-two boundary; between boundaries pan/zoom just blits.
    const res = Math.max(1, Math.min(4, Math.ceil(this.curScale * this.dpr)));
    const key = this.textCacheKey(n, color, maxW, res);
    let entry = this.textCache.get(key);
    if (entry) this.textHits++;
    if (!entry) {
      this.textMisses++;
      entry = this.renderTextBitmap(n, color, maxW, res);
      this.textCache.set(key, entry);
      if (this.textCache.size > 5000) {
        const first = this.textCache.keys().next().value;
        if (first !== undefined) this.textCache.delete(first);
      }
    }
    const totalH = entry.h;
    // With an image above, the text occupies the space below it and centers
    // inside that area; otherwise it centers in the whole box (as before).
    const startY =
      imgH > 0
        ? p.y + pad + imgH + IMAGE_GAP + Math.max(0, (p.h - pad * 2 - imgH - IMAGE_GAP - totalH) / 2)
        : p.y + p.h / 2 - totalH / 2;
    const startX = p.x + pad;
    if (entry.w > 0 && entry.h > 0) this.ctx.drawImage(entry.canvas, startX, startY, entry.w, entry.h);
  }

  /**
   * Draw the node's image into its reserved rect (cached bitmap), or start a
   * decode. Sync by design: no await inside the paint path.
   */
  private drawImage(p: Placed): void {
    const n = p.node;
    const imageId = n.style.image;
    if (!imageId || !this.resolveImage) return;
    const att = this.resolveImage(imageId);
    if (!att || att.w <= 0) return;
    const imgW = n.style.imageWidth ?? Math.min(att.w, MAX_IMAGE_W);
    const imgH = (imgW * att.h) / att.w;
    // Level by the same zoom bucket schema as the text cache: zoomed out →
    // small (256px), zoomed in → large (1024px). The original is never
    // decoded — the hard 1024px cap of ADR-001 §12 is enforced here.
    const res = Math.max(1, Math.min(4, Math.ceil(this.curScale * this.dpr)));
    const level: AssetLevel = res <= 1 ? "small" : "large";
    const key = `${imageId}@${level}`;

    const entry = this.imageCache.get(key);
    if (entry) {
      // LRU refresh (Map insertion order = recency).
      this.imageCache.delete(key);
      this.imageCache.set(key, entry);
      const x = p.x + (p.w - imgW) / 2;
      const y = p.y + (n.style.padding ?? 10);
      this.ctx.drawImage(entry.bitmap, x, y, imgW, imgH);
      return;
    }
    if (this.imageFailed.has(key)) return; // corrupt/unavailable: not per frame
    if (this.inflight.has(key) || this.inflightCount >= this.MAX_INFLIGHT) return;
    this.startDecode(key, imageId, n.id, level);
  }

  private async startDecode(key: string, assetId: string, nodeId: string, level: AssetLevel): Promise<void> {
    this.inflight.set(key, nodeId);
    this.inflightCount++;
    try {
      const blob = await this.assetStore.get(assetId, level);
      if (!blob) {
        this.imageFailed.add(key);
        return;
      }
      const bitmap = await createImageBitmap(blob);
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

  private drawRelationship(theme: RenderTheme, a: Placed, b: Placed, color: string, style: string, label?: string, bidirectional?: boolean, selected?: boolean): void {
    const ctx = this.ctx;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const c1x = ax + (bx - ax) * 0.35, c1y = ay;
    const c2x = bx - (bx - ax) * 0.35, c2y = by;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.setLineDash(style === "dashed" ? [7, 5] : style === "dotted" ? [2, 4] : []);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    // Arrowheads: at the target, and at the source when bidirectional.
    const arrow = (fromX: number, fromY: number, toX: number, toY: number): void => {
      const ang = Math.atan2(toY - fromY, toX - fromX);
      const len = 9;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(toX - len * Math.cos(ang - 0.42), toY - len * Math.sin(ang - 0.42));
      ctx.lineTo(toX - len * Math.cos(ang + 0.42), toY - len * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
    };
    // tangent at the end of the bezier ≈ direction from c2 to b
    arrow(c2x, c2y, bx, by);
    if (bidirectional) arrow(c1x, c1y, ax, ay);
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
  hitTestResize(state: RenderState, worldX: number, worldY: number): { id: string; side: "left" | "right" } | null {
    const hs = 12; // grab box slightly larger than the drawn 9px handle
    for (const id of state.selection) {
      if (state.editingId === id) continue;
      const rect = this.nodeWorldRect(state, id);
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
      if (a && b) this.drawRelationship(theme, a, b, rel.color ?? theme.selection, rel.lineStyle ?? "dashed", rel.label, rel.bidirectional);
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
