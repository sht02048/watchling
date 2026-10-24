import { clsx } from "clsx";
import { useId, type CSSProperties, type RefObject } from "react";
import { rgb } from "@watchling/renderer/pet/color.ts";
import { PALETTE } from "@watchling/renderer/pet/pet-figure.ts";
import {
  stateLabels,
  type SemanticState,
} from "@watchling/shared/ui-contract.ts";
import styles from "./StateStrip.module.css";

const ORDER: readonly SemanticState[] = [
  "idle",
  "working",
  "asking",
  "subagents",
  "waiting",
  "unknown",
];
const MEANING: Record<SemanticState, string> = {
  idle: "Waiting for you",
  working: "Claude is busy",
  asking: "Claude needs you",
  subagents: "Agents still running",
  waiting: "A background task runs",
  unknown: "Signals lost",
};
const HOW: Record<SemanticState, string> = {
  idle: "Shown on load",
  working: "Pick Work on a task",
  asking: "Pick Ask for permission",
  subagents: "Pick Run background agents",
  waiting: "Pick Run a build in the background",
  unknown: "Pick Lose the connection",
};

export function StateStrip({
  current,
  found,
  elementRef,
}: {
  current: SemanticState;
  found: ReadonlySet<SemanticState>;
  elementRef: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  return (
    <section
      ref={elementRef}
      className={styles.states}
      aria-labelledby={titleId}
    >
      <header className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          Peep's states
        </h2>
        <p className={styles.count} aria-live="polite">
          {found.size === ORDER.length
            ? `All ${ORDER.length} found`
            : `${found.size} of ${ORDER.length} found`}
        </p>
      </header>
      <ol className={styles.list}>
        {ORDER.map((state) => {
          const seen = found.has(state);
          return (
            <li
              key={state}
              className={clsx(styles.state, seen && styles.found)}
              aria-current={state === current ? "true" : undefined}
            >
              <span
                className={styles.dot}
                style={{ "--dot": rgb(PALETTE[state][1]) } as CSSProperties}
                aria-hidden="true"
              />
              <span className={styles.label}>{stateLabels[state]}</span>
              <span className={styles.hint}>
                {seen ? MEANING[state] : HOW[state]}
              </span>
              <span className={styles.check} aria-hidden="true">
                ✓
              </span>
              <span className="visually-hidden">
                {state === current
                  ? ", now"
                  : seen
                    ? ", found"
                    : ", not found yet"}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
