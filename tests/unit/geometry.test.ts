import { test } from "node:test";
import assert from "node:assert/strict";
import { clampWindow, isPoint, listPosition } from "../../src/main/geometry.ts";

test("rejects malformed coordinates without coercion", () => {
  for (const input of [
    null,
    [],
    { x: "1", y: 2 },
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: 0, y: 0, extra: 1 },
  ])
    assert.equal(isPoint(input), false);
  assert.equal(isPoint({ x: -1200, y: 24 }), true);
});
test("clamps negative-origin displays and undersized work areas", () => {
  assert.deepEqual(
    clampWindow(
      { x: -2000, y: 2000 },
      { x: -1200, y: 24, width: 1200, height: 800 },
      { width: 180, height: 180 },
    ),
    { x: -1200, y: 644 },
  );
  assert.deepEqual(
    clampWindow(
      { x: 99, y: 99 },
      { x: -40, y: 20, width: 50, height: 50 },
      { width: 180, height: 180 },
    ),
    { x: -40, y: 20 },
  );
});
test("places list below top-edge pets and above bottom-edge pets", () => {
  const area = { x: 0, y: 24, width: 1440, height: 876 };
  const list = { width: 320, height: 280 };
  assert.deepEqual(
    listPosition({ x: 1260, y: 720, width: 180, height: 180 }, area, list),
    { x: 1120, y: 432 },
  );
  assert.deepEqual(
    listPosition({ x: 0, y: 24, width: 180, height: 180 }, area, list),
    { x: 0, y: 212 },
  );
});
