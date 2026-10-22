import { clsx } from "clsx";
import type { RefObject } from "react";
import iconUrl from "@resources/icon.svg?url";
import { DOWNLOAD, REPO } from "@/app/links.ts";
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
        className={clsx(styles.app, styles.tile)}
        aria-label="Show terminal"
        onClick={onShowTerminal}
      >
        <Glyph name="terminal" className={styles.tileIcon} />
        <span className={styles.label}>Terminal</span>
      </button>
      <a className={styles.app} href={DOWNLOAD} aria-label="Download Watchling">
        <img src={iconUrl} alt="" width={52} height={52} draggable={false} />
        <span className={styles.label}>Download Watchling</span>
      </a>
      <a
        className={clsx(styles.app, styles.tile)}
        href={REPO}
        aria-label="Watchling on GitHub"
      >
        <Glyph name="github" className={styles.tileIcon} />
        <span className={styles.label}>GitHub</span>
      </a>
    </nav>
  );
}
