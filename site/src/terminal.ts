import type { Line, Prompt, Task, Terminal } from "./demo.ts";
import { el } from "./windows.ts";

const TASK_LABELS: Record<Task, string> = {
  run: "Run task",
  agents: "Start 2 background agents",
};

function line(item: Line): HTMLLIElement {
  const row = el("li", `line ${item.kind}`);
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
  }
  return row;
}

function cursorBox(): HTMLElement {
  const box = el("div", "input");
  box.append(el("span", "mark", ">"), el("span", "cursor"));
  box.setAttribute("aria-hidden", "true");
  return box;
}

function promptKey(prompt: Prompt): string {
  return prompt.kind === "tasks" ? `tasks:${prompt.tasks.join()}` : prompt.kind;
}

export function createTerminalView(
  terminal: Terminal,
  options: {
    start: (task: Task) => void;
    answer: (allow: boolean) => void;
    hint: () => boolean;
  },
): { element: HTMLElement; render: () => void } {
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
  scroll.append(welcome, lines);
  const prompt = el("div", "term-prompt");
  const footer = el("div", "term-footer");
  element.append(scroll, prompt, footer);
  let shownLines = 0;
  let shownPrompt = "";

  function renderPrompt(): void {
    const current = terminal.prompt;
    const nodes: HTMLElement[] = [];
    if (current.kind === "permission") {
      const box = el("div", "permission");
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", "Permission request");
      const choices = el("div", "choices");
      for (const [label, allow] of [
        ["Yes", true],
        ["No", false],
      ] as const) {
        const button = el("button", `choice ${allow ? "yes" : "no"}`, label);
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${label}, ${allow ? "allow" : "deny"} ${current.tool}: ${current.command}`,
        );
        button.addEventListener("click", () => options.answer(allow));
        choices.append(button);
      }
      box.append(
        el("div", "ask", `Allow ${current.tool}: ${current.command}?`),
        el("div", "muted", "Run the test suite"),
        choices,
      );
      nodes.push(box);
    } else {
      if (terminal.state === "working")
        nodes.push(el("div", "status", "✻ Working… (esc to interrupt)"));
      else if (terminal.state === "background")
        nodes.push(el("div", "status muted", "⧗ Background agents running"));
      nodes.push(cursorBox());
      if (current.kind === "tasks") {
        const actions = el("div", "actions");
        for (const task of current.tasks) {
          const button = el(
            "button",
            task === "run" ? "action" : "action secondary",
          );
          button.type = "button";
          if (task === "run") button.append(el("span", "play", "▶"));
          button.append(TASK_LABELS[task]);
          if (task === "run" && options.hint()) button.classList.add("hint");
          button.addEventListener("click", () => options.start(task));
          actions.append(button);
        }
        nodes.push(actions);
      }
    }
    prompt.replaceChildren(...nodes);
  }

  function render(): void {
    const key = `${promptKey(terminal.prompt)}:${terminal.state}`;
    if (key !== shownPrompt) {
      shownPrompt = key;
      renderPrompt();
      scroll.scrollTop = scroll.scrollHeight;
    }
    if (terminal.lines.length !== shownLines) {
      lines.append(...terminal.lines.slice(shownLines).map(line));
      shownLines = terminal.lines.length;
      scroll.scrollTop = scroll.scrollHeight;
    }
    footer.textContent =
      terminal.prompt.kind === "permission"
        ? "Waiting for your answer"
        : "? for shortcuts";
  }

  render();
  return { element, render };
}
