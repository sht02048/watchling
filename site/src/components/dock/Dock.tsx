import { clsx } from "clsx";
import type { RefObject } from "react";
import iconUrl from "@resources/icon.svg?url";
import { RELEASES } from "@/app/links.ts";
import { Glyph } from "@/components/icons/Glyph.tsx";
import styles from "./Dock.module.css";

export function Dock({
  elementRef,
  onShowTerminal,
}: {
  elementRef: RefObject<HTMLElement | null>;
  onShowTerminal: () => void;
}) {
  return (
    <nav ref={elementRef} className={styles.dock} aria-label="Dock">
      <button
        type="button"
        className={clsx(styles.app, styles.terminal)}
        aria-label="Show terminal"
        onClick={onShowTerminal}
      >
        <Glyph name="terminal" className={styles.terminalIcon} />
        <span className={styles.label}>Terminal</span>
      </button>
      <a className={styles.app} href={RELEASES} aria-label="Download Watchling">
        <img src={iconUrl} alt="" width={52} height={52} draggable={false} />
        <span className={styles.label}>Download Watchling</span>
      </a>
    </nav>
  );
}
