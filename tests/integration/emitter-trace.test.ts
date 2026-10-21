import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { startCollector } from "../../src/integration/claude/collector.ts";
import type { ClaudeEvent } from "../../src/integration/claude/protocol.ts";

const stage = {
  mainEntry: 1,
  descriptorBegin: 2,
  descriptorEnd: 3,
  stdinBegin: 4,
  stdinEnd: 5,
  projectionBegin: 6,
  projectionEnd: 7,
  connectBegin: 8,
  connectEnd: 9,
  sendBegin: 10,
  sendEnd: 11,
  normalReturn: 12,
  watchdogExit: 13,
  rejected: 14,
} as const;
const raw = {
  hook_event_name: "PreToolUse",
  session_id: "trace-session",
  cwd: "/private/trace-project",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_trace",
  prompt: "trace-sensitive-prompt",
  tool_input: { source: "trace-sensitive-source" },
  transcript_path: "/private/trace-transcript",
};
const body = JSON.stringify(raw);
const input4096 = Buffer.concat([
  Buffer.from(body),
  Buffer.alloc(4096 - Buffer.byteLength(body), 32),
]);
const deliveryStages = [1, 4, 5, 2, 3, 6, 7, 8, 9, 10, 11, 12];
const builder = "scripts/build-diagnostic-helper.mjs";
let directory: string;
let binary: string;
let releaseBinary: string;
let releaseDigest: string;

interface GuardCase {
  descriptor: string;
  input: string | Buffer;
  args?: string[];
  failed: number;
  prefix: number[];
}

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pagent-emitter-trace-"));
  releaseBinary = join(
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
  releaseDigest = digest(await readFile(releaseBinary));
  execFileSync(process.execPath, [builder, join(directory, "diagnostic")], {
    stdio: "inherit",
    timeout: 120000,
  });
  const manifest = JSON.parse(
    await readFile(join(directory, "diagnostic/manifest.json"), "utf8"),
  ) as { binaryPath: string; sha256: string };
  binary = manifest.binaryPath;
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function run(
  descriptor: string,
  input: string | Buffer | null = input4096,
  options: {
    executable?: string;
    args?: string[];
    fd3?: "absent" | "broken" | number;
  } = {},
) {
  const started = performance.now();
  const child = spawn(
    options.executable ?? binary,
    options.args ?? [
      "--installation-id",
      randomUUID(),
      "--descriptor",
      descriptor,
    ],
    {
      stdio:
        options.fd3 === "absent"
          ? ["pipe", "pipe", "pipe"]
          : [
              "pipe",
              "pipe",
              "pipe",
              typeof options.fd3 === "number" ? options.fd3 : "pipe",
            ],
    },
  );
  const { stdin, stdout, stderr } = child;
  assert.ok(stdin && stdout && stderr);
  const diagnostic = child.stdio[3] as Readable | null | undefined;
  let outputBytes = 0;
  let errorBytes = 0;
  let traceBytes = 0;
  let trace = Buffer.alloc(0);
  stdout.on("data", (bytes: Buffer) => (outputBytes += bytes.length));
  stderr.on("data", (bytes: Buffer) => (errorBytes += bytes.length));
  stdin.on("error", () => {});
  if (options.fd3 === "broken") diagnostic?.destroy();
  else
    diagnostic?.on("data", (bytes: Buffer) => {
      traceBytes += bytes.length;
      // Retain at most the contract bound plus one byte, but count all output.
      trace = Buffer.concat([trace, bytes]).subarray(0, 1025);
    });
  // As in emitter.test.ts, this is only a hung-process safety net. Actual helper
  // invocations retain the separate 500ms startup-inclusive assertion below.
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  if (input !== null) stdin.end(input);
  try {
    const [code, signal] = await new Promise<
      [number | null, NodeJS.Signals | null]
    >((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    return {
      code,
      signal,
      pid: child.pid,
      outputBytes,
      errorBytes,
      traceBytes,
      trace,
      elapsed: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
    stdin.destroy();
  }
}

function quiet(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.outputBytes, 0);
  assert.equal(result.errorBytes, 0);
}

function safe(result: Awaited<ReturnType<typeof run>>) {
  quiet(result);
  assert.ok(
    result.elapsed <= 500,
    `Helper exceeded wall budget: ${result.elapsed}ms`,
  );
}

function decode(result: Awaited<ReturnType<typeof run>>) {
  assert.ok(result.traceBytes > 0);
  assert.ok(result.traceBytes <= 32 * 32);
  assert.equal(result.traceBytes % 32, 0);
  assert.equal(result.trace.length, result.traceBytes);
  const records = [];
  let previousUptime = 0n;
  let previousCpu = 0n;
  for (let offset = 0; offset < result.trace.length; offset += 32) {
    assert.equal(result.trace.readUInt32LE(offset), 0x50414754);
    const record = {
      stage: result.trace.readUInt32LE(offset + 4),
      pid: result.trace.readUInt32LE(offset + 8),
      detail: result.trace.readInt32LE(offset + 12),
      monotonicUptimeNs: result.trace.readBigUInt64LE(offset + 16),
      currentThreadCpuNs: result.trace.readBigUInt64LE(offset + 24),
    };
    assert.equal(record.pid, result.pid);
    assert.ok(record.stage >= 1 && record.stage <= 14);
    if (record.stage === stage.rejected)
      assert.ok([1, 2, 4, 6, 8, 10].includes(record.detail));
    else assert.equal(record.detail, 0);
    assert.ok(record.monotonicUptimeNs > 0n);
    assert.ok(record.currentThreadCpuNs > 0n);
    // The watchdog has a different CPU clock and can race a main-thread write.
    if (record.stage !== stage.watchdogExit) {
      assert.ok(record.monotonicUptimeNs >= previousUptime);
      assert.ok(record.currentThreadCpuNs >= previousCpu);
      previousUptime = record.monotonicUptimeNs;
      previousCpu = record.currentThreadCpuNs;
    }
    records.push(record);
  }
  return records;
}

test("diagnostic build has a private digest manifest and cannot overwrite outputs", async () => {
  const manifestPath = join(directory, "diagnostic/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["binaryPath", "sha256"]);
  assert.equal(
    manifest.binaryPath,
    join(await realpath(join(directory, "diagnostic")), "pagent-hook-emitter"),
  );
  assert.equal(manifest.sha256, digest(await readFile(binary)));
  assert.equal((await stat(manifestPath)).mode & 0o7777, 0o600);
  assert.equal(digest(await readFile(releaseBinary)), releaseDigest);
  for (const output of [join(directory, "diagnostic"), dirname(releaseBinary)])
    assert.throws(
      () =>
        execFileSync(process.execPath, [builder, output], {
          stdio: "pipe",
          timeout: 5000,
        }),
      /Refusing to overwrite existing diagnostic output/,
    );
  assert.equal(manifest.sha256, digest(await readFile(binary)));
  assert.equal(digest(await readFile(releaseBinary)), releaseDigest);
});

test("actual 4096-byte delivery emits only the fixed metadata records", async () => {
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory: join(directory, "delivery"),
    onEvent: (event) => events.push(event),
    onLoss: () => assert.fail("Valid traced delivery lost"),
  });
  try {
    assert.equal(input4096.length, 4096);
    const result = await run(collector.descriptorPath);
    safe(result);
    assert.deepEqual(
      decode(result).map((record) => record.stage),
      deliveryStages,
    );
    for (let i = 0; i < 100 && events.length === 0; i++) await delay(5);
    assert.deepEqual(events, [
      {
        eventName: "PreToolUse",
        sessionId: "trace-session",
        project: "trace-project",
        toolName: "AskUserQuestion",
        toolUseId: "toolu_trace",
      },
    ]);
    const endpoint = JSON.parse(
      await readFile(collector.descriptorPath, "utf8"),
    ) as {
      token: string;
      socketPath: string;
    };
    for (const forbidden of [
      raw.session_id,
      raw.cwd,
      raw.prompt,
      raw.tool_input.source,
      raw.transcript_path,
      collector.descriptorPath,
      endpoint.token,
      endpoint.socketPath,
    ])
      assert.equal(result.trace.includes(Buffer.from(forbidden)), false);
  } finally {
    await collector.close();
  }
});

test("guard exits identify their failed stage without changing silent success", async () => {
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory: join(directory, "guards"),
    onEvent: (event) => events.push(event),
    onLoss: () => {},
  });
  try {
    const endpoint = JSON.parse(
      await readFile(collector.descriptorPath, "utf8"),
    );
    const disconnected = join(directory, "disconnected.json");
    await writeFile(
      disconnected,
      JSON.stringify({
        ...endpoint,
        socketPath: join(directory, "absent.socket"),
      }),
      { mode: 0o600 },
    );
    const unsafe = join(directory, "unsafe.json");
    await writeFile(unsafe, JSON.stringify(endpoint), { mode: 0o600 });
    await chmod(unsafe, 0o644);
    const cases: GuardCase[] = [
      {
        descriptor: collector.descriptorPath,
        input: body,
        args: [],
        failed: 1,
        prefix: [1],
      },
      {
        descriptor: collector.descriptorPath,
        input: Buffer.alloc(1_048_577, 32),
        failed: 4,
        prefix: [1, 4, 5],
      },
      {
        descriptor: join(directory, "missing.json"),
        input: body,
        failed: 2,
        prefix: [1, 4, 5, 2, 3],
      },
      {
        descriptor: unsafe,
        input: body,
        failed: 2,
        prefix: [1, 4, 5, 2, 3],
      },
      {
        descriptor: collector.descriptorPath,
        input: "{broken",
        failed: 6,
        prefix: [1, 4, 5, 2, 3, 6, 7],
      },
      {
        descriptor: disconnected,
        input: body,
        failed: 8,
        prefix: [1, 4, 5, 2, 3, 6, 7, 8, 9],
      },
      {
        descriptor: collector.descriptorPath,
        input: JSON.stringify({
          ...raw,
          hook_event_name: "PostToolBatch",
          tool_calls: Array.from({ length: 128 }, (_, i) => ({
            tool_name: "Bash",
            tool_use_id: `toolu_${i}_${"x".repeat(110)}`,
          })),
        }),
        failed: 8,
        prefix: [1, 4, 5, 2, 3, 6, 7, 8, 9],
      },
    ];
    for (const fixture of cases) {
      const result = await run(
        fixture.descriptor,
        fixture.input,
        fixture.args === undefined ? {} : { args: fixture.args },
      );
      safe(result);
      const records = decode(result);
      assert.deepEqual(
        records.map((record) => record.stage),
        [...fixture.prefix, stage.rejected, stage.normalReturn],
      );
      assert.equal(
        records.find((record) => record.stage === stage.rejected)?.detail,
        fixture.failed,
      );
    }
    assert.deepEqual(events, []);
  } finally {
    await collector.close();
  }
});

test("stalled stdin records either the deadline rejection or independent watchdog", async () => {
  const result = await run(join(directory, "not-reached.json"), null);
  safe(result);
  const records = decode(result);
  assert.deepEqual(
    records.slice(0, 2).map((record) => record.stage),
    [1, 4],
  );
  assert.ok(result.elapsed >= 120);
  const rejected = records.find((record) => record.stage === stage.rejected);
  if (rejected) {
    assert.equal(rejected.detail, stage.stdinBegin);
    assert.ok(records.some((record) => record.stage === stage.stdinEnd));
  }
  assert.ok(
    records.some((record) => record.stage === stage.watchdogExit) ||
      (rejected &&
        records.some((record) => record.stage === stage.normalReturn)),
  );
});

async function compileFixture(name: string, source: string) {
  const fixtureDirectory = join(directory, name);
  await mkdir(fixtureDirectory);
  const fixture = join(fixtureDirectory, "main.swift");
  await writeFile(fixture, source);
  const object = join(fixtureDirectory, "HookProtocol.o");
  execFileSync(
    "swiftc",
    [
      "-O",
      "-parse-as-library",
      "-emit-object",
      "-emit-module",
      "-module-name",
      "HookProtocol",
      "native/hook-emitter/Sources/HookProtocol/EventProjection.swift",
      "-emit-module-path",
      join(fixtureDirectory, "HookProtocol.swiftmodule"),
      "-o",
      object,
    ],
    { timeout: 30000 },
  );
  const executable = join(fixtureDirectory, "fixture-helper");
  execFileSync(
    "swiftc",
    [
      "-O",
      "-D",
      "PAGENT_NATIVE_TRACE",
      "-I",
      fixtureDirectory,
      object,
      "native/hook-emitter/Sources/HookEmitter/DiagnosticTrace.swift",
      fixture,
      "-o",
      executable,
    ],
    { timeout: 30000 },
  );
  return executable;
}

test("blocked-main fixture records watchdog termination on the independent thread", async () => {
  const source = await readFile(
    "native/hook-emitter/Sources/HookEmitter/main.swift",
    "utf8",
  );
  const call = "    run(deadline: deadline)";
  assert.equal(source.split(call).length, 2);
  const executable = await compileFixture(
    "blocked",
    source.replace(
      call,
      "    if deadline.isActive { while true { _ = Darwin.pause() } }",
    ),
  );
  const result = await run("", "", { executable, args: [] });
  quiet(result);
  const records = decode(result);
  assert.deepEqual(
    records.map((record) => record.stage),
    [1, 13],
  );
  // This altered fixture proves the unchanged independent watchdog, not startup
  // performance. Actual diagnostic and release binaries still use safe().
  const activeElapsed =
    Number(records[1]!.monotonicUptimeNs - records[0]!.monotonicUptimeNs) /
    1_000_000;
  assert.ok(
    activeElapsed >= 120 && activeElapsed <= 250,
    `Watchdog took ${activeElapsed}ms after mainEntry`,
  );
});

test("write-shutdown fixture records the real send failure as rejected stage 10", async () => {
  const source = await readFile(
    "native/hook-emitter/Sources/HookEmitter/main.swift",
    "utf8",
  );
  const call = "    let sent = sendAll(frame, fd: fd, deadline: deadline)";
  assert.equal(source.split(call).length, 2);
  const executable = await compileFixture(
    "send-failure",
    source.replace(call, `    _ = Darwin.shutdown(fd, SHUT_WR)\n${call}`),
  );
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory: join(directory, "send-failure-endpoint"),
    onEvent: (event) => events.push(event),
    onLoss: () => {},
  });
  try {
    const result = await run(collector.descriptorPath, input4096, {
      executable,
    });
    quiet(result);
    const records = decode(result);
    assert.deepEqual(
      records.map((record) => record.stage),
      [...deliveryStages.slice(0, -1), stage.rejected, stage.normalReturn],
    );
    assert.equal(
      records.find((record) => record.stage === stage.rejected)?.detail,
      stage.sendBegin,
    );
    assert.deepEqual(events, []);
  } finally {
    await collector.close();
  }
});

test("absent and broken diagnostic pipes do not affect configured delivery", async () => {
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory: join(directory, "unavailable"),
    onEvent: (event) => events.push(event),
    onLoss: () => assert.fail("Unavailable diagnostic FD affected delivery"),
  });
  try {
    for (const fd3 of ["absent", "broken"] as const) {
      const result = await run(collector.descriptorPath, input4096, { fd3 });
      safe(result);
      assert.equal(result.traceBytes, 0);
    }
    for (let i = 0; i < 100 && events.length < 2; i++) await delay(5);
    assert.equal(events.length, 2);
  } finally {
    await collector.close();
  }
});

function wouldBlock(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
  );
}

test("a saturated inherited diagnostic FIFO cannot block or add partial records", async () => {
  const path = join(directory, "full.fifo");
  execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
  const pipe = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    const baseline = await run("", "", { fd3: pipe.fd, args: [] });
    safe(baseline);
    const baselineBytes = Buffer.alloc(1024);
    const { bytesRead } = await pipe.read(
      baselineBytes,
      0,
      baselineBytes.length,
      null,
    );
    assert.deepEqual(
      decode({
        ...baseline,
        trace: baselineBytes.subarray(0, bytesRead),
        traceBytes: bytesRead,
      }).map((record) => record.stage),
      [stage.mainEntry, stage.rejected, stage.normalReturn],
    );
    let filled = 0;
    for (const size of [4096, 32]) {
      let full = false;
      const bytes = Buffer.alloc(size);
      for (let attempt = 0; attempt < 256; attempt++) {
        try {
          const { bytesWritten } = await pipe.write(bytes);
          assert.ok(bytesWritten > 0);
          filled += bytesWritten;
        } catch (error) {
          if (!wouldBlock(error)) throw error;
          full = true;
          break;
        }
      }
      assert.ok(
        full,
        "Fixture did not saturate the FIFO within its fixed bound",
      );
    }
    const result = await run(join(directory, "missing.json"), input4096, {
      fd3: pipe.fd,
    });
    safe(result);
    const bytes = Buffer.alloc(4096);
    while (filled > 0) {
      const { bytesRead } = await pipe.read(
        bytes,
        0,
        Math.min(filled, bytes.length),
        null,
      );
      assert.ok(bytesRead > 0);
      assert.ok(bytes.subarray(0, bytesRead).every((byte) => byte === 0));
      filled -= bytesRead;
    }
    await assert.rejects(pipe.read(bytes, 0, bytes.length, null), wouldBlock);
  } finally {
    await pipe.close();
  }
});

test("release helper leaves inherited FD3 silent on delivery, guard and deadline exits", async () => {
  const events: ClaudeEvent[] = [];
  const collector = await startCollector({
    directory: join(directory, "release"),
    onEvent: (event) => events.push(event),
    onLoss: () => assert.fail("Release delivery lost"),
  });
  try {
    const options = { executable: releaseBinary };
    for (const result of [
      await run(collector.descriptorPath, input4096, options),
      await run(collector.descriptorPath, input4096, { ...options, args: [] }),
      await run(collector.descriptorPath, null, options),
    ]) {
      safe(result);
      assert.equal(result.traceBytes, 0);
    }
    for (let i = 0; i < 100 && events.length === 0; i++) await delay(5);
    assert.equal(events.length, 1);
    assert.equal(digest(await readFile(releaseBinary)), releaseDigest);
  } finally {
    await collector.close();
  }
});
