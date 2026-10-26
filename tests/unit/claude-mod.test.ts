import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Hook = (
  $: unknown,
  e: Record<string, unknown>,
  next: (e: unknown) => Promise<unknown>,
) => Promise<unknown>;

const userData = "/Users/fixture/Library/Application Support/watchling";
const manifest = {
  version: 2,
  installationId: "11111111-1111-4111-8111-111111111111",
  helperPath:
    "/Applications/Watchling.app/Contents/Resources/helpers/watchling-hook-emitter",
  descriptorPath: `${userData}/endpoint.json`,
};

let copies = 0;
async function load(files: Record<string, string> = {}) {
  const url = pathToFileURL(
    join(import.meta.dirname, "../../resources/claude-mod/hooks/register.js"),
  );
  url.search = `copy=${++copies}`;
  const module = (await import(url.href)) as {
    register: (on: (name: string, hook: Hook) => void) => void;
    NEXT_TURN_GRACE_MS: number;
  };
  const hooks = new Map<string, Hook>();
  module.register((name, hook) => hooks.set(name, hook));
  const timers: { ms: number; fn: () => void }[] = [];
  const runs: { argv: string[]; init: { stdin: string } }[] = [];
  const logs: string[] = [];
  const stored: Record<string, string> = {
    [`${userData}/hooks-installation.json`]: JSON.stringify(manifest),
    ...files,
  };
  const session = { id: "session-1" };
  const $ = {
    plugin: { root: `${userData}/claude-mod/` },
    fs: {
      exists: async (path: string) => path in stored,
      read: async (path: string) => stored[path]!,
    },
    session: {
      id: async () => session.id,
      cwd: async () => "/Users/fixture/project",
    },
    process: {
      run: async (argv: string[], init: { stdin: string }) => {
        runs.push({ argv, init });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    clock: {
      after: (ms: number, fn: () => void) => {
        timers.push({ ms, fn });
        return { cancel() {} };
      },
    },
    ui: { log: (text: string) => logs.push(text) },
  };
  const fire = (name: string, e: Record<string, unknown>, result?: unknown) =>
    hooks.get(name)!($, e, async () => result ?? {});
  const elapse = async () => {
    for (const timer of timers.splice(0)) {
      assert.equal(timer.ms, module.NEXT_TURN_GRACE_MS);
      timer.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { fire, elapse, runs, logs, session };
}

test("an ended main turn runs the helper with only session metadata", async () => {
  const mod = await load();
  await mod.fire(
    "turn.start",
    { turnId: "t1", text: "secret" },
    { turnId: "t1" },
  );
  await mod.fire("turn.complete", {
    turnId: "t1",
    isAborted: true,
    reason: "aborted",
    answer: "secret answer",
  });
  mod.session.id = "session-after-clear";
  assert.equal(mod.runs.length, 0);
  await mod.elapse();
  assert.equal(mod.runs.length, 1);
  assert.deepEqual(mod.runs[0]!.argv, [
    manifest.helperPath,
    "--installation-id",
    manifest.installationId,
    "--descriptor",
    manifest.descriptorPath,
  ]);
  assert.deepEqual(JSON.parse(mod.runs[0]!.init.stdin), {
    hook_event_name: "TurnEnded",
    session_id: "session-1",
    cwd: "/Users/fixture/project",
  });
});

test("a turn dismissed at a permission prompt is reported, a subagent's is not", async () => {
  const mod = await load();
  await mod.fire("turn.start", { turnId: "t1" }, { turnId: "t1" });
  await mod.fire("turn.complete", {
    turnId: "t1",
    isAborted: false,
    reason: "answer",
  });
  await mod.fire(
    "turn.start",
    { turnId: "a1", agentId: "agent-1" },
    { turnId: "a1" },
  );
  await mod.fire("turn.complete", {
    turnId: "a1",
    agentId: "agent-1",
    isAborted: true,
  });
  await mod.elapse();
  assert.equal(mod.runs.length, 1);
});

test("a prompt or turn that starts within the grace period owns the session", async () => {
  for (const next of ["prompt.submit", "turn.start"]) {
    const mod = await load();
    await mod.fire("turn.start", { turnId: "t1" }, { turnId: "t1" });
    await mod.fire("turn.complete", { turnId: "t1", isAborted: true });
    await mod.fire(next, { turnId: "t2", text: "yes" }, { turnId: "t2" });
    await mod.elapse();
    assert.deepEqual(mod.runs, []);
  }
});

test("a subagent starting after the turn ends does not hide it", async () => {
  const mod = await load();
  await mod.fire("turn.start", { turnId: "t1" }, { turnId: "t1" });
  await mod.fire("turn.complete", { turnId: "t1", isAborted: true });
  await mod.fire(
    "turn.start",
    { turnId: "a1", agentId: "agent-1" },
    { turnId: "a1" },
  );
  await mod.elapse();
  assert.equal(mod.runs.length, 1);
});

test("a turn whose start the mod missed is still reported", async () => {
  const mod = await load();
  await mod.fire("turn.complete", { turnId: "t1", isAborted: true });
  await mod.elapse();
  assert.equal(mod.runs.length, 1);
});

test("without a usable installation manifest nothing runs", async () => {
  const path = `${userData}/hooks-installation.json`;
  for (const content of [
    "{}",
    JSON.stringify({ ...manifest, helperPath: "relative/helper" }),
    JSON.stringify({ ...manifest, helperPath: "/usr/bin/true" }),
    "null",
  ]) {
    const mod = await load({ [path]: content });
    await mod.fire("turn.complete", { turnId: "t1", isAborted: true });
    await mod.elapse();
    assert.deepEqual(mod.runs, []);
  }
  const broken = await load({ [path]: "{" });
  await broken.fire("turn.complete", { turnId: "t1", isAborted: true });
  await broken.elapse();
  assert.deepEqual(broken.runs, []);
  assert.equal(broken.logs.length, 1);
});
