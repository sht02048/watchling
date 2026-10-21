import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAppPaths } from "../../src/main/app-paths.ts";

const execute = promisify(execFile);
test("packaged hooks CLI preserves existing settings in disposable HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "pagent-packaged-"));
  const paths = resolveAppPaths(home);
  const executable = resolve(
    `build/pagent-darwin-${process.arch}/pagent.app/Contents/MacOS/pagent`,
  );
  const original = {
    theme: "dark",
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "true" }] },
      ],
    },
  };
  const run = async (...args: string[]) => {
    const result = await execute(executable, ["hooks", ...args], {
      env: { ...process.env, HOME: home },
      timeout: 10000,
      maxBuffer: 128 * 1024,
    });
    return JSON.parse(result.stdout) as {
      mode: string;
      targets: { settings: string };
      pagent: { status: string };
    };
  };
  try {
    await mkdir(join(home, ".claude"), { mode: 0o700 });
    await writeFile(paths.settingsPath, JSON.stringify(original), {
      mode: 0o600,
    });
    const before = await readFile(paths.settingsPath);
    assert.equal((await run("install")).mode, "preview");
    assert.deepEqual(await readFile(paths.settingsPath), before);
    assert.deepEqual(await readdir(home), [".claude"]);
    assert.equal(
      (await run("install", "--apply")).targets.settings,
      paths.settingsPath,
    );
    const installed = await readFile(paths.settingsPath);
    assert.notDeepEqual(installed, before);
    await run("check");
    await run("install", "--apply");
    assert.deepEqual(await readFile(paths.settingsPath), installed);
    await run("uninstall");
    assert.deepEqual(await readFile(paths.settingsPath), installed);
    const edited = { ...original, theme: "light", userSetting: true };
    await writeFile(paths.settingsPath, JSON.stringify(edited));
    await run("install", "--apply");
    await run("uninstall", "--apply");
    assert.deepEqual(
      JSON.parse(await readFile(paths.settingsPath, "utf8")),
      edited,
    );
    await assert.rejects(readFile(paths.manifestPath), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("packaged apply refuses symlink and nonregular settings without changing targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "pagent-packaged-"));
  const paths = resolveAppPaths(home);
  const executable = resolve(
    `build/pagent-darwin-${process.arch}/pagent.app/Contents/MacOS/pagent`,
  );
  const foreign = join(home, "foreign.json");
  const invoke = () =>
    execute(executable, ["hooks", "install", "--apply"], {
      env: { ...process.env, HOME: home },
      timeout: 10000,
    });
  const refused = (error: unknown) =>
    error instanceof Error && "code" in error && error.code === 2;
  try {
    await mkdir(join(home, ".claude"), { mode: 0o700 });
    await writeFile(foreign, '{"secret":"fixture-only"}', { mode: 0o600 });
    const before = await readFile(foreign);
    await symlink(foreign, paths.settingsPath);
    await assert.rejects(invoke, refused);
    assert.deepEqual(await readFile(foreign), before);
    await assert.rejects(readFile(paths.manifestPath), { code: "ENOENT" });
    await unlink(paths.settingsPath);
    await mkdir(paths.settingsPath);
    await assert.rejects(invoke, refused);
    assert.deepEqual(await readdir(paths.settingsPath), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
