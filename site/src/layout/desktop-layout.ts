import {
  bringToFront,
  clamp,
  leastCovered,
  moveWithin,
  rectOf,
  relativeRect,
  setBox,
} from "./geometry.ts";

export interface DesktopParts {
  desktop: HTMLElement;
  screen: HTMLElement;
  headline: HTMLElement;
  states: HTMLElement;
  peep: HTMLElement;
  terminal: HTMLElement;
  sessions: HTMLElement;
  dock: HTMLElement;
}

const DOCK_SPACE = 104;

export function layoutDesktop(parts: DesktopParts, peepMax: number): void {
  const { desktop, screen, headline, states, peep, terminal, dock } = parts;
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
  states.style.width = `${Math.round(colW)}px`;
  const band = relativeRect(dock, screen).y;
  const fixed = headline.offsetHeight + 32 + states.offsetHeight + 8;
  const size = Math.round(clamp((band - 48 - fixed) / 0.8, 140, peepMax));
  desktop.style.setProperty("--peep-size", `${size}px`);
  const top = Math.max(16, (band - fixed - size * 0.8) / 2);
  setBox(headline, colX, top);
  setBox(states, colX, top + headline.offsetHeight + 32);
  setBox(
    peep,
    colX + colW - size * 0.8,
    states.offsetTop + states.offsetHeight + 8 - size * 0.06,
  );
  const termH = Math.max(300, H - DOCK_SPACE - (peepMax * 0.82 + 2));
  setBox(
    terminal,
    colX + colW + gap,
    Math.max(16, (band - termH) / 2),
    termW,
    termH,
  );
}

export function placeSessions(parts: DesktopParts): void {
  const { screen, headline, states, peep, terminal, sessions, dock } = parts;
  bringToFront(sessions);
  const p = rectOf(peep);
  const body = {
    x: p.x + p.w * 0.2,
    y: p.y + p.h * 0.15,
    w: p.w * 0.6,
    h: p.h * 0.7,
  };
  const term = rectOf(terminal);
  const panel = rectOf(states);
  sessions.style.width = `${Math.round(clamp(body.x - panel.x - 12, 240, 312))}px`;
  const w = sessions.offsetWidth;
  const h = sessions.offsetHeight;
  const choice = leastCovered(
    [
      { x: panel.x, y: panel.y + panel.h + 12, w, h },
      { x: panel.x, y: panel.y - h - 12, w, h },
      { x: term.x - w - 12, y: body.y + body.h + 12, w, h },
    ],
    [term, panel, rectOf(headline), body, relativeRect(dock, screen)],
    screen,
  );
  moveWithin(sessions, screen, choice.x, choice.y);
}
