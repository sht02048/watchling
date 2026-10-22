import { clsx } from "clsx";
import { useEffect, useRef, useState, type RefObject } from "react";
import { RELEASES } from "@/app/links.ts";
import { Glyph } from "@/components/icons/Glyph.tsx";
import styles from "./MenuBar.module.css";

const INERT_MENUS = ["File", "Edit", "View", "Window", "Help"];

function clockText(date: Date): string {
  const day = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day}  ${time}`;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time
      className={clsx(styles.item, styles.clock)}
      dateTime={now.toISOString()}
    >
      {clockText(now)}
    </time>
  );
}

function AppMenu({
  open,
  onOpenChange,
  buttonRef,
  connected,
  onToggleConnected,
  onShowSessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  connected: boolean;
  onToggleConnected: () => void;
  onShowSessions: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className={styles.appMenu}>
      <button
        ref={buttonRef}
        type="button"
        className={clsx(styles.item, styles.strong, open && styles.open)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        Watchling
      </button>
      <div
        className={styles.dropdown}
        role="menu"
        aria-label="Watchling"
        hidden={!open}
      >
        <button
          type="button"
          className={styles.dropdownItem}
          role="menuitemcheckbox"
          aria-checked={connected}
          onClick={() => {
            onToggleConnected();
            onOpenChange(false);
          }}
        >
          <span className={styles.tick}>✓</span>
          Connected to Claude Code
        </button>
        <button
          type="button"
          className={styles.dropdownItem}
          role="menuitem"
          onClick={() => {
            onShowSessions();
            onOpenChange(false);
          }}
        >
          Show Sessions
        </button>
        <div className={styles.separator} role="separator" />
        <a className={styles.dropdownItem} href={RELEASES} role="menuitem">
          Download Watchling…
        </a>
      </div>
    </div>
  );
}

export function MenuBar({
  menuOpen,
  onMenuOpenChange,
  appButtonRef,
  connected,
  onToggleConnected,
  sessionsOpen,
  onShowSessions,
  onToggleSessions,
}: {
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  appButtonRef: RefObject<HTMLButtonElement | null>;
  connected: boolean;
  onToggleConnected: () => void;
  sessionsOpen: boolean;
  onShowSessions: () => void;
  onToggleSessions: () => void;
}) {
  return (
    <header className={styles.menubar}>
      <div className={styles.side}>
        <Glyph name="blob" className={styles.glyph} />
        <AppMenu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          buttonRef={appButtonRef}
          connected={connected}
          onToggleConnected={onToggleConnected}
          onShowSessions={onShowSessions}
        />
        {INERT_MENUS.map((label) => (
          <span key={label} className={clsx(styles.item, styles.inert)}>
            {label}
          </span>
        ))}
      </div>
      <div className={styles.side}>
        <button
          type="button"
          className={styles.item}
          aria-label="Watchling sessions"
          aria-expanded={sessionsOpen}
          onClick={onToggleSessions}
        >
          <Glyph name="peep" className={styles.trayIcon} />
        </button>
        <a className={clsx(styles.item, styles.strong)} href={RELEASES}>
          Download
        </a>
        <Clock />
      </div>
    </header>
  );
}
