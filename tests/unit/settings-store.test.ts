import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSettings,
  SettingsStore,
  type Settings,
} from "../../src/main/settings-store.ts";

test("settings start from the defaults and keep the last saved values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-settings-"));
  try {
    const store = new SettingsStore(directory);
    assert.deepEqual(await store.load(), defaultSettings);
    const saved: Settings = {
      petSize: "extra-large",
      allSpaces: false,
      hideWhenEmpty: false,
      dimWhenIdle: true,
      startupApplied: true,
    };
    await Promise.all([
      store.save({ ...defaultSettings, petSize: "small" }),
      store.save(saved),
    ]);
    await store.flush();
    assert.deepEqual(await new SettingsStore(directory).load(), saved);
    const file = join(directory, "settings.json");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), saved);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    for (const invalid of [
      { petSize: "huge" },
      { allSpaces: "yes" },
      { hideWhenEmpty: 1 },
      { dimWhenIdle: null },
      { startupApplied: "yes" },
    ])
      await assert.rejects(
        store.save({ ...defaultSettings, ...invalid } as unknown as Settings),
        TypeError,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unreadable or unknown settings fall back to the defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-settings-"));
  try {
    const store = new SettingsStore(directory);
    for (const data of [
      "broken",
      "[]",
      '{"petSize":"huge"}',
      '{"petSize":"toString"}',
      " ".repeat(4097) + '{"petSize":"large"}',
    ]) {
      await writeFile(join(directory, "settings.json"), data);
      assert.deepEqual(await store.load(), defaultSettings);
    }
    await writeFile(
      join(directory, "settings.json"),
      '{"petSize":"large","allSpaces":0,"dimWhenIdle":false,"extra":1}',
    );
    assert.deepEqual(await store.load(), {
      ...defaultSettings,
      petSize: "large",
      dimWhenIdle: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
