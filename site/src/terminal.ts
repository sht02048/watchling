import { PALETTE } from "../../src/renderer/pet/pet-figure.ts";
import { rgb } from "../../src/renderer/pet/color.ts";
import {
  stateLabels,
  type SemanticState,
} from "../../src/shared/ui-contract.ts";
import { choices, type Choice, type Line, type Terminal } from "./demo.ts";
import { el, peepGlyph, svg } from "./windows.ts";

function line(item: Line): HTMLLIElement {
  const row = el(
    "li",
    `line ${item.kind === "peep" ? "peep-line" : item.kind}`,
  );
  switch (item.kind) {
    case "user":
      row.append(el("span", "mark", ">"), el("span", "", item.text));
      break;
    case "tool": {
      const open = item.text.indexOf("(");
      row.append(
        el("span", "mark", "⏺"),
        el("b", "", item.text.slice(0, open)),
        el("span", "args", item.text.slice(open)),
      );
      break;
    }
    case "result":
      row.append(el("span", "mark", "⎿"), el("span", "", item.text));
      break;
    case "text":
    case "done":
      row.append(el("span", "mark", "⏺"), el("span", "", item.text));
      break;
    case "peep": {
      row.style.setProperty(
        "--peep-ink",
        rgb(PALETTE[item.state ?? "idle"][0]),
      );
      const name = el("span", "peep-label");
      name.append(el("b", "peep-name", "Peep"), " ·");
      row.append(
        svg("0 0 18 18", peepGlyph(), "mark peep-mark"),
        name,
        el("span", "", item.text),
      );
      break;
    }
  }
  return row;
}

function cursorBox(): HTMLElement {
  const box = el("div", "input");
  box.append(el("span", "mark", ">"), el("span", "cursor"));
  box.setAttribute("aria-hidden", "true");
  return box;
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    target.isContentEditable ||
    target.closest(".dropdown") !== null);

const dropdownOpen = () =>
  document.querySelector(".dropdown:not([hidden])") !== null;

export function createTerminalView(
  terminal: Terminal,
  options: {
    choose: (choice: Choice) => void;
    answer: (allow: boolean) => void;
    finish: () => void;
    finishTask: () => void;
    reconnect: () => void;
    found: () => ReadonlySet<SemanticState>;
  },
): { element: HTMLElement; render: () => void; destroy: () => void } {
  const element = el("div", "term");
  const scroll = el("div", "term-scroll");
  const welcome = el("div", "welcome");
  const head = el("div", "");
  head.append(
    el("span", "spark", "✻"),
    " Welcome to ",
    el("b", "", "Claude Code"),
  );
  welcome.append(head, el("div", "muted", `cwd: ~/code/${terminal.project}`));
  const lines = el("ol", "lines");
  lines.setAttribute("aria-label", "Output");
  lines.setAttribute("aria-live", "polite");
  scroll.append(welcome, lines);
  const prompt = el("div", "term-prompt");
  const footer = el("div", "term-footer");
  element.append(scroll, prompt, footer);
  let shownLines = 0;
  let shownPrompt = "";
  let menuActive = 0;
  let active = 0;
  let wantsFocus = false;
  let buttons: HTMLButtonElement[] = [];
  let horizontal = false;

  function setActive(index: number, focus: boolean): void {
    if (buttons.length === 0) return;
    active = (index + buttons.length) % buttons.length;
    if (terminal.prompt.kind === "menu") menuActive = active;
    buttons.forEach((button, i) => {
      button.classList.toggle("active", i === active);
      button.tabIndex = i === active ? 0 : -1;
    });
    if (focus) buttons[active]?.focus({ preventScroll: true });
  }

  function control(button: HTMLButtonElement, action: () => void): void {
    const index = buttons.length;
    buttons.push(button);
    button.type = "button";
    button.addEventListener("click", () => {
      wantsFocus = wantsFocus || element.contains(document.activeElement);
      action();
    });
    button.addEventListener("focus", () => setActive(index, false));
    button.addEventListener("pointerenter", () =>
      setActive(index, element.contains(document.activeElement)),
    );
  }

  function option(label: string, action: () => void): HTMLButtonElement {
    const button = el("button", "menu-option single");
    button.append(
      el("span", "menu-caret", "❯"),
      el("span", "menu-label", label),
    );
    control(button, action);
    return button;
  }

  function menu(): HTMLElement {
    const box = el("div", "menu");
    box.setAttribute("role", "group");
    box.setAttribute("aria-labelledby", "menu-title");
    const title = el("div", "menu-title", "What should Claude do?");
    title.id = "menu-title";
    const list = el("div", "menu-list");
    const found = options.found();
    choices.forEach((choice, index) => {
      const button = el("button", "menu-option");
      button.setAttribute(
        "aria-label",
        `${index + 1}. ${choice.label}. Shows ${stateLabels[choice.state]}${found.has(choice.state) ? ", found" : ""}`,
      );
      button.append(
        el("span", "menu-caret", "❯"),
        el("span", "menu-number", `${index + 1}.`),
        el("span", "menu-label", choice.label),
      );
      control(button, () => {
        if (terminal.prompt.kind === "menu") options.choose(choice.id);
      });
      list.append(button);
    });
    box.append(title, list);
    return box;
  }

  function action(
    title: string,
    label: string,
    run: () => void,
    className = "",
  ): HTMLElement {
    const box = el("div", "menu");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", title);
    box.append(
      el("div", `menu-title ${className}`.trim(), title),
      option(label, run),
    );
    return box;
  }

  function permission(tool: string, command: string): HTMLElement {
    const box = el("div", "permission");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Permission request");
    const row = el("div", "choices");
    for (const [label, allow] of [
      ["Yes", true],
      ["No", false],
    ] as const) {
      const button = el("button", `choice ${allow ? "yes" : "no"}`, label);
      button.setAttribute(
        "aria-label",
        `${label}, ${allow ? "allow" : "deny"} ${tool}: ${command}`,
      );
      control(button, () => options.answer(allow));
      row.append(button);
    }
    box.append(
      el("div", "ask", `Allow ${tool}: ${command}?`),
      el("div", "muted", "Run the test suite"),
      row,
    );
    return box;
  }

  function renderPrompt(): void {
    const current = terminal.prompt;
    wantsFocus = wantsFocus || element.contains(document.activeElement);
    buttons = [];
    horizontal = current.kind === "permission";
    const nodes: HTMLElement[] = [];
    if (current.kind === "menu") nodes.push(menu());
    else if (current.kind === "permission")
      nodes.push(permission(current.tool, current.command));
    else if (current.kind === "reconnect")
      nodes.push(
        action("Peep lost the signal.", "Reconnect to Claude Code", () =>
          options.reconnect(),
        ),
      );
    else if (current.kind === "agents")
      nodes.push(
        action(
          "⧗ Background agents running",
          "Finish now",
          () => options.finish(),
          "status",
        ),
      );
    else if (current.kind === "task")
      nodes.push(
        action(
          "✻ Working…",
          "Finish task",
          () => options.finishTask(),
          "status",
        ),
      );
    else
      nodes.push(
        el("div", "status", "✻ Working… (esc to interrupt)"),
        cursorBox(),
      );
    prompt.replaceChildren(...nodes);
    setActive(current.kind === "menu" ? menuActive : 0, false);
    if (wantsFocus && buttons.length > 0) {
      buttons[active]?.focus({ preventScroll: true });
      wantsFocus = false;
    }
  }

  function render(): void {
    const key = `${terminal.prompt.kind}:${options.found().size}`;
    if (key !== shownPrompt) {
      shownPrompt = key;
      renderPrompt();
    }
    if (terminal.lines.length !== shownLines) {
      lines.append(...terminal.lines.slice(shownLines).map(line));
      shownLines = terminal.lines.length;
    }
    scroll.scrollTop = scroll.scrollHeight;
    const kind = terminal.prompt.kind;
    footer.textContent =
      kind === "menu"
        ? "↑↓ to move · Enter to choose"
        : kind === "permission"
          ? "←→ to move · Enter to choose"
          : kind === "busy"
            ? "? for shortcuts"
            : "Enter to choose";
  }

  const onKey = (event: KeyboardEvent) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      buttons.length === 0 ||
      typing(event.target) ||
      dropdownOpen()
    )
      return;
    const focused = document.activeElement;
    const inside =
      focused === null ||
      focused === document.body ||
      element.contains(focused);
    const step =
      event.key === "ArrowDown" || (horizontal && event.key === "ArrowRight")
        ? 1
        : event.key === "ArrowUp" || (horizontal && event.key === "ArrowLeft")
          ? -1
          : 0;
    if (step !== 0) setActive(active + step, inside);
    else if (event.key === "Enter" && inside && !event.repeat)
      buttons[active]?.click();
    else return;
    event.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  render();
  return {
    element,
    render,
    destroy: () => document.removeEventListener("keydown", onKey),
  };
}
