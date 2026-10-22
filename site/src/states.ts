import { PALETTE } from "../../src/renderer/pet/pet-figure.ts";
import { rgb } from "../../src/renderer/pet/color.ts";
import {
  stateLabels,
  type SemanticState,
} from "../../src/shared/ui-contract.ts";
import { el } from "./windows.ts";

const ORDER: readonly SemanticState[] = [
  "idle",
  "working",
  "asking",
  "background",
  "unknown",
];
const MEANING: Record<SemanticState, string> = {
  idle: "Waiting for you",
  working: "Claude is busy",
  asking: "Claude needs you",
  background: "Agents still running",
  unknown: "Signals lost",
};

const HOW: Record<SemanticState, string> = {
  idle: "Shown on load",
  working: "Pick Work on a task",
  asking: "Pick Ask for permission",
  background: "Pick Run background agents",
  unknown: "Pick Lose the connection",
};

export function createStateStrip(): {
  element: HTMLElement;
  render: (current: SemanticState, found: ReadonlySet<SemanticState>) => void;
} {
  const element = el("section", "states");
  element.setAttribute("aria-labelledby", "states-title");
  const head = el("header", "states-head");
  const title = el("h2", "states-title", "Peep's states");
  title.id = "states-title";
  const count = el("p", "states-count");
  count.setAttribute("aria-live", "polite");
  head.append(title, count);
  const list = el("ol", "states-list");
  const rows = ORDER.map((state) => {
    const row = el("li", "state");
    const dot = el("span", "state-dot");
    dot.style.setProperty("--dot", rgb(PALETTE[state][1]));
    dot.setAttribute("aria-hidden", "true");
    const hint = el("span", "state-hint");
    const status = el("span", "visually-hidden");
    const check = el("span", "state-check", "✓");
    check.setAttribute("aria-hidden", "true");
    row.append(
      dot,
      el("span", "state-label", stateLabels[state]),
      hint,
      check,
      status,
    );
    list.append(row);
    return { state, row, hint, status };
  });
  element.append(head, list);

  return {
    element,
    render(current, found) {
      for (const { state, row, hint, status } of rows) {
        const seen = found.has(state);
        row.classList.toggle("found", seen);
        if (state === current) row.setAttribute("aria-current", "true");
        else row.removeAttribute("aria-current");
        hint.textContent = seen ? MEANING[state] : HOW[state];
        status.textContent =
          state === current ? ", now" : seen ? ", found" : ", not found yet";
      }
      count.textContent =
        found.size === ORDER.length
          ? "All 5 found"
          : `${found.size} of ${ORDER.length} found`;
    },
  };
}
