import { PALETTE } from "../pet/pet-figure.ts";
import { rgb } from "../pet/color.ts";
import {
  semanticStates,
  stateLabels,
  type SessionSummary,
  type Snapshot,
} from "../../shared/ui-contract.ts";

const total = document.querySelector("#total");
const needs = document.querySelector("#needs");
const entries = document.querySelector("#sessions");
const hint = document.querySelector<HTMLElement>("#hint");
if (!total || !needs || !entries || !hint)
  throw new Error("Session view missing");

let timers: [HTMLElement, number][] = [];

const rank = (session: SessionSummary) => semanticStates.indexOf(session.state);
const urgency = (a: SessionSummary, b: SessionSummary) =>
  rank(b) - rank(a) || b.since - a.since;
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
const needYou = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;

function tool(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

function summary(session: SessionSummary): string {
  const detail = session.detail;
  switch (session.state) {
    case "asking":
      if (detail?.kind === "question") return "Answer a question";
      return detail?.kind === "permission" && detail.tool
        ? `Approve ${tool(detail.tool)}`
        : "Needs approval";
    case "working":
      return detail?.kind === "tool"
        ? `Running ${tool(detail.tool)}`
        : "Working";
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
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

function icon(className: string, paths: string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function chevron(session: SessionSummary): HTMLElement {
  const cell = el("span", "go");
  if (!session.focusable) return cell;
  cell.append(icon("icon-go", ["M6.25 3.75 10.5 8l-4.25 4.25"]));
  return cell;
}

function line(
  session: SessionSummary,
  label: HTMLElement,
  className = "row",
): HTMLLIElement {
  const row = el(
    "li",
    session.state === "asking" ? `${className} asking` : className,
  );
  const text = summary(session);
  const detail = el("span", "detail", text);
  row.dataset.session = session.id;
  row.tabIndex = -1;
  row.setAttribute("aria-keyshortcuts", "Meta+C Shift+F10");
  row.title = [
    ...(session.focusable
      ? [
          session.terminalName
            ? `Show in ${session.terminalName}`
            : "Show Terminal",
        ]
      : []),
    `${session.project} · ${text}`,
    `Session ${session.id}`,
  ].join("\n");
  if (session.focusable) {
    row.classList.add("focusable");
    row.setAttribute("role", "button");
  }
  row.append(...dot(session), label, detail, time(session), chevron(session));
  return row;
}

function sessionRows(): HTMLElement[] {
  return [...entries!.querySelectorAll<HTMLElement>("li[data-session]")];
}

function rove(
  row: HTMLElement | undefined,
  focus: "scroll" | "keep" | "none" = "scroll",
): void {
  if (!row) return;
  for (const other of sessionRows()) other.tabIndex = other === row ? 0 : -1;
  if (focus !== "none") row.focus({ preventScroll: focus === "keep" });
}

function activeRow(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>("li[data-session]")
    : null;
}

function render(snapshot: Snapshot): void {
  const sessions = [...snapshot.sessions].sort(urgency);
  const asks = sessions.filter((session) => session.state === "asking").length;
  total!.textContent =
    sessions.length > 0
      ? plural(sessions.length, "session")
      : snapshot.state === "unknown"
        ? "Can't receive Claude Code signals"
        : "No sessions yet";
  needs!.textContent = asks > 0 ? needYou(asks) : "";
  hint!.hidden = sessions.length > 0 || snapshot.state === "unknown";
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
      rows.push(line(lead, name));
      continue;
    }
    name.title = project;
    name.append(
      el("span", "visually-hidden", ", "),
      el("span", "count", String(group.length)),
      el("span", "visually-hidden", " sessions"),
    );
    const waiting = group.filter((session) => session.state === "asking");
    const block = el("li", "group");
    const head = el("div", lead.state === "asking" ? "row asking" : "row");
    head.append(
      ...dot(lead),
      name,
      el("span", "detail", waiting.length > 0 ? needYou(waiting.length) : ""),
      el("span", "time"),
      el("span", "go"),
    );
    const children = el("ul", "");
    for (const session of group)
      children.append(
        line(session, el("span", "id", `${session.shortId}…`), "row child"),
      );
    block.append(head, children);
    rows.push(block);
  }
  const before = sessionRows();
  const active = activeRow();
  const stop = active ?? before.find((row) => row.tabIndex === 0);
  const id = stop?.dataset.session;
  entries!.replaceChildren(...rows);
  const all = sessionRows();
  const kept = all.find((row) => row.dataset.session === id);
  const neighbour = stop
    ? all[Math.min(before.indexOf(stop), all.length - 1)]
    : undefined;
  rove(kept ?? neighbour ?? all[0], active ? "keep" : "none");
}

const tick = setInterval(() => {
  for (const [node, since] of timers) node.textContent = elapsed(since);
}, 1000);
const unsubscribe = window.watchling.onSnapshot(render);
void window.watchling.getSnapshot().then(render);
entries.addEventListener("click", (event) => {
  const row = (event.target as Element).closest<HTMLElement>(
    "li[data-session]",
  );
  if (!row) return;
  rove(row);
  if (row.classList.contains("focusable"))
    window.watchling.focusSession(row.dataset.session!);
});
entries.addEventListener("contextmenu", (event) => {
  const row = (event.target as Element).closest<HTMLElement>(
    "li[data-session]",
  );
  if (!row) return;
  event.preventDefault();
  rove(row);
  window.watchling.showSessionMenu(row.dataset.session!);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.watchling.closeSessionList();
    return;
  }
  const rows = sessionRows();
  const row = activeRow();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const stop = rows.find((item) => item.tabIndex === 0);
    rove(
      row
        ? rows[Math.min(rows.length - 1, Math.max(0, rows.indexOf(row) + step))]
        : stop,
    );
    return;
  }
  if (!row) return;
  const id = row.dataset.session!;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (row.classList.contains("focusable")) window.watchling.focusSession(id);
  } else if (event.metaKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    window.watchling.copySessionId(id);
  } else if (
    event.key === "ContextMenu" ||
    (event.shiftKey && event.key === "F10")
  ) {
    event.preventDefault();
    window.watchling.showSessionMenu(id);
  }
});
window.addEventListener(
  "pagehide",
  () => {
    unsubscribe();
    clearInterval(tick);
  },
  { once: true },
);
