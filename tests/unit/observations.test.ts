import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Observations } from "../../src/domain/observations.ts";
import {
  isClaudeEvent,
  type ClaudeEvent,
} from "../../src/integration/claude/protocol.ts";

const fpA = "a".repeat(32);
const fpB = "b".repeat(32);

function event(
  eventName: ClaudeEvent["eventName"],
  fields: Partial<ClaudeEvent> = {},
): ClaudeEvent {
  return { eventName, sessionId: "session-1", project: "project", ...fields };
}
function feed(observations: Observations, ...events: ClaudeEvent[]): void {
  for (const item of events) observations.receive(item);
}
function stateOf(observations: Observations, sessionId = "session-1") {
  const snapshot = observations.snapshot();
  return snapshot.sessions.find((row) => sessionId.startsWith(row.id))?.state;
}

test("aggregate shows the highest session state in priority order", () => {
  const observations = new Observations();
  assert.equal(observations.snapshot().state, "idle");
  assert.deepEqual(observations.snapshot().sessions, []);
  feed(observations, event("SessionStart", { sessionId: "a" }));
  assert.equal(observations.snapshot().state, "idle");
  feed(
    observations,
    event("UserPromptSubmit", { sessionId: "b" }),
    event("Stop", { sessionId: "b" }),
  );
  assert.equal(observations.snapshot().state, "idle");
  feed(observations, event("UserPromptSubmit", { sessionId: "c" }));
  assert.equal(observations.snapshot().state, "working");
  observations.loseIntegrity();
  feed(observations, event("UserPromptSubmit", { sessionId: "c" }));
  assert.equal(observations.snapshot().state, "unknown");
  feed(
    observations,
    event("PermissionRequest", { sessionId: "d", toolName: "Bash" }),
  );
  assert.equal(observations.snapshot().state, "asking");
  assert.deepEqual(
    observations.snapshot().sessions.map((row) => [row.id, row.state]),
    [
      ["a", "unknown"],
      ["b", "unknown"],
      ["c", "working"],
      ["d", "asking"],
    ],
  );
});

test("sessions in the same project are independent and short IDs stay distinct", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit", { sessionId: "sameprefix-A" }),
    event("UserPromptSubmit", { sessionId: "sameprefix-B" }),
    event("Stop", { sessionId: "sameprefix-A" }),
  );
  const sessions = observations.snapshot().sessions;
  assert.deepEqual(
    sessions.map((row) => [row.id, row.project, row.state]),
    [
      ["sameprefix-A", "project", "idle"],
      ["sameprefix-B", "project", "working"],
    ],
  );
  assert.equal(sessions[0]!.detail, null);
});

test("two asks are cleared independently", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t2" }),
    event("PostToolUse", { toolName: "Bash", toolUseId: "t1" }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolUse", { toolName: "Bash", toolUseId: "t2" }),
  );
  assert.equal(stateOf(observations), "working");
});

test("AskUserQuestion pre-tool and permission request form one ask cleared by its post event", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", {
      toolName: "AskUserQuestion",
      toolUseId: "q1",
      inputFingerprint: fpA,
    }),
    event("PermissionRequest", {
      toolName: "AskUserQuestion",
      inputFingerprint: fpA,
    }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolUse", {
      toolName: "AskUserQuestion",
      toolUseId: "q1",
      inputFingerprint: fpB,
    }),
  );
  assert.equal(stateOf(observations), "working");
});

test("permission request binds to its pre-tool id and clears on the batch", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", {
      toolName: "Bash",
      toolUseId: "t1",
      inputFingerprint: fpA,
    }),
    event("PreToolUse", {
      toolName: "Read",
      toolUseId: "t2",
      inputFingerprint: fpB,
    }),
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolBatch", {
      toolCalls: [{ toolName: "Read", toolUseId: "t2" }],
    }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolBatch", {
      toolCalls: [{ toolName: "Bash", toolUseId: "t1" }],
    }),
  );
  assert.equal(stateOf(observations), "working");
});

test("ambiguous fingerprint clear marks the session unknown", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
    event("PostToolUse", {
      toolName: "Bash",
      toolUseId: "t1",
      inputFingerprint: fpA,
    }),
  );
  assert.equal(stateOf(observations), "unknown");
  feed(observations, event("Stop"));
  assert.equal(stateOf(observations), "unknown");
  feed(observations, event("UserPromptSubmit"));
  assert.equal(stateOf(observations), "working");
});

test("a single fingerprint ask clears on its matching post event", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
    event("PostToolUse", {
      toolName: "Bash",
      toolUseId: "t1",
      inputFingerprint: fpB,
    }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolUse", {
      toolName: "Bash",
      toolUseId: "t2",
      inputFingerprint: fpA,
    }),
  );
  assert.equal(stateOf(observations), "working");
});

test("non-interactive permission requests and notifications never ask", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", interactive: false }),
    event("Notification", {
      notificationType: "permission_prompt",
      interactive: false,
    }),
  );
  assert.equal(stateOf(observations), "working");
});

test("a notification ask is cleared by any post-tool event", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("Notification", { notificationType: "permission_prompt" }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolUseFailure", { toolName: "Bash", toolUseId: "other" }),
  );
  assert.equal(stateOf(observations), "working");
});

test("a notification adds nothing when an ask is already pending", () => {
  const observations = new Observations();
  feed(
    observations,
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
    event("Notification", { notificationType: "permission_prompt" }),
    event("PostToolUse", { toolName: "Bash", toolUseId: "t1" }),
  );
  assert.equal(stateOf(observations), "working");
});

test("an Esc interrupt ends the turn as done", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
    event("PermissionRequest", { toolName: "Read", toolUseId: "t2" }),
    event("PostToolUseFailure", {
      toolName: "Bash",
      toolUseId: "t1",
      isInterrupt: true,
    }),
  );
  assert.equal(stateOf(observations), "idle");
});

test("a turn end from the mod ends work and the main turn's asks", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"));
  feed(observations, event("TurnEnded", { agentId: "agent-1" }));
  assert.equal(stateOf(observations), "working");
  feed(observations, event("TurnEnded"));
  assert.equal(stateOf(observations), "idle");
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", { toolName: "Bash", toolUseId: "t1" }),
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
    event("PreToolUse", { toolName: "AskUserQuestion", toolUseId: "t2" }),
    event("Notification", { notificationType: "permission_prompt" }),
    event("TurnEnded"),
  );
  assert.equal(stateOf(observations), "idle");
  assert.equal(observations.snapshot().sessions[0]?.detail, null);
});

test("a turn end from the mod keeps asks from background agents", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "launch",
      childAgentId: "agent-1",
      childStatus: "async_launched",
    }),
    event("PermissionRequest", {
      toolName: "Bash",
      agentId: "agent-1",
      inputFingerprint: fpA,
    }),
    event("PermissionRequest", { toolName: "Read", toolUseId: "t1" }),
    event("TurnEnded"),
  );
  assert.equal(stateOf(observations), "asking");
  assert.deepEqual(observations.snapshot().sessions[0]?.detail, {
    kind: "permission",
    tool: "Bash",
  });
  feed(
    observations,
    event("PostToolUse", {
      toolName: "Bash",
      toolUseId: "t9",
      agentId: "agent-1",
      inputFingerprint: fpA,
    }),
  );
  assert.equal(stateOf(observations), "subagents");
});

test("a turn end drops asks from foreground agents, which end with the turn", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", {
      toolName: "Bash",
      agentId: "foreground",
      toolUseId: "t1",
    }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(observations, event("TurnEnded"));
  assert.equal(stateOf(observations), "idle");
});

test("an interrupted subagent tool leaves the main turn running", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Read", toolUseId: "main" }),
    event("PostToolUseFailure", {
      toolName: "Bash",
      toolUseId: "t1",
      agentId: "agent-1",
      isInterrupt: true,
    }),
  );
  assert.equal(stateOf(observations), "asking");
});

test("a denial without a post event keeps asking until the next prompt", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", {
      toolName: "Bash",
      toolUseId: "t1",
      inputFingerprint: fpA,
    }),
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
    event("PreToolUse", { toolName: "Read", toolUseId: "t2" }),
    event("PostToolUse", { toolName: "Read", toolUseId: "t2" }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(observations, event("UserPromptSubmit"));
  assert.equal(stateOf(observations), "working");
});

test("Stop clears asks and ends the turn", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
    event("Stop", { agentId: "child" }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(observations, event("Stop"));
  assert.equal(stateOf(observations), "idle");
});

test("integrity loss marks sessions unknown until their own next prompt", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit", { sessionId: "a" }),
    event("UserPromptSubmit", { sessionId: "b" }),
  );
  observations.loseIntegrity();
  assert.equal(stateOf(observations, "a"), "unknown");
  feed(
    observations,
    event("PreToolUse", { sessionId: "a", toolName: "Bash", toolUseId: "t" }),
    event("Stop", { sessionId: "a" }),
  );
  assert.equal(stateOf(observations, "a"), "unknown");
  feed(observations, event("UserPromptSubmit", { sessionId: "a" }));
  assert.equal(stateOf(observations, "a"), "working");
  assert.equal(stateOf(observations, "b"), "unknown");
  assert.equal(observations.snapshot().state, "unknown");
  feed(observations, event("UserPromptSubmit", { sessionId: "c" }));
  assert.equal(stateOf(observations, "c"), "working");
});

test("integrity loss with no sessions shows unknown until the next event", () => {
  const observations = new Observations();
  observations.loseIntegrity();
  assert.equal(observations.snapshot().state, "unknown");
  assert.deepEqual(observations.snapshot().sessions, []);
  feed(observations, event("SessionStart"));
  assert.equal(observations.snapshot().state, "idle");
});

test("a receiver failure keeps the aggregate unknown", () => {
  const observations = new Observations();
  observations.receiverFailed();
  assert.equal(observations.snapshot().state, "unknown");
  feed(observations, event("UserPromptSubmit"), event("Stop"));
  assert.equal(observations.snapshot().state, "unknown");
  assert.equal(stateOf(observations), "idle");
  feed(
    observations,
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
  );
  assert.equal(observations.snapshot().state, "asking");
});

test("subagent activity after Stop keeps the session idle", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("Stop"),
    event("PreToolUse", { agentId: "child", toolName: "Bash", toolUseId: "t" }),
    event("PostToolUse", {
      agentId: "child",
      toolName: "Bash",
      toolUseId: "t",
    }),
    event("SubagentStart", { agentId: "child" }),
    event("SubagentStop", { agentId: "child" }),
  );
  assert.equal(stateOf(observations), "idle");
  feed(
    observations,
    event("PermissionRequest", { agentId: "child", toolName: "Bash" }),
  );
  assert.equal(stateOf(observations), "asking");
});

test("subagent events fold into their parent session and child lifecycle cannot end it", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit", { sessionId: "root" }),
    event("SubagentStart", { sessionId: "root", agentId: "child" }),
    event("SessionEnd", { sessionId: "root", agentId: "child" }),
  );
  assert.equal(stateOf(observations, "root"), "working");
  assert.equal(observations.snapshot().sessions.length, 1);
  feed(observations, event("SessionEnd", { sessionId: "root" }));
  assert.equal(observations.snapshot().sessions.length, 0);
  assert.equal(observations.snapshot().state, "idle");
});

test("SessionStart keeps an existing session's state", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"), event("SessionStart"));
  assert.equal(stateOf(observations), "working");
});

test("pending pre-tool overflow evicts the oldest without unknown", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"));
  for (let i = 0; i < 65; i++)
    feed(
      observations,
      event("PreToolUse", {
        toolName: "Bash",
        toolUseId: `t${i}`,
        inputFingerprint: i === 0 ? fpA : fpB,
      }),
    );
  assert.equal(stateOf(observations), "working");
  feed(
    observations,
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
    event("PostToolBatch", {
      toolCalls: [{ toolName: "Bash", toolUseId: "t0" }],
    }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolUse", {
      toolName: "Bash",
      toolUseId: "t0",
      inputFingerprint: fpA,
    }),
  );
  assert.equal(stateOf(observations), "working");
});

test("ask overflow marks the session unknown", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"));
  for (let i = 0; i < 33; i++)
    feed(
      observations,
      event("PermissionRequest", { toolName: "Bash", toolUseId: `t${i}` }),
    );
  for (let i = 0; i < 32; i++)
    feed(
      observations,
      event("PostToolUse", { toolName: "Bash", toolUseId: `t${i}` }),
    );
  assert.equal(stateOf(observations), "unknown");
  feed(observations, event("UserPromptSubmit"));
  assert.equal(stateOf(observations), "working");
});

test("session capacity overflow drops the event and loses integrity", () => {
  const observations = new Observations();
  for (let i = 0; i < 129; i++)
    feed(observations, event("UserPromptSubmit", { sessionId: `s-${i}` }));
  const snapshot = observations.snapshot();
  assert.equal(snapshot.sessions.length, 128);
  assert.equal(snapshot.state, "unknown");
  assert.ok(snapshot.sessions.every((row) => row.state === "unknown"));
  feed(observations, event("UserPromptSubmit", { sessionId: "s-0" }));
  assert.equal(stateOf(observations, "s-0"), "working");
});

test("snapshots never carry fingerprints, interactivity or tool ids", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", {
      toolName: "SecretToolName",
      toolUseId: "secret-tool-id",
      inputFingerprint: fpA,
    }),
    event("PermissionRequest", {
      toolName: "SecretToolName",
      inputFingerprint: fpB,
      interactive: true,
    }),
  );
  const encoded = JSON.stringify(observations.snapshot());
  for (const secret of [
    fpA,
    fpB,
    "secret-tool-id",
    "interactive",
    "fingerprint",
  ])
    assert.ok(!encoded.includes(secret), secret);
  assert.deepEqual(Object.keys(observations.snapshot().sessions[0]!).sort(), [
    "detail",
    "id",
    "project",
    "shortId",
    "since",
    "state",
  ]);
  assert.deepEqual(observations.snapshot().sessions[0]!.detail, {
    kind: "permission",
    tool: "SecretToolName",
  });
});

test("repeated snapshots without events never change", async () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash" }),
  );
  const first = JSON.stringify(observations.snapshot());
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 5; i++)
    assert.equal(JSON.stringify(observations.snapshot()), first);
});

test("captured permission-host-none trace asks at the request and clears on the batch", () => {
  const fixture: { events: unknown[] } = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/claude/2.1.306-permission-host-none.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const observations = new Observations();
  const sequence: string[] = [];
  for (const item of fixture.events) {
    assert.ok(
      isClaudeEvent(item),
      "Captured projected event must satisfy the protocol",
    );
    observations.receive(item);
    sequence.push(`${item.eventName}:${observations.snapshot().state}`);
  }
  assert.deepEqual(sequence, [
    "SessionStart:idle",
    "UserPromptSubmit:working",
    "PreToolUse:working",
    "PermissionRequest:asking",
    "PostToolBatch:working",
    "Stop:idle",
    "SessionEnd:idle",
  ]);
});

test("a permission matching several pending tools stays fingerprint keyed", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", {
      toolName: "Bash",
      toolUseId: "t1",
      inputFingerprint: fpA,
    }),
    event("PreToolUse", {
      toolName: "Bash",
      toolUseId: "t2",
      inputFingerprint: fpA,
    }),
    event("PermissionRequest", { toolName: "Bash", inputFingerprint: fpA }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolBatch", {
      toolCalls: [{ toolName: "Bash", toolUseId: "t1" }],
    }),
  );
  assert.equal(stateOf(observations), "asking");
  feed(
    observations,
    event("PostToolUse", {
      toolName: "Bash",
      toolUseId: "t2",
      inputFingerprint: fpA,
    }),
  );
  assert.equal(stateOf(observations), "working");
});

test("stop failure ends the turn like stop", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"), event("StopFailure"));
  assert.equal(stateOf(observations), "idle");
});

test("non-interactive permission requests still count as activity", () => {
  const observations = new Observations();
  feed(
    observations,
    event("SessionStart"),
    event("PermissionRequest", { toolName: "Bash", interactive: false }),
  );
  assert.equal(stateOf(observations), "working");
});

test("events arriving after session end do not revive the session", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("SessionEnd"),
    event("PostToolUse", { toolName: "Bash", toolUseId: "t1" }),
    event("SubagentStop", { agentId: "agent-1" }),
  );
  assert.equal(observations.snapshot().sessions.length, 0);
  feed(observations, event("SessionStart"));
  assert.equal(stateOf(observations), "idle");
});

test("sessions first seen mid-turn after a loss start unknown", () => {
  const observations = new Observations();
  observations.loseIntegrity();
  feed(
    observations,
    event("PreToolUse", {
      sessionId: "late",
      toolName: "Bash",
      toolUseId: "t1",
    }),
    event("SessionStart", { sessionId: "fresh" }),
  );
  assert.equal(stateOf(observations, "late"), "unknown");
  assert.equal(stateOf(observations, "fresh"), "idle");
  feed(observations, event("UserPromptSubmit", { sessionId: "late" }));
  assert.equal(stateOf(observations, "late"), "working");
});

test("ended-session memory is bounded and forgets the oldest first", () => {
  const observations = new Observations();
  for (let i = 0; i <= 256; i++)
    feed(observations, event("SessionEnd", { sessionId: `ended-${i}` }));
  feed(
    observations,
    event("PreToolUse", {
      sessionId: "ended-0",
      toolName: "Bash",
      toolUseId: "t",
    }),
    event("PreToolUse", {
      sessionId: "ended-1",
      toolName: "Bash",
      toolUseId: "t",
    }),
  );
  assert.deepEqual(
    observations.snapshot().sessions.map((row) => row.project),
    ["project"],
  );
  assert.equal(stateOf(observations, "ended-0"), "working");
});

test("background subagents keep a finished turn in the background state", () => {
  const observations = new Observations();
  const launch = (agent: string) =>
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: `t-${agent}`,
      childAgentId: agent,
      childStatus: "async_launched",
    });
  feed(observations, event("UserPromptSubmit"), launch("a1"), launch("a2"));
  assert.equal(stateOf(observations), "working");
  feed(observations, event("Stop"));
  assert.equal(stateOf(observations), "subagents");
  assert.equal(observations.snapshot().state, "subagents");
  feed(
    observations,
    event("PreToolUse", { agentId: "a1", toolName: "Bash", toolUseId: "b1" }),
  );
  assert.equal(stateOf(observations), "subagents");
  feed(observations, event("SubagentStop", { agentId: "a1" }));
  assert.equal(stateOf(observations), "subagents");
  feed(observations, event("SubagentStop", { agentId: "a2" }));
  assert.equal(stateOf(observations), "idle");
});

test("a background subagent resumed with SendMessage rides again until it stops", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "SendMessage",
      toolUseId: "send-1",
      childAgentId: "a1",
      childStatus: "resumed",
    }),
    event("Stop"),
  );
  assert.equal(stateOf(observations), "subagents");
  assert.equal(observations.snapshot().companions, 1);
  feed(observations, event("SubagentStop", { agentId: "a1" }));
  assert.equal(stateOf(observations), "idle");
  assert.equal(observations.snapshot().companions, 0);
});

test("foreground subagents and other states outrank background", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "t1",
      childAgentId: "fg",
      childStatus: "completed",
    }),
    event("Stop"),
  );
  assert.equal(stateOf(observations), "idle");
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "t2",
      childAgentId: "bg",
      childStatus: "async_launched",
    }),
  );
  assert.equal(stateOf(observations), "working");
  feed(
    observations,
    event("Stop"),
    event("PermissionRequest", {
      agentId: "bg",
      toolName: "Bash",
      toolUseId: "b1",
    }),
  );
  assert.equal(stateOf(observations), "asking");
});

test("an empty background task list clears background agents", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "t1",
      childAgentId: "bg",
      childStatus: "async_launched",
    }),
    event("Stop", {
      backgroundTasks: [{ id: "x", type: "agent", status: "running" }],
    }),
  );
  assert.equal(stateOf(observations), "subagents");
  feed(observations, event("Stop", { backgroundTasks: [] }));
  assert.equal(stateOf(observations), "idle");
});

test("companions count background agents across sessions up to three", () => {
  const observations = new Observations();
  const launch = (sessionId: string, agent: string) =>
    event("PostToolUse", {
      sessionId,
      toolName: "Agent",
      toolUseId: `t-${agent}`,
      childAgentId: agent,
      childStatus: "async_launched",
    });
  assert.equal(observations.snapshot().companions, 0);
  feed(
    observations,
    event("UserPromptSubmit", { sessionId: "a" }),
    launch("a", "a1"),
    launch("a", "a2"),
    event("UserPromptSubmit", { sessionId: "b" }),
    launch("b", "b1"),
    launch("b", "b2"),
  );
  assert.equal(observations.snapshot().state, "working");
  assert.equal(observations.snapshot().companions, 3);
  feed(
    observations,
    event("SubagentStop", { sessionId: "a", agentId: "a1" }),
    event("SubagentStop", { sessionId: "b", agentId: "b1" }),
  );
  assert.equal(observations.snapshot().companions, 2);
});

const workflowStart = (agentId: string, sessionId = "session-1") =>
  event("SubagentStart", { sessionId, agentId, subagentKind: "workflow" });

test("workflow subagents keep a finished turn in the background state", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", { toolName: "Workflow", toolUseId: "wf" }),
    workflowStart("w1"),
    workflowStart("w2"),
    event("Stop", { backgroundTasks: [] }),
  );
  assert.equal(stateOf(observations), "subagents");
  assert.equal(observations.snapshot().companions, 2);
  assert.deepEqual(only(observations).detail, { kind: "agents", count: 2 });
  feed(observations, event("SubagentStop", { agentId: "w1" }));
  assert.equal(stateOf(observations), "subagents");
  feed(observations, event("SubagentStop", { agentId: "w2" }));
  assert.equal(stateOf(observations), "idle");
  assert.equal(observations.snapshot().companions, 0);
});

test("only workflow-kind subagent starts are counted", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("SubagentStart", { agentId: "fg" }),
    event("SubagentStart", { subagentKind: "workflow" }),
    event("Stop"),
  );
  assert.equal(stateOf(observations), "idle");
  assert.equal(observations.snapshot().companions, 0);
});

test("duplicate workflow starts count once and stray stops are ignored", () => {
  const observations = new Observations();
  feed(
    observations,
    event("SubagentStop", { agentId: "ghost" }),
    workflowStart("w1"),
    workflowStart("w1"),
    event("SubagentStop", { agentId: "ghost" }),
  );
  assert.equal(stateOf(observations), "subagents");
  assert.equal(observations.snapshot().companions, 1);
  assert.deepEqual(only(observations).detail, { kind: "agents", count: 1 });
});

test("workflow agent overflow marks the session unknown", () => {
  const observations = new Observations();
  feed(
    observations,
    ...Array.from({ length: 32 }, (_, index) => workflowStart(`w${index}`)),
  );
  assert.equal(stateOf(observations), "subagents");
  feed(observations, workflowStart("w0"));
  assert.equal(stateOf(observations), "subagents");
  feed(observations, workflowStart("w32"));
  assert.equal(stateOf(observations), "unknown");
});

test("workflow and async agents share the background state and companions", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "t1",
      childAgentId: "a1",
      childStatus: "async_launched",
    }),
    workflowStart("w1"),
    workflowStart("w2"),
    workflowStart("w3"),
  );
  assert.equal(stateOf(observations), "working");
  assert.equal(observations.snapshot().companions, 3);
  feed(observations, event("Stop", { backgroundTasks: [] }));
  assert.equal(stateOf(observations), "subagents");
  assert.deepEqual(only(observations).detail, { kind: "agents", count: 3 });
  feed(
    observations,
    event("SubagentStop", { agentId: "w1" }),
    event("SubagentStop", { agentId: "w2" }),
    event("SubagentStop", { agentId: "w3" }),
  );
  assert.equal(stateOf(observations), "idle");
});

test("workflow agents end with their session and skip tombstones", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    workflowStart("w1"),
    event("SessionEnd"),
    workflowStart("w2"),
  );
  assert.deepEqual(observations.snapshot().sessions, []);
  assert.equal(observations.snapshot().companions, 0);
});

function clock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}
function only(observations: Observations) {
  const sessions = observations.snapshot().sessions;
  assert.equal(sessions.length, 1);
  return sessions[0]!;
}

test("since starts at creation and moves only when the displayed state changes", () => {
  const time = clock();
  const observations = new Observations(time.now);
  feed(observations, event("SessionStart"));
  assert.equal(only(observations).since, 1_000);
  time.advance(500);
  feed(observations, event("UserPromptSubmit"));
  assert.equal(only(observations).since, 1_500);
  time.advance(500);
  feed(
    observations,
    event("PreToolUse", { toolName: "Read", toolUseId: "t1" }),
    event("PostToolUse", { toolName: "Read", toolUseId: "t1" }),
    event("PreToolUse", { toolName: "Edit", toolUseId: "t2" }),
  );
  assert.equal(only(observations).state, "working");
  assert.equal(only(observations).since, 1_500);
  time.advance(60_000);
  assert.equal(only(observations).since, 1_500);
  assert.equal(only(observations).state, "working");
  feed(
    observations,
    event("PermissionRequest", { toolName: "Edit", toolUseId: "t2" }),
  );
  assert.equal(only(observations).since, 62_000);
  time.advance(1);
  observations.loseIntegrity();
  assert.equal(only(observations).state, "asking");
  assert.equal(only(observations).since, 62_000);
  feed(observations, event("Stop"));
  assert.equal(only(observations).state, "unknown");
  assert.equal(only(observations).since, 62_001);
});

test("detail names the running main-session tool and clears when it ends", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"));
  assert.equal(only(observations).detail, null);
  feed(
    observations,
    event("PreToolUse", { toolName: "Bash", toolUseId: "t1" }),
  );
  assert.deepEqual(only(observations).detail, { kind: "tool", tool: "Bash" });
  feed(
    observations,
    event("PreToolUse", {
      toolName: "Task",
      toolUseId: "c1",
      agentId: "child",
    }),
  );
  assert.deepEqual(only(observations).detail, { kind: "tool", tool: "Bash" });
  feed(
    observations,
    event("PostToolUse", { toolName: "Task", toolUseId: "other" }),
  );
  assert.deepEqual(only(observations).detail, { kind: "tool", tool: "Bash" });
  feed(
    observations,
    event("PostToolUseFailure", { toolName: "Bash", toolUseId: "t1" }),
  );
  assert.equal(only(observations).detail, null);
  feed(
    observations,
    event("PreToolUse", { toolName: "Read", toolUseId: "t2" }),
  );
  feed(
    observations,
    event("PostToolBatch", {
      toolCalls: [{ toolName: "Read", toolUseId: "t2" }],
    }),
  );
  assert.equal(only(observations).detail, null);
  feed(
    observations,
    event("PreToolUse", { toolName: "Grep", toolUseId: "t3" }),
  );
  feed(observations, event("UserPromptSubmit"));
  assert.equal(only(observations).detail, null);
  feed(
    observations,
    event("PreToolUse", { toolName: "Grep", toolUseId: "t4" }),
  );
  feed(observations, event("Stop"), event("UserPromptSubmit"));
  assert.equal(only(observations).detail, null);
});

test("asking detail prefers a question, else the latest permission tool", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PermissionRequest", { toolName: "Bash", toolUseId: "t1" }),
  );
  assert.deepEqual(only(observations).detail, {
    kind: "permission",
    tool: "Bash",
  });
  feed(
    observations,
    event("PermissionRequest", {
      toolName: "mcp__github__create_issue",
      inputFingerprint: fpA,
    }),
  );
  assert.deepEqual(only(observations).detail, {
    kind: "permission",
    tool: "mcp__github__create_issue",
  });
  feed(
    observations,
    event("PreToolUse", { toolName: "AskUserQuestion", toolUseId: "q1" }),
  );
  assert.deepEqual(only(observations).detail, { kind: "question" });
  feed(
    observations,
    event("PostToolUse", { toolName: "AskUserQuestion", toolUseId: "q1" }),
  );
  assert.deepEqual(only(observations).detail, {
    kind: "permission",
    tool: "mcp__github__create_issue",
  });
});

test("a notification-only ask has no tool name", () => {
  const observations = new Observations();
  feed(observations, event("UserPromptSubmit"), event("Notification"));
  assert.equal(only(observations).state, "asking");
  assert.deepEqual(only(observations).detail, { kind: "permission" });
});

test("background detail counts the session's agents", () => {
  const observations = new Observations();
  const launch = (id: string) =>
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: `launch-${id}`,
      childStatus: "async_launched",
      childAgentId: id,
    });
  feed(
    observations,
    event("UserPromptSubmit"),
    launch("a1"),
    launch("a2"),
    event("Stop"),
  );
  assert.deepEqual(only(observations).detail, { kind: "agents", count: 2 });
  feed(observations, event("SubagentStop", { agentId: "a1" }));
  assert.deepEqual(only(observations).detail, { kind: "agents", count: 1 });
});

test("short ids are at least four characters and unique only within a project", () => {
  const observations = new Observations();
  feed(
    observations,
    event("SessionStart", { sessionId: "4f2a9c1e", project: "watchling" }),
    event("SessionStart", { sessionId: "4f2a77d0", project: "watchling" }),
    event("SessionStart", { sessionId: "b81d0c3a", project: "watchling" }),
    event("SessionStart", { sessionId: "4f2a0000", project: "other" }),
    event("SessionStart", { sessionId: "ab", project: "tiny" }),
  );
  assert.deepEqual(
    observations.snapshot().sessions.map((row) => [row.project, row.shortId]),
    [
      ["watchling", "4f2a9"],
      ["watchling", "4f2a7"],
      ["watchling", "b81d"],
      ["other", "4f2a"],
      ["tiny", "ab"],
    ],
  );
});

test("a session lost while the app was closed is unknown until its next turn", () => {
  const observations = new Observations();
  observations.loseSession("session-1");
  observations.loseSession("session-2");
  feed(
    observations,
    event("PreToolUse", { toolName: "Bash", toolUseId: "toolu_1" }),
    event("SessionStart", { sessionId: "session-2" }),
    event("PreToolUse", {
      sessionId: "session-3",
      toolName: "Bash",
      toolUseId: "toolu_3",
    }),
  );
  assert.equal(stateOf(observations), "unknown");
  assert.equal(stateOf(observations, "session-2"), "idle");
  assert.equal(stateOf(observations, "session-3"), "working");
  feed(observations, event("UserPromptSubmit"));
  assert.equal(stateOf(observations), "working");
  observations.loseSession("session-3");
  assert.equal(stateOf(observations, "session-3"), "unknown");
  assert.equal(observations.snapshot().state, "unknown");
});
test("a session's terminal comes from its latest located event", () => {
  const observations = new Observations();
  feed(observations, event("SessionStart"));
  assert.equal(observations.terminal("session-1"), null);
  assert.equal(observations.snapshot().sessions[0]!.focusable, undefined);
  feed(
    observations,
    event("UserPromptSubmit", {
      terminalApp: "com.stablyai.orca",
      orcaTerminal: "term_1",
    }),
    event("Stop"),
  );
  assert.deepEqual(observations.terminal("session-1"), {
    app: "com.stablyai.orca",
    orcaTerminal: "term_1",
  });
  assert.equal(observations.snapshot().sessions[0]!.focusable, true);
  assert.equal(observations.snapshot().sessions[0]!.terminalName, "Orca");
  feed(
    observations,
    event("UserPromptSubmit", { terminalApp: "com.apple.Terminal" }),
  );
  assert.deepEqual(observations.terminal("session-1"), {
    app: "com.apple.Terminal",
  });
  assert.equal(observations.snapshot().sessions[0]!.terminalName, "Terminal");
  feed(observations, event("Stop", { terminalApp: "com.example.unknown" }));
  assert.equal(observations.snapshot().sessions[0]!.focusable, true);
  assert.equal(observations.snapshot().sessions[0]!.terminalName, undefined);
  feed(observations, event("SessionEnd"));
  assert.equal(observations.terminal("session-1"), null);
});
test("a background agent launched before a restart reappears with its next event", () => {
  const observations = new Observations();
  feed(
    observations,
    event("PreToolUse", {
      agentId: "agent-1",
      toolName: "Read",
      toolUseId: "t1",
    }),
  );
  assert.equal(observations.snapshot().state, "subagents");
  assert.equal(observations.snapshot().companions, 1);
  feed(
    observations,
    event("PostToolUse", {
      agentId: "agent-1",
      toolName: "Read",
      toolUseId: "t1",
    }),
  );
  assert.equal(observations.snapshot().companions, 1);
  feed(observations, event("SubagentStop", { agentId: "agent-1" }));
  assert.equal(observations.snapshot().state, "idle");
  assert.equal(observations.snapshot().companions, 0);
});

test("subagents working inside a turn are not mistaken for background agents", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PreToolUse", {
      agentId: "agent-1",
      toolName: "Read",
      toolUseId: "t1",
    }),
    event("SubagentStop", { agentId: "agent-1" }),
    event("Stop"),
  );
  assert.equal(observations.snapshot().state, "idle");
  assert.equal(observations.snapshot().companions, 0);
  feed(observations, event("SubagentStop", { agentId: "agent-2" }));
  assert.equal(observations.snapshot().companions, 0);
});

test("a known background agent is not counted twice", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "t1",
      childAgentId: "agent-1",
      childStatus: "async_launched",
    }),
    event("Stop"),
    event("PreToolUse", {
      agentId: "agent-1",
      toolName: "Read",
      toolUseId: "t2",
    }),
    event("SubagentStart", { agentId: "flow-1", subagentKind: "workflow" }),
    event("PreToolUse", {
      agentId: "flow-1",
      toolName: "Read",
      toolUseId: "t3",
    }),
  );
  assert.equal(observations.snapshot().companions, 2);
});

test("a finished turn with a running background shell task is waiting", () => {
  const observations = new Observations();
  const shell = (status: string) => ({ id: "t1", type: "shell", status });
  feed(
    observations,
    event("UserPromptSubmit"),
    event("Stop", { backgroundTasks: [shell("running")] }),
  );
  assert.equal(observations.snapshot().state, "waiting");
  assert.deepEqual(observations.snapshot().sessions[0]!.detail, {
    kind: "tasks",
    count: 1,
  });
  assert.equal(observations.snapshot().companions, 0);
  feed(observations, event("UserPromptSubmit"));
  assert.equal(observations.snapshot().state, "working");
  feed(observations, event("Stop", { backgroundTasks: [shell("completed")] }));
  assert.equal(observations.snapshot().state, "idle");
  feed(observations, event("Stop", { backgroundTasks: [shell("running")] }));
  assert.equal(observations.snapshot().state, "waiting");
  feed(observations, event("Stop", { backgroundTasks: [] }));
  assert.equal(observations.snapshot().state, "idle");
});

test("background agents outrank waiting, and other task types are not shell tasks", () => {
  const observations = new Observations();
  feed(
    observations,
    event("UserPromptSubmit"),
    event("PostToolUse", {
      toolName: "Agent",
      toolUseId: "t1",
      childAgentId: "agent-1",
      childStatus: "async_launched",
    }),
    event("Stop", {
      backgroundTasks: [
        { id: "a", type: "local_agent", status: "running" },
        { id: "s", type: "shell", status: "running" },
      ],
    }),
  );
  assert.equal(observations.snapshot().state, "subagents");
  feed(observations, event("SubagentStop", { agentId: "agent-1" }));
  assert.equal(observations.snapshot().state, "waiting");
  feed(
    observations,
    event("Stop", {
      backgroundTasks: [{ id: "a", type: "local_agent", status: "running" }],
    }),
  );
  assert.equal(observations.snapshot().state, "idle");
});

test("only running shell tasks count, under either type name", () => {
  const observations = new Observations();
  const stop = (type: string, status: string) =>
    event("Stop", { backgroundTasks: [{ id: "t", type, status }] });
  feed(observations, event("UserPromptSubmit"), stop("local_bash", "running"));
  assert.equal(observations.snapshot().state, "waiting");
  for (const status of ["exited", "Completed", "success", "killed"]) {
    feed(observations, stop("shell", status));
    assert.equal(observations.snapshot().state, "idle", status);
  }
  feed(observations, stop("shell", "pending"));
  assert.equal(observations.snapshot().state, "waiting");
});

test("a shell-only task list clears a background agent whose stop was missed", () => {
  const observations = new Observations();
  feed(
    observations,
    event("PreToolUse", {
      agentId: "ghost",
      toolName: "Read",
      toolUseId: "t1",
    }),
  );
  assert.equal(observations.snapshot().state, "subagents");
  feed(
    observations,
    event("SubagentStop", {
      agentId: "other",
      backgroundTasks: [{ id: "s", type: "shell", status: "running" }],
    }),
  );
  assert.equal(observations.snapshot().state, "waiting");
  assert.equal(observations.snapshot().companions, 0);
});

test("an interrupt or a failed stop keeps the last task count, and SessionEnd drops it", () => {
  const observations = new Observations();
  const running = [{ id: "s", type: "shell", status: "running" }];
  feed(
    observations,
    event("UserPromptSubmit"),
    event("Stop", { backgroundTasks: running }),
    event("UserPromptSubmit"),
    event("PostToolUseFailure", {
      toolName: "Bash",
      toolUseId: "t1",
      isInterrupt: true,
    }),
  );
  assert.equal(observations.snapshot().state, "waiting");
  feed(observations, event("UserPromptSubmit"), event("TurnEnded"));
  assert.equal(observations.snapshot().state, "waiting");
  feed(observations, event("UserPromptSubmit"), event("StopFailure"));
  assert.equal(observations.snapshot().state, "waiting");
  feed(observations, event("SessionEnd"));
  assert.deepEqual(observations.snapshot().sessions, []);
  assert.equal(observations.snapshot().state, "idle");
});
