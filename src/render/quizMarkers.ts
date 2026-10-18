import type { Sheet } from "../core/types";

/** If a missed topic is collapsed away, mark its nearest displayed ancestor. */
export function displayedMistakeNodes(sheet: Sheet, displayed: ReadonlySet<string>, sources: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  for (const source of sources) {
    let id: string | null = source;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      if (displayed.has(id)) { result.add(id); break; }
      id = sheet.nodes[id]?.parentId ?? null;
    }
  }
  return result;
}

/** Screen-sized study overlay: a broad red down arrow with rounded corners. */
export function drawQuizMistakeArrow(ctx: CanvasRenderingContext2D, box: { x:number; y:number; w:number }, scale: number): void {
  const x = box.x + box.w / 2, y = box.y - 7 / scale;
  const X = (v:number) => x + v / scale, Y = (v:number) => y + v / scale;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(X(-7),Y(-48)); ctx.lineTo(X(7),Y(-48));
  ctx.quadraticCurveTo(X(10),Y(-48),X(10),Y(-45));
  ctx.lineTo(X(10),Y(-21)); ctx.lineTo(X(17),Y(-21));
  ctx.quadraticCurveTo(X(21),Y(-21),X(18),Y(-17));
  ctx.lineTo(X(2),Y(-1.5)); ctx.quadraticCurveTo(X(0),Y(0),X(-2),Y(-1.5));
  ctx.lineTo(X(-18),Y(-17)); ctx.quadraticCurveTo(X(-21),Y(-21),X(-17),Y(-21));
  ctx.lineTo(X(-10),Y(-21)); ctx.lineTo(X(-10),Y(-45));
  ctx.quadraticCurveTo(X(-10),Y(-48),X(-7),Y(-48)); ctx.closePath();
  ctx.lineWidth=2/scale; ctx.strokeStyle="#ffffff"; ctx.setLineDash([]); ctx.stroke();
  ctx.fillStyle="#d52629"; ctx.fill();
  ctx.restore();
}
