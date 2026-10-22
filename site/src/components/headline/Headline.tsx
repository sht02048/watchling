import type { RefObject } from "react";
import styles from "./Headline.module.css";

export function Headline({
  elementRef,
}: {
  elementRef: RefObject<HTMLElement | null>;
}) {
  return (
    <header ref={elementRef} className={styles.headline}>
      <h1 className={styles.title}>A desktop pet for Claude Code</h1>
      <p className={styles.sub}>
        Peep sits on your Mac, watches your Claude Code sessions, and speaks up
        when Claude needs you.
      </p>
    </header>
  );
}
