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

function copy(session: SessionSummary): HTMLButtonElement {
  const button = el("button", "copy");
  button.append(
    icon("icon-copy", [
      "M7 5.25h5a1.75 1.75 0 0 1 1.75 1.75v5A1.75 1.75 0 0 1 12 13.75H7A1.75 1.75 0 0 1 5.25 12V7A1.75 1.75 0 0 1 7 5.25Z",
      "M2.25 10.25v-6.5c0-.83.67-1.5 1.5-1.5h6.5",
    ]),
    icon("icon-done", ["M3 8.5l3.25 3.25L13 4.75"]),
  );
  button.type = "button";
  button.title = `Copy session ID ${session.id}`;
  button.setAttribute("aria-label", `Copy session ID ${session.id}`);
  button.addEventListener("click", () => {
    window.pagent.copySessionId(session.id);
    button.classList.add("copied");
    button.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      button.classList.remove("copied");
      button.setAttribute("aria-label", `Copy session ID ${session.id}`);
    }, 1500);
  });
  return button;
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
  detail.title = text;
  const name = el("span", "name");
  name.append(label, copy(session));
  row.append(...dot(session), name, detail, time(session));
  row.title = session.id;
  return row;
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
    name.title = project;
    if (group.length === 1) {
      rows.push(line(lead, name));
      continue;
    }
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
    );
    const children = el("ul", "");
    for (const session of group)
      children.append(
        line(session, el("span", "id", `${session.shortId}…`), "row child"),
      );
    block.append(head, children);
    rows.push(block);
  }
  entries!.replaceChildren(...rows);
}

const tick = setInterval(() => {
  for (const [node, since] of timers) node.textContent = elapsed(since);
}, 1000);
const unsubscribe = window.pagent.onSnapshot(render);
void window.pagent.getSnapshot().then(render);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.pagent.closeSessionList();
});
window.addEventListener(
  "pagehide",
  () => {
    unsubscribe();
    clearInterval(tick);
  },
  { once: true },
);
