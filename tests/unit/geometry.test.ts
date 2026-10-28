import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampWindow,
  contains,
  expand,
  listPosition,
} from "../../src/main/geometry.ts";
import { isPoint } from "../../src/shared/ui-contract.ts";

test("rejects malformed coordinates without coercion", () => {
  for (const input of [
    null,
    [],
    { x: "1", y: 2 },
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: 1e308, y: 0 },
    { x: 0, y: -1_000_001 },
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
test("places the list beside Peep's body, below at the top edge and above otherwise", () => {
  const area = { x: 0, y: 24, width: 1440, height: 876 };
  const list = { width: 320, height: 280 };
  assert.deepEqual(
    listPosition({ x: 1260, y: 720, width: 180, height: 180 }, area, list),
    { x: 1086, y: 468 },
  );
  assert.deepEqual(
    listPosition({ x: 0, y: 24, width: 180, height: 180 }, area, list),
    { x: 34, y: 183 },
  );
});
test("the list keeps the same gap from Peep's body at every size", () => {
  const area = { x: 0, y: 24, width: 1440, height: 876 };
  const list = { width: 320, height: 280 };
  for (const side of [135, 180, 270]) {
    const pet = { x: 1000, y: 500, width: side, height: side };
    const top = pet.y + side * 0.52 - side * 0.31;
    const right = pet.x + side / 2 + side * 0.31;
    const position = listPosition(pet, area, list);
    assert.ok(Math.abs(top - (position.y + list.height) - 10) <= 1, `${side}`);
    assert.ok(Math.abs(right - (position.x + list.width)) <= 1, `${side}`);
  }
});
test("pets may overhang display edges by their transparent margin", () => {
  const area = expand({ x: 0, y: 0, width: 1440, height: 900 }, 30);
  assert.deepEqual(
    clampWindow({ x: 5000, y: 5000 }, area, { width: 180, height: 180 }),
    { x: 1290, y: 750 },
  );
  assert.deepEqual(
    clampWindow({ x: -5000, y: -5000 }, area, { width: 180, height: 180 }),
    { x: -30, y: -30 },
  );
});

test("bounds contain their edges and nothing past them", () => {
  const area = { x: -100, y: 20, width: 50, height: 30 };
  assert.equal(contains(area, { x: -100, y: 20 }), true);
  assert.equal(contains(area, { x: -50, y: 50 }), true);
  assert.equal(contains(area, { x: -101, y: 30 }), false);
  assert.equal(contains(area, { x: -75, y: 51 }), false);
});
