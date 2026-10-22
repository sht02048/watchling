import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useAnimatedHeight(
  ref: RefObject<HTMLElement | null>,
  trigger: unknown,
  onFrame: () => void,
): void {
  const settled = useRef<number>(undefined);
  const latest = useRef(onFrame);
  useEffect(() => {
    latest.current = onFrame;
  });

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (box.getAnimations().length === 0) settled.current = box.offsetHeight;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref]);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const running = box.getAnimations();
    const from = running.length > 0 ? box.offsetHeight : settled.current;
    for (const animation of running) animation.cancel();
    const to = box.offsetHeight;
    settled.current = to;
    if (from === undefined || from === to || reducedMotion()) return;

    const animation = box.animate(
      { height: [`${from}px`, `${to}px`] },
      { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
    );
    let frame = requestAnimationFrame(function tick() {
      latest.current();
      frame = requestAnimationFrame(tick);
    });
    const stop = () => cancelAnimationFrame(frame);
    animation.finished.then(stop, stop);
  }, [trigger]);
}
