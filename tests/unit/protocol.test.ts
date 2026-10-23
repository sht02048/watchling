import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFrame,
  isClaudeEvent,
  MAX_FRAME_BYTES,
} from "../../src/integration/claude/protocol.ts";

const event = {
  eventName: "PermissionRequest",
  sessionId: "session-1",
  project: "café-☃",
  toolName: "Bash",
};
const frame = {
  version: 1,
  epoch: "11111111-1111-4111-8111-111111111111",
  token: "a".repeat(64),
  eventId: "01234567-89ab-4cde-8f01-23456789abcd",
  event,
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

test("permission metadata needs no fabricated tool-use identity", () => {
  assert.equal(isClaudeEvent(event), true);
  assert.deepEqual(decodeFrame(encode(frame))?.event, event);
  assert.equal("toolUseId" in decodeFrame(encode(frame))!.event, false);
  assert.equal(isClaudeEvent({ ...event, eventName: "PreToolUse" }), false);
  assert.equal(
    isClaudeEvent({ ...event, eventName: "PreToolUse", toolUseId: "toolu_1" }),
    true,
  );
});
test("wire validation excludes raw content and unknown envelope fields", () => {
  for (const field of [
    "tool_input",
    "toolResponse",
    "cwd",
    "transcript_path",
    "prompt",
    "message",
  ]) {
    assert.equal(
      decodeFrame(
        encode({ ...frame, event: { ...event, [field]: "private" } }),
      ),
      null,
    );
  }
  assert.equal(decodeFrame(encode({ ...frame, extra: "private" })), null);
  assert.equal(decodeFrame(encode({ ...frame, version: 2 })), null);
  assert.equal(decodeFrame(encode({ ...frame, token: "short" })), null);
  assert.equal(decodeFrame(encode({ ...frame, epoch: "old" })), null);
  assert.equal(
    decodeFrame(encode({ ...frame, epoch: `${frame.epoch}\n` })),
    null,
  );
});
test("transport identity is a required lowercase UUID with no legacy envelope", () => {
  const { eventId, ...legacy } = frame;
  assert.equal(decodeFrame(encode(legacy)), null);
  for (const invalid of [
    undefined,
    null,
    1,
    "",
    "toolu_1",
    eventId.toUpperCase(),
    eventId.replaceAll("-", ""),
    `${eventId}0`,
    ` ${eventId}`,
    `${eventId}\n`,
    eventId.replace("a", "g"),
  ]) {
    assert.equal(decodeFrame(encode({ ...frame, eventId: invalid })), null);
  }
  assert.equal(
    decodeFrame(encode({ ...legacy, providerEventId: eventId })),
    null,
  );
});
test("native-compatible envelope keeps transport and provider identities separate", () => {
  const metadata = {
    ...event,
    promptId: "prompt-1",
    agentId: "agent-1",
    toolUseId: "toolu_1",
    permissionMode: "default",
    isInterrupt: false,
    stopHookActive: true,
    childAgentId: "child-1",
    childStatus: "completed",
    toolCalls: [{ toolName: "Bash", toolUseId: "toolu_2" }],
    backgroundTasks: [{ id: "task-1", type: "local_agent", status: "running" }],
  };
  // JSONEncoder may write keys in any order and the native helper adds a newline.
  const nativeFrame = {
    event: metadata,
    eventId: frame.eventId,
    token: frame.token,
    epoch: frame.epoch,
    version: 1,
  };
  const decoded = decodeFrame(Buffer.from(`${JSON.stringify(nativeFrame)}\n`));
  assert.deepEqual(decoded, { ...frame, event: metadata });
  assert.equal("eventId" in decoded!.event, false);
  assert.equal("receivedSeq" in decoded!.event, false);
  assert.equal(
    decodeFrame(
      encode({ ...frame, event: { ...event, eventId: frame.eventId } }),
    ),
    null,
  );
});
test("oversized and malformed frames fail before semantic interpretation", () => {
  assert.equal(decodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), null);
  assert.equal(decodeFrame(Buffer.from([0xff])), null);
  assert.equal(decodeFrame(Buffer.from("{broken")), null);
  assert.equal(isClaudeEvent({ ...event, project: "a".repeat(257) }), false);
  assert.equal(isClaudeEvent({ ...event, sessionId: "a\nb" }), false);
  assert.equal(isClaudeEvent({ ...event, isInterrupt: 1 }), false);
});
test("unrelated notification types cannot become permission observations", () => {
  assert.equal(isClaudeEvent({ ...event, eventName: "Notification" }), false);
  assert.equal(
    isClaudeEvent({
      ...event,
      eventName: "Notification",
      notificationType: "idle_prompt",
    }),
    false,
  );
  assert.equal(
    isClaudeEvent({
      ...event,
      eventName: "Notification",
      notificationType: "permission_prompt",
    }),
    true,
  );
});
test("batch and background metadata stay bounded and contain no content", () => {
  const base = { eventName: "PostToolBatch", sessionId: "s1", project: "p" };
  const call = { toolName: "Bash", toolUseId: "toolu_1" };
  assert.equal(isClaudeEvent({ ...base, toolCalls: [call] }), true);
  assert.equal(
    isClaudeEvent({ ...base, toolCalls: [{ ...call, result: "private" }] }),
    false,
  );
  assert.equal(
    isClaudeEvent({
      ...base,
      toolCalls: Array.from({ length: 129 }, () => call),
    }),
    false,
  );
  assert.equal(
    isClaudeEvent({
      ...base,
      backgroundTasks: [{ id: "t1", type: "local_agent", status: "running" }],
    }),
    true,
  );
  assert.equal(
    isClaudeEvent({
      ...base,
      backgroundTasks: [
        {
          id: "t1",
          type: "local_agent",
          status: "running",
          description: "private",
        },
      ],
    }),
    false,
  );
});
test("subagent kind is a closed value only on SubagentStart", () => {
  const start = {
    eventName: "SubagentStart",
    sessionId: "s1",
    project: "p",
    agentId: "agent-1",
  };
  assert.equal(isClaudeEvent({ ...start, subagentKind: "workflow" }), true);
  for (const invalid of [
    "workflow-subagent",
    "Workflow",
    "custom-agent",
    "",
    1,
    null,
    ["workflow"],
  ]) {
    assert.equal(isClaudeEvent({ ...start, subagentKind: invalid }), false);
  }
  for (const eventName of ["SubagentStop", "PostToolUse", "Stop"]) {
    assert.equal(
      isClaudeEvent({
        ...start,
        eventName,
        toolName: "Workflow",
        toolUseId: "toolu_1",
        subagentKind: "workflow",
      }),
      false,
    );
  }
  assert.equal(isClaudeEvent({ ...start, agentType: "workflow" }), false);
});
test("interactivity and input fingerprints are bounded metadata", () => {
  const fingerprint = "0123456789abcdef0123456789abcdef";
  assert.equal(
    isClaudeEvent({
      ...event,
      interactive: false,
      inputFingerprint: fingerprint,
    }),
    true,
  );
  assert.equal(
    isClaudeEvent({
      ...event,
      eventName: "PostToolUse",
      toolUseId: "toolu_1",
      inputFingerprint: fingerprint,
    }),
    true,
  );
  for (const invalid of [
    fingerprint.toUpperCase(),
    fingerprint.slice(1),
    `${fingerprint}0`,
    123,
  ]) {
    assert.equal(isClaudeEvent({ ...event, inputFingerprint: invalid }), false);
  }
  assert.equal(
    isClaudeEvent({
      eventName: "Stop",
      sessionId: "session-1",
      project: "p",
      inputFingerprint: fingerprint,
    }),
    false,
  );
  assert.equal(isClaudeEvent({ ...event, interactive: "true" }), false);
  assert.equal(
    isClaudeEvent({
      eventName: "Stop",
      sessionId: "session-1",
      project: "p",
      interactive: true,
    }),
    false,
  );
});
test("terminal locations are bounded identifiers", () => {
  const located = {
    ...event,
    terminalApp: "com.stablyai.orca",
    orcaTerminal: "term_ed6717a3-a9b4-475c-b51a-bf72e39228c3",
  };
  assert.equal(isClaudeEvent(located), true);
  for (const terminalApp of [
    "",
    "Terminal",
    ".com.apple",
    "com..apple",
    "-a.b",
    "com.-x",
    "com apple",
    "com/apple.x",
    `${"a.".repeat(128)}b`,
    1,
  ])
    assert.equal(isClaudeEvent({ ...located, terminalApp }), false);
  for (const orcaTerminal of [
    "term_",
    "term_a b",
    "term_../x",
    "pane_1",
    `term_${"a".repeat(129)}`,
  ])
    assert.equal(isClaudeEvent({ ...located, orcaTerminal }), false);
});
