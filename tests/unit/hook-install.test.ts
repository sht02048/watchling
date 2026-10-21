import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveAppPaths, type AppPaths } from "../../src/main/app-paths.ts";
import { runHookCommand } from "../../src/main/hook-command.ts";
import {
  HookManagementError,
  MANIFEST_LIMIT,
  SETTINGS_LIMIT,
  manageClaudeHooks,
  quoteHookArgument,
  relocateClaudeHooks,
} from "../../src/integration/claude/hook-install.ts";
import { hookEvents, isRecord } from "../../src/integration/claude/protocol.ts";

type JsonObject = Record<string, unknown>;
const LOCK_MAGIC = "pagent-hook-lock-v1\n";
// Darwin's O_EXLOCK is forwarded by Node but absent from fs.constants.
const DARWIN_O_EXLOCK = 0x20;
interface Fixture {
  home: string;
  paths: AppPaths;
  helper: string;
}
async function fixture(
  body: (value: Fixture) => Promise<void>,
  prefix = "pagent-hooks-",
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  try {
    const helperDirectory = join(home, "packaged helpers");
    await mkdir(helperDirectory, { mode: 0o700 });
    const helper = join(helperDirectory, "pagent-hook-emitter");
    // The installer only validates this disposable regular file; it never runs it.
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await body({ home, paths: resolveAppPaths(home), helper });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function settings(f: Fixture, value: unknown): Promise<void> {
  await mkdir(dirname(f.paths.settingsPath), { recursive: true, mode: 0o700 });
  await writeFile(f.paths.settingsPath, JSON.stringify(value), { mode: 0o600 });
}
async function json(path: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isRecord(value));
  return value;
}
function groups(value: JsonObject, event: string): JsonObject[] {
  assert.ok(isRecord(value.hooks));
  const result = value.hooks[event];
  assert.ok(Array.isArray(result));
  return result as JsonObject[];
}
function ownedGroup(value: JsonObject, event: string): JsonObject {
  const group = groups(value, event).find(
    (item) =>
      Array.isArray(item.hooks) &&
      item.hooks.some(
        (handler) =>
          isRecord(handler) &&
          typeof handler.command === "string" &&
          handler.command.includes("--installation-id"),
      ),
  );
  assert.ok(group);
  return group;
}
function ownedHandler(value: JsonObject, event: string): JsonObject {
  const group = ownedGroup(value, event);
  assert.ok(Array.isArray(group.hooks));
  const handler: unknown = group.hooks.find(
    (item) =>
      isRecord(item) &&
      typeof item.command === "string" &&
      item.command.includes("--installation-id"),
  );
  assert.ok(isRecord(handler));
  return handler;
}
async function tree(path: string): Promise<unknown> {
  const stat = await lstat(path);
  const metadata = {
    mode: stat.mode,
    ino: stat.ino,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
  };
  if (stat.isSymbolicLink()) return { ...metadata, link: await readlink(path) };
  if (stat.isDirectory()) {
    const entries: Record<string, unknown> = {};
    for (const name of (await readdir(path)).sort())
      entries[name] = await tree(join(path, name));
    return { ...metadata, entries };
  }
  return {
    ...metadata,
    hash: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}
async function refused(action: Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof HookManagementError && error.exitCode === 2,
  );
}
function cli(f: Fixture, argv: readonly string[], platform = process.platform) {
  const moduleUrl = new URL("../../src/main/hook-command.ts", import.meta.url)
    .href;
  const source = `
    import { runHookCommand } from ${JSON.stringify(moduleUrl)};
    Object.defineProperty(process, "platform", { value: process.env.PAGENT_TEST_PLATFORM });
    const code = await runHookCommand(JSON.parse(process.env.PAGENT_TEST_ARGS),
      JSON.parse(process.env.PAGENT_TEST_PATHS), process.env.PAGENT_TEST_HELPER);
    process.exitCode = code === null ? 77 : code;
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f.home,
        PAGENT_TEST_ARGS: JSON.stringify(argv),
        PAGENT_TEST_PATHS: JSON.stringify(f.paths),
        PAGENT_TEST_HELPER: f.helper,
        PAGENT_TEST_PLATFORM: platform,
      },
      timeout: 15_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function nodeLock(f: Fixture, path = f.paths.lockPath) {
  const source = `
    import { constants } from "node:fs";
    import { open } from "node:fs/promises";
    try {
      const file = await open(process.env.PAGENT_TEST_LOCK,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | ${DARWIN_O_EXLOCK});
      await file.close();
    } catch (error) {
      if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") process.exitCode = 2;
      else throw error;
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: f.home, PAGENT_TEST_LOCK: path },
      timeout: 15_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
async function nodeOwner(f: Fixture, source: string) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
      import { constants } from "node:fs";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { dirname, join } from "node:path";
      const paths = JSON.parse(process.env.PAGENT_TEST_PATHS);
      const helper = process.env.PAGENT_TEST_HELPER;
      let paused = false;
      async function pause() {
        if (paused) throw new Error("Node fixture owner paused more than once");
        paused = true;
        const resumed = new Promise(resolve => process.once("message", resolve));
        process.send("held");
        await resumed;
      }
      ${source}
      process.disconnect();
    `,
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        HOME: f.home,
        PAGENT_TEST_PATHS: JSON.stringify(f.paths),
        PAGENT_TEST_HELPER: f.helper,
      },
    },
  );
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  const { stdout, stderr } = child;
  assert.ok(stdout);
  assert.ok(stderr);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const paused = new Promise<void>((resolvePaused, rejectPaused) => {
    const fail = (error: Error): void => {
      clearTimeout(timer);
      rejectPaused(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`Node fixture owner never paused: ${output}`)),
      5000,
    );
    child.once("error", fail);
    stdout.on("error", fail);
    stderr.on("error", fail);
    child.once("exit", (code, signal) =>
      fail(
        new Error(`Node fixture owner exited: ${code}/${signal}: ${output}`),
      ),
    );
    child.once("message", (message) => {
      if (message !== "held")
        fail(new Error("Unexpected Node fixture checkpoint"));
      else {
        clearTimeout(timer);
        resolvePaused();
      }
    });
  });
  try {
    await paused;
  } catch (error) {
    child.kill("SIGKILL");
    await closed;
    throw error;
  }
  return { child, closed, output: () => output };
}
async function holdNodeLock(f: Fixture) {
  return await nodeOwner(
    f,
    `
    const file = await fs.open(paths.lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | ${DARWIN_O_EXLOCK});
    try { await pause(); }
    finally { await file.close(); }
  `,
  );
}
async function holdInstaller(
  f: Fixture,
  operation: "install" | "uninstall",
  phase:
    | "manifest"
    | "settings"
    | "removal"
    | "cleanup"
    | "failure-cleanup"
    | "backup"
    | "publication",
  expectedError: string | null = null,
) {
  const moduleUrl = new URL(
    "../../src/integration/claude/hook-install.ts",
    import.meta.url,
  ).href;
  return await nodeOwner(
    f,
    `
    const phase = ${JSON.stringify(phase)};
    const expectedError = ${JSON.stringify(expectedError)};
    const open = fs.open;
    const link = fs.link;
    const rename = fs.rename;
    const unlink = fs.unlink;
    const readdir = fs.readdir;
    let locked = false;
    fs.open = async (path, flags, ...args) => {
      const file = await open(path, flags, ...args);
      if (path === paths.lockPath && typeof flags === "number" && (flags & ${DARWIN_O_EXLOCK}))
        locked = true;
      return file;
    };
    fs.link = async (source, target) => {
      if (phase === "publication" && target === paths.lockPath) await pause();
      return await link(source, target);
    };
    fs.rename = async (source, target) => {
      if (phase === "failure-cleanup" && target === paths.settingsPath)
        throw new Error("Injected settings replacement failure");
      if ((phase === "manifest" && target === paths.manifestPath) ||
          (phase === "settings" && target === paths.settingsPath)) {
        if (!locked) throw new Error("Mutating installer did not acquire its own locked FD");
        await pause();
      }
      return await rename(source, target);
    };
    fs.unlink = async path => {
      if ((phase === "removal" && path === paths.manifestPath) ||
          ((phase === "cleanup" || phase === "failure-cleanup") &&
           path.startsWith(join(dirname(paths.settingsPath), ".settings.json.")))) {
        if (!locked) throw new Error("Mutating installer did not acquire its own locked FD");
        await pause();
      }
      return await unlink(path);
    };
    fs.readdir = async (...args) => {
      if (locked && phase === "backup" && args[0] === paths.backupDirectory) await pause();
      return await readdir(...args);
    };
    syncBuiltinESMExports();
    const { manageClaudeHooks } = await import(${JSON.stringify(moduleUrl)});
    let rejected = false;
    try { await manageClaudeHooks(${JSON.stringify(operation)}, true, paths, helper); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== expectedError) throw error;
      rejected = true;
    }
    if (expectedError !== null && !rejected) throw new Error("Installer unexpectedly succeeded");
  `,
  );
}

test("check and both previews never create or rewrite any fixture path", async () => {
  await fixture(async (f) => {
    const empty = await tree(f.home);
    assert.equal(
      (await manageClaudeHooks("check", false, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
    assert.equal(
      (await manageClaudeHooks("install", false, f.paths, f.helper)).pagent.diff
        .length,
      hookEvents.length,
    );
    assert.equal(
      (await manageClaudeHooks("uninstall", false, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
    assert.equal(
      (await manageClaudeHooks("uninstall", true, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
    assert.deepEqual(await tree(f.home), empty);
    await settings(f, {
      secret: "never print this",
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "future-provider", payload: { keep: true } }],
          },
        ],
      },
    });
    const before = await tree(f.home);
    for (const operation of ["check", "install", "uninstall"] as const)
      await manageClaudeHooks(operation, false, f.paths, f.helper);
    assert.deepEqual(await tree(f.home), before);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const installed = await tree(f.home);
    await manageClaudeHooks("check", false, f.paths, f.helper);
    await manageClaudeHooks("install", false, f.paths, f.helper);
    await manageClaudeHooks("uninstall", false, f.paths, f.helper);
    assert.deepEqual(await tree(f.home), installed);
  });
});

test("installation is exact, private, stable, idempotent, and preserves unrelated order", async () => {
  await fixture(async (f) => {
    const original = {
      theme: "unchanged",
      custom: { nested: [1, 2] },
      hooks: {
        Stop: [
          {
            matcher: "",
            extra: "keep",
            hooks: [
              { type: "command", command: "original one", timeout: 8 },
              { type: "future-hook", special: { data: true } },
            ],
          },
        ],
        FutureEvent: [
          { hooks: [{ type: "agent", prompt: "unknown events survive" }] },
        ],
        SessionEnd: [],
      },
    };
    await settings(f, original);
    const originalBytes = await readFile(f.paths.settingsPath);
    const result = await manageClaudeHooks("install", true, f.paths, f.helper);
    assert.equal(result.pagent.status, "installed");
    const manifest = await json(f.paths.manifestPath);
    assert.match(String(manifest.installationId), /^[0-9a-f-]{36}$/);
    const installed = await json(f.paths.settingsPath);
    assert.deepEqual(installed.custom, original.custom);
    assert.deepEqual(groups(installed, "Stop")[0], original.hooks.Stop[0]);
    assert.deepEqual(
      groups(installed, "FutureEvent"),
      original.hooks.FutureEvent,
    );
    for (const event of hookEvents) {
      const handler = ownedHandler(installed, event);
      assert.deepEqual(handler, {
        type: "command",
        timeout: 1,
        command: [
          f.helper,
          "--installation-id",
          String(manifest.installationId),
          "--descriptor",
          f.paths.descriptorPath,
        ]
          .map(quoteHookArgument)
          .join(" "),
      });
      assert.equal(
        ownedGroup(installed, event).matcher,
        event === "Notification" ? "permission_prompt" : "",
      );
      assert.equal(Object.hasOwn(handler, "async"), false);
    }
    for (const path of [f.paths.manifestPath, f.paths.settingsPath])
      assert.equal((await lstat(path)).mode & 0o7777, 0o600);
    for (const path of [f.paths.userData, f.paths.backupDirectory])
      assert.equal((await lstat(path)).mode & 0o7777, 0o700);
    const backups = await readdir(f.paths.backupDirectory);
    assert.equal(backups.length, 1);
    assert.deepEqual(
      await readFile(join(f.paths.backupDirectory, backups[0]!)),
      originalBytes,
    );
    const before = await tree(f.home);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    assert.deepEqual(await tree(f.home), before);
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    assert.deepEqual(await json(f.paths.settingsPath), original);
    await assert.rejects(lstat(f.paths.manifestPath), { code: "ENOENT" });
  });
});

test("user edits and handlers inside owned groups survive uninstall with the helper missing", async () => {
  await fixture(async (f) => {
    await settings(f, {
      theme: "before",
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "keep first" }] },
        ],
      },
    });
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const edited = await json(f.paths.settingsPath);
    edited.theme = "after";
    edited.userAdded = { value: 42 };
    const group = ownedGroup(edited, "PermissionRequest");
    const added = {
      type: "prompt",
      prompt: "nonowned addition",
      arbitrary: [1, 2],
    };
    (group.hooks as unknown[]).push(added);
    const retainedEmptyGroup = ownedGroup(edited, "SessionStart");
    retainedEmptyGroup.newField = "do not discard user group metadata";
    await settings(f, edited);
    await unlink(f.helper);
    assert.equal(
      (await manageClaudeHooks("check", false, f.paths, f.helper)).pagent
        .status,
      "installed",
    );
    const before = await tree(f.home);
    const preview = await manageClaudeHooks(
      "uninstall",
      false,
      f.paths,
      f.helper,
    );
    assert.equal(preview.pagent.diff.length, hookEvents.length);
    assert.deepEqual(await tree(f.home), before);
    const result = await manageClaudeHooks(
      "uninstall",
      true,
      f.paths,
      f.helper,
    );
    assert.equal(result.pagent.status, "not-installed");
    const after = await json(f.paths.settingsPath);
    assert.equal(after.theme, "after");
    assert.deepEqual(after.userAdded, { value: 42 });
    assert.deepEqual(groups(after, "PermissionRequest"), [
      { matcher: "", hooks: [added] },
    ]);
    assert.deepEqual(groups(after, "SessionStart"), [
      { matcher: "", hooks: [], newField: retainedEmptyGroup.newField },
    ]);
    assert.deepEqual(groups(after, "Stop"), [
      { matcher: "", hooks: [{ type: "command", command: "keep first" }] },
    ]);
    assert.equal(
      (await manageClaudeHooks("uninstall", true, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
  });
});

test("prepared manifests and partially missing entries reconcile using the original UUID", async () => {
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const manifest = await readFile(f.paths.manifestPath, "utf8");
    // Model termination after durable intent but before any settings publication.
    await unlink(f.paths.settingsPath);
    assert.equal(
      (await manageClaudeHooks("check", false, f.paths, f.helper)).pagent
        .status,
      "prepared",
    );
    await manageClaudeHooks("install", true, f.paths, f.helper);
    assert.equal(await readFile(f.paths.manifestPath, "utf8"), manifest);
    const partial = await json(f.paths.settingsPath);
    assert.ok(isRecord(partial.hooks));
    delete partial.hooks.PreToolUse;
    await settings(f, partial);
    const check = await manageClaudeHooks("check", false, f.paths, f.helper);
    assert.equal(check.pagent.status, "partial");
    assert.deepEqual(check.pagent.diff, [
      { event: "PreToolUse", matcher: "", action: "add" },
    ]);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    assert.equal(await readFile(f.paths.manifestPath, "utf8"), manifest);
    const repaired = await json(f.paths.settingsPath);
    for (const event of hookEvents)
      assert.equal(groups(repaired, event).length, 1);
    await unlink(f.paths.settingsPath);
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    await assert.rejects(lstat(f.paths.settingsPath), { code: "ENOENT" });
    await assert.rejects(lstat(f.paths.manifestPath), { code: "ENOENT" });
  });
});

test("modified, moved, duplicated, and orphan ownership is refused without writes", async () => {
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const original = await readFile(f.paths.settingsPath, "utf8");
    const changes: ((value: JsonObject) => void)[] = [
      (value) => {
        ownedHandler(value, "Stop").timeout = 2;
      },
      (value) => {
        ownedHandler(value, "PermissionRequest").async = true;
      },
      (value) => {
        ownedHandler(value, "Stop").type = "prompt";
      },
      (value) => {
        ownedHandler(value, "Stop").command =
          `${quoteHookArgument(f.helper)} changed`;
      },
      (value) => {
        const handler = ownedHandler(value, "Stop");
        handler.command = `${String(handler.command)} ; echo changed`;
      },
      (value) => {
        ownedGroup(value, "Stop").matcher = "different";
      },
      (value) => {
        (ownedGroup(value, "Stop").hooks as unknown[]).push({
          ...ownedHandler(value, "Stop"),
        });
      },
      (value) => {
        assert.ok(isRecord(value.hooks));
        value.hooks.FutureEvent = value.hooks.Stop;
        delete value.hooks.Stop;
      },
    ];
    for (const change of changes) {
      const value: unknown = JSON.parse(original);
      assert.ok(isRecord(value));
      change(value);
      await settings(f, value);
      const before = await tree(f.home);
      for (const operation of ["check", "install", "uninstall"] as const)
        await refused(
          manageClaudeHooks(
            operation,
            operation !== "check",
            f.paths,
            f.helper,
          ),
        );
      assert.deepEqual(await tree(f.home), before);
    }
    await writeFile(f.paths.settingsPath, original);
    await unlink(f.paths.manifestPath);
    const before = await tree(f.home);
    for (const operation of ["check", "install", "uninstall"] as const)
      await refused(
        manageClaudeHooks(operation, operation !== "check", f.paths, f.helper),
      );
    assert.deepEqual(await tree(f.home), before);
  });
});

test("malformed JSON and unsupported settings schemas never start installation", async () => {
  await fixture(async (f) => {
    await mkdir(dirname(f.paths.settingsPath), { mode: 0o700 });
    for (const bytes of [
      "{",
      "null",
      "[]",
      '{"unknown":1e400}',
      '{"hooks":[]}',
      '{"hooks":{"Stop":{}}}',
      '{"hooks":{"Stop":[{"hooks":{}}]}}',
      '{"hooks":{"Stop":[{"hooks":["command"]}]}}',
      '{"hooks":{"Stop":[{"matcher":false,"hooks":[]}]}}',
      Buffer.from([0xff]),
    ]) {
      await writeFile(f.paths.settingsPath, bytes, { mode: 0o600 });
      const before = await tree(f.home);
      for (const operation of ["check", "install", "uninstall"] as const)
        await refused(
          manageClaudeHooks(
            operation,
            operation !== "check",
            f.paths,
            f.helper,
          ),
        );
      assert.deepEqual(await tree(f.home), before);
    }
  });
});

test("lossy numeric lexemes fail closed before any install or uninstall mutation", async () => {
  await fixture(async (f) => {
    await mkdir(dirname(f.paths.settingsPath), { mode: 0o700 });
    const lossy = [
      "9007199254740993",
      "1e-400",
      "-1e-400",
      "0.100000000000000005",
      "4.9406564584124654e-324",
      `1.${"0".repeat(2000)}1`,
    ];
    for (const installed of [false, true]) {
      if (installed) {
        await settings(f, {});
        await manageClaudeHooks("install", true, f.paths, f.helper);
      }
      const source = installed
        ? await readFile(f.paths.settingsPath, "utf8")
        : "{}";
      for (const lexeme of lossy) {
        const bytes = source.replace(
          "{",
          `{"unrelated":${lexeme}${source.trim() === "{}" ? "" : ","}`,
        );
        await writeFile(f.paths.settingsPath, bytes, { mode: 0o600 });
        const before = await tree(f.home);
        for (const operation of ["check", "install", "uninstall"] as const)
          await refused(
            manageClaudeHooks(
              operation,
              operation !== "check",
              f.paths,
              f.helper,
            ),
          );
        assert.deepEqual(await tree(f.home), before);
        assert.equal(await readFile(f.paths.settingsPath, "utf8"), bytes);
      }
    }
  });
});

test("negative zero is refused before any fixture mutation, including equivalent zero lexemes", async () => {
  await fixture(async (f) => {
    await mkdir(dirname(f.paths.settingsPath), { mode: 0o700 });
    for (const installed of [false, true]) {
      if (installed) {
        await settings(f, {});
        await manageClaudeHooks("install", true, f.paths, f.helper);
      }
      const source = installed
        ? await readFile(f.paths.settingsPath, "utf8")
        : "{}";
      for (const lexeme of ["-0", "-0.0", "-0e0", "-0.000e9000"]) {
        assert.equal(Object.is(JSON.parse(lexeme), -0), true);
        const bytes = source.replace(
          "{",
          `{"unrelated":{"offset":${lexeme}}${source.trim() === "{}" ? "" : ","}`,
        );
        await writeFile(f.paths.settingsPath, bytes, { mode: 0o600 });
        const before = await tree(f.home);
        for (const operation of ["check", "install", "uninstall"] as const)
          for (const apply of operation === "check" ? [false] : [false, true])
            await refused(
              manageClaudeHooks(operation, apply, f.paths, f.helper),
            );
        assert.deepEqual(await tree(f.home), before);
        assert.equal(await readFile(f.paths.settingsPath, "utf8"), bytes);
      }
    }
  });
});

test("equivalent decimal notation survives install and uninstall without mathematical changes", async () => {
  await fixture(async (f) => {
    await mkdir(dirname(f.paths.settingsPath), { mode: 0o700 });
    const numbers = [
      "1.00e+2",
      "10e-1",
      "0.10",
      "9.007199254740992e15",
      "0.000e9000",
      "5e-324",
      "1.7976931348623157e308",
      "1.2300e2",
      `0.${"0".repeat(1000)}1e1001`,
    ];
    const source = `{"unrelated":[${numbers.join(",")}],"nested":{"value":2.5000e-1}}`;
    const expected: unknown = JSON.parse(JSON.stringify(JSON.parse(source)));
    await writeFile(f.paths.settingsPath, source, { mode: 0o600 });
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const installed = await json(f.paths.settingsPath);
    assert.ok(isRecord(expected));
    assert.deepEqual(installed.unrelated, expected.unrelated);
    assert.deepEqual(installed.nested, expected.nested);
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    assert.deepEqual(await json(f.paths.settingsPath), expected);
  });
});

test("symlink and nonregular settings are refused before touching installer files or referents", async () => {
  await fixture(async (f) => {
    await mkdir(dirname(f.paths.settingsPath), { mode: 0o700 });
    const referent = join(f.home, "referent.json");
    await writeFile(referent, '{"untouched":true}', { mode: 0o600 });
    for (const installed of [false, true]) {
      if (installed)
        await manageClaudeHooks("install", true, f.paths, f.helper);
      if (installed) await unlink(f.paths.settingsPath);
      await symlink(referent, f.paths.settingsPath);
      const before = await tree(f.home);
      for (const operation of ["check", "install", "uninstall"] as const)
        await refused(
          manageClaudeHooks(
            operation,
            operation !== "check",
            f.paths,
            f.helper,
          ),
        );
      assert.deepEqual(await tree(f.home), before);
      assert.equal(await readFile(referent, "utf8"), '{"untouched":true}');
      await unlink(f.paths.settingsPath);
    }
    await mkdir(f.paths.settingsPath, { mode: 0o700 });
    const before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
  });
});

test("private path symlinks and insecure manifests are not repaired or followed", async () => {
  for (const key of [
    "userData",
    "manifestPath",
    "lockPath",
    "backupDirectory",
    "descriptorPath",
  ] as const) {
    await fixture(async (f) => {
      await mkdir(dirname(f.paths[key]), { recursive: true, mode: 0o700 });
      const target = join(f.home, "foreign-private-target");
      if (key === "userData" || key === "backupDirectory")
        await mkdir(target, { mode: 0o700 });
      else await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, f.paths[key]);
      const before = await tree(f.home);
      await refused(manageClaudeHooks("install", true, f.paths, f.helper));
      await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
      assert.deepEqual(await tree(f.home), before);
    });
  }
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const manifest = await readFile(f.paths.manifestPath, "utf8");
    await chmod(f.paths.manifestPath, 0o644);
    const before = await tree(f.home);
    await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
    await chmod(f.paths.manifestPath, 0o600);
    for (const value of [
      "{}",
      "{",
      `${manifest.slice(0, -2)},"foreign":true}`,
    ]) {
      await writeFile(f.paths.manifestPath, value);
      const beforeInvalid = await tree(f.home);
      await refused(manageClaudeHooks("install", true, f.paths, f.helper));
      assert.deepEqual(await tree(f.home), beforeInvalid);
    }
  });
});

test("unsafe settings and private directory permissions are refused without repair", async () => {
  await fixture(async (f) => {
    await settings(f, { keep: true });
    await chmod(f.paths.settingsPath, 0o666);
    let before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
    await chmod(f.paths.settingsPath, 0o600);
    await mkdir(f.paths.userData, { recursive: true, mode: 0o700 });
    await chmod(f.paths.userData, 0o755);
    before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
    await chmod(f.paths.userData, 0o700);
    await mkdir(f.paths.backupDirectory, { mode: 0o700 });
    const target = join(f.home, "backup-referent");
    await writeFile(target, "do not follow", { mode: 0o600 });
    await symlink(
      target,
      join(f.paths.backupDirectory, `hooks-1234567890123-${randomUUID()}.json`),
    );
    before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
  });
});

test("helper validation requires an owned regular executable but never blocks check or uninstall", async () => {
  await fixture(async (f) => {
    await chmod(f.helper, 0o600);
    const before = await tree(f.home);
    await refused(manageClaudeHooks("install", false, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
    await chmod(f.helper, 0o700);
    const target = join(f.home, "real-helper");
    await writeFile(target, "fake", { mode: 0o700 });
    await unlink(f.helper);
    await symlink(target, f.helper);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    await unlink(f.helper);
    assert.equal(
      (await manageClaudeHooks("check", false, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
    assert.equal(
      (await manageClaudeHooks("uninstall", true, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
  });
});

test("settings and manifest reads are bounded, including UTF-8 byte counts", async () => {
  await fixture(async (f) => {
    await mkdir(dirname(f.paths.settingsPath), { mode: 0o700 });
    await writeFile(f.paths.settingsPath, " ".repeat(SETTINGS_LIMIT + 1));
    let before = await tree(f.home);
    await refused(manageClaudeHooks("check", false, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
    const small = JSON.stringify({
      text: "한".repeat(Math.floor(SETTINGS_LIMIT / 3)),
    });
    assert.ok(Buffer.byteLength(small) > SETTINGS_LIMIT);
    await writeFile(f.paths.settingsPath, small);
    await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
    const exact = `{"keep":"${"x".repeat(SETTINGS_LIMIT - Buffer.byteLength('{"keep":""}'))}"}`;
    assert.equal(Buffer.byteLength(exact), SETTINGS_LIMIT);
    await writeFile(f.paths.settingsPath, exact);
    assert.equal(
      (await manageClaudeHooks("check", false, f.paths, f.helper)).pagent
        .status,
      "not-installed",
    );
    before = await tree(f.home);
    await refused(manageClaudeHooks("install", false, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
    await settings(f, {});
    await mkdir(f.paths.userData, { recursive: true, mode: 0o700 });
    await writeFile(f.paths.manifestPath, " ".repeat(MANIFEST_LIMIT + 1), {
      mode: 0o600,
    });
    before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    assert.deepEqual(await tree(f.home), before);
  });
});

test("only fixed shell-quoted absolute arguments are emitted, even for hostile-looking paths", async () => {
  assert.equal(quoteHookArgument("a'b"), "'a'\\''b'");
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const manifest = await json(f.paths.manifestPath);
    const handler = ownedHandler(
      await json(f.paths.settingsPath),
      "PermissionRequest",
    );
    assert.equal(
      handler.command,
      `${quoteHookArgument(f.helper)} '--installation-id' ${quoteHookArgument(String(manifest.installationId))} '--descriptor' ${quoteHookArgument(f.paths.descriptorPath)}`,
    );
    assert.equal(String(handler.command).includes("$CLAUDE"), false);
    await refused(
      manageClaudeHooks("install", true, f.paths, "relative-helper"),
    );
    await refused(
      manageClaudeHooks("install", true, f.paths, `${f.helper}\nunsafe`),
    );
    const moved = join(f.home, "new helper");
    await writeFile(moved, "fake", { mode: 0o700 });
    const before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, moved));
    assert.deepEqual(await tree(f.home), before);
    await manageClaudeHooks("uninstall", true, f.paths, moved);
  }, "pagent's hooks-;$(no-execution)-");
});

test("apply retains at most three private bounded backups and never restores a whole backup", async () => {
  await fixture(async (f) => {
    for (let index = 0; index < 5; index++) {
      await settings(f, { currentUserValue: index });
      await manageClaudeHooks("install", true, f.paths, f.helper);
      const installed = await json(f.paths.settingsPath);
      installed.currentUserValue = `edited-${index}`;
      await settings(f, installed);
      await manageClaudeHooks("uninstall", true, f.paths, f.helper);
      assert.deepEqual(await json(f.paths.settingsPath), {
        currentUserValue: `edited-${index}`,
      });
      const names = await readdir(f.paths.backupDirectory);
      assert.ok(names.length <= 3);
      for (const name of names) {
        const stat = await lstat(join(f.paths.backupDirectory, name));
        assert.equal(stat.mode & 0o7777, 0o600);
        assert.ok(stat.size <= SETTINGS_LIMIT);
      }
    }
  });
});

test("a killed Node lock owner releases the same permanent inode for reacquisition", async () => {
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const original = await lstat(f.paths.lockPath);
    assert.equal(original.isFile(), true);
    assert.equal(original.mode & 0o7777, 0o600);
    assert.equal(await readFile(f.paths.lockPath, "utf8"), LOCK_MAGIC);
    const holder = await holdNodeLock(f);
    try {
      assert.equal(nodeLock(f).status, 2);
      assert.equal(holder.child.kill("SIGKILL"), true);
      assert.deepEqual(await holder.closed, { code: null, signal: "SIGKILL" });
      const successor = await holdNodeLock(f);
      try {
        assert.equal(nodeLock(f).status, 2);
        successor.child.send("continue");
        assert.deepEqual(
          await successor.closed,
          { code: 0, signal: null },
          successor.output(),
        );
      } finally {
        successor.child.kill("SIGKILL");
        await successor.closed;
      }
    } finally {
      holder.child.kill("SIGKILL");
      await holder.closed;
    }
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    assert.equal((await lstat(f.paths.lockPath)).ino, original.ino);
    assert.equal(await readFile(f.paths.lockPath, "utf8"), LOCK_MAGIC);
    await assert.rejects(lstat(f.paths.manifestPath), { code: "ENOENT" });
  });
});

test("concurrent Node owners and installer mutations cannot enter a held kernel lock", async () => {
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const holder = await holdNodeLock(f);
    try {
      const before = await tree(f.home);
      for (let attempt = 0; attempt < 3; attempt++) {
        const contender = nodeLock(f);
        assert.equal(contender.status, 2, contender.stderr);
        assert.equal(contender.stdout, "");
      }
      await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
      const contender = cli(f, ["hooks", "uninstall", "--apply"]);
      assert.equal(contender.status, 2, contender.stderr);
      assert.deepEqual(await tree(f.home), before);
    } finally {
      holder.child.send("continue");
      assert.deepEqual(
        await holder.closed,
        { code: 0, signal: null },
        holder.output(),
      );
    }
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
  });
});

test("the mutating installer retains its own locked FD through writes and awaited cleanup", async () => {
  for (const phase of ["manifest", "settings", "removal", "cleanup"] as const) {
    await fixture(async (f) => {
      await settings(f, { unrelated: phase });
      if (phase === "removal")
        await manageClaudeHooks("install", true, f.paths, f.helper);
      const owner = await holdInstaller(
        f,
        phase === "removal" ? "uninstall" : "install",
        phase,
      );
      const original = await lstat(f.paths.lockPath);
      try {
        const before = await tree(f.home);
        const contender = nodeLock(f);
        assert.equal(contender.status, 2, `${phase}: ${contender.stderr}`);
        const writer = cli(f, [
          "hooks",
          phase === "cleanup" ? "uninstall" : "install",
          "--apply",
        ]);
        assert.equal(writer.status, 2, `${phase}: ${writer.stderr}`);
        assert.deepEqual(await tree(f.home), before);
        owner.child.send("continue");
        assert.deepEqual(
          await owner.closed,
          { code: 0, signal: null },
          owner.output(),
        );
      } finally {
        owner.child.kill("SIGKILL");
        await owner.closed;
      }
      assert.equal(nodeLock(f).status, 0);
      assert.equal((await lstat(f.paths.lockPath)).ino, original.ino);
      if (phase !== "removal")
        await manageClaudeHooks("uninstall", true, f.paths, f.helper);
      assert.deepEqual(await json(f.paths.settingsPath), { unrelated: phase });
      await assert.rejects(lstat(f.paths.manifestPath), { code: "ENOENT" });
    });
  }
});

test("failed mutation retains the installer FD until its temporary cleanup has settled", async () => {
  await fixture(async (f) => {
    const owner = await holdInstaller(
      f,
      "install",
      "failure-cleanup",
      "Injected settings replacement failure",
    );
    const original = await lstat(f.paths.lockPath);
    try {
      const before = await tree(f.home);
      assert.equal(nodeLock(f).status, 2);
      const contender = cli(f, ["hooks", "install", "--apply"]);
      assert.equal(contender.status, 2, contender.stderr);
      assert.deepEqual(await tree(f.home), before);
      owner.child.send("continue");
      assert.deepEqual(
        await owner.closed,
        { code: 0, signal: null },
        owner.output(),
      );
    } finally {
      owner.child.kill("SIGKILL");
      await owner.closed;
    }
    assert.equal(nodeLock(f).status, 0);
    assert.equal((await lstat(f.paths.lockPath)).ino, original.ino);
    await assert.rejects(lstat(f.paths.settingsPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(dirname(f.paths.settingsPath)), []);
    assert.equal(
      (await manageClaudeHooks("check", false, f.paths, f.helper)).pagent
        .status,
      "prepared",
    );
    await manageClaudeHooks("install", true, f.paths, f.helper);
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
  });
});

test("SIGKILL of a mutating installer releases its FD and preserves prepared intent for retry", async () => {
  await fixture(async (f) => {
    const owner = await holdInstaller(f, "install", "settings");
    const original = await lstat(f.paths.lockPath);
    const manifest = await readFile(f.paths.manifestPath, "utf8");
    try {
      assert.equal(nodeLock(f).status, 2);
      assert.equal(owner.child.kill("SIGKILL"), true);
      assert.deepEqual(await owner.closed, { code: null, signal: "SIGKILL" });
    } finally {
      owner.child.kill("SIGKILL");
      await owner.closed;
    }
    assert.equal(nodeLock(f).status, 0);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    assert.equal(await readFile(f.paths.manifestPath, "utf8"), manifest);
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    assert.equal((await lstat(f.paths.lockPath)).ino, original.ino);
    assert.equal(await readFile(f.paths.lockPath, "utf8"), LOCK_MAGIC);
  });
});

test("foreign, malformed, insecure, symlink, and obsolete directory locks are never replaced", async () => {
  await fixture(async (f) => {
    await mkdir(f.paths.userData, { recursive: true, mode: 0o700 });
    await settings(f, {});
    for (const bytes of [
      "",
      "foreign",
      "{}",
      `${LOCK_MAGIC}extra`,
      "pagent-hook-lock-v2\n",
    ]) {
      await writeFile(f.paths.lockPath, bytes, { mode: 0o600 });
      const before = await tree(f.home);
      await refused(manageClaudeHooks("install", true, f.paths, f.helper));
      const result = cli(f, ["hooks", "install", "--apply"]);
      assert.equal(result.status, 2);
      assert.deepEqual(await tree(f.home), before);
      await unlink(f.paths.lockPath);
    }
    await writeFile(f.paths.lockPath, LOCK_MAGIC, { mode: 0o644 });
    let before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    assert.equal(cli(f, ["hooks", "install", "--apply"]).status, 2);
    assert.deepEqual(await tree(f.home), before);
    await unlink(f.paths.lockPath);
    await mkdir(f.paths.lockPath, { mode: 0o700 });
    before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    assert.equal(cli(f, ["hooks", "install", "--apply"]).status, 2);
    assert.deepEqual(await tree(f.home), before);
    await rm(f.paths.lockPath, { recursive: true });
    const referent = join(f.home, "foreign-lock");
    await writeFile(referent, LOCK_MAGIC, { mode: 0o600 });
    await symlink(referent, f.paths.lockPath);
    before = await tree(f.home);
    await refused(manageClaudeHooks("install", true, f.paths, f.helper));
    assert.equal(cli(f, ["hooks", "install", "--apply"]).status, 2);
    assert.deepEqual(await tree(f.home), before);
  });
});

test("lock publication prepares complete private magic before linking and never replaces a racing actor", async () => {
  await fixture(async (f) => {
    const owner = await holdInstaller(
      f,
      "install",
      "publication",
      "Unrecognized installer lock ownership magic",
    );
    try {
      await assert.rejects(lstat(f.paths.lockPath), { code: "ENOENT" });
      const names = await readdir(f.paths.userData);
      assert.equal(names.length, 1);
      const temporary = join(f.paths.userData, names[0]!);
      assert.match(names[0]!, /^\.hooks-install\.lock\.[0-9a-f-]+\.tmp$/);
      const prepared = await lstat(temporary);
      assert.equal(prepared.isFile(), true);
      assert.equal(prepared.mode & 0o7777, 0o600);
      assert.equal(prepared.nlink, 1);
      assert.equal(prepared.size, Buffer.byteLength(LOCK_MAGIC));
      assert.equal(await readFile(temporary, "utf8"), LOCK_MAGIC);
      await writeFile(f.paths.lockPath, "foreign actor", {
        mode: 0o600,
        flag: "wx",
      });
      const foreign = await lstat(f.paths.lockPath);
      owner.child.send("continue");
      assert.deepEqual(
        await owner.closed,
        { code: 0, signal: null },
        owner.output(),
      );
      assert.equal((await lstat(f.paths.lockPath)).ino, foreign.ino);
      assert.equal(await readFile(f.paths.lockPath, "utf8"), "foreign actor");
      assert.deepEqual(await readdir(f.paths.userData), ["hooks-install.lock"]);
      await assert.rejects(lstat(f.paths.manifestPath), { code: "ENOENT" });
      await assert.rejects(lstat(f.paths.settingsPath), { code: "ENOENT" });
    } finally {
      owner.child.kill("SIGKILL");
      await owner.closed;
    }
  });
});

test("interrupted hard-link publication remains usable and does not remove an alias", async () => {
  await fixture(async (f) => {
    await mkdir(f.paths.userData, { recursive: true, mode: 0o700 });
    const prepared = join(f.paths.userData, ".hooks-install.lock.prepared.tmp");
    await writeFile(prepared, LOCK_MAGIC, { mode: 0o600 });
    await link(prepared, f.paths.lockPath);
    const original = await lstat(prepared);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const owner = await holdNodeLock(f);
    try {
      assert.equal(nodeLock(f, prepared).status, 2);
      owner.child.send("continue");
      assert.deepEqual(
        await owner.closed,
        { code: 0, signal: null },
        owner.output(),
      );
    } finally {
      owner.child.kill("SIGKILL");
      await owner.closed;
    }
    await manageClaudeHooks("uninstall", true, f.paths, f.helper);
    assert.equal(nodeLock(f, prepared).status, 0);
    assert.equal((await lstat(f.paths.lockPath)).ino, original.ino);
    assert.equal((await lstat(prepared)).ino, original.ino);
    assert.equal(await readFile(prepared, "utf8"), LOCK_MAGIC);
  });
});

test("unsupported installer lock paths and an unsafe parent are refused without writes", async () => {
  await fixture(async (f) => {
    await mkdir(f.paths.userData, { recursive: true, mode: 0o700 });
    await writeFile(f.paths.lockPath, LOCK_MAGIC, { mode: 0o600 });
    const before = await tree(f.home);
    for (const lockPath of [
      "",
      "relative",
      `${f.paths.lockPath}/`,
      `${f.paths.userData}/unused/../hooks-install.lock`,
      `${f.paths.lockPath}\n`,
    ])
      for (const operation of ["install", "uninstall"] as const)
        await refused(
          manageClaudeHooks(
            operation,
            true,
            { ...f.paths, lockPath },
            f.helper,
          ),
        );
    assert.deepEqual(await tree(f.home), before);
    await chmod(f.paths.userData, 0o755);
    const insecure = await tree(f.home);
    for (const operation of ["check", "install", "uninstall"] as const)
      await refused(
        manageClaudeHooks(operation, operation !== "check", f.paths, f.helper),
      );
    assert.equal(cli(f, ["hooks", "install", "--apply"]).status, 2);
    assert.deepEqual(await tree(f.home), insecure);
    await chmod(f.paths.userData, 0o700);
  });
});

test("replacement of a held public path fails installer verification without deleting either actor's inode", async () => {
  await fixture(async (f) => {
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const owner = await holdInstaller(
      f,
      "uninstall",
      "backup",
      "Installer lock verification failed; retry explicitly",
    );
    const moved = join(f.paths.userData, "held-lock-inode");
    const original = await lstat(f.paths.lockPath);
    try {
      await link(f.paths.lockPath, moved);
      await unlink(f.paths.lockPath);
      await writeFile(f.paths.lockPath, "another actor", { mode: 0o600 });
      const replacement = await lstat(f.paths.lockPath);
      const before = await tree(f.home);
      assert.equal(nodeLock(f, moved).status, 2);
      await refused(manageClaudeHooks("uninstall", true, f.paths, f.helper));
      owner.child.send("continue");
      assert.deepEqual(
        await owner.closed,
        { code: 0, signal: null },
        owner.output(),
      );
      assert.deepEqual(await tree(f.home), before);
      assert.equal(nodeLock(f, moved).status, 0);
      assert.equal((await lstat(f.paths.lockPath)).ino, replacement.ino);
      assert.equal(await readFile(f.paths.lockPath, "utf8"), "another actor");
      assert.equal((await lstat(moved)).ino, original.ino);
      assert.equal(await readFile(moved, "utf8"), LOCK_MAGIC);
      await lstat(f.paths.manifestPath);
    } finally {
      owner.child.kill("SIGKILL");
      await owner.closed;
    }
  });
});

test("non-Darwin apply refuses rather than falling back, including idempotent operations", async () => {
  await fixture(async (f) => {
    for (const installed of [false, true]) {
      if (installed)
        await manageClaudeHooks("install", true, f.paths, f.helper);
      const before = await tree(f.home);
      for (const operation of ["install", "uninstall"] as const) {
        assert.equal(
          cli(f, ["hooks", operation, "--apply"], "linux").status,
          2,
        );
        assert.equal(cli(f, ["hooks", operation], "linux").status, 0);
      }
      assert.equal(cli(f, ["hooks", "check"], "linux").status, 0);
      assert.deepEqual(await tree(f.home), before);
    }
  });
});

test("the direct Node CLI dispatch is read-only by default, redacted, and has stable exit codes", async () => {
  await fixture(async (f) => {
    await settings(f, {
      secret: "SENSITIVE_SETTINGS_VALUE",
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "SENSITIVE_OTHER_HANDLER" }],
          },
        ],
      },
    });
    const before = await tree(f.home);
    assert.equal(await runHookCommand(["not-hooks"], f.paths, f.helper), null);
    for (const argv of [
      ["hooks", "check"],
      ["hooks", "install"],
      ["hooks", "uninstall"],
    ]) {
      const result = cli(f, argv);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes("SENSITIVE_"), false);
      const report: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(report));
      assert.deepEqual(Object.keys(report).sort(), [
        "mode",
        "pagent",
        "targets",
      ]);
    }
    for (const argv of [
      ["hooks"],
      ["hooks", "unknown"],
      ["hooks", "check", "--apply"],
      ["hooks", "install", "--yes"],
      ["hooks", "install", "--apply", "extra"],
      ["hooks", "uninstall", "--apply", "--apply"],
    ])
      assert.equal(cli(f, argv).status, 2);
    assert.deepEqual(await tree(f.home), before);
    assert.equal(cli(f, ["hooks", "install", "--apply"]).status, 0);
    assert.equal(cli(f, ["hooks", "check"]).status, 0);
    await unlink(f.helper);
    assert.equal(cli(f, ["hooks", "uninstall", "--apply"]).status, 0);
    await writeFile(f.paths.settingsPath, "malformed");
    assert.equal(cli(f, ["hooks", "check"]).status, 2);
  });
});

test(
  "direct CLI reports ordinary I/O failures as exit 1 without leaking settings",
  {
    skip:
      process.getuid?.() === 0
        ? "root bypasses fixture directory write permissions"
        : false,
  },
  async () => {
    await fixture(async (f) => {
      const library = join(f.home, "Library");
      await mkdir(library, { mode: 0o500 });
      try {
        const result = cli(f, ["hooks", "install", "--apply"]);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(
          result.stdout.includes("Hook I/O or verification failed"),
          true,
        );
      } finally {
        await chmod(library, 0o700);
      }
    });
  },
);

test("relocation rewrites owned hooks to a moved helper and keeps unrelated settings", async () => {
  await fixture(async (f) => {
    const original = {
      theme: "kept",
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "mine" }] }],
      },
    };
    await settings(f, original);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const moved = join(f.home, "Applications", "pagent-hook-emitter");
    await mkdir(dirname(moved), { mode: 0o700 });
    await writeFile(moved, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const result = await relocateClaudeHooks(f.paths, moved);
    assert.equal(result?.pagent.status, "installed");
    assert.equal((await json(f.paths.manifestPath)).helperPath, moved);
    const relocated = await json(f.paths.settingsPath);
    assert.equal(JSON.stringify(relocated).includes(f.helper), false);
    for (const event of hookEvents)
      assert.equal(
        String(ownedHandler(relocated, event).command).startsWith(
          quoteHookArgument(moved),
        ),
        true,
      );
    assert.equal(relocated.theme, "kept");
    assert.deepEqual(groups(relocated, "Stop")[0], original.hooks.Stop[0]);
    const before = await tree(f.home);
    assert.equal(await relocateClaudeHooks(f.paths, moved), null);
    assert.deepEqual(await tree(f.home), before);
    await manageClaudeHooks("uninstall", true, f.paths, moved);
    assert.deepEqual(await json(f.paths.settingsPath), original);
  });
});

test("relocation never installs without a manifest or toward a missing helper", async () => {
  await fixture(async (f) => {
    await settings(f, { theme: "untouched" });
    const before = await tree(f.home);
    assert.equal(await relocateClaudeHooks(f.paths, f.helper), null);
    assert.deepEqual(await tree(f.home), before);
    await manageClaudeHooks("install", true, f.paths, f.helper);
    const installed = await tree(f.home);
    await refused(
      relocateClaudeHooks(f.paths, join(f.home, "missing", "helper")),
    );
    assert.deepEqual(await tree(f.home), installed);
  });
});
