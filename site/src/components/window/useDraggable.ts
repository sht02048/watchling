import { useEffect, useRef, type RefObject } from "react";
import { moveWithin } from "@/layout/geometry.ts";

interface DragOptions {
  enabled: boolean;
  canStart?: (event: PointerEvent) => boolean;
  onClick?: () => void;
}

export function useDraggable(
  element: RefObject<HTMLElement | null>,
  handle: RefObject<HTMLElement | null>,
  bounds: RefObject<HTMLElement | null>,
  options: DragOptions,
): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const target = element.current;
    const grip = handle.current;
    if (!target || !grip) return;
    let drag:
      | {
          id: number;
          x: number;
          y: number;
          left: number;
          top: number;
          moved: boolean;
        }
      | undefined;

    const down = (event: PointerEvent) => {
      const { enabled, canStart } = latest.current;
      if (event.button !== 0 || !enabled) return;
      if (canStart && !canStart(event)) return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: target.offsetLeft,
        top: target.offsetTop,
        moved: false,
      };
      grip.setPointerCapture(event.pointerId);
      target.dataset.dragging = "";
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId || !bounds.current) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      moveWithin(target, bounds.current, drag.left + dx, drag.top + dy);
    };
    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (!drag || drag.id !== event.pointerId) return;
      const click = !drag.moved && !cancelled;
      drag = undefined;
      delete target.dataset.dragging;
      if (grip.hasPointerCapture(event.pointerId))
        grip.releasePointerCapture(event.pointerId);
      if (click) latest.current.onClick?.();
    };
    const up = (event: PointerEvent) => finish(event, false);
    const cancel = (event: PointerEvent) => finish(event, true);

    grip.addEventListener("pointerdown", down);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", cancel);
    return () => {
      grip.removeEventListener("pointerdown", down);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", cancel);
    };
  }, [element, handle, bounds]);
}
