import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
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
  const home = await mkdtemp(join(tmpdir(), "watchling-packaged-"));
  const paths = resolveAppPaths(home);
  const executable = resolve(
    "build/release/Watchling-darwin-arm64/Watchling.app/Contents/MacOS/Watchling",
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
      watchling: { status: string };
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
    assert.equal(
      (
        JSON.parse(installed.toString("utf8")) as {
          env: Record<string, string>;
        }
      ).env.CLAUDE_CODE_PLUGIN_DIRS,
      paths.pluginDirectory,
    );
    assert.deepEqual(
      await readFile(join(paths.pluginDirectory, "hooks/register.js")),
      await readFile("resources/claude-mod/hooks/register.js"),
    );
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
    await assert.rejects(readdir(paths.pluginDirectory), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("packaged apply refuses symlink and nonregular settings without changing targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "watchling-packaged-"));
  const paths = resolveAppPaths(home);
  const executable = resolve(
    "build/release/Watchling-darwin-arm64/Watchling.app/Contents/MacOS/Watchling",
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

test("packaged app connects and relocates hooks only when launched from Applications", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "watchling-packaged-")),
  );
  const paths = resolveAppPaths(home);
  const built = resolve("build/release/Watchling-darwin-arm64/Watchling.app");
  const installed = join(home, "Applications", "Watchling.app");
  const helper = (bundle: string) =>
    join(bundle, "Contents/Resources/helpers/watchling-hook-emitter");
  const cli = (bundle: string, ...args: string[]) =>
    execute(join(bundle, "Contents/MacOS/Watchling"), ["hooks", ...args], {
      env: { ...process.env, HOME: home },
      timeout: 10000,
    });
  const manifestHelper = async () =>
    (
      JSON.parse(await readFile(paths.manifestPath, "utf8")) as {
        helperPath: string;
      }
    ).helperPath;
  const launch = async (bundle: string, until: () => Promise<boolean>) => {
    await rm(paths.descriptorPath, { force: true });
    const child = spawn(join(bundle, "Contents/MacOS/Watchling"), [], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    const exited = new Promise((done) => child.once("exit", done));
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await until().catch(() => false)) return true;
        await new Promise((done) => setTimeout(done, 100));
      }
      return false;
    } finally {
      child.kill();
      await exited;
    }
  };
  const settled = async () => {
    await readFile(paths.descriptorPath);
    await new Promise((done) => setTimeout(done, 1000));
    return true;
  };
  const preferences = (value: { optedOut: boolean; noticeShown: boolean }) =>
    writeFile(join(paths.userData, "preferences.json"), JSON.stringify(value), {
      mode: 0o600,
    });
  const original = { theme: "dark", nested: { keep: [1, 2] } };
  try {
    await mkdir(join(home, ".claude"), { mode: 0o700 });
    await writeFile(paths.settingsPath, JSON.stringify(original), {
      mode: 0o600,
    });
    await mkdir(paths.userData, { recursive: true, mode: 0o700 });
    await preferences({ optedOut: false, noticeShown: true });
    await mkdir(join(home, "Applications"));
    await execute("/bin/cp", ["-cR", built, installed]);
    const untouched = await readFile(paths.settingsPath);
    assert.equal(await launch(built, settled), true);
    assert.deepEqual(await readFile(paths.settingsPath), untouched);
    await assert.rejects(readFile(paths.manifestPath), { code: "ENOENT" });

    assert.equal(
      await launch(
        installed,
        async () =>
          (await manifestHelper()) === helper(installed) &&
          (await readFile(paths.settingsPath, "utf8")).includes(
            helper(installed),
          ),
      ),
      true,
    );
    assert.equal(
      (await readFile(paths.settingsPath, "utf8")).includes(helper(installed)),
      true,
    );

    await cli(installed, "uninstall", "--apply");
    await preferences({ optedOut: true, noticeShown: true });
    const disconnected = await readFile(paths.settingsPath);
    assert.equal(await launch(installed, settled), true);
    assert.deepEqual(await readFile(paths.settingsPath), disconnected);
    await assert.rejects(readFile(paths.manifestPath), { code: "ENOENT" });

    await cli(built, "install", "--apply");
    assert.equal(await manifestHelper(), helper(built));
    assert.equal(
      await launch(
        installed,
        async () =>
          (await manifestHelper()) === helper(installed) &&
          (await readFile(paths.settingsPath, "utf8")).includes(
            helper(installed),
          ),
      ),
      true,
    );
    const relocated = await readFile(paths.settingsPath, "utf8");
    assert.equal(relocated.includes(helper(built)), false);
    assert.equal(relocated.includes(helper(installed)), true);
    const moved = await readFile(paths.settingsPath);
    assert.equal(await launch(built, settled), true);
    assert.deepEqual(await readFile(paths.settingsPath), moved);
    assert.equal(await manifestHelper(), helper(installed));

    await cli(installed, "uninstall", "--apply");
    assert.deepEqual(
      JSON.parse(await readFile(paths.settingsPath, "utf8")),
      original,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
