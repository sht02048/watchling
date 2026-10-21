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

export function listPosition(
  pet: Bounds,
  area: Bounds,
  size: { width: number; height: number },
): Point {
  const x = pet.x + pet.width - size.width;
  const above = pet.y - size.height - 8;
  return clampWindow(
    { x, y: above >= area.y ? above : pet.y + pet.height + 8 },
    area,
    size,
  );
}
