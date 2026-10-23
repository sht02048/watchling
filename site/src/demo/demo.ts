import {
  semanticStates,
  type SemanticState,
  type SessionDetail,
  type SessionSummary,
  type Snapshot,
} from "@watchling/shared/ui-contract.ts";

export const choices = [
  { id: "work", label: "Work on a task", state: "working" },
  { id: "ask", label: "Ask for permission", state: "asking" },
  { id: "agents", label: "Run background agents", state: "subagents" },
  { id: "disconnect", label: "Lose the connection", state: "unknown" },
] as const satisfies readonly {
  id: string;
  label: string;
  state: SemanticState;
}[];
export type Choice = (typeof choices)[number]["id"];
export type LineKind = "user" | "tool" | "result" | "text" | "done" | "peep";

export interface Line {
  kind: LineKind;
  text: string;
  tool?: string;
  state?: SemanticState;
}

export type Prompt =
  | { kind: "menu" }
  | { kind: "permission"; tool: string; command: string }
  | { kind: "reconnect" }
  | { kind: "agents" }
  | { kind: "task" }
  | { kind: "busy" };

export interface Terminal {
  id: number;
  project: string;
  sessionId: string;
  state: SemanticState;
  since: number;
  detail: SessionDetail | null;
  lines: Line[];
  prompt: Prompt;
}

export interface Timing {
  typeSpeed: number;
  agentDurations: readonly [number, number];
}

const SESSION = {
  project: "pocket-notes",
  sessionId: "3f9c2e1a-7b40-4d1e-9a61-0c5d2b8e4f17",
};

const peep = (text: string, state: SemanticState): Line => ({
  kind: "peep",
  text,
  state,
});

const WORK_LINES: Line[] = [
  { kind: "user", text: "Add a search box to the notes list" },
  peep("Claude is working, so I turned orange and got busy too.", "working"),
  { kind: "tool", text: "Read(src/notes/NoteList.ts)", tool: "Read" },
  { kind: "result", text: "Read 64 lines" },
  { kind: "tool", text: "Edit(src/notes/NoteList.ts)", tool: "Edit" },
  { kind: "result", text: "Updated with 18 additions and 2 removals" },
  { kind: "text", text: "Wiring the filter into the list next." },
];
const FINISHED_LINES: Line[] = [
  { kind: "tool", text: "Bash(pnpm test notes)", tool: "Bash" },
  { kind: "result", text: "12 passed (0.8s)" },
  { kind: "done", text: "Added a search box that filters notes as you type." },
  peep("Claude finished, so I'm back to idle.", "idle"),
];
const ASK_LINES: Line[] = [
  { kind: "user", text: "Make sure the date tests pass" },
  { kind: "text", text: "I'll run the test suite." },
];
const APPROVED_LINES: Line[] = [
  { kind: "tool", text: "Bash(pnpm test)", tool: "Bash" },
  { kind: "result", text: "24 passed (1.2s)" },
  { kind: "done", text: "Fixed. The date test now pins UTC and passes." },
  peep("You answered, so I calmed down. Back to idle.", "idle"),
];
const DENIED_LINES: Line[] = [
  { kind: "tool", text: "Bash(pnpm test)", tool: "Bash" },
  { kind: "result", text: "Denied by you" },
  { kind: "done", text: "Okay, I won't run the tests. What should I try?" },
  peep("Nothing ran. I'm idle until Claude gets something new.", "idle"),
];
const AGENT_LINES: Line[] = [
  {
    kind: "user",
    text: "Review the docs and audit dependencies in the background",
  },
  { kind: "tool", text: "Task(Review the docs)", tool: "Task" },
  { kind: "result", text: "Running in the background" },
  { kind: "tool", text: "Task(Audit dependencies)", tool: "Task" },
  { kind: "result", text: "Running in the background" },
  { kind: "text", text: "Both agents are on it. I'll report back." },
];
const TASK_SECONDS = 5;
const AGENT_NAMES = ["Review the docs", "Audit dependencies"];
const rank = (state: SemanticState) => semanticStates.indexOf(state);

export function overallState(states: readonly SemanticState[]): SemanticState {
  return states.reduce<SemanticState>(
    (top, state) => (rank(state) > rank(top) ? state : top),
    "idle",
  );
}

export function createDemo(options: {
  timing: () => Timing;
  onChange: () => void;
}) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const terminal: Terminal = {
    id: 1,
    ...SESSION,
    state: "idle",
    since: Date.now(),
    detail: null,
    lines: [
      peep(
        "I'm Peep from Watchling. I sit on your desktop and watch your Claude Code sessions. Pick something for Claude to do.",
        "idle",
      ),
    ],
    prompt: { kind: "menu" },
  };
  let connected = true;
  let destroyed = false;

  let agentTimers: ReturnType<typeof setTimeout>[] = [];
  let taskTimer: ReturnType<typeof setTimeout> | undefined;
  let agentsLeft: string[] = [];

  function later(
    seconds: number,
    action: () => void,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!destroyed) action();
    }, seconds * 1000);
    timers.add(timer);
    return timer;
  }

  function set(state: SemanticState, detail: SessionDetail | null): void {
    if (terminal.state !== state) terminal.since = Date.now();
    terminal.state = state;
    terminal.detail = detail;
  }

  function stream(lines: Line[], then: () => void): void {
    const step = options.timing().typeSpeed / 1000;
    const push = (index: number) => {
      const line = lines[index];
      if (!line) return then();
      terminal.lines.push(line);
      if (line.tool && terminal.state === "working")
        terminal.detail = { kind: "tool", tool: line.tool };
      options.onChange();
      if (step <= 0) push(index + 1);
      else later(step, () => push(index + 1));
    };
    push(0);
  }

  function ready(): void {
    set("idle", null);
    terminal.prompt = connected ? { kind: "menu" } : { kind: "reconnect" };
    options.onChange();
  }

  function work(): void {
    const started = Date.now();
    set("working", { kind: "tool", tool: "Read" });
    stream(WORK_LINES, () => {
      terminal.prompt = { kind: "task" };
      options.onChange();
      const left = TASK_SECONDS - (Date.now() - started) / 1000;
      taskTimer = later(Math.max(0, left), finishTask);
    });
  }

  function finishTask(): void {
    if (terminal.prompt.kind !== "task") return;
    if (taskTimer !== undefined) {
      clearTimeout(taskTimer);
      timers.delete(taskTimer);
      taskTimer = undefined;
    }
    terminal.prompt = { kind: "busy" };
    terminal.detail = { kind: "tool", tool: "Bash" };
    stream(FINISHED_LINES, ready);
  }

  function ask(): void {
    set("asking", { kind: "permission", tool: "Bash" });
    terminal.lines.push(
      ...ASK_LINES,
      peep(
        "Claude needs you. I turned purple and raised a ! so you'd notice.",
        "asking",
      ),
    );
    terminal.prompt = {
      kind: "permission",
      tool: "Bash",
      command: "pnpm test",
    };
    options.onChange();
  }

  function agents(): void {
    set("working", { kind: "tool", tool: "Task" });
    stream(AGENT_LINES, () => {
      agentsLeft = [...AGENT_NAMES];
      set("subagents", { kind: "agents", count: agentsLeft.length });
      terminal.lines.push(
        peep(
          "The main turn is done, but 2 agents still run. They ride on my head until they finish.",
          "subagents",
        ),
      );
      terminal.prompt = { kind: "agents" };
      options.onChange();
      agentTimers = [...options.timing().agentDurations]
        .sort((a, b) => a - b)
        .map((duration) => later(duration, agentFinished));
    });
  }

  function agentFinished(): void {
    const name = agentsLeft.shift();
    if (name === undefined) return;
    terminal.lines.push({ kind: "result", text: `Agent "${name}" finished` });
    if (agentsLeft.length > 0) {
      set("subagents", { kind: "agents", count: agentsLeft.length });
      options.onChange();
      return;
    }
    agentsDone([
      { kind: "done", text: "Both reports are in." },
      peep("Both agents are back, so I'm idle again.", "idle"),
    ]);
  }

  function finishAgents(): void {
    if (terminal.prompt.kind !== "agents") return;
    for (const name of agentsLeft)
      terminal.lines.push({ kind: "result", text: `Stopped agent "${name}"` });
    agentsLeft = [];
    agentsDone([
      { kind: "done", text: "Stopped the background agents." },
      peep("No agents left on my head, so I'm idle again.", "idle"),
    ]);
  }

  function agentsDone(lines: Line[]): void {
    for (const timer of agentTimers) {
      clearTimeout(timer);
      timers.delete(timer);
    }
    agentTimers = [];
    terminal.prompt = { kind: "busy" };
    set("idle", null);
    stream(lines, ready);
  }

  function setConnected(next: boolean): void {
    if (next === connected) return;
    connected = next;
    if (next) {
      terminal.lines.push(
        { kind: "result", text: "Reconnected to Claude Code" },
        peep(
          "Signals are back, so I can see Claude again. Back to idle.",
          "idle",
        ),
      );
      if (terminal.prompt.kind === "reconnect")
        terminal.prompt = { kind: "menu" };
    } else {
      terminal.lines.push(
        peep(
          "Signals stopped, so I can't tell what Claude is doing. I turn grey instead of guessing.",
          "unknown",
        ),
      );
      if (terminal.prompt.kind === "menu")
        terminal.prompt = { kind: "reconnect" };
    }
    options.onChange();
  }

  function snapshot(): Snapshot {
    if (!connected) return { state: "unknown", sessions: [], companions: 0 };
    return {
      state: overallState([terminal.state]),
      sessions: [
        {
          id: terminal.sessionId,
          shortId: terminal.sessionId.slice(0, 8),
          project: terminal.project,
          state: terminal.state,
          since: terminal.since,
          detail: terminal.detail,
        } satisfies SessionSummary,
      ],
      companions:
        terminal.state === "subagents" && terminal.detail?.kind === "agents"
          ? terminal.detail.count
          : 0,
    };
  }

  return {
    terminal,
    get connected() {
      return connected;
    },
    choose(choice: Choice): void {
      if (terminal.prompt.kind !== "menu") return;
      if (choice === "disconnect") return setConnected(false);
      terminal.prompt = { kind: "busy" };
      if (choice === "work") work();
      else if (choice === "ask") ask();
      else agents();
    },
    answer(allow: boolean): void {
      if (terminal.prompt.kind !== "permission") return;
      terminal.prompt = { kind: "busy" };
      set("working", allow ? { kind: "tool", tool: "Bash" } : null);
      stream(allow ? APPROVED_LINES : DENIED_LINES, ready);
    },
    finishAgents,
    finishTask,
    setConnected,
    snapshot,
    destroy(): void {
      destroyed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type Demo = ReturnType<typeof createDemo>;
