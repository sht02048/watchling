import type { Point } from "../shared/ui-contract.ts";

export interface Bounds extends Point {
  width: number;
  height: number;
}

export function clampWindow(
  position: Point,
  area: Bounds,
  size: { width: number; height: number },
): Point {
  return {
    x: Math.round(
      Math.max(
        area.x,
        Math.min(position.x, area.x + Math.max(0, area.width - size.width)),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(position.y, area.y + Math.max(0, area.height - size.height)),
      ),
    ),
  };
}

export function contains(area: Bounds, point: Point): boolean {
  return (
    point.x >= area.x &&
    point.x <= area.x + area.width &&
    point.y >= area.y &&
    point.y <= area.y + area.height
  );
}

export function expand(area: Bounds, inset: number): Bounds {
  return {
    x: area.x - inset,
    y: area.y - inset,
    width: area.width + inset * 2,
    height: area.height + inset * 2,
  };
}

// pet-figure draws Peep around 52% of the window height, about 31% of the
// side across including its spikes; the rest of the window is transparent.
function petBody(pet: Bounds): Bounds {
  const radius = Math.min(pet.width, pet.height) * 0.31;
  const x = pet.x + pet.width / 2;
  const y = pet.y + pet.height * 0.52;
  return {
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2,
  };
}

export function listPosition(
  pet: Bounds,
  area: Bounds,
  size: { width: number; height: number },
): Point {
  const body = petBody(pet);
  const gap = 10;
  const towardsLeft = body.x + body.width / 2 >= area.x + area.width / 2;
  const x = towardsLeft ? body.x + body.width - size.width : body.x;
  const above = body.y - gap - size.height;
  return clampWindow(
    { x, y: above >= area.y ? above : body.y + body.height + gap },
    area,
    size,
  );
}
