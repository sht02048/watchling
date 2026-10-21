import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startCollector } from "../src/integration/claude/collector.ts";
import { quoteHookArgument } from "../src/integration/claude/hook-install.ts";

const [authorization, tool, ...extra] = process.argv.slice(2);
if (
  ![
    "--authorized-live-negative-control",
    "--authorized-live-interactive-probe",
  ].includes(authorization) ||
  !["Bash", "AskUserQuestion"].includes(tool) ||
  extra.length
) {
  throw new Error(
    "Requires explicit prior user authorization and arguments: --authorized-live-negative-control Bash|AskUserQuestion. This modifies actual Claude settings temporarily and makes a bounded provider request.",
  );
}
const execute = promisify(execFile);
const interactive = authorization === "--authorized-live-interactive-probe";
const binary = resolve(
  "build/pagent-darwin-arm64/pagent.app/Contents/MacOS/pagent",
);
const claude = await realpath(join(homedir(), ".local/bin/claude"));
const sessionId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), "pagent-live-probe-"));
const records = [],
  aliases = new Map();
let collector,
  attemptedInstall = false,
  digestBefore,
  failed = false;
const started = performance.now();
const evidence = {
  scenario: interactive
    ? "Interactive Terminal probe requiring operator input; not a complete desktop attention round trip"
    : "Noninteractive permission-host-none negative control, never proof of a human wait",
  requestedTool: tool,
  maximumBudgetUsd: interactive ? undefined : 0.25,
  maximumInteractiveWaitMs: interactive ? 120000 : undefined,
  records,
  settingsRestored: false,
  hooksRemoved: false,
  providerExit: "not-started",
  losses: [],
};
const digest = async () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        JSON.parse(
          await readFile(join(homedir(), ".claude/settings.json"), "utf8"),
        ),
      ),
    )
    .digest("hex");
async function cli(...args) {
  const { stdout } = await execute(binary, ["hooks", ...args], {
    timeout: 15000,
    maxBuffer: 65536,
  });
  return JSON.parse(stdout);
}
function anonymize(value, key = "") {
  if (key === "project") return "fixture-project";
  if (typeof value === "string" && (key === "id" || key.endsWith("Id"))) {
    if (!aliases.has(value)) {
      if (aliases.size >= 4096) throw new Error("Probe alias limit exceeded");
      aliases.set(value, `id-${aliases.size + 1}`);
    }
    return aliases.get(value);
  }
  if (Array.isArray(value)) return value.map((item) => anonymize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        anonymize(item, name),
      ]),
    );
  return value;
}
async function interactiveProbe(args) {
  const pidPath = join(directory, "probe.pid");
  const childPath = join(directory, "probe-child.pid");
  const commandPath = join(directory, "probe.command");
  await writeFile(
    commandPath,
    `#!/bin/sh\nset -eu\ncd ${quoteHookArgument(directory)}\nchild=''\nstop() {\n trap '' TERM INT HUP\n if [ -n "$child" ]; then kill -TERM "$child" || true; wait "$child" || true; fi\n exit 0\n}\ntrap stop TERM INT HUP\n${[claude, ...args].map(quoteHookArgument).join(" ")} <&0 &\nchild=$!\nprintf '%s' "$child" > ${quoteHookArgument(childPath)}\nprintf '%s' "$$" > ${quoteHookArgument(pidPath)}\nwait "$child"\n`,
    { mode: 0o700 },
  );
  async function ownedPid() {
    try {
      const value = (await readFile(pidPath, "utf8")).trim();
      if (!/^[0-9]{1,9}$/.test(value) || Number(value) < 2) return null;
      const { stdout } = await execute(
        "/bin/ps",
        ["-ww", "-p", value, "-o", "command="],
        { timeout: 3000, maxBuffer: 16384 },
      );
      return stdout.includes(commandPath) ? Number(value) : null;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === 1 || error.code === "ESRCH")
        return null;
      throw error;
    }
  }
  try {
    evidence.interactiveLaunchRequested = true;
    await execute("/usr/bin/open", ["-a", "Terminal", commandPath], {
      timeout: 10000,
      maxBuffer: 4096,
    });
    evidence.providerExit = "interactive-timeout";
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      if (
        tool === "Bash" &&
        evidence.approvalMarkerObservedAtMs === undefined
      ) {
        try {
          if (
            (await readFile(join(directory, "approved"), "utf8")) === "approved"
          )
            evidence.approvalMarkerObservedAtMs = performance.now() - started;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const returned = records.some(
        (event) => event.eventName === "PostToolUse" && event.toolName === tool,
      );
      const stopped = records.some((event) => event.eventName === "Stop");
      if (
        returned &&
        stopped &&
        (tool !== "Bash" || evidence.approvalMarkerObservedAtMs !== undefined)
      ) {
        evidence.providerExit = "interactive-tool-return-and-stop-observed";
        break;
      }
      await delay(50);
    }
    if (evidence.providerExit === "interactive-timeout") failed = true;
  } finally {
    const pid = await ownedPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      for (let i = 0; i < 20 && (await ownedPid()); i++) await delay(50);
      const remaining = await ownedPid();
      if (remaining) {
        const child = (await readFile(childPath, "utf8")).trim();
        if (!/^[0-9]{1,9}$/.test(child) || Number(child) < 2)
          throw new Error("Invalid owned child PID");
        try {
          const { stdout } = await execute(
            "/bin/ps",
            ["-p", child, "-o", "ppid="],
            { timeout: 3000, maxBuffer: 1024 },
          );
          if (stdout.trim() === String(remaining))
            process.kill(Number(child), "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH" && error.code !== 1) throw error;
        }
        for (let i = 0; i < 20 && (await ownedPid()); i++) await delay(50);
      }
    }
    evidence.interactiveProcessStopped = (await ownedPid()) === null;
    if (!evidence.interactiveProcessStopped)
      throw new Error("Owned interactive process did not stop");
    // The only permitted command has a two-second sleep; allow its bounded exit.
    await delay(2500);
  }
}
try {
  if ((await cli("check")).pagent.status !== "not-installed")
    throw new Error("An installation already exists");
  digestBefore = await digest();
  evidence.claudeVersion = (
    await execute(claude, ["--version"], { timeout: 10000, maxBuffer: 4096 })
  ).stdout.trim();
  collector = await startCollector({
    directory: join(homedir(), "Library/Application Support/pagent"),
    onEvent(event, identity) {
      if (event.sessionId !== sessionId) return;
      if (records.length >= 128) {
        evidence.recordLimitExceeded = true;
        failed = true;
        return;
      }
      records.push({
        atMs: performance.now() - started,
        ...anonymize(event),
        receivedSeq: identity.receivedSeq,
      });
    },
    onLoss(reason) {
      failed = true;
      if (evidence.losses.length < 16) evidence.losses.push(reason);
    },
  });
  attemptedInstall = true;
  await cli("install", "--apply");
  const prompt =
    tool === "Bash"
      ? `Request Bash exactly once with command: ${interactive ? `printf approved > ${quoteHookArgument(join(directory, "approved"))}; sleep 2; printf pagent-live-probe` : "printf pagent-live-probe"}. After the result or denial, stop.`
      : "Invoke AskUserQuestion exactly once: one question 'Choose a probe option', header 'Probe', options Alpha (first probe option) and Beta (second probe option), multiSelect false. Do not ask in plain prose. After the result or denial, stop.";
  try {
    const args = [
      ...(interactive ? [] : ["--print", "--no-session-persistence"]),
      "--no-chrome",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "user",
      "--session-id",
      sessionId,
      "--permission-mode",
      "manual",
      ...(interactive ? [] : ["--permission-prompts", "none"]),
      "--settings",
      JSON.stringify({ permissions: { ask: [tool] } }),
      "--tools",
      tool,
      "--model",
      "haiku",
      ...(interactive
        ? []
        : ["--max-budget-usd", "0.25", "--output-format", "json"]),
      "--system-prompt",
      "This is a bounded integration probe. Never inspect files. Only request the exact tool call specified by the user, once. If denied, do not retry or substitute another action. Then stop.",
      prompt,
    ];
    if (interactive) {
      await interactiveProbe(args);
    } else {
      const { stdout } = await execute(claude, args, {
        cwd: directory,
        timeout: 90000,
        maxBuffer: 65536,
      });
      const result = JSON.parse(stdout);
      evidence.providerExit = "success";
      evidence.resultSubtype = result.subtype;
      evidence.providerReportedError = result.is_error === true;
      evidence.costUsd = result.total_cost_usd;
      if (result.is_error) failed = true;
    }
  } catch (error) {
    evidence.providerExit = error.killed ? "timeout" : "failed";
    evidence.exitCode = typeof error.code === "number" ? error.code : undefined;
    failed = true;
  }
  await delay(250);
  evidence.requestedToolObserved = records.some(
    (event) => event.eventName === "PreToolUse" && event.toolName === tool,
  );
  if (!evidence.requestedToolObserved) failed = true;
} catch {
  failed = true;
  evidence.setupFailed = true;
} finally {
  if (attemptedInstall) {
    try {
      await cli("uninstall", "--apply");
      evidence.hooksRemoved =
        (await cli("check")).pagent.status === "not-installed";
    } catch {
      failed = true;
      evidence.cleanupFailed = true;
    }
  }
  try {
    await collector?.close();
  } catch {
    failed = true;
    evidence.collectorCleanupFailed = true;
  }
  if (digestBefore) {
    try {
      evidence.settingsRestored = digestBefore === (await digest());
    } catch {
      failed = true;
      evidence.settingsVerificationFailed = true;
    }
  }
  if (
    evidence.interactiveLaunchRequested &&
    evidence.interactiveProcessStopped !== true
  ) {
    evidence.retainedWorkspace = directory;
    failed = true;
  } else {
    await rm(directory, { recursive: true, force: true });
  }
}
await mkdir("build/verification", { recursive: true });
const path = `build/verification/live-${interactive ? "interactive" : "negative-control"}-${tool}-${Date.now()}.json`;
await writeFile(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...evidence, path }));
if (failed || !evidence.settingsRestored || !evidence.hooksRemoved)
  process.exitCode = 1;
