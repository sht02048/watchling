import { test } from "node:test";
import assert from "node:assert/strict";
import { presence } from "../../src/main/presence.ts";

const base = {
  hidden: false,
  hideWhenEmpty: true,
  dimWhenIdle: true,
  peeking: false,
} as const;

test("Peep hides with no sessions and dims while every session is idle", () => {
  assert.equal(presence({ ...base, activity: "empty" }), "hidden");
  assert.equal(presence({ ...base, activity: "idle" }), "dimmed");
  assert.equal(presence({ ...base, activity: "active" }), "shown");
});

test("each setting works on its own", () => {
  assert.equal(
    presence({ ...base, activity: "empty", hideWhenEmpty: false }),
    "dimmed",
  );
  assert.equal(
    presence({
      ...base,
      activity: "empty",
      hideWhenEmpty: false,
      dimWhenIdle: false,
    }),
    "shown",
  );
  assert.equal(
    presence({ ...base, activity: "empty", dimWhenIdle: false }),
    "hidden",
  );
  assert.equal(
    presence({ ...base, activity: "idle", dimWhenIdle: false }),
    "shown",
  );
});

test("showing Peep on purpose wins until the next activity", () => {
  for (const activity of ["empty", "idle"] as const)
    assert.equal(presence({ ...base, activity, peeking: true }), "shown");
});

test("hiding Peep from the menu wins over everything", () => {
  for (const activity of ["active", "idle", "empty"] as const)
    assert.equal(
      presence({ ...base, activity, hidden: true, peeking: true }),
      "hidden",
    );
});
