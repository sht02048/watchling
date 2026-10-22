import { clsx } from "clsx";
import { useRef, type ReactNode, type RefObject } from "react";
import { bringToFront } from "@/layout/geometry.ts";
import styles from "./Window.module.css";
import { useDraggable } from "./useDraggable.ts";

export function Window({
  title,
  label,
  className,
  barClassName,
  elementRef,
  boundsRef,
  movable,
  hidden = false,
  onClose,
  children,
}: {
  title: string;
  label: string;
  className?: string | undefined;
  barClassName?: string | undefined;
  elementRef: RefObject<HTMLElement | null>;
  boundsRef: RefObject<HTMLElement | null>;
  movable: boolean;
  hidden?: boolean;
  onClose?: () => void;
  children: ReactNode;
}) {
  const barRef = useRef<HTMLElement>(null);
  useDraggable(elementRef, barRef, boundsRef, {
    enabled: movable,
    canStart: (event) => !(event.target as Element).closest("button"),
  });

  return (
    <section
      ref={elementRef}
      className={clsx(styles.window, className)}
      aria-label={label}
      hidden={hidden}
      onPointerDownCapture={(event) => bringToFront(event.currentTarget)}
    >
      <header ref={barRef} className={clsx(styles.titlebar, barClassName)}>
        <div className={styles.lights}>
          {onClose ? (
            <button
              type="button"
              className={styles.light}
              aria-label={`Close ${title}`}
              onClick={onClose}
            />
          ) : (
            <span className={styles.light} aria-hidden="true" />
          )}
          <span
            className={clsx(styles.light, styles.minimize)}
            aria-hidden="true"
          />
          <span
            className={clsx(styles.light, styles.zoom)}
            aria-hidden="true"
          />
        </div>
        <span className={styles.title}>{title}</span>
      </header>
      <div className={styles.content}>{children}</div>
    </section>
  );
}
