import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PositionStore } from "../../src/main/position-store.ts";

test("serializes position updates and restores the final value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-position-"));
  try {
    const store = new PositionStore(directory);
    assert.equal(await store.load(), null);
    await Promise.all([
      store.save({ x: 10, y: 20 }),
      store.save({ x: -900, y: 40 }),
    ]);
    await store.flush();
    assert.deepEqual(await new PositionStore(directory).load(), {
      x: -900,
      y: 40,
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "position.json"), "utf8")),
      { x: -900, y: 40 },
    );
    await assert.rejects(store.save({ x: NaN, y: 0 }), TypeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("invalid persistence never becomes a window coordinate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-position-"));
  try {
    const store = new PositionStore(directory);
    for (const data of [
      "broken",
      '{"x":"100","y":5}',
      '{"x":null,"y":null}',
      '{"x":1e308,"y":0}',
      " ".repeat(257) + '{"x":1,"y":2}',
    ]) {
      await writeFile(join(directory, "position.json"), data);
      assert.equal(await store.load(), null);
    }
    await writeFile(join(directory, "position.json"), '{"x":42.2,"y":24.7}');
    assert.deepEqual(await store.load(), { x: 42, y: 25 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
