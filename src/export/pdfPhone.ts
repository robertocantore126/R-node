/** Readable windows into the SAME world coordinates; never reflow any topic. */
export interface PhoneRect { x:number; y:number; w:number; h:number }
export interface PhonePage { left:number; top:number; width:number; height:number; col:number; row:number }

export function phoneMapPages(bounds: PhoneRect, nodes: PhoneRect[], width: number, height: number, overlap = 32): PhonePage[] {
  if (![bounds.x,bounds.y,bounds.w,bounds.h,width,height,overlap].every(Number.isFinite) || bounds.w<=0 || bounds.h<=0 || width<=overlap || height<=overlap || overlap<0) throw new Error("Invalid phone PDF dimensions");
  const cols=Math.max(1,Math.ceil((bounds.w-width)/(width-overlap))+1);
  const rows=Math.max(1,Math.ceil((bounds.h-height)/(height-overlap))+1);
  if (cols*rows>100000) throw new Error("Map is too large for phone PDF pages");
  const pages: PhonePage[]=[];
  for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
    const left=bounds.x+col*(width-overlap),top=bounds.y+row*(height-overlap);
    if(nodes.some(n=>n.x<left+width && n.x+n.w>left && n.y<top+height && n.y+n.h>top)) pages.push({left,top,width,height,col,row});
  }
  if(pages.length>5000) throw new Error("Map needs too many phone PDF pages");
  return pages;
}
