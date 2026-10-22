import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { SemanticState } from "@watchling/shared/ui-contract.ts";
import { Dock } from "@/components/dock/Dock.tsx";
import { Headline } from "@/components/headline/Headline.tsx";
import { MenuBar } from "@/components/menubar/MenuBar.tsx";
import { Peep } from "@/components/peep/Peep.tsx";
import { SessionsWindow } from "@/components/sessions/SessionsWindow.tsx";
import { StateStrip } from "@/components/states/StateStrip.tsx";
import { TerminalWindow } from "@/components/terminal/Terminal.tsx";
import type { Config } from "@/config/config.ts";
import type { Demo } from "@/demo/demo.ts";
import {
  layoutDesktop,
  placeSessions,
  type DesktopParts,
} from "@/layout/desktop-layout.ts";
import { bringToFront, keepWithin } from "@/layout/geometry.ts";
import styles from "./Desktop.module.css";

export function Desktop({
  demo,
  config,
  compact,
  found,
}: {
  demo: Demo;
  config: Config;
  compact: boolean;
  found: ReadonlySet<SemanticState>;
}) {
  const snapshot = demo.snapshot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessions, setSessions] = useState({ open: false, shown: 0 });
  const desktopRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  const headlineRef = useRef<HTMLElement>(null);
  const statesRef = useRef<HTMLElement>(null);
  const peepRef = useRef<HTMLButtonElement>(null);
  const terminalRef = useRef<HTMLElement>(null);
  const sessionsRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const appButtonRef = useRef<HTMLButtonElement>(null);

  const parts = (): DesktopParts | null => {
    const desktop = desktopRef.current;
    const screen = screenRef.current;
    const headline = headlineRef.current;
    const states = statesRef.current;
    const peep = peepRef.current;
    const terminal = terminalRef.current;
    const sessions = sessionsRef.current;
    const dock = dockRef.current;
    if (
      !desktop ||
      !screen ||
      !headline ||
      !states ||
      !peep ||
      !terminal ||
      !sessions ||
      !dock
    )
      return null;
    return {
      desktop,
      screen,
      headline,
      states,
      peep,
      terminal,
      sessions,
      dock,
    };
  };

  const showSessions = (open: boolean) =>
    setSessions((current) => ({
      open,
      shown: open ? current.shown + 1 : current.shown,
    }));

  useLayoutEffect(() => {
    if (compact) {
      desktopRef.current?.style.setProperty(
        "--peep-size",
        `${config.peepSize}px`,
      );
      return;
    }
    const all = parts();
    if (!all) return;
    layoutDesktop(all, config.peepSize);
    const onResize = () => {
      layoutDesktop(all, config.peepSize);
      keepWithin(all.sessions, all.screen);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [compact, config.peepSize]);

  useLayoutEffect(() => {
    if (!sessions.open || compact) return;
    const all = parts();
    if (all) placeSessions(all);
  }, [sessions.shown, compact]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuOpen) {
        setMenuOpen(false);
        appButtonRef.current?.focus();
      } else if (sessions.open) showSessions(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, sessions.open]);

  return (
    <div
      ref={desktopRef}
      className={styles.desktop}
      data-mode={config.mode}
      data-state={snapshot.state}
      style={{ "--hue": String(config.wallpaperHue) } as CSSProperties}
    >
      <MenuBar
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        appButtonRef={appButtonRef}
        connected={demo.connected}
        onToggleConnected={() => demo.setConnected(!demo.connected)}
        sessionsOpen={sessions.open}
        onShowSessions={() => showSessions(true)}
        onToggleSessions={() => showSessions(!sessions.open)}
      />
      <main ref={screenRef} className={styles.screen}>
        <Headline elementRef={headlineRef} />
        <TerminalWindow
          elementRef={terminalRef}
          boundsRef={screenRef}
          movable={!compact}
          terminal={demo.terminal}
          found={found}
          menuOpen={menuOpen}
          actions={{
            choose: demo.choose,
            answer: demo.answer,
            finishAgents: demo.finishAgents,
            finishTask: demo.finishTask,
            reconnect: () => demo.setConnected(true),
          }}
        />
        <Peep
          state={snapshot.state}
          companions={snapshot.companions}
          elementRef={peepRef}
          boundsRef={screenRef}
          movable={!compact}
          onToggle={() => showSessions(!sessions.open)}
        />
        <StateStrip
          current={snapshot.state}
          found={found}
          elementRef={statesRef}
        />
        <SessionsWindow
          snapshot={snapshot}
          open={sessions.open}
          onClose={() => showSessions(false)}
          elementRef={sessionsRef}
          boundsRef={screenRef}
          movable={!compact}
        />
      </main>
      <Dock
        elementRef={dockRef}
        onShowTerminal={() => {
          if (terminalRef.current) bringToFront(terminalRef.current);
        }}
      />
    </div>
  );
}
