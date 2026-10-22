import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveAppPaths, type AppPaths } from "../../src/main/app-paths.ts";
import {
  canAutoConnect,
  ClaudeConnection,
  PreferenceStore,
} from "../../src/main/connection.ts";
import { manageClaudeHooks } from "../../src/integration/claude/hook-install.ts";

interface Fixture {
  home: string;
  paths: AppPaths;
  helper: string;
}
async function fixture(body: (value: Fixture) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "watchling-connection-"));
  try {
    const helper = join(home, "helpers", "watchling-hook-emitter");
    await mkdir(dirname(helper), { mode: 0o700 });
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const paths = resolveAppPaths(home);
    await mkdir(dirname(paths.settingsPath), { mode: 0o700 });
    await writeFile(paths.settingsPath, '{"theme":"kept"}', { mode: 0o600 });
    await body({ home, paths, helper });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
function connection(f: Fixture, available = true) {
  const notices: number[] = [];
  const value = new ClaudeConnection({
    paths: f.paths,
    helperPath: f.helper,
    available,
    notify: () => notices.push(Date.now()),
  });
  return { connection: value, notices };
}
async function status(f: Fixture): Promise<string> {
  return (await manageClaudeHooks("check", false, f.paths, f.helper)).watchling
    .status;
}
async function settings(f: Fixture): Promise<unknown> {
  return JSON.parse(await readFile(f.paths.settingsPath, "utf8"));
}

test("auto-connect runs only for a packaged app in an Applications folder", () => {
  const home = "/Users/fixture";
  for (const path of [
    "/Applications/Watchling.app/Contents/MacOS/Watchling",
    "/Users/fixture/Applications/Watchling.app/Contents/MacOS/Watchling",
  ]) {
    assert.equal(canAutoConnect(true, path, home), true, path);
    assert.equal(canAutoConnect(false, path, home), false, path);
  }
  for (const path of [
    "/Volumes/Watchling 0.1.0-arm64/Watchling.app/Contents/MacOS/Watchling",
    "/private/var/folders/xy/T/AppTranslocation/0A1B/d/Watchling.app/Contents/MacOS/Watchling",
    "/Users/fixture/code/watchling/build/release/mac-arm64/Watchling.app/Contents/MacOS/Watchling",
    "/Users/fixture/code/watchling/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  ])
    assert.equal(canAutoConnect(true, path, home), false, path);
});

test("preferences default, round-trip privately, and ignore invalid data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-preferences-"));
  try {
    const store = new PreferenceStore(join(directory, "watchling"));
    assert.deepEqual(await store.load(), {
      optedOut: false,
      noticeShown: false,
    });
    await store.save({ optedOut: true, noticeShown: true });
    assert.deepEqual(
      await new PreferenceStore(join(directory, "watchling")).load(),
      {
        optedOut: true,
        noticeShown: true,
      },
    );
    const path = join(directory, "watchling", "preferences.json");
    assert.equal((await lstat(path)).mode & 0o7777, 0o600);
    assert.deepEqual(await readdir(join(directory, "watchling")), [
      "preferences.json",
    ]);
    for (const data of [
      "broken",
      '{"optedOut":"yes","noticeShown":true}',
      '{"optedOut":true}',
      " ".repeat(257),
    ]) {
      await writeFile(path, data);
      assert.deepEqual(await store.load(), {
        optedOut: false,
        noticeShown: false,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launch installs hooks once and shows the notice only the first time", async () => {
  await fixture(async (f) => {
    const first = connection(f);
    await first.connection.start();
    assert.equal(await status(f), "installed");
    assert.equal(await first.connection.isConnected(), true);
    assert.equal(first.notices.length, 1);
    assert.deepEqual(await new PreferenceStore(f.paths.userData).load(), {
      optedOut: false,
      noticeShown: true,
    });

    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    const second = connection(f);
    await second.connection.start();
    assert.equal(await status(f), "installed");
    assert.equal(second.notices.length, 0);
    const settled = await readFile(f.paths.settingsPath);
    await second.connection.start();
    assert.deepEqual(await readFile(f.paths.settingsPath), settled);
  });
});

test("hooks installed before the first launch do not trigger the notice", async () => {
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const { connection: value, notices } = connection(f);
    await value.start();
    assert.equal(notices.length, 0);
    assert.equal(await status(f), "installed");
  });
});

test("unstable locations never install and cannot toggle", async () => {
  await fixture(async (f) => {
    const { connection: value, notices } = connection(f, false);
    await value.start();
    await value.setConnected(true);
    assert.equal(await status(f), "not-installed");
    assert.equal(await value.isConnected(), false);
    assert.deepEqual(await settings(f), { theme: "kept" });
    assert.equal(notices.length, 0);
    await assert.rejects(lstat(f.paths.userData), { code: "ENOENT" });
  });
});

test("turning the connection off uninstalls and keeps launches from reinstalling", async () => {
  await fixture(async (f) => {
    const { connection: value, notices } = connection(f);
    await value.start();
    await value.setConnected(false);
    assert.equal(await value.isConnected(), false);
    assert.deepEqual(await settings(f), { theme: "kept" });
    assert.equal(
      (await new PreferenceStore(f.paths.userData).load()).optedOut,
      true,
    );

    const relaunch = connection(f);
    await relaunch.connection.start();
    assert.equal(await status(f), "not-installed");
    assert.deepEqual(await settings(f), { theme: "kept" });

    await relaunch.connection.setConnected(true);
    assert.equal(await relaunch.connection.isConnected(), true);
    assert.deepEqual(await new PreferenceStore(f.paths.userData).load(), {
      optedOut: false,
      noticeShown: true,
    });
    assert.equal(notices.length + relaunch.notices.length, 1);
  });
});
