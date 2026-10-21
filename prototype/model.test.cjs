const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregate,
  updateSession,
  waiting,
  clampPosition,
} = require("./model.js");
const session = (id, state) => ({ id, state, project: "same-project" });

test("explicit waits dominate unknown and working sessions", () => {
  assert.equal(
    aggregate([
      session("a", "working"),
      session("b", "unknown"),
      session("c", "attention"),
    ]),
    "attention",
  );
});
test("unknown is not inferred idle or working", () => {
  assert.equal(aggregate([]), "unknown");
  assert.equal(
    aggregate([session("a", "idle"), session("b", "unknown")]),
    "unknown",
  );
  assert.equal(
    aggregate([session("a", "working"), session("b", "unknown")]),
    "unknown",
  );
});
test("clearing one wait retains another wait, then other work", () => {
  const start = [
    session("a", "attention"),
    session("b", "attention"),
    session("c", "working"),
  ];
  const first = updateSession(start, "a", "idle");
  assert.equal(aggregate(first), "attention");
  assert.deepEqual(
    waiting(first).map((s) => s.id),
    ["b"],
  );
  const second = updateSession(first, "b", "idle");
  assert.equal(aggregate(second), "working");
  assert.equal(aggregate(updateSession(second, "c", "idle")), "idle");
  assert.equal(start[0].state, "attention", "updates do not mutate the input");
});
test("same project sessions are independently identified", () => {
  const result = updateSession(
    [session("a", "working"), session("b", "idle")],
    "b",
    "attention",
  );
  assert.equal(result[0].state, "working");
  assert.equal(result[1].state, "attention");
});
test("invalid states and missing ids are rejected, not silently normalized", () => {
  assert.throws(() => aggregate([session("a", "error")]), RangeError);
  assert.throws(() => aggregate([session("a", "__proto__")]), RangeError);
  assert.throws(
    () => updateSession([session("a", "idle")], "missing", "working"),
    RangeError,
  );
  assert.throws(
    () => updateSession([session("a", "idle")], "a", "done"),
    RangeError,
  );
});
test("pet stays inside desktop at all edges and on small screens", () => {
  assert.deepEqual(clampPosition(-20, 900, 600, 450, 180), { x: 0, y: 270 });
  assert.deepEqual(clampPosition(500, -60, 320, 430, 154), { x: 166, y: 0 });
  assert.deepEqual(clampPosition(10, 10, 100, 100, 180), { x: 0, y: 0 });
});
