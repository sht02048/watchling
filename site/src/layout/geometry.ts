export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const rectOf = (element: HTMLElement): Rect => ({
  x: element.offsetLeft,
  y: element.offsetTop,
  w: element.offsetWidth,
  h: element.offsetHeight,
});

export function relativeRect(element: HTMLElement, origin: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  const base = origin.getBoundingClientRect();
  return {
    x: box.left - base.left,
    y: box.top - base.top,
    w: box.width,
    h: box.height,
  };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function leastCovered<T extends Rect>(
  candidates: T[],
  obstacles: Rect[],
  bounds: HTMLElement,
): T {
  const inside = candidates.filter(
    (rect) =>
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.w <= bounds.clientWidth &&
      rect.y + rect.h <= bounds.clientHeight,
  );
  const pool = inside.length > 0 ? inside : candidates;
  const cost = (rect: Rect) =>
    obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0);
  return pool.reduce((best, rect) => (cost(rect) < cost(best) ? rect : best));
}

export function setBox(
  element: HTMLElement,
  x: number,
  y: number,
  w?: number,
  h?: number,
): void {
  if (w !== undefined) element.style.width = `${Math.round(w)}px`;
  if (h !== undefined) element.style.height = `${Math.round(h)}px`;
  element.style.left = `${Math.round(x)}px`;
  element.style.top = `${Math.round(y)}px`;
}

export function moveWithin(
  element: HTMLElement,
  bounds: HTMLElement,
  x: number,
  y: number,
): void {
  const maxX = Math.max(0, bounds.clientWidth - element.offsetWidth);
  const maxY = Math.max(0, bounds.clientHeight - element.offsetHeight);
  element.style.left = `${Math.round(clamp(x, 0, maxX))}px`;
  element.style.top = `${Math.round(clamp(y, 0, maxY))}px`;
}

export function keepWithin(element: HTMLElement, bounds: HTMLElement): void {
  moveWithin(element, bounds, element.offsetLeft, element.offsetTop);
}

let top = 10;

export function bringToFront(element: HTMLElement): void {
  element.style.zIndex = String(++top);
}
