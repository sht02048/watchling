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
  project: "프로젝트",
  toolName: "Bash",
};
const frame = {
  version: 1,
  epoch: "11111111-1111-4111-8111-111111111111",
  token: "a".repeat(64),
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
