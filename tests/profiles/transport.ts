import {
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import {
  arch,
  cpus,
  platform,
  release,
  tmpdir,
  totalmem,
  version,
} from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  decodeFrame,
  hookEvents,
  isEpoch,
  isToken,
  type ClaudeEvent,
  type Endpoint,
} from "../../src/integration/claude/protocol.ts";
import { quoteHookArgument } from "../../src/integration/claude/hook-install.ts";
import type { Snapshot } from "../../src/shared/ui-contract.ts";
import type { ArmReport, MainReport, ProfileFixture } from "./main.ts";
import { diagnoseOrder, normalCorpusPredecessors } from "./order.ts";
import { createProfileTrace } from "./trace.ts";
import {
  distribution,
  fixedLane,
  padded,
  prepareUdsProducer,
  sendWire,
  until as waitUntil,
  wire,
  type LaneReport,
  type UdsProducer,
  type UdsReport,
  type WireResult,
} from "./uds-producer.ts";

type Profile = "N" | "O";
type Slot = {
  index: number;
  key: string;
  role: string;
  event: ClaudeEvent;
  input: Buffer;
  sha256: string;
  replayOf: string | null;
  predecessors: string[];
};
type HelperResult = {
  spawned: boolean;
  elapsedMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  inputError: string | null;
  error: string | null;
  lifecycle?: {
    spawnPid: number | null;
    requestedNs: string;
    spawnReturnedNs: string;
    spawnEventObservedNs: string | null;
    stdinFinishedObservedNs: string | null;
    exitObservedNs: string | null;
    closeObservedNs: string | null;
  };
  diagnostic?: {
    invalidRecords: number;
    overflow: boolean;
    trailingBytes: number;
    records: {
      stage: number;
      pid: number;
      detail: number;
      uptimeNs: string;
      threadCpuNs: string;
    }[];
  };
};
type NativeLane = LaneReport<HelperResult | WireResult>;
type Capture = {
  key: string;
  bytes: number;
  sha256: string;
  atNs: string;
  eventId: string;
  forwardingStartedNs: string | null;
  forwardedNs: string | null;
  processingMs: number;
};
type RendererSample = {
  scheduledMs: number;
  startedMs: number | null;
  latencyMs: number | null;
  snapshotResolvedMs?: number;
  renderFinishedMs?: number;
  rafObservedMs?: number;
  outcome:
    "ok" | "hidden" | "missed" | "busy" | "error" | "timeout" | "stopped";
  error?: string;
};
type RendererFixture = { stop(): RendererSample[] };
type Check = {
  name: string;
  passed: boolean;
  observed: unknown;
  limit: unknown;
};

const seed = 0x50414745;
const execute = promisify(execFile);
const outputPath = resolve("test-results/transport-profile.json");
const artifactRoot = resolve("test-results/transport-profile-fixtures");
const children = new Set<ChildProcess>();
const sockets = new Set<Socket>();
const abort = new AbortController();
let activeApplication: ElectronApplication | undefined;
let diagnosticNative = false;
let driverTrace: ReturnType<typeof createProfileTrace> | undefined;
const unmetEvidence = [
  "Current upstream/reducer capabilities do not represent confirmed approval/question waits with causal clears; candidate corpus roles are not verified provider semantics.",
  "Confirmed attention in another session, affected-scope confidence transitions, and non-restoration of confirmed waits are unsupported by unknown-only Observations.",
  "Active operation/wait and terminal retention invariants remain unimplemented; bounded transport replay identity is not provider identity or proof of those invariants. Transient log bounds are not exposed by the agreed fixture controls.",
  "The native internal 150ms boundary is not directly timestamped by this external harness; controlled deadline paths and the independent 500ms wall ceiling are measured separately.",
];
const now = (): bigint => process.hrtime.bigint();
const msSince = (start: bigint): number => Number(now() - start) / 1e6;
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function kill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
async function stopChildren(): Promise<void> {
  const results = await Promise.allSettled(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => {
          kill(child);
          reject(new Error("Child did not close after SIGKILL"));
        }, 1000);
        child.once("close", () => {
          clearTimeout(timeout);
          done();
        });
        kill(child);
      });
    }),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}
async function readEndpoint(path: string): Promise<Endpoint> {
  const endpoint = JSON.parse(await readFile(path, "utf8")) as Endpoint;
  const directory = dirname(endpoint.socketPath);
  const prefix = join(tmpdir(), `pagent-${process.getuid!()}-`);
  if (
    endpoint.version !== 1 ||
    !isEpoch(endpoint.epoch) ||
    !isToken(endpoint.token) ||
    !directory.startsWith(prefix) ||
    !/^[A-Za-z0-9]+$/.test(directory.slice(prefix.length)) ||
    basename(endpoint.socketPath) !== "socket"
  )
    throw new Error(
      "Refusing a collector endpoint outside its private fixture directory",
    );
  const info = await lstat(directory);
  const socket = await lstat(endpoint.socketPath);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o7777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== process.getuid!() ||
    (socket.mode & 0o7777) !== 0o600
  )
    throw new Error("Collector endpoint metadata is not private");
  return endpoint;
}
async function packagedInstall(
  executable: string,
  env: Record<string, string>,
): Promise<string> {
  const child = spawn(executable, ["hooks", "install", "--apply"], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = Buffer.alloc(0),
    stderrBytes = 0;
  let failure: Error | undefined;
  const timeout = setTimeout(() => {
    failure = new Error("Packaged hooks CLI exceeded 10s");
    kill(child);
  }, 10_000);
  child.stdout!.on("data", (bytes: Buffer) => {
    if (stdout.length + bytes.length > 128 * 1024) {
      failure = new Error("Packaged hooks CLI output exceeded 128 KiB");
      kill(child);
    } else stdout = Buffer.concat([stdout, bytes]);
  });
  child.stderr!.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.length;
  });
  try {
    const code = await new Promise<number | null>((done) => {
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", done);
    });
    if (failure) throw failure;
    if (code !== 0 || stderrBytes !== 0)
      throw new Error(
        `Packaged hooks CLI failed: exit=${code}, stderrBytes=${stderrBytes}`,
      );
    return stdout.toString("utf8");
  } finally {
    clearTimeout(timeout);
    children.delete(child);
  }
}
function environment(home: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.HOME = home;
  env.PAGENT_PROFILE_HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  return env;
}
function until(deadline: bigint): Promise<void> {
  return waitUntil(deadline, abort.signal);
}
function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function check(
  name: string,
  passed: boolean,
  observed: unknown,
  limit: unknown,
): Check {
  return { name, passed, observed, limit };
}
function latencyCheck(
  name: string,
  values: readonly number[],
  p95: number,
  maximum: number,
): Check {
  const stats = distribution(values);
  return check(
    name,
    stats.p95Ms !== null &&
      stats.maximumMs !== null &&
      stats.p95Ms <= p95 &&
      stats.maximumMs <= maximum,
    stats,
    { p95Ms: p95, maximumMs: maximum },
  );
}
function canonical(event: ClaudeEvent): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(event).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
function corpus(profile: Profile): Slot[] {
  let state = seed;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const slots: Slot[] = [];
  const blocks = profile === "N" ? 60 : 10;
  for (let block = 0; block < blocks; block++) {
    const names = ["Bash", "Read", "Edit", "Grep", "Glob", "Bash"];
    for (let i = names.length - 1; i > 0; i--) {
      const j = random() % (i + 1);
      [names[i], names[j]] = [names[j]!, names[i]!];
    }
    const id = `${profile}-turn-${String(block).padStart(3, "0")}`;
    const root = block % 8;
    const base = {
      sessionId: `profile-root-${root}`,
      project: `profile-project-${root}`,
      promptId: id,
    };
    const events: { role: string; event: ClaudeEvent }[] = [
      { role: "turn-start", event: { ...base, eventName: "UserPromptSubmit" } },
      ...names.map((toolName, i) => ({
        role: "tool-start",
        event: {
          ...base,
          eventName: "PreToolUse" as const,
          toolName,
          toolUseId: `${id}-tool-${i}`,
        },
      })),
      {
        role: "approval-wait-candidate",
        event: { ...base, eventName: "PermissionRequest", toolName: "Bash" },
      },
      {
        role: "question-wait-candidate",
        event: {
          ...base,
          eventName: "PreToolUse",
          toolName: "AskUserQuestion",
          toolUseId: `${id}-question`,
        },
      },
      {
        role: "question-clear-candidate",
        event: {
          ...base,
          eventName: "PostToolUse",
          toolName: "AskUserQuestion",
          toolUseId: `${id}-question`,
        },
      },
      {
        role: "approval-clear-candidate",
        event: {
          ...base,
          eventName: "PostToolUse",
          toolName: "Bash",
          toolUseId: `${id}-approval`,
        },
      },
      ...names.map((toolName, i) => ({
        role: "tool-end",
        event: {
          ...base,
          eventName: "PostToolUse" as const,
          toolName,
          toolUseId: `${id}-tool-${i}`,
        },
      })),
      { role: "turn-end", event: { ...base, eventName: "Stop" } },
    ];
    // Neither PermissionRequest nor the current reducer has a confirmed causal
    // clear. These are explicitly candidate metadata, NOT invented wait support.
    for (let step = 0; step < 20; step++) {
      const original = step === 18 ? 1 : step === 19 ? 7 : step;
      const entry = events[original]!;
      const event = entry.event;
      const raw = {
        hook_event_name: event.eventName,
        session_id: event.sessionId,
        cwd: `/fixture/${event.project}`,
        prompt_id: event.promptId,
        ...(event.toolName ? { tool_name: event.toolName } : {}),
        ...(event.toolUseId ? { tool_use_id: event.toolUseId } : {}),
      };
      const input = padded(raw, 4096, false);
      const prefix = `${profile}/block-${String(block).padStart(3, "0")}/step-`;
      slots.push({
        index: slots.length,
        key: `${prefix}${String(step).padStart(2, "0")}`,
        role: step >= 18 ? "exact-envelope-replay" : entry.role,
        event,
        input,
        sha256: sha256(input),
        replayOf:
          step >= 18 ? `${prefix}${String(original).padStart(2, "0")}` : null,
        predecessors:
          profile === "N"
            ? normalCorpusPredecessors(slots.length).map(
                (index) => slots[index]!.key,
              )
            : [],
      });
    }
  }
  return slots;
}
async function fixtureFiles(normal: Slot[], overload: Slot[]) {
  const manifest: {
    path: string;
    bytes: number;
    sha256: string;
    kind: string;
  }[] = [];
  for (const slot of [...normal, ...overload]) {
    if (slot.key.startsWith("N/") && slot.replayOf) continue;
    const path = join(artifactRoot, `${slot.key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, slot.input, { mode: 0o600 });
    manifest.push({
      path: relative(process.cwd(), path),
      bytes: slot.input.length,
      sha256: slot.sha256,
      kind: "native-stdin",
    });
  }
  const template: Endpoint = {
    version: 1,
    epoch: "00000000-0000-0000-0000-000000000000",
    token: "0".repeat(64),
    socketPath: "/template/not-used",
  };
  for (let i = 0; i < 2000; i++) {
    const frame = wire(i, template);
    const path = join(
      artifactRoot,
      "O",
      "uds",
      `${String(i).padStart(4, "0")}.json`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, frame.bytes, { mode: 0o600 });
    manifest.push({
      path: relative(process.cwd(), path),
      bytes: frame.bytes.length,
      sha256: sha256(frame.bytes),
      kind: `${frame.role}-wire-template`,
    });
  }
  return manifest;
}

async function helper(
  command: string,
  env: Record<string, string>,
  input: Buffer | null,
  mode: "normal" | "delayed" = "normal",
): Promise<HelperResult> {
  const start = now(); // Startup-inclusive: before the configured shell command spawn.
  let child: ChildProcess;
  const finishSpawn = driverTrace?.begin("driver.helper.dispatch");
  try {
    child = spawn("/bin/sh", ["-c", command], {
      env,
      detached: true,
      stdio: diagnosticNative
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      spawned: false,
      elapsedMs: msSince(start),
      code: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      inputError: null,
      error: errorText(error),
    };
  } finally {
    finishSpawn?.();
  }
  const lifecycle: NonNullable<HelperResult["lifecycle"]> = {
    spawnPid: child.pid ?? null,
    requestedNs: start.toString(),
    spawnReturnedNs: now().toString(),
    spawnEventObservedNs: null,
    stdinFinishedObservedNs: null,
    exitObservedNs: null,
    closeObservedNs: null,
  };
  child.once("spawn", () => {
    lifecycle.spawnEventObservedNs = now().toString();
  });
  child.stdin!.once("finish", () => {
    lifecycle.stdinFinishedObservedNs = now().toString();
  });
  child.once("exit", () => {
    lifecycle.exitObservedNs = now().toString();
  });
  child.once("close", () => {
    lifecycle.closeObservedNs = now().toString();
  });
  const diagnostic: NonNullable<HelperResult["diagnostic"]> = {
    invalidRecords: 0,
    overflow: false,
    trailingBytes: 0,
    records: [],
  };
  let diagnosticCarry = Buffer.alloc(0);
  if (diagnosticNative) {
    child.stdio[3]!.on("data", (bytes: Buffer) => {
      if (bytes.length + diagnosticCarry.length > 1024)
        diagnostic.overflow = true;
      diagnosticCarry = Buffer.concat([
        diagnosticCarry,
        bytes.subarray(0, Math.max(0, 1024 - diagnosticCarry.length)),
      ]);
      while (diagnosticCarry.length >= 32) {
        const packet = diagnosticCarry.subarray(0, 32);
        const stage = packet.readUInt32LE(4);
        if (packet.readUInt32LE(0) !== 0x50414754 || stage < 1 || stage > 14)
          diagnostic.invalidRecords++;
        else if (diagnostic.records.length >= 32) diagnostic.overflow = true;
        else
          diagnostic.records.push({
            stage,
            pid: packet.readUInt32LE(8),
            detail: packet.readInt32LE(12),
            uptimeNs: packet.readBigUInt64LE(16).toString(),
            threadCpuNs: packet.readBigUInt64LE(24).toString(),
          });
        diagnosticCarry = diagnosticCarry.subarray(32);
      }
    });
    child.stdio[3]!.on("error", () => {
      diagnostic.invalidRecords++;
    });
  }
  children.add(child);
  let stdoutBytes = 0,
    stderrBytes = 0;
  let inputError: string | null = null;
  let failure: string | null = null;
  let timedOut = false;
  let delayed: ReturnType<typeof setTimeout> | undefined;
  child.stdout!.on("data", (bytes: Buffer) => {
    stdoutBytes += bytes.length;
  });
  child.stderr!.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.length;
  });
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    inputError = error.code ?? error.message;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    kill(child);
  }, 500);
  try {
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((done) => {
      child.once("error", (error) => {
        failure = errorText(error);
      });
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (input !== null) {
      if (mode === "delayed") {
        child.stdin!.write(input.subarray(0, 1));
        delayed = setTimeout(() => child.stdin!.end(input.subarray(1)), 200);
      } else child.stdin!.end(input);
    }
    const result = await closed;
    return {
      spawned: child.pid !== undefined,
      elapsedMs: msSince(start),
      ...result,
      stdoutBytes,
      stderrBytes,
      timedOut,
      inputError,
      error: failure,
      lifecycle,
      ...(diagnosticNative
        ? {
            diagnostic: {
              ...diagnostic,
              trailingBytes: diagnosticCarry.length,
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
    if (delayed) clearTimeout(delayed);
    child.stdin!.destroy();
    children.delete(child);
  }
}
function helperSafe(result: HelperResult): boolean {
  return (
    result.spawned &&
    result.code === 0 &&
    result.signal === null &&
    !result.timedOut &&
    result.stdoutBytes === 0 &&
    result.stderrBytes === 0 &&
    result.error === null &&
    result.elapsedMs <= 500
  );
}
async function send(bytes: Buffer, path: string): Promise<WireResult> {
  return sendWire(bytes, path, sockets, abort.signal, driverTrace?.begin);
}

async function captureProxy(endpoint: Endpoint, slots: Slot[]) {
  const directory = await mkdtemp(
    join(tmpdir(), `pagent-${process.getuid!()}-`),
  );
  const socketPath = join(directory, "socket");
  if (Buffer.byteLength(socketPath) >= 104) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Capture proxy UDS path is too long");
  }
  const live = new Set<Socket>();
  const captured: Capture[] = [];
  const originals = new Map<
    string,
    { bytes: Buffer; sha256: string; eventId: string }
  >();
  const failures = new Set<string>();
  const lookup = new Map<string, Slot>();
  for (const slot of slots)
    if (!slot.replayOf) lookup.set(canonical(slot.event), slot);
  const pending = new Set<Promise<void>>();
  let bytesHighWater = 0,
    currentBytes = 0,
    connectionsHighWater = 0;
  const server = createServer((socket) => {
    if (live.size >= 16) {
      failures.add("Capture proxy connection bound exceeded");
      socket.destroy();
      return;
    }
    live.add(socket);
    connectionsHighWater = Math.max(connectionsHighWater, live.size);
    let buffer = Buffer.alloc(0);
    let finished = false;
    const timeout = setTimeout(() => {
      failures.add("Capture proxy input timed out");
      socket.destroy();
    }, 500);
    socket.on("error", (error) => {
      failures.add(`Capture socket: ${errorText(error)}`);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      currentBytes -= buffer.length;
      live.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      const finishCapture = driverTrace?.begin("driver.capture");
      try {
        const processingStarted = now();
        if (finished) {
          failures.add("Helper wrote trailing data after its frame");
          return;
        }
        if (buffer.length + chunk.length > 1024) {
          failures.add("Normal helper wire frame exceeded 1024 bytes");
          finished = true;
          socket.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        currentBytes += chunk.length;
        bytesHighWater = Math.max(bytesHighWater, currentBytes);
        if (!buffer.includes(10)) return;
        finished = true;
        const frame = decodeFrame(buffer);
        if (
          !frame ||
          frame.epoch !== endpoint.epoch ||
          frame.token !== endpoint.token
        ) {
          failures.add(
            "Native helper emitted an invalid/authentication-mismatched frame",
          );
          socket.destroy();
          return;
        }
        const slot = lookup.get(canonical(frame.event));
        const key = slot?.key ?? "warmup-or-probe";
        if (captured.length >= 1600) {
          failures.add("Capture manifest bound exceeded");
          socket.destroy();
          return;
        }
        const record: Capture = {
          key,
          bytes: buffer.length,
          sha256: sha256(buffer),
          atNs: processingStarted.toString(),
          eventId: frame.eventId,
          forwardingStartedNs: null,
          forwardedNs: null,
          processingMs: 0,
        };
        captured.push(record);
        if (slot && (slot.index % 20 === 1 || slot.index % 20 === 7)) {
          if (!originals.has(slot.key)) {
            if (originals.size >= 120)
              failures.add("Replay source cache bound exceeded");
            else
              originals.set(slot.key, {
                bytes: Buffer.from(buffer),
                sha256: record.sha256,
                eventId: frame.eventId,
              });
          }
        }
        const bytes = buffer;
        const task = (async () => {
          record.forwardingStartedNs = now().toString();
          const result = await send(bytes, endpoint.socketPath);
          if (!result.written || result.error)
            failures.add(
              `Proxy forwarding failed: ${result.error ?? "frame not written"}`,
            );
          else record.forwardedNs = now().toString();
        })();
        record.processingMs = msSince(processingStarted);
        pending.add(task);
        void task
          .finally(() => {
            pending.delete(task);
            socket.destroy();
          })
          .catch((error: unknown) => failures.add(errorText(error)));
      } finally {
        finishCapture?.();
      }
    });
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        done();
      });
    });
    server.on("error", (error) => {
      failures.add(`Capture listener: ${errorText(error)}`);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    for (const socket of live) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    endpoint: { ...endpoint, socketPath },
    captured,
    originals,
    failures,
    beginLoad() {
      if (pending.size || live.size)
        failures.add("Warm-up forwarding did not settle before load");
      originals.clear();
    },
    metrics: () => ({
      bytesHighWater,
      connectionsHighWater,
      retainedReplayBytes: [...originals.values()].reduce(
        (total, source) => total + source.bytes.length,
        0,
      ),
      completedFrameProcessing: distribution(
        captured.map((frame) => frame.processingMs),
      ),
    }),
    async close() {
      for (const socket of live) socket.destroy();
      await Promise.allSettled([...pending]);
      await new Promise<void>((done) => server.close(() => done()));
      originals.clear();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Executed inside the real pet renderer. profile-transport.mjs exposes its
// existing render(snapshot) closure only in the separately built fixture UI.
function installRendererSampler(options: {
  startUnixMs: number;
  durationMs: number;
}): void {
  const candidate = Reflect.get(window, "__pagentProfileRender") as
    ((snapshot: Snapshot) => void) | undefined;
  if (typeof candidate !== "function")
    throw new Error(
      "Fixture build did not expose the production pet render function",
    );
  const render: (snapshot: Snapshot) => void = candidate;
  const start = performance.now() + options.startUnixMs - Date.now();
  const total = (options.durationMs + 30_000) / 100;
  const samples: RendererSample[] = [];
  let tick = 0;
  let active = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let raf: number | undefined;
  let pending: RendererSample | undefined;
  function schedule(): void {
    if (stopped || tick >= total) return;
    timer = setTimeout(
      probe,
      Math.max(0, start + tick * 100 - performance.now()),
    );
  }
  function probe(): void {
    if (stopped) return;
    const current = performance.now();
    while (tick < total && start + tick * 100 <= current) {
      if (samples.length >= 1500)
        throw new Error("Renderer measurement bound exceeded");
      const entry: RendererSample = {
        scheduledMs: tick * 100,
        startedMs: null,
        latencyMs: null,
        outcome: "missed",
      };
      tick++;
      samples.push(entry);
      if (current - (start + entry.scheduledMs) >= 100) continue;
      if (document.visibilityState !== "visible") {
        entry.outcome = "hidden";
        continue;
      }
      if (active) {
        entry.outcome = "busy";
        continue;
      }
      active = true;
      pending = entry;
      entry.startedMs = performance.now() - start;
      const dispatched = performance.now();
      watchdog = setTimeout(() => {
        entry.outcome = "timeout";
        entry.latencyMs = performance.now() - dispatched;
      }, 1000);
      void window.pagent
        .getSnapshot()
        .then((snapshot) => {
          if (stopped) return;
          entry.snapshotResolvedMs = performance.now() - start;
          render(snapshot); // The actual production rendering closure, not an echo/ping.
          entry.renderFinishedMs = performance.now() - start;
          raf = requestAnimationFrame(() => {
            if (stopped) return;
            entry.rafObservedMs = performance.now() - start;
            if (watchdog) clearTimeout(watchdog);
            const canvas = document.querySelector("canvas");
            entry.latencyMs = performance.now() - dispatched;
            entry.outcome = canvas
              ?.getAttribute("aria-label")
              ?.includes(`pagent ${snapshot.state}.`)
              ? "ok"
              : "error";
            if (entry.outcome === "error")
              entry.error =
                "Snapshot was not reflected by the production renderer";
            active = false;
            pending = undefined;
            raf = undefined;
          });
        })
        .catch((error: unknown) => {
          if (stopped) return;
          if (watchdog) clearTimeout(watchdog);
          entry.outcome = "error";
          entry.error = String(error);
          entry.latencyMs = performance.now() - dispatched;
          active = false;
          pending = undefined;
        });
    }
    schedule();
  }
  const stop = (): RendererSample[] => {
    if (!stopped) {
      // Late/missing final ticks still get records rather than disappearing.
      const elapsed = performance.now() - start;
      while (tick < total && tick * 100 <= elapsed) {
        samples.push({
          scheduledMs: tick++ * 100,
          startedMs: null,
          latencyMs: null,
          outcome: "missed",
        });
      }
      stopped = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      if (raf !== undefined) cancelAnimationFrame(raf);
      if (pending && pending.outcome !== "timeout") pending.outcome = "stopped";
    }
    return samples;
  };
  Object.defineProperty(window, "__pagentProfileRenderer", { value: { stop } });
  window.addEventListener("pagehide", stop, { once: true });
  schedule();
}

async function sequential(
  command: string,
  env: Record<string, string>,
  input: Buffer,
) {
  const start = now();
  const calls: HelperResult[] = [];
  for (let i = 0; i < 100; i++) {
    abort.signal.throwIfAborted();
    calls.push(await helper(command, env, input));
  }
  const elapsedMs = msSince(start);
  const summary = distribution(
    calls.filter((call) => call.spawned).map((call) => call.elapsedMs),
  );
  return {
    count: calls.length,
    concurrency: 1,
    elapsedMs,
    calls,
    summary,
    passed:
      calls.length === 100 &&
      summary.count === 100 &&
      calls.every(helperSafe) &&
      elapsedMs <= 5000 &&
      summary.p95Ms! <= 100,
  };
}
async function unresponsivePeer(
  command: string,
  env: Record<string, string>,
  input: Buffer,
  descriptor: string,
  original: Endpoint,
) {
  const directory = await mkdtemp(
    join(tmpdir(), `pagent-${process.getuid!()}-`),
  );
  const path = join(directory, "socket");
  const live = new Set<Socket>();
  const errors: string[] = [];
  let acceptedConnections = 0;
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    acceptedConnections++;
    live.add(socket);
    socket.on("error", (error) => {
      if (errors.length < 16) errors.push(errorText(error));
    });
    socket.once("close", () => live.delete(socket));
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        done();
      });
    });
    server.on("error", (error) => {
      if (errors.length < 16) errors.push(errorText(error));
    });
    await chmod(path, 0o600);
    await writeFile(
      descriptor,
      JSON.stringify({ ...original, socketPath: path }),
      { mode: 0o600 },
    );
    return {
      result: await helper(command, env, input),
      acceptedConnections,
      errors,
      peer: "UDS listener accepts but never drains or responds",
      limitation:
        "The one-way helper has no ACK; a small frame can fit kernel buffers without exercising a blocked send.",
    };
  } finally {
    for (const socket of live) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    const cleanup = await Promise.allSettled([
      writeFile(descriptor, JSON.stringify(original), { mode: 0o600 }),
      rm(directory, { recursive: true, force: true }),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return {
    path: relative(process.cwd(), path),
    bytes: (await stat(path)).size,
    sha256: hash.digest("hex"),
  };
}
async function foreground(env: Record<string, string>) {
  try {
    // Read NSWorkspace directly. No System Events, activation, accessibility
    // prompts, or synthetic OS input is used to make a locked desktop pass.
    const result = await execute(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `
      ObjC.import('AppKit');
      const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      JSON.stringify({pid: Number(front.processIdentifier), bundleId: ObjC.unwrap(front.bundleIdentifier), executable: ObjC.unwrap(front.executableURL.path)});
    `,
      ],
      { env, timeout: 5000, maxBuffer: 4096 },
    );
    const value = JSON.parse(result.stdout) as {
      pid?: number;
      bundleId?: string;
      executable?: string;
    };
    const measured =
      typeof value.pid === "number" &&
      value.pid > 0 &&
      typeof value.bundleId === "string" &&
      typeof value.executable === "string";
    const loginwindow =
      value.bundleId === "com.apple.loginwindow" ||
      /\/loginwindow\.app\//.test(value.executable ?? "");
    return {
      measured,
      pid: value.pid ?? null,
      bundleId: value.bundleId ?? null,
      loginwindow,
      available: measured && !loginwindow,
      error: null as string | null,
    };
  } catch (error) {
    return {
      measured: false,
      pid: null,
      bundleId: null,
      loginwindow: null,
      available: false,
      error: errorText(error),
    };
  }
}
async function logFiles(directory: string) {
  const files: { path: string; bytes: number }[] = [];
  const pending = [directory];
  let visited = 0;
  while (pending.length) {
    const path = pending.pop()!;
    for await (const entry of await opendir(path)) {
      if (++visited > 1024)
        throw new Error("Log inventory directory bound exceeded");
      const full = join(path, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && /\.log(?:\.\d+)?$/.test(entry.name))
        files.push({
          path: relative(directory, full),
          bytes: (await stat(full)).size,
        });
    }
  }
  return {
    files,
    passed:
      files.length <= 3 && files.every((file) => file.bytes <= 1024 * 1024),
    resolution:
      "Final disposable-HOME file inventory; transient log growth is not observed",
  };
}
function statsOf(
  main: MainReport,
  point: number,
): Record<string, number | null> | null {
  return (
    main.resources.filter((sample) => sample.atMs <= point).at(-1)?.stats ??
    null
  );
}
function assess(
  profile: Profile,
  main: MainReport,
  arm: ArmReport,
  renderer: RendererSample[],
  lane: NativeLane,
  uds: UdsReport | null,
  baselineStats: Record<string, number>,
  proxyFailures: string[],
) {
  const checks: Check[] = [];
  const start = arm.loadStartMs;
  const end = arm.recoveryEndMs;
  const snapshotWindows = [
    ...new Set(main.snapshotAccounting.map((record) => record.windowId)),
  ].map((windowId) => {
    const records = main.snapshotAccounting.filter(
      (record) => record.windowId === windowId,
    );
    const publications = records.filter(
      (record) => record.kind === "published",
    );
    let from = 0;
    let maximumPublicationsPerSecond = 0;
    for (const [index, record] of publications.entries()) {
      while (record.atMs - publications[from]!.atMs >= 1000) from++;
      maximumPublicationsPerSecond = Math.max(
        maximumPublicationsPerSecond,
        index - from + 1,
      );
    }
    return {
      windowId,
      records: records.length,
      scheduled: records.filter((record) => record.kind === "scheduled").length,
      materialized: records.filter((record) => record.kind === "materialized")
        .length,
      published: publications.length,
      cancelled: records.filter((record) => record.kind === "cancelled").length,
      maximumPending: Math.max(...records.map((record) => record.pending)),
      maximumBytes: Math.max(...records.map((record) => record.bytes)),
      finalPending: records.at(-1)!.pending,
      maximumPublicationsPerSecond,
    };
  });
  checks.push(
    check(
      "every-change per-window unpublished snapshot count/byte evidence",
      snapshotWindows.length > 0 &&
        snapshotWindows.every(
          (window) =>
            window.scheduled > 0 &&
            window.materialized > 0 &&
            window.published > 0 &&
            window.maximumPending === 1 &&
            window.maximumBytes > 0 &&
            window.maximumBytes <= 128 * 1024 &&
            window.finalPending === 0,
        ),
      { windows: snapshotWindows, evidence: main.snapshotBoundEvidence },
      "all scheduling/materialization/publication/cancellation boundaries; unpublished <=1 and <=128KiB per window",
    ),
    check(
      "snapshot publication rate remains at most 20Hz per window",
      snapshotWindows.length > 0 &&
        snapshotWindows.every(
          (window) => window.maximumPublicationsPerSecond <= 20,
        ),
      snapshotWindows.map(({ windowId, maximumPublicationsPerSecond }) => ({
        windowId,
        maximumPublicationsPerSecond,
      })),
      "at most 20 publications in any half-open 1000ms window, using every publication record",
    ),
  );
  const baseline = main.rss
    .filter(
      (sample) =>
        sample.scheduledMs !== null &&
        sample.scheduledMs >= 5000 &&
        sample.scheduledMs < 10_000,
    )
    .map((sample) => sample.bytes);
  const baselineBytes = median(baseline);
  const measuredRss = main.rss.filter(
    (sample) => sample.atMs >= start && sample.atMs <= main.finishedMs,
  );
  const peakBytes = measuredRss.length
    ? Math.max(...measuredRss.map((sample) => sample.bytes))
    : null;
  const finalRss = main.rss.at(-1);
  const memoryAllowance = (profile === "N" ? 64 : 96) * 1024 * 1024;
  checks.push(
    check(
      "warm-up baseline RSS coverage",
      baseline.length === 50,
      { count: baseline.length, baselineBytes },
      "50 samples at 100ms over final 5s of the fixed 10s warm-up",
    ),
  );
  checks.push(
    check(
      "sampled main RSS peak",
      baselineBytes !== null &&
        peakBytes !== null &&
        peakBytes <= baselineBytes + memoryAllowance,
      { baselineBytes, peakBytes },
      memoryAllowance,
    ),
  );
  checks.push(
    check(
      "30s recovery RSS",
      baselineBytes !== null &&
        finalRss !== undefined &&
        finalRss.atMs >= end &&
        finalRss.bytes <= baselineBytes + 32 * 1024 * 1024,
      finalRss ?? null,
      { earliestMs: end, allowanceBytes: 32 * 1024 * 1024 },
    ),
  );
  const loop = main.loop.filter(
    (sample) => sample.atMs >= start && sample.atMs < end,
  );
  const expectedTicks = Math.ceil(end / 20) - Math.ceil(start / 20);
  checks.push(
    check(
      "absolute main-loop tick coverage",
      loop.length === expectedTicks,
      loop.length,
      expectedTicks,
    ),
  );
  for (const phase of ["load", "recovery"] as const) {
    const ticks = loop.filter(
      (sample) => sample.atMs < arm.loadEndMs === (phase === "load"),
    );
    checks.push(
      latencyCheck(
        `main-loop delay / ${phase}`,
        ticks.map((sample) => sample.delayMs),
        profile === "N" ? 25 : 50,
        profile === "N" ? 100 : 200,
      ),
    );
  }
  const expectedUi = (profile === "N" ? 90_000 : 40_000) / 100;
  const hiddenSamples = renderer.filter(
    (sample) => sample.outcome === "hidden",
  );
  const unexplainedHidden = hiddenSamples.filter(
    (sample) =>
      !main.hidden.some((interval) => {
        const time = start + sample.scheduledMs;
        return (
          time >= interval.fromMs - 25 &&
          interval.untilMs !== null &&
          time <= interval.untilMs + 25
        );
      }),
  );
  const uiFailures = renderer.filter(
    (sample) => sample.outcome !== "ok" && sample.outcome !== "hidden",
  );
  checks.push(
    check(
      "renderer scheduled sample coverage",
      renderer.length === expectedUi &&
        uiFailures.length === 0 &&
        unexplainedHidden.length === 0,
      {
        count: renderer.length,
        failed: uiFailures.length,
        intentionallyHidden: hiddenSamples.length - unexplainedHidden.length,
        unexplainedHidden: unexplainedHidden.length,
      },
      expectedUi,
    ),
  );
  for (const phase of ["load", "recovery"] as const) {
    const samples = renderer.filter(
      (sample) =>
        sample.outcome === "ok" &&
        sample.scheduledMs < main.durationMs === (phase === "load"),
    );
    checks.push(
      latencyCheck(
        `getSnapshot -> production render -> RAF / ${phase}`,
        samples.map((sample) => sample.latencyMs!),
        profile === "N" ? 100 : 200,
        profile === "N" ? 250 : 500,
      ),
    );
  }
  checks.push(
    check(
      "native drag / tray-handler action counts and latency",
      main.actions.length === 30 &&
        main.actions.every((action) => action.passed) &&
        ["drag", "hide", "show"].every(
          (kind) =>
            main.actions.filter((action) => action.kind === kind).length === 10,
        ),
      main.actions,
      { drag: 10, hide: 10, show: 10, maximumMs: profile === "N" ? 250 : 500 },
    ),
  );
  const helpers = lane.attempts.flatMap((attempt) =>
    attempt.result && "spawned" in attempt.result && attempt.result.spawned
      ? [attempt.result]
      : [],
  );
  const expectedHelpers = profile === "N" ? 1080 : 200;
  checks.push(
    check(
      "fixed input slots / actual native invocations",
      lane.started === lane.planned &&
        helpers.length === expectedHelpers &&
        helpers.every(helperSafe) &&
        lane.maximumConcurrent <= (profile === "N" ? 4 : 8),
      {
        planned: lane.planned,
        started: lane.started,
        unissued: lane.unissued,
        actualHelperSpawns: helpers.length,
        safeHelperExits: helpers.filter(helperSafe).length,
        maximumConcurrent: lane.maximumConcurrent,
      },
      {
        slots: profile === "N" ? 1200 : 200,
        helperSpawns: expectedHelpers,
        concurrency: profile === "N" ? 4 : 8,
      },
    ),
  );
  checks.push(
    latencyCheck(
      "startup-inclusive configured helper",
      helpers.map((call) => call.elapsedMs),
      profile === "N" ? 100 : 250,
      500,
    ),
  );
  checks.push(
    check(
      "exact native frame capture / proxy forwarding",
      proxyFailures.length === 0,
      proxyFailures,
      [],
    ),
  );
  const stats = main.finalStats as unknown as Record<string, number> | null;
  const delta = stats
    ? Object.fromEntries(
        [
          "accepted",
          "rejected",
          "overflow",
          "consumerFailures",
          "authenticatedOverflow",
          "duplicateFrames",
          "delivered",
          "dedupEvictions",
        ].map((name) => [name, stats[name]! - baselineStats[name]!]),
      )
    : null;
  const receipts = main.transportReceipts.filter(
    (receipt) => BigInt(receipt.atNs) >= BigInt(main.loadStartNs),
  );
  const dispositions = Object.fromEntries(
    ["queued", "duplicate", "overflow"].map((kind) => [
      kind,
      receipts.filter((receipt) => receipt.disposition === kind).length,
    ]),
  );
  checks.push(
    check(
      "authenticated collector receipts reconcile accepted/duplicate/overflow frames",
      delta !== null &&
        dispositions.queued! + dispositions.duplicate! === delta.accepted &&
        dispositions.duplicate === delta.duplicateFrames &&
        dispositions.overflow === delta.authenticatedOverflow &&
        dispositions.queued === delta.delivered,
      { dispositions, delta },
      "one receipt per authenticated valid frame; duplicate frames are accepted but not delivered twice",
    ),
    check(
      "bounded transport replay cache evidence (not operation/wait/terminal proof)",
      stats !== null &&
        Number.isSafeInteger(stats.dedupSize) &&
        stats.dedupSize! > 0 &&
        stats.dedupSize! <= 4096 &&
        Number.isSafeInteger(stats.maximumDedupSize) &&
        stats.maximumDedupSize! >= stats.dedupSize! &&
        stats.maximumDedupSize! <= 4096 &&
        Number.isSafeInteger(stats.dedupEvictions) &&
        stats.dedupEvictions! >= 0,
      {
        finalSize: stats?.dedupSize,
        maximumSize: stats?.maximumDedupSize,
        evictions: stats?.dedupEvictions,
        mutationEvidence: main.collectorBoundEvidence,
      },
      "transport cache <=4096; profile does not add extra inputs to force eviction",
    ),
  );
  checks.push(
    check(
      "collector recovered queue/connections",
      stats !== null &&
        stats.queued === 0 &&
        stats.queuedBytes === 0 &&
        stats.activeConnections === 0 &&
        stats.connectionBytes === 0 &&
        (delta?.consumerFailures ?? -1) === 0,
      { final: stats, delta },
      "zero pending bodies/connections/consumer failures",
    ),
  );
  if (profile === "N") {
    const replays = lane.attempts.filter(
      (attempt) => attempt.role === "exact-envelope-replay",
    );
    checks.push(
      check(
        "N accepted every valid helper/replay slot without loss",
        delta?.accepted === 1200 &&
          delta.duplicateFrames === 120 &&
          delta.delivered === 1080 &&
          delta.rejected === 0 &&
          delta.overflow === 0 &&
          delta.authenticatedOverflow === 0 &&
          replays.length === 120 &&
          replays.every(
            (attempt) =>
              attempt.result &&
              "written" in attempt.result &&
              attempt.result.written &&
              attempt.result.error === null,
          ),
        { delta, replayCount: replays.length },
        {
          accepted: 1200,
          uniqueDeliveries: 1080,
          duplicateFrames: 120,
          replays: 120,
          loss: 0,
        },
      ),
    );
  } else {
    const mix = Object.fromEntries(
      ["authenticated-valid", "oversized", "wrong-token"].map((role) => [
        role,
        uds?.attempts.filter(
          (attempt) => attempt.role === role && attempt.startedMs !== null,
        ).length ?? 0,
      ]),
    );
    const byteMixCorrect =
      uds?.attempts.every(
        (attempt) =>
          attempt.bytes === (attempt.role === "oversized" ? 8193 : 8192),
      ) ?? false;
    checks.push(
      check(
        "O fixed UDS attempts and 8/1/1 byte mix",
        uds?.started === 2000 &&
          mix["authenticated-valid"] === 1600 &&
          mix.oversized === 200 &&
          mix["wrong-token"] === 200 &&
          byteMixCorrect &&
          uds.maximumConcurrent <= 32,
        {
          planned: uds?.planned,
          started: uds?.started,
          unissued: uds?.unissued,
          mix,
          maximumConcurrent: uds?.maximumConcurrent,
          byteMixCorrect,
        },
        {
          attempts: 2000,
          concurrency: 32,
          valid8192: 1600,
          oversized8193: 200,
          wrongToken8192: 200,
        },
      ),
    );
    checks.push(
      check(
        "rejected input did not create extra observed sessions",
        main.snapshots.every((sample) =>
          sample.snapshot.sessions.every((session) =>
            /^profile-project-[0-7]$/.test(session.project),
          ),
        ) && main.finalSnapshot.sessions.length === 8,
        main.finalSnapshot.sessions,
        "exactly the eight authenticated root projects; no rejected-project rows",
      ),
    );
    checks.push(
      check(
        "O consumer-only pause caused authenticated saturation",
        main.drain.heldDrains > 0 &&
          (delta?.authenticatedOverflow ?? 0) > 0 &&
          stats?.maximumQueue === 128,
        {
          drain: main.drain,
          authenticatedOverflow: delta?.authenticatedOverflow,
          maximumQueue: stats?.maximumQueue,
        },
        { pauseMs: [2000, 4000], queue: 128, minimumAuthenticatedOverflow: 1 },
      ),
    );
    const confidence = main.confidence;
    const observedDelay = confidence.firstUnknownAfterDropDelayMs;
    checks.push(
      check(
        "O observed unknown no later than 500ms after exact authenticated drop (not wait proof)",
        observedDelay !== null && observedDelay >= 0 && observedDelay <= 500,
        { ...confidence, observedDelayMs: observedDelay },
        500,
      ),
    );
    const firstLoss = confidence.firstAuthenticatedDropMs;
    const afterLoss =
      firstLoss === null
        ? []
        : main.snapshots.filter((sample) => sample.atMs >= firstLoss);
    checks.push(
      check(
        "O no automatic known-state recovery in sampled snapshots",
        firstLoss !== null &&
          main.finalSnapshot.state === "unknown" &&
          afterLoss.every((sample) => sample.snapshot.state === "unknown"),
        {
          finalState: main.finalSnapshot.state,
          transitionsAfterLoss: afterLoss.length,
        },
        "remain unknown absent a verified causal boundary",
      ),
    );
  }
  checks.push(
    check(
      "fixture resource/sample assertions",
      main.violations.length === 0,
      main.violations,
      [],
    ),
  );
  return {
    checks,
    measuredTransportPassed: checks.every((entry) => entry.passed),
    collectorDelta: delta,
    resourceSummary: {
      baselineBytes,
      peakSampledRssBytes: peakBytes,
      finalRss: finalRss ?? null,
      endOfLoadStats: statsOf(main, arm.loadEndMs),
      finalStats: stats,
    },
    helperStartup: distribution(helpers.map((call) => call.elapsedMs)),
    mainLoop: distribution(loop.map((sample) => sample.delayMs)),
    rendererLatency: distribution(
      renderer
        .filter((sample) => sample.outcome === "ok")
        .map((sample) => sample.latencyMs!),
    ),
  };
}

async function closeApplication(
  application: ElectronApplication,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          kill(application.process());
          reject(new Error("Electron cleanup exceeded 10s"));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function runOne(
  profile: Profile,
  repetition: number,
  slots: Slot[],
  executable: string,
  helperPath: string,
) {
  const home = await mkdtemp(join(tmpdir(), "pagent-transport-home-"));
  driverTrace = createProfileTrace();
  const env = environment(home);
  const producerAbort = new AbortController();
  const producerSignal = AbortSignal.any([abort.signal, producerAbort.signal]);
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let proxy: Awaited<ReturnType<typeof captureProxy>> | undefined;
  let udsProducer: UdsProducer | undefined;
  let watchdogCancellation: Promise<void> | undefined;
  let nativeProducer: Promise<NativeLane> | undefined;
  let original: Endpoint | undefined;
  let descriptor: string | undefined;
  const cleanupErrors: string[] = [];
  const failures: string[] = [];
  const record: Record<string, unknown> = {
    profile,
    repetition,
    homeIsolation: "fresh disposable HOME, removed after run",
    failures,
    cleanupErrors,
    unmetEvidence,
    passed: false,
  };
  const settings = join(home, ".claude", "settings.json");
  const watchdog = setTimeout(
    () => {
      failures.push("Run exceeded the bounded harness lifecycle watchdog");
      producerAbort.abort(new Error("Profile lifecycle watchdog"));
      if (application) kill(application.process());
      for (const child of children) kill(child);
      for (const socket of sockets) socket.destroy();
      watchdogCancellation = udsProducer?.cancel().catch((error: unknown) => {
        cleanupErrors.push(`Watchdog UDS cancellation: ${errorText(error)}`);
      });
    },
    profile === "N" ? 240_000 : 190_000,
  );
  try {
    const report = JSON.parse(await packagedInstall(executable, env)) as {
      targets: { settings: string };
    };
    if (report.targets.settings !== settings)
      throw new Error("Packaged CLI did not target the disposable HOME");
    const installed = await readFile(settings);
    const configuration = JSON.parse(installed.toString()) as {
      hooks?: Record<
        string,
        { hooks?: { type?: string; command?: string }[] }[]
      >;
    };
    const commands = new Set<string>();
    for (const name of hookEvents) {
      const handlers =
        configuration.hooks?.[name]?.flatMap((entry) => entry.hooks ?? []) ??
        [];
      if (
        handlers.length !== 1 ||
        handlers[0]?.type !== "command" ||
        typeof handlers[0].command !== "string"
      )
        throw new Error(
          `Missing configured bundled-helper command for ${name}`,
        );
      commands.add(handlers[0].command);
    }
    if (commands.size !== 1)
      throw new Error("Packaged CLI configured inconsistent helper commands");
    const command = [...commands][0]!;
    if (!command.startsWith(quoteHookArgument(helperPath) + " "))
      throw new Error(
        "Configured command does not invoke the freshly packaged bundled helper",
      );
    record.configuration = {
      command,
      settingsSha256: sha256(installed),
      hookEvents: [...hookEvents],
      obtainedFrom: "packaged hooks install --apply",
    };
    application = await _electron.launch({
      args: [resolve("dist/main/profile.js")],
      env,
      timeout: 15_000,
    });
    activeApplication = application;
    const readyDeadline = now() + 10_000_000_000n;
    while (
      !(await application.evaluate(
        () =>
          (
            Reflect.get(globalThis, "__pagentTransportProfile") as
              ProfileFixture | undefined
          )?.ready ?? false,
      ))
    ) {
      if (now() >= readyDeadline)
        throw new Error(
          "Production runDesktop onStarted/collector contract did not become ready",
        );
      abort.signal.throwIfAborted();
      await delay(25, undefined, { signal: abort.signal });
    }
    page = application
      .windows()
      .find((window) => window.url() === "pagent://app/pet/index.html");
    if (!page) throw new Error("Production pet renderer did not load");
    page.on("pageerror", (error) => {
      if (failures.length < 128) failures.push(`Renderer: ${error.message}`);
    });
    const foregroundAtLaunch = await foreground(env);
    record.foregroundAtLaunch = foregroundAtLaunch;
    const actual = await application.evaluate(() => {
      const controls = (
        Reflect.get(globalThis, "__pagentTransportProfile") as ProfileFixture
      ).controls!;
      return {
        descriptor: controls.collector?.descriptorPath,
        stats: controls.collector?.stats(),
      };
    });
    if (!actual.descriptor?.startsWith(home + "/"))
      throw new Error("Collector escaped the disposable HOME");
    descriptor = actual.descriptor;
    original = await readEndpoint(descriptor);
    proxy = await captureProxy(original, slots);
    // Only a temporary descriptor is redirected; the configured shell command
    // and every native frame remain unchanged. Raw auth material is not saved.
    await writeFile(descriptor, JSON.stringify(proxy.endpoint), {
      mode: 0o600,
    });
    const warmup = await application.evaluate(() =>
      (
        Reflect.get(globalThis, "__pagentTransportProfile") as ProfileFixture
      ).warmup(),
    );
    const running = await sequential(command, env, slots[0]!.input);
    record.sequentialRunning = running;
    const stalledStdin = await helper(command, env, null);
    const delayedStdin = await helper(command, env, slots[0]!.input, "delayed");
    const invalidInput = await helper(
      command,
      env,
      padded("not a hook payload", 4096, false),
    );
    const unresponsive = await unresponsivePeer(
      command,
      env,
      slots[0]!.input,
      descriptor,
      proxy.endpoint,
    );
    record.errorProbes = {
      stalledStdin,
      delayedStdin,
      invalidInput,
      unresponsive,
      internalDeadlineMs: 150,
      internalDeadlineMeasuredDirectly: false,
      passed:
        [stalledStdin, delayedStdin, invalidInput, unresponsive.result].every(
          helperSafe,
        ) &&
        unresponsive.errors.length === 0 &&
        unresponsive.acceptedConnections > 0 &&
        stalledStdin.elapsedMs >= 120 &&
        delayedStdin.elapsedMs >= 120,
    };
    const warmupEnd = BigInt(warmup.warmupEndNs);
    if (now() > warmupEnd)
      failures.push("Warm-up work overran the fixed 10s window");
    await until(warmupEnd);
    const baselineStats = await application.evaluate(() => ({
      ...(
        Reflect.get(globalThis, "__pagentTransportProfile") as ProfileFixture
      ).controls!.collector!.stats(),
    }));
    if (baselineStats.queued !== 0 || baselineStats.activeConnections !== 0)
      failures.push(
        "Warm-up collector work did not drain before the fixed profile",
      );
    const endpoint = original;
    const wirePreparationStarted = now();
    // Readiness joins worker startup and fixed input/hash preparation before
    // either app or producer is armed. Only native replays depend on load data.
    if (profile === "O")
      udsProducer = await prepareUdsProducer(endpoint, {
        workerUrl: new URL("./profile-uds-worker.mjs", import.meta.url),
        signal: producerSignal,
      });
    record.producerPreparation = {
      elapsedMs: msSince(wirePreparationStarted),
      wireFrames: udsProducer?.preparation.wireFrames ?? 0,
      retainedWireBytes: udsProducer?.preparation.retainedWireBytes ?? 0,
      worker: udsProducer?.preparation ?? null,
      scope:
        "Bounded fixture-only worker input preparation/readiness joined before arming; not collector or main RSS. Worker sockets/timers do not share the driver's synchronous helper-spawn thread.",
    };
    proxy.beginLoad();
    const start = now() + 1_000_000_000n;
    await udsProducer?.start(start);
    const arm = await application.evaluate(
      (_, args) =>
        (
          Reflect.get(globalThis, "__pagentTransportProfile") as ProfileFixture
        ).arm(args.profile, args.start),
      { profile, start: start.toString() },
    );
    const duration = profile === "N" ? 60_000 : 10_000;
    await page.evaluate(installRendererSampler, {
      startUnixMs: Date.now() + Number(start - now()) / 1e6,
      durationMs: duration,
    });
    const captured = proxy;
    nativeProducer = fixedLane<HelperResult | WireResult>(
      slots.length,
      50,
      profile === "N" ? 4 : 8,
      start,
      (index) => {
        const slot = slots[index]!;
        const replay = profile === "N" && slot.replayOf !== null;
        const source = replay
          ? captured.originals.get(slot.replayOf!)
          : undefined;
        const bytes = replay ? source?.bytes : slot.input;
        return {
          role: replay
            ? "exact-envelope-replay"
            : slot.role === "exact-envelope-replay"
              ? "native-probe"
              : slot.role,
          replay,
          ...(source ? { eventId: source.eventId } : {}),
          bytes: bytes?.length ?? 0,
          sha256: replay ? (source?.sha256 ?? null) : slot.sha256,
          // Do not lower scheduled native load to disguise slow/out-of-order
          // emission. Missing causal predecessors are separate failed evidence.
          prerequisite: bytes ? null : "exact-native-replay-source-unavailable",
          run: () =>
            replay
              ? send(bytes!, endpoint.socketPath)
              : helper(command, env, bytes!),
        };
      },
      producerSignal,
      undefined,
      driverTrace.begin,
    );
    const udsPromise = udsProducer?.result ?? Promise.resolve(null);
    const [lane, uds] = await Promise.all([nativeProducer, udsPromise]);
    await until(start + BigInt(duration + 30_000) * 1_000_000n);
    const renderer = await page.evaluate(() =>
      (
        Reflect.get(window, "__pagentProfileRenderer") as RendererFixture
      ).stop(),
    );
    const main = await application.evaluate(() =>
      (
        Reflect.get(globalThis, "__pagentTransportProfile") as ProfileFixture
      ).finish(),
    );
    const proxyFailures = [...proxy.failures];
    const assessment = assess(
      profile,
      main,
      arm,
      renderer,
      lane,
      uds,
      baselineStats as unknown as Record<string, number>,
      proxyFailures,
    );
    const foregroundAtRecoveryEnd = await foreground(env);
    const displaySamples = main.displaySamples.filter(
      (sample) => sample.atMs >= arm.loadStartMs,
    );
    const displayAvailable =
      foregroundAtLaunch.available &&
      foregroundAtRecoveryEnd.available &&
      displaySamples.length >= main.durationMs / 1000 + 30 &&
      displaySamples.every(
        (sample) =>
          sample.reason !== "lock-screen" &&
          sample.idleState !== "locked" &&
          sample.idleState !== "unknown" &&
          sample.displayCount > 0 &&
          (sample.nativeVisible ||
            main.hidden.some(
              (interval) =>
                interval.untilMs !== null &&
                sample.atMs >= interval.fromMs - 25 &&
                sample.atMs <= interval.untilMs + 25,
            )),
      );
    record.displayAvailability = {
      foregroundAtLaunch,
      foregroundAtRecoveryEnd,
      displayAvailable,
      note: "Locked/loginwindow/unmeasurable console invalidates visible-UI acceptance even if an unthrottled renderer produces RAFs. No activation is attempted.",
    };
    assessment.checks.push(
      check(
        "visible desktop precondition",
        displayAvailable,
        record.displayAvailability,
        "unlocked measured console throughout load/recovery, not loginwindow; only scheduled hide intervals excluded",
      ),
    );
    const loadCaptures = proxy.captured.filter(
      (frame) => BigInt(frame.atNs) >= start,
    );
    const loadReceipts = main.transportReceipts.filter(
      (receipt) => BigInt(receipt.atNs) >= start,
    );
    const capturesByKey = new Map(
      loadCaptures.map((frame) => [frame.key, frame]),
    );
    const orderDiagnostics =
      profile === "N"
        ? diagnoseOrder(
            lane.attempts.map((attempt) => {
              const slot = slots[attempt.index]!;
              const frame = capturesByKey.get(slot.key);
              return {
                key: slot.key,
                predecessors: slot.predecessors,
                eventId: attempt.eventId ?? frame?.eventId ?? null,
                preparedNs: attempt.preparedNs,
                startedNs: attempt.startedNs,
                forwardedNs:
                  attempt.role === "exact-envelope-replay"
                    ? attempt.result &&
                      "written" in attempt.result &&
                      attempt.result.written &&
                      !attempt.result.error
                      ? attempt.finishedNs
                      : null
                    : (frame?.forwardedNs ?? null),
                reason: attempt.reason,
              };
            }),
            loadCaptures,
            loadReceipts,
          )
        : [];
    assessment.checks.push(
      check(
        "actual configured native frames captured",
        loadCaptures.length === (profile === "N" ? 1080 : 200),
        loadCaptures.length,
        profile === "N" ? 1080 : 200,
      ),
    );
    const distinctNativeIds = new Set(
      loadCaptures.map((frame) => frame.eventId),
    );
    const receivedIds = new Set(loadReceipts.map((receipt) => receipt.eventId));
    assessment.checks.push(
      check(
        "independent native invocations retain distinct transport UUIDs",
        distinctNativeIds.size === loadCaptures.length &&
          loadCaptures.every(
            (frame) => isEpoch(frame.eventId) && receivedIds.has(frame.eventId),
          ),
        {
          frames: loadCaptures.length,
          distinctTransportIds: distinctNativeIds.size,
          observedAtCollector: loadCaptures.filter((frame) =>
            receivedIds.has(frame.eventId),
          ).length,
        },
        "one helper-generated UUID per invocation, including identical provider payloads, preserved at the collector; not provider causality",
      ),
    );
    if (profile === "N")
      assessment.checks.push(
        check(
          "exact replay preserves captured bytes and transport UUID",
          lane.attempts
            .filter((attempt) => attempt.role === "exact-envelope-replay")
            .every((attempt) => {
              const source = capturesByKey.get(slots[attempt.index]!.replayOf!);
              return (
                source !== undefined &&
                attempt.eventId === source.eventId &&
                attempt.sha256 === source.sha256
              );
            }),
          { replaySlots: 120 },
          "captured envelope unchanged; independent helper invocations are not replays",
        ),
        check(
          "fixed corpus causal issuance order",
          orderDiagnostics.length === 1612 &&
            orderDiagnostics.every((entry) => entry.issuance === "ordered"),
          {
            edges: orderDiagnostics.length,
            failures: orderDiagnostics.filter(
              (entry) => entry.issuance !== "ordered",
            ),
          },
          "1612 fixture-required edges (60 × 26 within-block + 52 same-root turn boundaries) must be issued in causal order. Missing/unissued predecessors fail; no backfill or resequencing. This does not prove provider semantics or correct handling of reversed arrivals.",
        ),
        check(
          "fixed corpus admission completeness and attribution",
          orderDiagnostics.length === 1612 &&
            orderDiagnostics.every((entry) => entry.admission === "observed"),
          {
            edges: orderDiagnostics.length,
            failures: orderDiagnostics.filter(
              (entry) => entry.admission !== "observed",
            ),
            arrivalReversals: orderDiagnostics.filter(
              (entry) => entry.stages.collectorAdmission.order === "reversed",
            ),
          },
          "Every causal edge has unambiguous non-overflow admissions. Arrival order is recorded, not assumed to be FIFO across independent helpers; out-of-order state semantics require separate evidence.",
        ),
      );
    assessment.measuredTransportPassed = assessment.checks.every(
      (entry) => entry.passed,
    );
    const files = await logFiles(home);
    record.measurements = {
      arm,
      main,
      renderer,
      nativeAndReplayLane: lane,
      udsLane: uds,
      orderDiagnostics,
      capture: {
        frames: proxy.captured,
        ...proxy.metrics(),
        failures: proxyFailures,
      },
      logFiles: files,
    };
    const attempts = [...lane.attempts, ...(uds?.attempts ?? [])];
    const unissuedReasons: Record<string, number> = {};
    for (const attempt of attempts)
      if (attempt.startedMs === null) {
        const reason = attempt.reason ?? "unspecified";
        unissuedReasons[reason] = (unissuedReasons[reason] ?? 0) + 1;
      }
    record.inputAccounting = {
      planned: lane.planned + (uds?.planned ?? 0),
      started: lane.started + (uds?.started ?? 0),
      actualNativeSpawns: lane.attempts.filter(
        (attempt) =>
          attempt.result &&
          "spawned" in attempt.result &&
          attempt.result.spawned,
      ).length,
      exactReplaysStarted: lane.attempts.filter(
        (attempt) =>
          attempt.role === "exact-envelope-replay" &&
          attempt.startedMs !== null,
      ).length,
      acceptedFrames: assessment.collectorDelta?.accepted ?? null,
      duplicateFrames: assessment.collectorDelta?.duplicateFrames ?? null,
      uniqueDeliveries: assessment.collectorDelta?.delivered ?? null,
      queuedReceipts: loadReceipts.filter(
        (receipt) => receipt.disposition === "queued",
      ).length,
      authenticatedDropped:
        assessment.collectorDelta?.authenticatedOverflow ?? null,
      rejected: assessment.collectorDelta?.rejected ?? null,
      overflow: assessment.collectorDelta?.overflow ?? null,
      unissuedReasons,
      socketFailures: attempts.filter(
        (attempt) =>
          attempt.result &&
          "written" in attempt.result &&
          (!attempt.result.written || attempt.result.error !== null),
      ).length,
      attribution:
        "Authenticated admission/duplicate/overflow receipts carry transport UUID and collector receivedSeq. Socket write completion is not an admission ACK. Rejected frames have only aggregate statistics; overlapping identical replay sends are explicitly ambiguous, never inferred FIFO.",
    };
    record.assessment = assessment;
    if (!(record.errorProbes as { passed: boolean }).passed)
      failures.push(
        "A controlled helper failure probe failed its wall/silence/deadline-path checks",
      );
    if (!running.passed)
      failures.push("App-running sequential 100-call budget failed");
    if (!files.passed) failures.push("Disposable-HOME log file bounds failed");
    if (!assessment.measuredTransportPassed)
      failures.push("One or more measured profile thresholds/counts failed");
    await proxy.close();
    proxy = undefined;
    await writeFile(descriptor, JSON.stringify(original), { mode: 0o600 });
    await closeApplication(application);
    application = undefined;
    activeApplication = undefined;
    try {
      await stat(descriptor);
      failures.push(
        "Production collector left its endpoint descriptor after app shutdown",
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    const off = await sequential(command, env, slots[0]!.input);
    record.sequentialOff = off;
    if (!off.passed)
      failures.push(
        "App-off sequential 100-call N startup/cumulative budgets failed",
      );
    record.acceptanceEligible = !diagnosticNative;
    record.measuredChecksPassed = failures.length === 0;
    record.transportPassed = !diagnosticNative && failures.length === 0;
    // Transport evidence is useful but intentionally cannot certify slice1b.
    record.passed =
      !diagnosticNative && failures.length === 0 && unmetEvidence.length === 0;
  } catch (error) {
    failures.push(errorText(error));
  } finally {
    clearTimeout(watchdog);
    producerAbort.abort(new Error("Profile cleanup"));
    await watchdogCancellation;
    if (udsProducer) {
      try {
        await udsProducer.cancel();
        record.udsProducerCleanup = { joined: true, atNs: now().toString() };
      } catch (error) {
        record.udsProducerCleanup = { joined: false };
        cleanupErrors.push(`UDS worker cleanup: ${errorText(error)}`);
      }
    }
    await stopChildren().catch((error: unknown) =>
      cleanupErrors.push(`Child cleanup: ${errorText(error)}`),
    );
    for (const socket of sockets) socket.destroy();
    if (nativeProducer) await Promise.allSettled([nativeProducer]);
    if (proxy)
      await proxy
        .close()
        .catch((error: unknown) =>
          cleanupErrors.push(`Proxy cleanup: ${errorText(error)}`),
        );
    if (application) {
      try {
        if (descriptor && original)
          await writeFile(descriptor, JSON.stringify(original), {
            mode: 0o600,
          });
        await application.evaluate(() =>
          (
            Reflect.get(globalThis, "__pagentTransportProfile") as
              ProfileFixture | undefined
          )?.abort(),
        );
      } catch (error) {
        cleanupErrors.push(`Fixture cleanup: ${errorText(error)}`);
      }
      await closeApplication(application).catch((error: unknown) =>
        cleanupErrors.push(`Electron cleanup: ${errorText(error)}`),
      );
    }
    activeApplication = undefined;
    if (original)
      await rm(dirname(original.socketPath), {
        recursive: true,
        force: true,
      }).catch((error: unknown) =>
        cleanupErrors.push(`Collector endpoint cleanup: ${errorText(error)}`),
      );
    await rm(home, { recursive: true, force: true }).catch((error: unknown) =>
      cleanupErrors.push(`HOME cleanup: ${errorText(error)}`),
    );
    const missing = [
      "configuration",
      "sequentialRunning",
      "errorProbes",
      "measurements",
      "assessment",
      "sequentialOff",
    ].filter((stage) => !(stage in record));
    record.missingMeasurements = missing;
    if (missing.length)
      failures.push(`Unmeasured stages after failure: ${missing.join(", ")}`);
    if (cleanupErrors.length || missing.length) {
      record.transportPassed = false;
      record.passed = false;
    }
    driverTrace.close();
    record.driverTrace = driverTrace.report();
    driverTrace = undefined;
  }
  return record;
}

export async function runProfiles(options: {
  profiles: Profile[];
  diagnosticNative?: boolean;
}) {
  diagnosticNative = options.diagnosticNative === true;
  const results: Record<string, unknown>[] = [];
  const runErrors: string[] = [];
  const onSignal = (): void => {
    abort.abort(new Error("Profiling interrupted"));
    if (activeApplication) kill(activeApplication.process());
    for (const child of children) kill(child);
    for (const socket of sockets) socket.destroy();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    seed: "0x50414745",
    profilesRequested: options.profiles,
    repetitions: 3,
    fullContractSelection: options.profiles.length === 2,
    passed: false,
    diagnosticNative,
    acceptanceEligible: !diagnosticNative,
    orderAssessmentBasis:
      "Approved fixed-corpus contract: causally valid issuance plus complete, unambiguous admission. Reception reversals remain recorded observations, not an invented cross-process FIFO guarantee. This supersedes the old receipt-order predicate without reclassifying preserved reports or proving out-of-order state semantics.",
    diagnosticClockNote:
      "Native uptimeNs and current-thread CPU are interpreted as within-helper deltas. Parent *ObservedNs fields are driver observations, not child execution timestamps; no cross-runtime epoch equivalence is assumed.",
    runs: results,
    errors: runErrors,
    limits: {
      N: {
        seconds: 60,
        slots: 1200,
        actualHelperCalls: 1080,
        exactFrameReplays: 120,
        acceptedFrames: 1200,
        uniqueDeliveries: 1080,
        duplicateFrames: 120,
        rate: 20,
        childConcurrency: 4,
      },
      O: {
        seconds: 10,
        udsAttempts: 2000,
        udsRate: 200,
        udsConcurrency: 32,
        valid8192: 1600,
        oversized8193: 200,
        wrongToken8192: 200,
        actualHelperCalls: 200,
        helperRate: 20,
        childConcurrency: 8,
        consumerDrainPauseMs: [2000, 4000],
      },
      warmupMs: 10_000,
      baselineWindowMs: [5000, 10_000],
      recoveryMs: 30_000,
      helperInternalDeadlineMs: 150,
      helperWallCeilingMs: 500,
    },
    evidenceScope:
      "Local packaged CLI/helper and actual production runDesktop/bridge/rendering, not live-provider semantic coverage or OS click-through/focus acceptance",
    cachePolicy:
      "No forced GC or cache purge; first invocation does not mean forced cold cache",
    clock:
      "process.hrtime.bigint monotonic startup/input clocks shared by driver and isolated UDS worker; renderer local performance.now duration; Date used only to align renderer schedule",
    missingEnvironmentEvidence: [
      "Claude Code is deliberately not invoked and user installations/settings are not inspected; its installed version and provider-schema provenance are unverified.",
    ],
  };
  try {
    if (platform() !== "darwin")
      throw new Error("The approved profile contract requires macOS");
    if (
      options.profiles.length < 1 ||
      options.profiles.length > 2 ||
      new Set(options.profiles).size !== options.profiles.length ||
      options.profiles.some((profile) => profile !== "N" && profile !== "O")
    )
      throw new Error(
        "Select N, O, or both exactly once; each selection always runs three repetitions",
      );
    const packageDirectory = diagnosticNative
      ? `pagent-diagnostic-darwin-${process.arch}`
      : `pagent-darwin-${process.arch}`;
    const executable = resolve(
      `build/${packageDirectory}/pagent.app/Contents/MacOS/pagent`,
    );
    const helperPath = resolve(
      `build/${packageDirectory}/pagent.app/Contents/Resources/helpers/pagent-hook-emitter`,
    );
    const electronExecutable = createRequire(import.meta.url)(
      "electron",
    ) as string;
    const appRoot = resolve(`build/${packageDirectory}/pagent.app/Contents`);
    const macos = await execute("/usr/bin/sw_vers", ["-productVersion"], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const swift = await execute("/usr/bin/swift", ["--version"], {
      timeout: 5000,
      maxBuffer: 16 * 1024,
    });
    report.environment = {
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      osVersion: version(),
      macos: macos.stdout.trim(),
      hardware: {
        model: cpus()[0]?.model ?? null,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      driverNode: process.versions,
      swift: swift.stdout.trim(),
      claude: {
        invoked: false,
        version: null,
        source:
          "native/hook-emitter/Sources/HookProtocol/EventProjection.swift",
        semanticSupport: "unverified",
      },
    };
    report.hashes = await Promise.all(
      [
        executable,
        helperPath,
        electronExecutable,
        join(appRoot, "Resources", "app.asar"),
        "dist/main/profile.js",
        "dist/main/profile-driver.mjs",
        "dist/main/profile-uds-worker.mjs",
        "dist/renderer/pet/index.js",
        "dist/preload/index.cjs",
        "tests/profiles/main.ts",
        "tests/profiles/transport.ts",
        "tests/profiles/order.ts",
        "tests/profiles/uds-producer.ts",
        "tests/profiles/uds-worker.ts",
        "tests/profiles/trace.ts",
        "scripts/profile-transport.mjs",
        "src/main/desktop.ts",
        "src/main/snapshot-publisher.ts",
        "src/main/ipc.ts",
        "src/integration/claude/collector.ts",
        "src/integration/claude/protocol.ts",
        "src/domain/observations.ts",
        "native/hook-emitter/Sources/HookProtocol/EventProjection.swift",
        "native/hook-emitter/Sources/HookProtocol/InputFingerprint.swift",
        "native/hook-emitter/Sources/HookProtocol/ProcessAncestry.swift",
        "native/hook-emitter/Sources/HookEmitter/main.swift",
        "native/hook-emitter/Sources/HookEmitter/DiagnosticTrace.swift",
        "scripts/build-diagnostic-helper.mjs",
        "src/integration/claude/hook-install.ts",
      ].map(hashFile),
    );
    const normal = corpus("N"),
      overload = corpus("O");
    report.fixtures = {
      files: await fixtureFiles(normal, overload),
      wireTemplates:
        "Fixed dummy 36-byte epoch / 64-byte token are substituted with fresh temporary credentials. Synthetic UDS slots have distinct deterministic transport UUIDs per epoch, never provider IDs. Each actual attempted frame hash/byte count is recorded separately, without saving credentials.",
      corpus:
        "20 slots/block, 8 round-robin root sessions, six parallel tool pairs, two wait/clear candidates, turn boundaries, two replay slots. Missing causal wait support is unmet, not assumed.",
    };
    await mkdir(dirname(outputPath), { recursive: true });
    for (const profile of options.profiles) {
      for (let repetition = 1; repetition <= 3; repetition++) {
        abort.signal.throwIfAborted();
        results.push(
          await runOne(
            profile,
            repetition,
            profile === "N" ? normal : overload,
            executable,
            helperPath,
          ),
        );
        await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
      }
    }
    report.transportPassed =
      results.length === options.profiles.length * 3 &&
      results.every((run) => run.transportPassed === true);
    report.measuredChecksPassed =
      results.length === options.profiles.length * 3 &&
      results.every((run) => run.measuredChecksPassed === true);
    report.passed =
      !diagnosticNative &&
      results.length === 6 &&
      results.every((run) => run.passed === true) &&
      runErrors.length === 0 &&
      (report.missingEnvironmentEvidence as string[]).length === 0;
  } catch (error) {
    runErrors.push(errorText(error));
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stopChildren().catch((error: unknown) =>
      runErrors.push(`Child cleanup: ${errorText(error)}`),
    );
    for (const socket of sockets) socket.destroy();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  }
  return {
    passed: report.passed === true,
    outputPath,
    completedRuns: results.length,
    transportPassed: report.transportPassed === true,
  };
}
