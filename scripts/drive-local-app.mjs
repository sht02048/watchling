import { _electron as electron } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const bundle = resolve("build/unfused/mac-arm64/pagent.app");
const executable = join(bundle, "Contents/MacOS/pagent");
const output = resolve("build/verification", `drive-${Date.now()}`);
const home = await mkdtemp(join(tmpdir(), "pagent-drive-"));
const project = "/private/tmp/pagent-drive-project";

async function hooks(...args) {
  const { stdout } = await execute(executable, ["hooks", ...args], {
    env: { ...process.env, HOME: home },
    timeout: 10000,
  });
  return JSON.parse(stdout);
}

function installedCommands(settings) {
  const commands = new Map();
  for (const [event, groups] of Object.entries(settings.hooks ?? {}))
    for (const group of groups)
      for (const handler of group.hooks ?? [])
        if (handler.command?.includes("pagent-hook-emitter"))
          commands.set(event, handler.command);
  return commands;
}

function runHook(command, payload, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const session = (id) => ({ session_id: id, cwd: project });
const bash = { command: "echo pagent-drive" };
const steps = [
  {
    name: "session start",
    event: { ...session("drive-a"), hook_event_name: "SessionStart" },
    expect: "idle",
    sessions: 1,
  },
  {
    name: "prompt submitted",
    event: { ...session("drive-a"), hook_event_name: "UserPromptSubmit" },
    expect: "working",
    sessions: 1,
  },
  {
    name: "tool requested",
    event: {
      ...session("drive-a"),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_drive_1",
      tool_input: bash,
    },
    expect: "working",
    sessions: 1,
  },
  {
    name: "permission prompt",
    event: {
      ...session("drive-a"),
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: bash,
    },
    env: { CLAUDE_CODE_SESSION_ATTENDED: "1" },
    expect: "asking",
    sessions: 1,
  },
  {
    name: "tool finished",
    event: {
      ...session("drive-a"),
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_drive_1",
      tool_input: bash,
    },
    expect: "working",
    sessions: 1,
  },
  {
    name: "non-interactive permission in another session",
    event: {
      ...session("drive-b"),
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: bash,
    },
    env: { CLAUDE_CODE_SESSION_ATTENDED: "0" },
    expect: "working",
    sessions: 2,
  },
  {
    name: "first turn ended while the other session works",
    event: { ...session("drive-a"), hook_event_name: "Stop" },
    expect: "working",
    sessions: 2,
  },
  {
    name: "all turns ended",
    event: { ...session("drive-b"), hook_event_name: "Stop" },
    expect: "done",
    sessions: 2,
  },
  {
    name: "sessions ended",
    event: [
      { ...session("drive-a"), hook_event_name: "SessionEnd" },
      { ...session("drive-b"), hook_event_name: "SessionEnd" },
    ],
    expect: "idle",
    sessions: 0,
  },
];

let application;
const report = { bundle, home, steps: [] };
let failed = false;
try {
  await mkdir(output, { recursive: true });
  await mkdir(join(home, ".claude"), { mode: 0o700 });
  await writeFile(join(home, ".claude", "settings.json"), "{}", {
    mode: 0o600,
  });
  const install = await hooks("install", "--apply");
  if (
    install.pagent?.status === "failed" ||
    install.pagent?.status === "refused"
  )
    throw new Error(`hook install failed: ${install.pagent.reason}`);
  const commands = installedCommands(
    JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")),
  );

  application = await electron.launch({
    executablePath: executable,
    env: { ...process.env, HOME: home },
  });
  await application.firstWindow();
  const findWindow = async (part) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const page = application.windows().find((w) => w.url().includes(part));
      if (page) return page;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`window ${part} not found`);
  };
  const pet = await findWindow("/pet/");
  const list = await findWindow("/sessions/");
  await pet.waitForLoadState("domcontentloaded");
  const snapshot = () => pet.evaluate(() => window.pagent.getSnapshot());
  await pet.waitForFunction(
    async () => (await window.pagent.getSnapshot()) !== undefined,
  );
  const endpoint = join(
    home,
    "Library/Application Support/pagent/endpoint.json",
  );
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    ready = await readFile(endpoint).then(
      () => true,
      () => false,
    );
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error("app never published its endpoint descriptor");

  for (const [index, step] of steps.entries()) {
    const events = Array.isArray(step.event) ? step.event : [step.event];
    const runs = [];
    for (const event of events) {
      const command = commands.get(event.hook_event_name);
      if (!command) throw new Error(`no hook for ${event.hook_event_name}`);
      runs.push(await runHook(command, event, step.env));
    }
    let actual;
    for (let attempt = 0; attempt < 30; attempt++) {
      actual = await snapshot();
      if (
        actual.state === step.expect &&
        actual.sessions.length === step.sessions
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const image = join(output, `${index + 1}-${actual.state}-pet.png`);
    await new Promise((r) => setTimeout(r, 400));
    await pet.screenshot({ path: image });
    await list.screenshot({
      path: join(output, `${index + 1}-${actual.state}-list.png`),
    });
    const ok =
      actual.state === step.expect &&
      actual.sessions.length === step.sessions &&
      runs.every((run) => run.code === 0 && !run.stdout && !run.stderr);
    failed ||= !ok;
    report.steps.push({
      name: step.name,
      expect: step.expect,
      actual: actual.state,
      sessions: actual.sessions.map(({ id, state }) => ({ id, state })),
      helperExit: runs.map((run) => run.code),
      helperOutput: runs.some((run) => run.stdout || run.stderr),
      ok,
      image,
    });
    console.log(
      `${ok ? "✓" : "✗"} ${step.name}: expected ${step.expect}, got ${actual.state}`,
    );
  }
  if (process.argv.includes("--screen"))
    await execute("screencapture", ["-x", join(output, "screen.png")]);
} catch (error) {
  failed = true;
  report.error = String(error?.stack ?? error);
  console.error(error);
} finally {
  await application?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
  console.log(`report: ${join(output, "report.json")}`);
}
process.exit(failed ? 1 : 0);
