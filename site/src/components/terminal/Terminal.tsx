import { useLayoutEffect, useRef, type RefObject } from "react";
import type { SemanticState } from "@watchling/shared/ui-contract.ts";
import type { Prompt, Terminal as TerminalState } from "@/demo/demo.ts";
import { Window } from "@/components/window/Window.tsx";
import styles from "./Terminal.module.css";
import { TerminalLine } from "./TerminalLine.tsx";
import { TerminalPrompt, type PromptActions } from "./TerminalPrompt.tsx";
import { useAnimatedHeight } from "./useAnimatedHeight.ts";

function footerText(kind: Prompt["kind"], coarse: boolean): string {
  if (kind === "busy") return "? for shortcuts";
  if (coarse) return "Tap to choose";
  if (kind === "menu") return "↑↓ to move · Enter to choose";
  if (kind === "permission") return "←→ to move · Enter to choose";
  return "Enter to choose";
}

function Terminal({
  terminal,
  found,
  menuOpen,
  actions,
}: {
  terminal: TerminalState;
  found: ReadonlySet<SemanticState>;
  menuOpen: boolean;
  actions: PromptActions;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [terminal.lines.length, terminal.prompt]);
  useAnimatedHeight(promptRef, terminal.prompt, () => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });

  return (
    <div ref={rootRef} className={styles.term}>
      <div ref={scrollRef} className={styles.scroll}>
        <div className={styles.welcome}>
          <div>
            <span className={styles.spark}>✻</span> Welcome to{" "}
            <b>Claude Code</b>
          </div>
          <div className={styles.muted}>cwd: ~/code/{terminal.project}</div>
        </div>
        <ol className={styles.lines} aria-label="Output" aria-live="polite">
          {terminal.lines.map((line, index) => (
            <TerminalLine key={index} line={line} />
          ))}
        </ol>
      </div>
      <div ref={promptRef} className={styles.prompt}>
        <TerminalPrompt
          prompt={terminal.prompt}
          found={found}
          menuOpen={menuOpen}
          actions={actions}
          rootRef={rootRef}
        />
      </div>
      <div className={styles.footer}>
        {footerText(
          terminal.prompt.kind,
          matchMedia("(pointer: coarse)").matches,
        )}
      </div>
    </div>
  );
}

export function TerminalWindow({
  elementRef,
  boundsRef,
  movable,
  ...props
}: {
  elementRef: RefObject<HTMLElement | null>;
  boundsRef: RefObject<HTMLElement | null>;
  movable: boolean;
  terminal: TerminalState;
  found: ReadonlySet<SemanticState>;
  menuOpen: boolean;
  actions: PromptActions;
}) {
  return (
    <Window
      title={`${props.terminal.project} — claude`}
      label="Terminal"
      className={styles.window}
      elementRef={elementRef}
      boundsRef={boundsRef}
      movable={movable}
    >
      <Terminal {...props} />
    </Window>
  );
}
