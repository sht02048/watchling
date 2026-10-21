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
  assert.equal(
    observations.snapshot().observation,
    "아직 Claude Code 신호를 수신하지 않았어요.",
  );
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
  assert.equal(
    observations.snapshot().observation,
    "승인이나 질문 응답이 필요해 보여요.",
  );
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
  assert.equal(sessions[0]!.reason, "다음 요청을 기다리고 있어요.");
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
  assert.equal(
    observations.snapshot().observation,
    "Claude Code가 다음 요청을 기다리고 있어요.",
  );
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
  assert.match(observations.snapshot().observation, /놓친 신호/);
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

test("snapshots never carry fingerprints, interactivity, tool names or tool ids", () => {
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
    "SecretToolName",
    "secret-tool-id",
    "interactive",
    "fingerprint",
  ])
    assert.ok(!encoded.includes(secret), secret);
  assert.deepEqual(Object.keys(observations.snapshot().sessions[0]!).sort(), [
    "id",
    "project",
    "reason",
    "state",
  ]);
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
