import iconUrl from "../../resources/icon.svg?url";
import { createPet } from "../../src/renderer/pet/pet-figure.ts";
import {
  stateLabels,
  type SemanticState,
  type Snapshot,
} from "../../src/shared/ui-contract.ts";
import type { Config } from "./config.ts";
import { createDemo, type Demo } from "./demo.ts";
import { createSessionsView } from "./sessions.ts";
import { createStateStrip } from "./states.ts";
import { createTerminalView } from "./terminal.ts";
import {
  bringToFront,
  createWindow,
  draggable,
  el,
  keepWithin,
  moveWithin,
} from "./windows.ts";

export const RELEASES = "https://github.com/sht02048/watchling/releases/latest";
const SVG = "http://www.w3.org/2000/svg";
const compactQuery = "(max-width: 719px)";
const reducedQuery = "(prefers-reduced-motion: reduce)";

function svg(viewBox: string, d: string, className: string): SVGSVGElement {
  const root = document.createElementNS(SVG, "svg");
  root.setAttribute("viewBox", viewBox);
  root.setAttribute("class", className);
  root.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill-rule", "evenodd");
  root.append(path);
  return root;
}

function peepGlyph(): string {
  const points = Array.from({ length: 144 }, (_, index) => {
    const angle = (index / 144) * Math.PI * 2;
    const radius =
      7.1 *
      (1 +
        0.042 * Math.cos(9 * angle + 0.2) +
        0.017 * Math.cos(7 * angle + 0.6));
    return `${(9 + radius * Math.cos(angle)).toFixed(2)} ${(9.4 + radius * Math.sin(angle)).toFixed(2)}`;
  });
  const eyes = [6.4, 11.6]
    .map((x) => `M${x - 1.15} 9.4a1.15 1.6 0 1 0 2.3 0a1.15 1.6 0 1 0 -2.3 0Z`)
    .join("");
  return `M${points.join("L")}Z${eyes}`;
}

function blobGlyph(): string {
  return "M9 2.2c1.5 0 2.4.9 2.4.9s-.4-1.3 1-2c.3 1.2-.6 2.1-.6 2.1 2.5.6 3.7 2.9 3.7 5.6 0 3.6-2.4 7-4.4 7-1 0-1.3-.5-2.1-.5s-1.1.5-2.1.5c-2 0-4.4-3.4-4.4-7 0-3.3 1.9-5.7 4.6-5.7.9 0 1.4.3 1.9.3Z";
}

function terminalGlyph(): string {
  return "M3 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2.2 4 3 3-3 3-.9-.9 2.1-2.1-2.1-2.1.9-.9ZM9.5 12.4h4.6v1.2H9.5v-1.2Z";
}

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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Progress {
  hint: boolean;
  found: Set<SemanticState>;
}

interface Desktop {
  update(config: Config): void;
  destroy(): void;
}

const rectOf = (element: HTMLElement): Rect => ({
  x: element.offsetLeft,
  y: element.offsetTop,
  w: element.offsetWidth,
  h: element.offsetHeight,
});

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function pick<T extends Rect>(
  candidates: T[],
  obstacles: Rect[],
  screen: HTMLElement,
): T {
  const inside = candidates.filter(
    (rect) =>
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.x + rect.w <= screen.clientWidth &&
      rect.y + rect.h <= screen.clientHeight,
  );
  const pool = inside.length > 0 ? inside : candidates;
  const cost = (rect: Rect) =>
    obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0);
  return pool.reduce((best, rect) => (cost(rect) < cost(best) ? rect : best));
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

function buildDesktop(
  root: HTMLElement,
  getConfig: () => Config,
  compact: boolean,
  progress: Progress,
): Desktop {
  const config = getConfig();
  const reduced = matchMedia(reducedQuery);
  const cleanups: (() => void)[] = [];
  const desktop = el("div", compact ? "desktop compact" : "desktop");

  const menubar = el("header", "menubar");
  const left = el("div", "menu-left");
  const glyph = svg("0 0 18 18", blobGlyph(), "glyph");
  const appMenuButton = el("button", "menu-item app-name", "Watchling");
  appMenuButton.type = "button";
  appMenuButton.setAttribute("aria-haspopup", "menu");
  appMenuButton.setAttribute("aria-expanded", "false");
  const menu = el("div", "dropdown");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Watchling");
  menu.hidden = true;
  const connectItem = el("button", "dropdown-item");
  connectItem.type = "button";
  connectItem.setAttribute("role", "menuitemcheckbox");
  connectItem.append(el("span", "tick", "✓"), "Connected to Claude Code");
  const sessionsItem = el("button", "dropdown-item", "Show Sessions");
  sessionsItem.type = "button";
  sessionsItem.setAttribute("role", "menuitem");
  const separator = el("div", "separator");
  separator.setAttribute("role", "separator");
  const downloadItem = el("a", "dropdown-item", "Download Watchling…");
  downloadItem.href = RELEASES;
  downloadItem.setAttribute("role", "menuitem");
  menu.append(connectItem, sessionsItem, separator, downloadItem);
  const appMenu = el("div", "app-menu");
  appMenu.append(appMenuButton, menu);
  left.append(glyph, appMenu);
  for (const label of ["File", "Edit", "View", "Window", "Help"])
    left.append(el("span", "menu-item inert", label));
  const right = el("div", "menu-right");
  const tray = el("button", "menu-item tray");
  tray.type = "button";
  tray.setAttribute("aria-label", "Watchling sessions");
  tray.setAttribute("aria-expanded", "false");
  tray.append(svg("0 0 18 18", peepGlyph(), "tray-icon"));
  const download = el("a", "menu-item download", "Download");
  download.href = RELEASES;
  const clock = el("time", "menu-item clock");
  right.append(tray, download, clock);
  menubar.append(left, right);

  const screen = el("main", "screen");
  const headline = el("header", "headline");
  headline.append(
    el("h1", "headline-title", "A desktop pet for Claude Code"),
    el(
      "p",
      "headline-sub",
      "Peep sits on your Mac, watches your Claude Code sessions, and speaks up when Claude needs you.",
    ),
  );
  const dock = el("nav", "dock");
  dock.setAttribute("aria-label", "Dock");

  const peep = el("button", "peep");
  peep.type = "button";
  const back = el("canvas", "layer");
  const canvas = el("canvas", "body");
  const front = el("canvas", "layer");
  peep.append(back, canvas, front);
  const bubble = el("div", "bubble");
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  bubble.dataset.side = "right";
  const bubbleText = el("p", "bubble-text");
  bubble.append(bubbleText);
  const stage = el("div", "stage");
  stage.append(bubble);
  const states = createStateStrip(compact);

  const sessionsView = createSessionsView();
  const sessionsWindow = createWindow({
    title: "Sessions",
    label: "Watchling sessions",
    className: "sessions-window",
    onClose: () => toggleSessions(false),
  });
  sessionsWindow.content.append(sessionsView.element);
  sessionsWindow.element.hidden = true;

  let demo: Demo;
  let shownText = "";
  let perched = true;

  function render(): void {
    const snapshot: Snapshot = demo.snapshot();
    progress.found.add(snapshot.state);
    pet.setState(snapshot.state);
    pet.setCompanions(snapshot.companions);
    peep.setAttribute(
      "aria-label",
      `Peep, ${stateLabels[snapshot.state]}. Show sessions`,
    );
    desktop.dataset.state = snapshot.state;
    terminalView.render();
    sessionsView.render(snapshot);
    states.render(snapshot.state, progress.found);
    const checked = String(demo.connected);
    connectItem.setAttribute("aria-checked", checked);
    connectButton.setAttribute("aria-pressed", checked);
    connectButton.textContent = demo.connected
      ? "Connected to Claude Code"
      : "Disconnected from Claude Code";
    const text = demo.bubble();
    if (text !== shownText) {
      shownText = text;
      bubbleText.textContent = text;
      placeBubble();
      bubble.classList.remove("enter");
      void bubble.offsetWidth;
      bubble.classList.add("enter");
    }
  }

  demo = createDemo({
    pointer: compact ? "↑" : "→",
    timing: () => {
      const current = getConfig();
      return {
        typeSpeed: reduced.matches ? 0 : current.typeSpeed,
        permissionDelay: current.permissionDelay,
        agentDurations: current.agentDurations,
      };
    },
    onChange: render,
  });
  cleanups.push(() => demo.destroy());

  const terminal = demo.terminals[0]!;
  const terminalView = createTerminalView(terminal, {
    start: (task) => {
      if (task === "run") progress.hint = false;
      demo.start(terminal.id, task);
    },
    answer: (allow) => demo.answer(terminal.id, allow),
    hint: () => progress.hint,
  });
  const terminalWindow = createWindow({
    title: `${terminal.project} — claude`,
    label: "Terminal",
    className: "terminal",
  });
  terminalWindow.content.append(terminalView.element);

  const connectButton = el("button", "connect");
  connectButton.type = "button";
  connectButton.addEventListener("click", () =>
    demo.setConnected(!demo.connected),
  );

  const dockApp = el("a", "dock-app");
  dockApp.href = RELEASES;
  dockApp.setAttribute("aria-label", "Download Watchling");
  const dockIcon = el("img");
  dockIcon.src = iconUrl;
  dockIcon.alt = "";
  dockIcon.width = 52;
  dockIcon.height = 52;
  dockIcon.draggable = false;
  dockApp.append(dockIcon, el("span", "dock-label", "Download Watchling"));
  const dockTerminal = el("button", "dock-app dock-terminal");
  dockTerminal.type = "button";
  dockTerminal.setAttribute("aria-label", "Show terminal");
  dockTerminal.append(
    svg("0 0 20 20", terminalGlyph(), "terminal-icon"),
    el("span", "dock-label", "Terminal"),
  );
  dockTerminal.addEventListener("click", () =>
    bringToFront(terminalWindow.element),
  );
  dock.append(dockTerminal, dockApp);

  stage.prepend(peep);
  screen.append(
    headline,
    terminalWindow.element,
    stage,
    states.element,
    sessionsWindow.element,
  );
  if (compact) screen.append(connectButton);
  desktop.append(menubar, screen, dock);
  root.replaceChildren(desktop);

  const pet = createPet(canvas, { back, front });
  cleanups.push(
    () => pet.destroy(),
    () => sessionsView.destroy(),
  );

  const DOCK = 104;

  function setBox(
    element: HTMLElement,
    x: number,
    y: number,
    w?: number,
    h?: number,
  ): void {
    if (w !== undefined) element.style.width = `${Math.round(w)}px`;
    if (h !== undefined) element.style.height = `${Math.round(h)}px`;
    element.style.left = `${Math.round(x)}px`;
    element.style.top = `${Math.round(y)}px`;
  }

  function layout(current: Config): void {
    if (compact) return;
    perched = true;
    const W = screen.clientWidth;
    const H = screen.clientHeight;
    const colW = Math.min(440, W * 0.3);
    const gap = Math.max(56, W * 0.05);
    const termW = Math.min(
      980,
      W - Math.max(32, W * 0.06) - colW - gap - Math.max(32, W * 0.04),
    );
    const colX = Math.max(24, (W - colW - gap - termW) / 2);
    headline.style.width = `${Math.round(colW)}px`;
    states.element.style.width = `${Math.round(colW)}px`;
    const band = dockRect().y;
    const fixed = headline.offsetHeight + 32 + states.element.offsetHeight + 8;
    const size = Math.round(
      clamp((band - 48 - fixed) / 0.8, 140, current.peepSize),
    );
    desktop.style.setProperty("--peep-size", `${size}px`);
    const top = Math.max(16, (band - fixed - size * 0.8) / 2);
    setBox(headline, colX, top);
    setBox(states.element, colX, top + headline.offsetHeight + 32);
    setBox(
      peep,
      colX - size * 0.16,
      states.element.offsetTop + states.element.offsetHeight + 8 - size * 0.06,
    );
    const termH = Math.max(300, H - DOCK - (current.peepSize * 0.82 + 2));
    setBox(
      terminalWindow.element,
      colX + colW + gap,
      Math.max(16, (band - termH) / 2),
      termW,
      termH,
    );
    placeBubble();
  }

  function placeBubble(): void {
    if (compact) return;
    const p = rectOf(peep);
    const size = p.w;
    const term = rectOf(terminalWindow.element);
    const panel = rectOf(states.element);
    const hx = p.x + size / 2;
    const hy = p.y + size * 0.45;
    const max = getConfig().bubbleMaxWidth;
    const rightX = p.x + size * 0.84;
    const room = term.x - 16 - rightX;
    let side: string;
    let x: number;
    let y: number;
    if (perched && room >= 200) {
      bubble.style.maxWidth = `${Math.round(Math.min(max, room))}px`;
      side = "right";
      x = rightX;
      y = Math.max(hy - bubble.offsetHeight * 0.55, panel.y + panel.h + 8);
    } else if (perched) {
      bubble.style.maxWidth = `${Math.round(panel.w)}px`;
      side = "above";
      x = panel.x;
      y = p.y + size * 0.06 - bubble.offsetHeight - 8;
    } else {
      bubble.style.maxWidth = `${max}px`;
      const w = bubble.offsetWidth;
      const h = bubble.offsetHeight;
      const choice = pick(
        [
          { x: rightX, y: hy - h * 0.55, w, h, side: "right" },
          { x: p.x + size * 0.16 - w, y: hy - h * 0.55, w, h, side: "left" },
          { x: hx - w / 2, y: p.y + size * 0.1 - h, w, h, side: "above" },
          { x: hx - w / 2, y: p.y + size * 0.86, w, h, side: "below" },
        ],
        [term, panel, rectOf(headline), dockRect()],
        screen,
      );
      side = choice.side;
      x = choice.x;
      y = choice.y;
    }
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    x = clamp(x, 8, screen.clientWidth - w - 8);
    y = clamp(y, 8, screen.clientHeight - h - 8);
    bubble.dataset.side = side;
    bubble.style.left = `${Math.round(x)}px`;
    bubble.style.top = `${Math.round(y)}px`;
    bubble.style.setProperty(
      "--tail",
      `${Math.round(
        side === "left" || side === "right"
          ? clamp(hy - y, 18, h - 18)
          : clamp(hx - x, 22, w - 22),
      )}px`,
    );
  }

  function dockRect(): Rect {
    const box = dock.getBoundingClientRect();
    const origin = screen.getBoundingClientRect();
    return {
      x: box.left - origin.left,
      y: box.top - origin.top,
      w: box.width,
      h: box.height,
    };
  }

  function toggleSessions(open = sessionsWindow.element.hidden === true): void {
    sessionsWindow.element.hidden = !open;
    tray.setAttribute("aria-expanded", String(open));
    if (open && !compact) {
      bringToFront(sessionsWindow.element);
      const p = rectOf(peep);
      const b = rectOf(bubble);
      const term = rectOf(terminalWindow.element);
      const panel = rectOf(states.element);
      const w = sessionsWindow.element.offsetWidth;
      const h = sessionsWindow.element.offsetHeight;
      const beside = Math.min(p.x + p.w * 0.84, term.x - 16 - w);
      const choice = pick(
        [
          { x: beside, y: b.y + b.h + 12, w, h },
          { x: beside, y: b.y - h - 12, w, h },
          { x: panel.x, y: panel.y - h - 12, w, h },
        ],
        [term, panel, rectOf(headline), b, dockRect()],
        screen,
      );
      moveWithin(sessionsWindow.element, screen, choice.x, choice.y);
    }
  }

  function setMenu(open: boolean): void {
    menu.hidden = !open;
    appMenuButton.setAttribute("aria-expanded", String(open));
    appMenuButton.classList.toggle("open", open);
  }

  draggable(terminalWindow.element, terminalWindow.bar, screen, {
    enabled: () => !compact,
    onMove: () => {
      placeBubble();
    },
  });
  draggable(sessionsWindow.element, sessionsWindow.bar, screen, {
    enabled: () => !compact,
    canStart: (event) => !(event.target as Element).closest("button"),
  });
  draggable(peep, peep, screen, {
    enabled: () => !compact,
    canStart: (event) => {
      const box = canvas.getBoundingClientRect();
      return pet.hitTest(event.clientX - box.left, event.clientY - box.top);
    },
    onMove: () => {
      perched = false;
      placeBubble();
    },
    onClick: () => toggleSessions(),
  });
  peep.addEventListener("click", (event) => {
    if (compact || event.detail === 0) toggleSessions();
  });
  peep.addEventListener("pointermove", (event) => {
    if (compact) return;
    const box = canvas.getBoundingClientRect();
    peep.classList.toggle(
      "hit",
      pet.hitTest(event.clientX - box.left, event.clientY - box.top),
    );
  });
  tray.addEventListener("click", () => toggleSessions());
  appMenuButton.addEventListener("click", () => setMenu(menu.hidden === true));
  connectItem.addEventListener("click", () => {
    demo.setConnected(!demo.connected);
    setMenu(false);
  });
  sessionsItem.addEventListener("click", () => {
    toggleSessions(true);
    setMenu(false);
  });
  const outside = (event: PointerEvent) => {
    if (!appMenu.contains(event.target as Node)) setMenu(false);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!menu.hidden) {
      setMenu(false);
      appMenuButton.focus();
    } else if (!sessionsWindow.element.hidden) toggleSessions(false);
  };
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", escape);
  cleanups.push(() => {
    document.removeEventListener("pointerdown", outside);
    document.removeEventListener("keydown", escape);
  });

  const tickClock = () => {
    const now = new Date();
    clock.textContent = clockText(now);
    clock.dateTime = now.toISOString();
  };
  tickClock();
  const clockTimer = setInterval(tickClock, 5000);
  cleanups.push(() => clearInterval(clockTimer));

  function apply(current: Config): void {
    desktop.dataset.mode = current.mode;
    desktop.style.setProperty("--hue", String(current.wallpaperHue));
    desktop.style.setProperty("--bubble-max", `${current.bubbleMaxWidth}px`);
    desktop.style.setProperty("--peep-size", `${current.peepSize}px`);
  }

  apply(config);
  render();
  layout(config);

  const onResize = () => {
    if (compact) return;
    layout(getConfig());
    keepWithin(sessionsWindow.element, screen);
  };
  window.addEventListener("resize", onResize);
  cleanups.push(() => window.removeEventListener("resize", onResize));

  let last = config;
  return {
    update(next: Config): void {
      apply(next);
      if (next.peepSize !== last.peepSize) layout(next);
      else placeBubble();
      last = next;
    },
    destroy(): void {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

export function mountSite(
  root: HTMLElement,
  initial: Config,
): { update(config: Config): void; reset(): void; destroy(): void } {
  let config = initial;
  const fresh = (): Progress => ({ hint: true, found: new Set(["idle"]) });
  let progress = fresh();
  const compact = matchMedia(compactQuery);
  let desktop = buildDesktop(root, () => config, compact.matches, progress);
  const rebuild = () => {
    desktop.destroy();
    desktop = buildDesktop(root, () => config, compact.matches, progress);
  };
  compact.addEventListener("change", rebuild);
  return {
    update(next: Config): void {
      config = next;
      desktop.update(next);
    },
    reset(): void {
      progress = fresh();
      rebuild();
    },
    destroy(): void {
      compact.removeEventListener("change", rebuild);
      desktop.destroy();
    },
  };
}
