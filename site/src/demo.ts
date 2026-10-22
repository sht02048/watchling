import {
  semanticStates,
  type SemanticState,
  type SessionDetail,
  type SessionSummary,
  type Snapshot,
} from "../../src/shared/ui-contract.ts";

export type Task = "run" | "agents";
export type LineKind = "user" | "tool" | "result" | "text" | "done";

export interface Line {
  kind: LineKind;
  text: string;
  tool?: string;
}

export type Prompt =
  | { kind: "tasks"; tasks: readonly Task[] }
  | { kind: "permission"; tool: string; command: string }
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
  permissionDelay: number;
  agentDurations: readonly [number, number];
}

type Moment =
  "start" | "done" | "denied" | "agents-done" | "reconnected" | "other";

const SESSION = {
  project: "pocket-notes",
  sessionId: "3f9c2e1a-7b40-4d1e-9a61-0c5d2b8e4f17",
};
const TASKS: readonly Task[] = ["run", "agents"];

const RUN_LINES: Line[] = [
  { kind: "user", text: "Fix the flaky date test in utils" },
  { kind: "tool", text: "Read(src/utils/date.ts)", tool: "Read" },
  { kind: "result", text: "Read 48 lines" },
  { kind: "tool", text: "Read(src/utils/date.test.ts)", tool: "Read" },
  { kind: "result", text: "Read 31 lines" },
  { kind: "text", text: "The test depends on the local timezone. Pinning it." },
  { kind: "tool", text: "Edit(src/utils/date.test.ts)", tool: "Edit" },
  { kind: "result", text: "Updated with 2 additions and 1 removal" },
];
const APPROVED_LINES: Line[] = [
  { kind: "tool", text: "Bash(pnpm test)", tool: "Bash" },
  { kind: "result", text: "24 passed (1.2s)" },
  { kind: "done", text: "Fixed. The date test now pins UTC and passes." },
];
const DENIED_LINES: Line[] = [
  { kind: "result", text: "Not run" },
  {
    kind: "done",
    text: "Okay, I won't run the tests. What should I try next?",
  },
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
const AGENT_NAMES = ["Review the docs", "Audit dependencies"];

const rank = (state: SemanticState) => semanticStates.indexOf(state);

export function overallState(states: readonly SemanticState[]): SemanticState {
  return states.reduce<SemanticState>(
    (top, state) => (rank(state) > rank(top) ? state : top),
    "idle",
  );
}

export function createDemo(options: {
  pointer: string;
  timing: () => Timing;
  onChange: () => void;
}) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const terminals: Terminal[] = [
    {
      id: 1,
      ...SESSION,
      state: "idle",
      since: Date.now(),
      detail: null,
      lines: [],
      prompt: { kind: "tasks", tasks: TASKS },
    },
  ];
  let connected = true;
  let moment: Moment = "start";
  let destroyed = false;

  function later(seconds: number, action: () => void): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!destroyed) action();
    }, seconds * 1000);
    timers.add(timer);
  }

  function set(
    terminal: Terminal,
    state: SemanticState,
    detail: SessionDetail | null,
  ): void {
    if (terminal.state !== state) terminal.since = Date.now();
    terminal.state = state;
    terminal.detail = detail;
  }

  function changed(next: Moment = "other"): void {
    moment = next;
    options.onChange();
  }

  function stream(terminal: Terminal, lines: Line[], then: () => void): void {
    const step = options.timing().typeSpeed / 1000;
    const push = (index: number) => {
      const line = lines[index];
      if (!line) return then();
      terminal.lines.push(line);
      if (line.tool && terminal.state === "working")
        terminal.detail = { kind: "tool", tool: line.tool };
      changed();
      if (step <= 0) push(index + 1);
      else later(step, () => push(index + 1));
    };
    push(0);
  }

  function idle(terminal: Terminal, next: Moment): void {
    set(terminal, "idle", null);
    terminal.prompt = { kind: "tasks", tasks: TASKS };
    changed(next);
  }

  function run(terminal: Terminal): void {
    const started = Date.now();
    terminal.prompt = { kind: "busy" };
    set(terminal, "working", { kind: "tool", tool: "Read" });
    stream(terminal, RUN_LINES, () => {
      const wait =
        options.timing().permissionDelay - (Date.now() - started) / 1000;
      later(Math.max(0, wait), () => {
        terminal.prompt = {
          kind: "permission",
          tool: "Bash",
          command: "pnpm test",
        };
        set(terminal, "asking", { kind: "permission", tool: "Bash" });
        changed();
      });
    });
  }

  function startAgents(terminal: Terminal): void {
    terminal.prompt = { kind: "busy" };
    set(terminal, "working", { kind: "tool", tool: "Task" });
    stream(terminal, AGENT_LINES, () => {
      set(terminal, "background", { kind: "agents", count: 2 });
      changed();
      const durations = [...options.timing().agentDurations].sort(
        (a, b) => a - b,
      );
      durations.forEach((duration, index) =>
        later(duration, () => {
          const left = durations.length - index - 1;
          terminal.lines.push({
            kind: left > 0 ? "result" : "done",
            text:
              left > 0
                ? `Agent "${AGENT_NAMES[index]}" finished`
                : `Agent "${AGENT_NAMES[index]}" finished. Both reports are in.`,
          });
          if (left > 0) {
            set(terminal, "background", { kind: "agents", count: left });
            changed();
          } else idle(terminal, "agents-done");
        }),
      );
    });
  }

  function find(id: number): Terminal | undefined {
    return terminals.find((terminal) => terminal.id === id);
  }

  return {
    terminals,
    get connected() {
      return connected;
    },
    start(id: number, task: Task): void {
      const terminal = find(id);
      if (!terminal || terminal.prompt.kind !== "tasks") return;
      if (task === "run") run(terminal);
      else startAgents(terminal);
    },
    answer(id: number, allow: boolean): void {
      const terminal = find(id);
      if (!terminal || terminal.prompt.kind !== "permission") return;
      terminal.prompt = { kind: "busy" };
      if (allow) {
        set(terminal, "working", { kind: "tool", tool: "Bash" });
        stream(terminal, APPROVED_LINES, () => idle(terminal, "done"));
      } else {
        set(terminal, "working", null);
        stream(terminal, DENIED_LINES, () => idle(terminal, "denied"));
      }
    },
    setConnected(next: boolean): void {
      if (next === connected) return;
      connected = next;
      changed(next ? "reconnected" : "other");
    },
    snapshot(): Snapshot {
      if (!connected) return { state: "unknown", sessions: [], companions: 0 };
      const sessions: SessionSummary[] = terminals.map((terminal) => ({
        id: terminal.sessionId,
        shortId: terminal.sessionId.slice(0, 8),
        project: terminal.project,
        state: terminal.state,
        since: terminal.since,
        detail: terminal.detail,
      }));
      return {
        state: overallState(sessions.map((session) => session.state)),
        sessions,
        companions: terminals.reduce(
          (sum, terminal) =>
            sum +
            (terminal.state === "background" &&
            terminal.detail?.kind === "agents"
              ? terminal.detail.count
              : 0),
          0,
        ),
      };
    },
    bubble(): string {
      const snapshot = this.snapshot();
      switch (snapshot.state) {
        case "unknown":
          return "I lost track of your sessions.";
        case "asking":
          return "Claude needs you in the terminal.";
        case "working":
          return "Claude is busy in the terminal. I'll keep watch.";
        case "background":
          return snapshot.companions === 1
            ? "One agent left. It's riding on my head."
            : `${snapshot.companions} agents are working in the background. They ride on my head.`;
        case "idle":
          switch (moment) {
            case "start":
              return `I'm Peep from Watchling. I sit on your desktop and watch your Claude Code sessions. Try Run task ${options.pointer}`;
            case "done":
              return "All done. Click me to see your sessions.";
            case "denied":
              return "Okay, nothing ran. Claude is waiting for you.";
            case "agents-done":
              return "Both agents are back. All quiet now.";
            case "reconnected":
              return "I can see your sessions again.";
            case "other":
              return "All quiet. Give Claude something else to do.";
          }
      }
    },
    destroy(): void {
      destroyed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type Demo = ReturnType<typeof createDemo>;
