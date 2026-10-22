import { PALETTE } from "../../src/renderer/pet/pet-figure.ts";
import { rgb } from "../../src/renderer/pet/color.ts";
import {
  semanticStates,
  stateLabels,
  type SessionSummary,
  type Snapshot,
} from "../../src/shared/ui-contract.ts";
import { el } from "./windows.ts";

const rank = (session: SessionSummary) => semanticStates.indexOf(session.state);
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
const needYou = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;

function summary(session: SessionSummary): string {
  const detail = session.detail;
  switch (session.state) {
    case "asking":
      return detail?.kind === "permission" && detail.tool
        ? `Approve ${detail.tool}`
        : "Needs approval";
    case "working":
      return detail?.kind === "tool" ? `Running ${detail.tool}` : "Working";
    case "background":
      return plural(
        detail?.kind === "agents" ? detail.count : 0,
        "background agent",
      );
    case "unknown":
      return "Missed signals";
    case "idle":
      return "Idle";
  }
}

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function createSessionsView(): {
  element: HTMLElement;
  render: (snapshot: Snapshot) => void;
  destroy: () => void;
} {
  const element = el("div", "sessions");
  const head = el("div", "head");
  const total = el("span", "");
  const needs = el("span", "needs");
  head.append(total, needs);
  const list = el("ul", "list");
  list.setAttribute("aria-label", "Sessions");
  element.append(head, list);
  let timers: [HTMLElement, number][] = [];

  function dot(session: SessionSummary): HTMLElement[] {
    const mark = el("span", "dot");
    mark.style.background = rgb(PALETTE[session.state][1]);
    mark.setAttribute("aria-hidden", "true");
    return [
      mark,
      el("span", "visually-hidden", `${stateLabels[session.state]}:`),
    ];
  }

  function time(session: SessionSummary): HTMLElement {
    const node = el("span", "time", elapsed(session.since));
    timers.push([node, session.since]);
    return node;
  }

  function row(
    session: SessionSummary,
    label: HTMLElement,
    className = "row",
  ): HTMLLIElement {
    const item = el(
      "li",
      session.state === "asking" ? `${className} asking` : className,
    );
    item.append(
      ...dot(session),
      label,
      el("span", "detail", summary(session)),
      time(session),
    );
    return item;
  }

  function render(snapshot: Snapshot): void {
    const sessions = [...snapshot.sessions].sort(
      (a, b) => rank(b) - rank(a) || b.since - a.since,
    );
    const asks = sessions.filter(
      (session) => session.state === "asking",
    ).length;
    total.textContent =
      sessions.length > 0
        ? plural(sessions.length, "session")
        : snapshot.state === "unknown"
          ? "Can't receive Claude Code signals"
          : "No sessions yet";
    needs.textContent = asks > 0 ? needYou(asks) : "";
    timers = [];
    const projects = new Map<string, SessionSummary[]>();
    for (const session of sessions)
      projects.set(session.project, [
        ...(projects.get(session.project) ?? []),
        session,
      ]);
    const rows: HTMLLIElement[] = [];
    for (const [project, group] of projects) {
      const lead = group[0]!;
      const name = el("span", "project", project);
      if (group.length === 1) {
        rows.push(row(lead, name));
        continue;
      }
      name.append(
        el("span", "visually-hidden", ", "),
        el("span", "count", String(group.length)),
        el("span", "visually-hidden", " sessions"),
      );
      const waiting = group.filter((session) => session.state === "asking");
      const block = el("li", "group");
      const top = el("div", lead.state === "asking" ? "row asking" : "row");
      top.append(
        ...dot(lead),
        name,
        el("span", "detail", waiting.length > 0 ? needYou(waiting.length) : ""),
        el("span", "time"),
      );
      const children = el("ul", "");
      for (const session of group)
        children.append(
          row(session, el("span", "id", `${session.shortId}…`), "row child"),
        );
      block.append(top, children);
      rows.push(block);
    }
    list.replaceChildren(...rows);
  }

  const tick = setInterval(() => {
    for (const [node, since] of timers) node.textContent = elapsed(since);
  }, 1000);
  return { element, render, destroy: () => clearInterval(tick) };
}
