import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCollector } from "../../src/integration/claude/collector.ts";
import { Observations } from "../../src/domain/observations.ts";
import {
  isEpoch,
  type ClaudeEvent,
} from "../../src/integration/claude/protocol.ts";

const binary = join(
  execFileSync(
    "swift",
    [
      "build",
      "--package-path",
      "native/hook-emitter",
      "-c",
      "release",
      "--show-bin-path",
    ],
    { encoding: "utf8" },
  ).trim(),
  "pagent-hook-emitter",
);
const raw = {
  hook_event_name: "PreToolUse",
  session_id: "session-1",
  cwd: "/private/프로젝트",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_1",
  prompt_id: "prompt-1",
  tool_input: {
    questions: ["private question"],
    code: "pagent-input-secret-4f9c2a",
    limit: 3,
  },
  transcript_path: "/private/transcript",
  prompt: "private prompt",
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(token: string, toolName: string, input: unknown): string {
  const key = createHmac("sha256", Buffer.from(token, "hex"))
    .update("pagent-fingerprint-v1")
    .digest();
  return createHmac("sha256", key)
    .update(`${toolName}\0${canonical(input)}`)
    .digest("hex")
    .slice(0, 32);
}

async function run(
  descriptor: string,
  input: string | Buffer | null,
  args?: string[],
  executable = binary,
  env: NodeJS.ProcessEnv = process.env,
) {
  const start = performance.now();
  const child = spawn(
    executable,
    args ?? ["--installation-id", randomUUID(), "--descriptor", descriptor],
    { stdio: ["pipe", "pipe", "pipe"], env },
  );
  let stdout = "",
    stderr = "",
    inputError: string | undefined;
  let firstOutputAt: number | undefined;
  child.stdout.on("data", (bytes: Buffer) => {
    firstOutputAt ??= performance.now();
    stdout = (stdout + bytes.toString()).slice(0, 8192);
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(0, 8192);
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    inputError = error.code;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  if (input !== null) child.stdin.end(input);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      code,
      stdout,
      stderr,
      elapsed: performance.now() - start,
      inputError,
      activeElapsed:
        firstOutputAt === undefined
          ? undefined
          : performance.now() - firstOutputAt,
    };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
}
function safe(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(
    result.elapsed <= 500,
    `Helper exceeded wall budget: ${result.elapsed}ms`,
  );
}

test("independent watchdog exits successfully while the main thread is blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-watchdog-"));
  try {
    const source = await readFile(
      "native/hook-emitter/Sources/HookEmitter/main.swift",
      "utf8",
    );
    const call = "    run(deadline: deadline)";
    assert.equal(source.split(call).length, 2);
    // Replace only the work entry with a blocking syscall; retain the real watchdog unchanged.
    const fixture = join(directory, "main.swift");
    const marker =
      "let fixtureMarker: [UInt8] = [97, 114, 109, 101, 100]\nfixtureMarker.withUnsafeBytes { _ = Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }\n";
    await writeFile(
      fixture,
      source
        .replace(
          call,
          "    if deadline.isActive { while true { _ = Darwin.pause() } }",
        )
        .replace("let watchdogDeadline =", marker + "let watchdogDeadline ="),
    );
    const executable = join(directory, "blocked-helper");
    const object = join(directory, "HookProtocol.o");
    execFileSync(
      "swiftc",
      [
        "-O",
        "-parse-as-library",
        "-wmo",
        "-emit-object",
        "-emit-module",
        "-module-name",
        "HookProtocol",
        "native/hook-emitter/Sources/HookProtocol/EventProjection.swift",
        "native/hook-emitter/Sources/HookProtocol/InputFingerprint.swift",
        "native/hook-emitter/Sources/HookProtocol/ProcessAncestry.swift",
        "-emit-module-path",
        join(directory, "HookProtocol.swiftmodule"),
        "-o",
        object,
      ],
      { timeout: 30000 },
    );
    execFileSync(
      "swiftc",
      ["-O", "-I", directory, object, fixture, "-o", executable],
      { timeout: 30000 },
    );
    const result = await run("", "", [], executable);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "armed");
    assert.equal(result.stderr, "");
    // This newly compiled, instrumented fixture tests the watchdog, not product startup.
    // Actual product invocations below retain the separate startup-inclusive 500ms assertion.
    assert.ok(
      result.activeElapsed !== undefined &&
        result.activeElapsed >= 120 &&
        result.activeElapsed <= 250,
      `Blocked-main watchdog took ${result.activeElapsed}ms after arming (total ${result.elapsed}ms)`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual Swift helper delivers only metadata to the private collector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-emitter-test-"));
  const events: ClaudeEvent[] = [];
  const identities: { eventId: string; receivedSeq: number }[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (event, identity) => {
      events.push(event);
      identities.push(identity);
    },
    onLoss: () => assert.fail("Valid emitter delivery lost"),
  });
  try {
    const result = await run(collector.descriptorPath, JSON.stringify(raw));
    safe(result);
    assert.equal(result.inputError, undefined);
    for (let i = 0; i < 400 && events.length === 0; i++) await delay(5);
    const { token } = JSON.parse(
      await readFile(collector.descriptorPath, "utf8"),
    ) as { token: string };
    assert.deepEqual(events, [
      {
        eventName: "PreToolUse",
        sessionId: "session-1",
        project: "프로젝트",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_1",
        promptId: "prompt-1",
        inputFingerprint: fingerprint(token, raw.tool_name, raw.tool_input),
      },
    ]);
    assert.equal(JSON.stringify(events).includes("private"), false);
    assert.equal(JSON.stringify(events).includes(raw.tool_input.code), false);
    safe(await run(collector.descriptorPath, JSON.stringify(raw)));
    for (let i = 0; i < 400 && events.length < 2; i++) await delay(5);
    assert.equal(
      events.length,
      2,
      "Distinct native emissions must not be merged by payload",
    );
    assert.deepEqual(events[0], events[1]);
    assert.ok(identities.every((identity) => isEpoch(identity.eventId)));
    assert.equal(
      new Set(identities.map((identity) => identity.eventId)).size,
      2,
    );
    assert.ok(identities[1]!.receivedSeq > identities[0]!.receivedSeq);
    const stalled = await run(collector.descriptorPath, null);
    safe(stalled);
    assert.ok(
      stalled.elapsed >= 120,
      "Live-endpoint probe must actually exercise the stdin deadline",
    );
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("permission requests report whether the spawning Claude process is interactive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-emitter-test-"));
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (event) => events.push(event),
    onLoss: () => assert.fail("Valid emitter delivery lost"),
  });
  const wrapper = join(directory, "claude-wrapper.mjs");
  await writeFile(
    wrapper,
    `import { spawnSync } from "node:child_process";
const [helper, descriptor, attended] = process.argv.slice(2);
const env = { ...process.env, CLAUDE_PID: String(process.pid) };
delete env.CLAUDE_CODE_SESSION_ATTENDED;
if (attended !== "unset") env.CLAUDE_CODE_SESSION_ATTENDED = attended;
const input = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
});
const result = spawnSync(
  "/bin/sh",
  ["-c", '"$0" --installation-id "$1" --descriptor "$2"', helper, "${randomUUID()}", descriptor],
  { input, env },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
  );
  const secret = "pagent-permission-secret-81d7";
  const permission = {
    hook_event_name: "PermissionRequest",
    session_id: "session-ask",
    cwd: "/private/ask-project",
    tool_name: "Bash",
    tool_input: { command: secret, timeout: 5 },
  };
  try {
    const { token } = JSON.parse(
      await readFile(collector.descriptorPath, "utf8"),
    ) as { token: string };
    const cases: [string, string[], boolean][] = [
      ["unset", [], true],
      ["unset", ["-p"], false],
      ["unset", ["--print=json"], false],
      ["1", ["-p"], true],
      ["0", [], false],
    ];
    for (const [attended, flags, interactive] of cases) {
      events.length = 0;
      const result = await run(
        collector.descriptorPath,
        JSON.stringify(permission),
        [wrapper, binary, collector.descriptorPath, attended, ...flags],
        process.execPath,
      );
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      for (let i = 0; i < 400 && events.length === 0; i++) await delay(5);
      assert.deepEqual(
        events,
        [
          {
            eventName: "PermissionRequest",
            sessionId: "session-ask",
            project: "ask-project",
            toolName: "Bash",
            inputFingerprint: fingerprint(
              token,
              permission.tool_name,
              permission.tool_input,
            ),
            interactive,
          },
        ],
        `${attended} ${flags.join(" ")}`,
      );
      assert.equal(JSON.stringify(events).includes(secret), false);
    }
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("app-off, invalid arguments and stalled stdin are silent bounded successes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-emitter-test-"));
  try {
    const missing = join(directory, "absent.json");
    const off = await run(missing, JSON.stringify(raw));
    safe(off);
    assert.equal(off.inputError, undefined);
    safe(await run(missing, "{}", []));
    safe(await run(missing, null));
    safe(await run(missing, "not-json"));
    safe(await run(missing, Buffer.alloc(1_048_577, 32)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsafe descriptors/socket links and oversized projections never deliver", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-emitter-test-"));
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (event) => events.push(event),
    onLoss: () => {},
  });
  try {
    const body = JSON.stringify(raw);
    const alias = join(directory, "descriptor-link");
    await symlink(collector.descriptorPath, alias);
    safe(await run(alias, body));
    const malformed = join(directory, "malformed.json");
    await writeFile(malformed, "x".repeat(4097), { mode: 0o600 });
    safe(await run(malformed, body));
    await writeFile(malformed, await readFile(collector.descriptorPath));
    await chmod(malformed, 0o644);
    safe(await run(malformed, body));
    const endpoint = JSON.parse(
      await readFile(collector.descriptorPath, "utf8"),
    ) as { socketPath: string };
    const socketAlias = join(directory, "socket-link");
    await symlink(endpoint.socketPath, socketAlias);
    await chmod(malformed, 0o600);
    await writeFile(
      malformed,
      JSON.stringify({ ...endpoint, socketPath: socketAlias }),
    );
    safe(await run(malformed, body));
    safe(
      await run(
        collector.descriptorPath,
        JSON.stringify({
          ...raw,
          hook_event_name: "PostToolBatch",
          tool_calls: Array.from({ length: 128 }, (_, i) => ({
            tool_name: "Bash",
            tool_use_id: `toolu_${i}_${"x".repeat(110)}`,
          })),
        }),
      ),
    );
    safe(await run(collector.descriptorPath, "{broken"));
    assert.deepEqual(events, []);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("helper events drive session states through the collector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-pipeline-test-"));
  const observations = new Observations();
  let received = 0;
  const collector = await startCollector({
    directory,
    onEvent: (event) => {
      observations.receive(event);
      received++;
    },
    onLoss: () => assert.fail("Valid emitter delivery lost"),
  });
  const base = { session_id: "pipeline-a", cwd: "/private/파이프라인" };
  const input = { command: "printf pagent-pipeline-secret-7d1e" };
  const steps: [Record<string, unknown>, string | undefined, string][] = [
    [{ ...base, hook_event_name: "SessionStart" }, undefined, "idle"],
    [{ ...base, hook_event_name: "UserPromptSubmit" }, undefined, "working"],
    [
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_pipeline",
        tool_input: input,
      },
      undefined,
      "working",
    ],
    [
      {
        ...base,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { ...input },
      },
      "1",
      "asking",
    ],
    [
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_pipeline",
        tool_input: input,
        tool_response: { stdout: "pagent-pipeline-secret-7d1e" },
      },
      undefined,
      "working",
    ],
    [
      {
        session_id: "pipeline-b",
        cwd: "/private/파이프라인",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: input,
      },
      "0",
      "working",
    ],
    [{ ...base, hook_event_name: "Stop" }, undefined, "working"],
    [
      { ...base, session_id: "pipeline-b", hook_event_name: "Stop" },
      undefined,
      "done",
    ],
    [{ ...base, hook_event_name: "SessionEnd" }, undefined, "done"],
    [
      { ...base, session_id: "pipeline-b", hook_event_name: "SessionEnd" },
      undefined,
      "idle",
    ],
  ];
  try {
    for (const [index, [payload, attended, expected]] of steps.entries()) {
      if (attended === undefined)
        delete process.env.CLAUDE_CODE_SESSION_ATTENDED;
      else process.env.CLAUDE_CODE_SESSION_ATTENDED = attended;
      safe(await run(collector.descriptorPath, JSON.stringify(payload)));
      for (let i = 0; i < 400 && received <= index; i++) await delay(5);
      assert.equal(received, index + 1, String(payload.hook_event_name));
      const snapshot = observations.snapshot();
      assert.equal(snapshot.state, expected, String(payload.hook_event_name));
      assert.ok(
        snapshot.sessions.every(
          (session) => session.state !== "asking" || attended === "1",
        ),
      );
      assert.equal(
        JSON.stringify(snapshot).includes("pagent-pipeline-secret"),
        false,
      );
    }
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
