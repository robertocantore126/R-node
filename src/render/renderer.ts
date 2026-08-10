/**
 * Canvas renderer — one <canvas>, no DOM/SVG nodes per topic.
 *
 * Paints relationships, connectors and nodes with viewport culling, then
 * provides hit testing over the same geometry. Text editing happens in an
 * HTML overlay (allowed by the architecture) — the renderer skips the title
 * of the node being edited so the overlay doesn't double-paint.
 */
import type { MindNode, Sheet, StructureType, Orientation } from "../core/types";
import { nodeRuns } from "../core/text";
import { createCanvasTextMeasurer, LINE_HEIGHT_FACTOR, measureNode, TEXT_INSET, wrapRunLines, type TextMeasurer } from "../layout/measure";
import { THEMES, type RenderTheme, type ThemeName } from "./theme";
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

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
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

    const add = (n: MindNode): void => {
      const m = measureNode(n, this.measurer);
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

    const placed = this.placedNodes(state);
    const byId = new Map(placed.map((p) => [p.node.id, p]));

    // 1) relationships
    for (const rel of state.sheet.relationships) {
      const a = byId.get(rel.fromId);
      const b = byId.get(rel.toId);
      if (a && b) this.drawRelationship(theme, a, b, rel.color ?? theme.selection, rel.lineStyle ?? "dashed", rel.label);
    }

    // 2) connectors
    for (const p of placed) {
      if (!p.visible) continue;
      if (p.node.parentId) {
        const parent = byId.get(p.node.parentId);
        if (parent && parent.visible)
          this.drawConnector(
            parent,
            p,
            state.sheet.structure.structureType,
            state.sheet.structure.orientation,
            this.branchColor(theme, p.node, state.sheet)
          );
      }
    }

    // 3) nodes
    for (const p of placed) {
      if (!p.visible) continue;
      this.drawNode(theme, p, state);
    }

    // 4) drop indicator
    if (state.drop && state.drop.mode !== "none") {
      const target = byId.get(state.drop.nodeId);
      if (target) this.drawDropIndicator(theme, target, state.drop.mode);
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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

    // text (rich, bitmap-cached). The node being edited is skipped: the
    // HTML overlay owns it, no ghosting.
    if (!editing) this.drawText(theme, p, textColor);

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

  private drawText(_theme: RenderTheme, p: Placed, color: string): void {
    const n = p.node;
    const pad = n.style.padding ?? 10;
    const maxW = Math.max(20, p.w - pad * 2 - TEXT_INSET);
    // Resolution bucket: re-render the bitmap only when the zoom crosses a
    // power-of-two boundary; between boundaries pan/zoom just blits.
    const res = Math.max(1, Math.min(4, Math.ceil(this.curScale * this.dpr)));
    const key = this.textCacheKey(n, color, maxW, res);
    let entry = this.textCache.get(key);
    if (!entry) {
      entry = this.renderTextBitmap(n, color, maxW, res);
      this.textCache.set(key, entry);
      if (this.textCache.size > 5000) {
        const first = this.textCache.keys().next().value;
        if (first !== undefined) this.textCache.delete(first);
      }
    }
    const totalH = entry.h;
    const startY = p.y + p.h / 2 - totalH / 2;
    const startX = p.x + pad;
    if (entry.w > 0 && entry.h > 0) this.ctx.drawImage(entry.canvas, startX, startY, entry.w, entry.h);
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
      totalH += lh + (line.gapBefore ? lh * 0.6 : 0);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(maxW * res));
    canvas.height = Math.max(1, Math.ceil(totalH * res));
    const bctx = canvas.getContext("2d");
    if (!bctx) return { canvas, w: maxW, h: totalH };
    bctx.scale(res, res);
    bctx.textBaseline = "middle";

    const strike = (n.style.strikethrough ?? false);
    let yCursor = 0;

    for (const line of lines) {
      const lh = line.height ?? size * LINE_HEIGHT_FACTOR;
      if (line.gapBefore) yCursor += lh * 0.6;
      const y = yCursor + lh / 2;
      // left-aligned: honor the bullet hanging indent; centered: center the line
      let x = n.style.align === "left" ? (line.indent ?? 0) : (maxW - line.width) / 2;
      for (const seg of line.segments) {
        const runSize = seg.run.fontSize ?? size;
        const bold = (seg.run.bold ?? false) || (n.style.fontWeight ?? 400) >= 700;
        const italic = (seg.run.italic ?? false) || (n.style.italic ?? false);
        const family = n.style.fontFamily ?? "system-ui, -apple-system, sans-serif";
        bctx.font = `${italic ? "italic " : ""}${bold ? 700 : n.style.fontWeight ?? 400} ${runSize}px ${family}`;
        bctx.fillStyle = seg.run.color ?? color;
        const w = this.measurer.measure(seg.text, { fontSize: runSize, fontFamily: family, fontWeight: bold ? 700 : n.style.fontWeight ?? 400, italic }).width;
        bctx.fillText(seg.text, x, y);
        const underline = (seg.run.underline ?? false) || (n.style.underline ?? false);
        if (underline || strike) {
          bctx.strokeStyle = seg.run.color ?? color;
          bctx.lineWidth = 1;
          bctx.beginPath();
          const yy = underline ? y + runSize * 0.55 : y;
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

  private drawRelationship(theme: RenderTheme, a: Placed, b: Placed, color: string, style: string, label?: string): void {
    const ctx = this.ctx;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(style === "dashed" ? [7, 5] : style === "dotted" ? [2, 4] : []);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.bezierCurveTo(ax + (bx - ax) * 0.35, ay, bx - (bx - ax) * 0.35, by, bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
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

  nodeWorldRect(state: RenderState, id: string): { x: number; y: number; w: number; h: number } | null {
    const p = this.placedNodes(state).find((p) => p.node.id === id);
    if (!p) return null;
    return { x: p.x, y: p.y, w: p.w, h: p.h };
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
      if (a && b) this.drawRelationship(theme, a, b, rel.color ?? theme.selection, rel.lineStyle ?? "dashed", rel.label);
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
  }
}
