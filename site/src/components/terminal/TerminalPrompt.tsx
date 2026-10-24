import { clsx } from "clsx";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  stateLabels,
  type SemanticState,
} from "@watchling/shared/ui-contract.ts";
import { choices, type Choice, type Prompt } from "@/demo/demo.ts";
import styles from "./Terminal.module.css";

export interface PromptActions {
  choose: (choice: Choice) => void;
  answer: (allow: boolean) => void;
  finishAgents: () => void;
  finishBuild: () => void;
  finishTask: () => void;
  reconnect: () => void;
}

interface Control {
  key: string;
  className: string | undefined;
  ariaLabel?: string;
  content: ReactNode;
  run: () => void;
}

const SINGLE = {
  reconnect: {
    title: "Peep lost the signal.",
    label: "Reconnect to Claude Code",
    status: false,
  },
  agents: {
    title: "⧗ Background agents running",
    label: "Finish now",
    status: true,
  },
  build: {
    title: "◷ Background task running",
    label: "Finish build",
    status: true,
  },
  task: { title: "✻ Working…", label: "Finish task", status: true },
} as const;

const Caret = () => <span className={styles.caret}>❯</span>;

function controlsFor(
  prompt: Prompt,
  found: ReadonlySet<SemanticState>,
  actions: PromptActions,
): Control[] {
  switch (prompt.kind) {
    case "menu":
      return choices.map((choice, index) => ({
        key: choice.id,
        className: styles.option,
        ariaLabel: `${index + 1}. ${choice.label}. Shows ${stateLabels[choice.state]}${found.has(choice.state) ? ", found" : ""}`,
        content: (
          <>
            <Caret />
            <span>{index + 1}.</span>
            <span className={styles.label}>{choice.label}</span>
          </>
        ),
        run: () => actions.choose(choice.id),
      }));
    case "permission":
      return (
        [
          ["Yes", true],
          ["No", false],
        ] as const
      ).map(([label, allow]) => ({
        key: label,
        className: styles.choice,
        ariaLabel: `${label}, ${allow ? "allow" : "deny"} ${prompt.tool}: ${prompt.command}`,
        content: label,
        run: () => actions.answer(allow),
      }));
    case "reconnect":
    case "agents":
    case "build":
    case "task": {
      const run = {
        reconnect: actions.reconnect,
        agents: actions.finishAgents,
        build: actions.finishBuild,
        task: actions.finishTask,
      }[prompt.kind];
      return [
        {
          key: prompt.kind,
          className: clsx(styles.option, styles.single),
          content: (
            <>
              <Caret />
              <span className={styles.label}>{SINGLE[prompt.kind].label}</span>
            </>
          ),
          run,
        },
      ];
    }
    case "busy":
      return [];
  }
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    target.isContentEditable ||
    target.closest('[role="menu"]') !== null);

export function TerminalPrompt({
  prompt,
  found,
  menuOpen,
  actions,
  rootRef,
}: {
  prompt: Prompt;
  found: ReadonlySet<SemanticState>;
  menuOpen: boolean;
  actions: PromptActions;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const kind = prompt.kind;
  const controls = controlsFor(prompt, found, actions);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const wantsFocus = useRef(false);
  const [active, setActive] = useState(0);
  const [menuActive, setMenuActive] = useState(0);
  const [shownKind, setShownKind] = useState(kind);
  const focusInside = () =>
    rootRef.current?.contains(document.activeElement) ?? false;

  if (shownKind !== kind) {
    // Checked while the previous controls are still mounted; after the commit the focused one is gone.
    wantsFocus.current ||= focusInside();
    setShownKind(kind);
    setActive(kind === "menu" ? menuActive : 0);
  }

  const select = (index: number, focus: boolean) => {
    if (controls.length === 0) return;
    const next = (index + controls.length) % controls.length;
    setActive(next);
    if (kind === "menu") setMenuActive(next);
    if (focus) buttons.current[next]?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!wantsFocus.current || controls.length === 0) return;
    buttons.current[active]?.focus({ preventScroll: true });
    wantsFocus.current = false;
  }, [kind]);

  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    const horizontal = kind === "permission";
    onKey.current = (event) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        controls.length === 0 ||
        typing(event.target) ||
        menuOpen
      )
        return;
      const focused = document.activeElement;
      const inside =
        focused === null || focused === document.body || focusInside();
      const step =
        event.key === "ArrowDown" || (horizontal && event.key === "ArrowRight")
          ? 1
          : event.key === "ArrowUp" || (horizontal && event.key === "ArrowLeft")
            ? -1
            : 0;
      if (step !== 0) select(active + step, inside);
      else if (event.key === "Enter" && inside && !event.repeat)
        buttons.current[active]?.click();
      else return;
      event.preventDefault();
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const button = (control: Control, index: number) => (
    <button
      key={control.key}
      ref={(node) => {
        buttons.current[index] = node;
        if (!node) return;
        // React drops pointerenter for a button that appears under a still cursor.
        const enter = () => select(index, focusInside());
        node.addEventListener("pointerenter", enter);
        return () => {
          node.removeEventListener("pointerenter", enter);
          buttons.current[index] = null;
        };
      }}
      type="button"
      className={clsx(control.className, index === active && styles.active)}
      tabIndex={index === active ? 0 : -1}
      aria-label={control.ariaLabel}
      onClick={() => {
        wantsFocus.current ||= focusInside();
        control.run();
      }}
      onFocus={() => select(index, false)}
    >
      {control.content}
    </button>
  );

  switch (prompt.kind) {
    case "menu":
      return (
        <div className={styles.menu} role="group" aria-labelledby={titleId}>
          <div id={titleId} className={styles.menuTitle}>
            What should Claude do?
          </div>
          <div className={styles.menuList}>{controls.map(button)}</div>
        </div>
      );
    case "permission":
      return (
        <div
          className={styles.permission}
          role="group"
          aria-label="Permission request"
        >
          <div className={styles.ask}>
            Allow {prompt.tool}: {prompt.command}?
          </div>
          <div className={styles.muted}>Run the test suite</div>
          <div className={styles.choices}>{controls.map(button)}</div>
        </div>
      );
    case "reconnect":
    case "agents":
    case "build":
    case "task": {
      const { title, status } = SINGLE[prompt.kind];
      return (
        <div className={styles.menu} role="group" aria-label={title}>
          <div className={clsx(styles.menuTitle, status && styles.status)}>
            {title}
          </div>
          {controls.map(button)}
        </div>
      );
    }
    case "busy":
      return (
        <>
          <div className={styles.status}>✻ Working… (esc to interrupt)</div>
          <div className={styles.input} aria-hidden="true">
            <span>&gt;</span>
            <span className={styles.cursor} />
          </div>
        </>
      );
  }
}
