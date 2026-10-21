import { test } from "node:test";
import assert from "node:assert/strict";
import { Observations } from "../../src/domain/observations.ts";

test("unverified permission/question candidates are not asserted as human waits", () => {
  const observations = new Observations();
  observations.receive({
    eventName: "PermissionRequest",
    sessionId: "session-1",
    project: "project",
    toolName: "Bash",
  });
  observations.receive({
    eventName: "Notification",
    sessionId: "session-1",
    project: "project",
    notificationType: "permission_prompt",
  });
  observations.receive({
    eventName: "PreToolUse",
    sessionId: "session-1",
    project: "project",
    toolName: "AskUserQuestion",
    toolUseId: "tool-1",
  });
  assert.equal(observations.snapshot().state, "unknown");
  assert.equal(observations.snapshot().sessions.length, 1);
  assert.equal(observations.snapshot().sessions[0]!.state, "unknown");
});

test("child lifecycle cannot end the observed root session", () => {
  const observations = new Observations();
  observations.receive({
    eventName: "SessionStart",
    sessionId: "root",
    project: "project",
  });
  observations.receive({
    eventName: "SessionEnd",
    sessionId: "root",
    project: "project",
    agentId: "child",
  });
  assert.equal(observations.snapshot().sessions.length, 1);
  observations.receive({
    eventName: "SessionEnd",
    sessionId: "root",
    project: "project",
  });
  assert.equal(observations.snapshot().sessions.length, 0);
  observations.receive({
    eventName: "PostToolUse",
    sessionId: "unseen-root",
    project: "project",
    agentId: "child",
    toolName: "Bash",
    toolUseId: "tool-1",
  });
  assert.equal(observations.snapshot().sessions.length, 0);
});

test("session capacity is bounded and successful traffic cannot silently heal loss", () => {
  const observations = new Observations();
  for (let i = 0; i < 130; i++)
    observations.receive({
      eventName: "SessionStart",
      sessionId: `session-${i}`,
      project: "project",
    });
  assert.equal(observations.snapshot().sessions.length, 128);
  assert.match(observations.snapshot().observation, /신뢰가 저하/);
  observations.receive({
    eventName: "UserPromptSubmit",
    sessionId: "session-0",
    project: "project",
  });
  assert.match(observations.snapshot().observation, /신뢰가 저하/);
});

test("short displayed IDs remain distinct when provider IDs share a prefix", () => {
  const observations = new Observations();
  observations.receive({
    eventName: "SessionStart",
    sessionId: "sameprefix-A",
    project: "project",
  });
  observations.receive({
    eventName: "SessionStart",
    sessionId: "sameprefix-B",
    project: "project",
  });
  assert.equal(
    new Set(observations.snapshot().sessions.map((row) => row.id)).size,
    2,
  );
});
