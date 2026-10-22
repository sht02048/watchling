let top = 10;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function bringToFront(element: HTMLElement): void {
  element.style.zIndex = String(++top);
}

export function moveWithin(
  element: HTMLElement,
  screen: HTMLElement,
  x: number,
  y: number,
): void {
  const maxX = Math.max(0, screen.clientWidth - element.offsetWidth);
  const maxY = Math.max(0, screen.clientHeight - element.offsetHeight);
  element.style.left = `${Math.round(Math.min(Math.max(x, 0), maxX))}px`;
  element.style.top = `${Math.round(Math.min(Math.max(y, 0), maxY))}px`;
}

export function keepWithin(element: HTMLElement, screen: HTMLElement): void {
  moveWithin(element, screen, element.offsetLeft, element.offsetTop);
}

export function draggable(
  element: HTMLElement,
  handle: HTMLElement,
  screen: HTMLElement,
  options: {
    enabled: () => boolean;
    canStart?: (event: PointerEvent) => boolean;
    onMove?: () => void;
    onClick?: () => void;
  },
): void {
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
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !options.enabled()) return;
    if (options.canStart && !options.canStart(event)) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: element.offsetLeft,
      top: element.offsetTop,
      moved: false,
    };
    handle.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    moveWithin(element, screen, drag.left + dx, drag.top + dy);
    options.onMove?.();
  });
  const finish = (event: PointerEvent, cancelled: boolean) => {
    if (!drag || drag.id !== event.pointerId) return;
    const click = !drag.moved && !cancelled;
    drag = undefined;
    element.classList.remove("dragging");
    if (handle.hasPointerCapture(event.pointerId))
      handle.releasePointerCapture(event.pointerId);
    if (click) options.onClick?.();
  };
  handle.addEventListener("pointerup", (event) => finish(event, false));
  handle.addEventListener("pointercancel", (event) => finish(event, true));
}

export function createWindow(options: {
  title: string;
  label: string;
  className: string;
  onClose?: () => void;
}): { element: HTMLElement; bar: HTMLElement; content: HTMLElement } {
  const element = el("section", `window ${options.className}`);
  element.setAttribute("aria-label", options.label);
  const bar = el("header", "titlebar");
  const lights = el("div", "lights");
  for (const color of ["close", "minimize", "zoom"]) {
    if (color === "close" && options.onClose) {
      const close = el("button", "light close");
      close.type = "button";
      close.setAttribute("aria-label", `Close ${options.title}`);
      close.addEventListener("click", options.onClose);
      lights.append(close);
    } else {
      const light = el("span", `light ${color}`);
      light.setAttribute("aria-hidden", "true");
      lights.append(light);
    }
  }
  bar.append(lights, el("span", "title", options.title));
  const content = el("div", "content");
  element.append(bar, content);
  element.addEventListener("pointerdown", () => bringToFront(element), true);
  return { element, bar, content };
}
