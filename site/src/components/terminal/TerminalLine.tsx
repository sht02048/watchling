import { clsx } from "clsx";
import type { CSSProperties } from "react";
import { rgb } from "@watchling/renderer/pet/color.ts";
import { PALETTE } from "@watchling/renderer/pet/pet-figure.ts";
import type { Line } from "@/demo/demo.ts";
import { Glyph } from "@/components/icons/Glyph.tsx";
import styles from "./Terminal.module.css";

export function TerminalLine({ line }: { line: Line }) {
  switch (line.kind) {
    case "user":
      return (
        <li className={clsx(styles.line, styles.user)}>
          <span className={styles.mark}>&gt;</span>
          <span>{line.text}</span>
        </li>
      );
    case "tool": {
      const open = line.text.indexOf("(");
      return (
        <li className={clsx(styles.line, styles.tool)}>
          <span className={styles.mark}>⏺</span>
          <b>{line.text.slice(0, open)}</b>
          <span>{line.text.slice(open)}</span>
        </li>
      );
    }
    case "result":
      return (
        <li className={clsx(styles.line, styles.result)}>
          <span className={styles.mark}>⎿</span>
          <span>{line.text}</span>
        </li>
      );
    case "text":
    case "done":
      return (
        <li className={clsx(styles.line, styles.said)}>
          <span className={styles.mark}>⏺</span>
          <span>{line.text}</span>
        </li>
      );
    case "peep":
      return (
        <li
          className={clsx(styles.line, styles.peepLine)}
          style={
            {
              "--peep-ink": rgb(PALETTE[line.state ?? "idle"][0]),
            } as CSSProperties
          }
        >
          <Glyph name="peep" className={clsx(styles.mark, styles.peepMark)} />
          <span className={styles.peepLabel}>
            <b className={styles.peepName}>Peep</b> ·
          </span>
          <span>{line.text}</span>
        </li>
      );
  }
}
