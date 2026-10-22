import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type {
  ClaudeEvent,
  Endpoint,
} from "../../src/integration/claude/protocol.ts";
import { diagnoseProducer, type ProducerTiming } from "./order.ts";
import type { ProfileTrace, TraceReport } from "./trace.ts";

export const udsContract = {
  count: 2000,
  intervalMs: 5,
  concurrency: 32,
  durationMs: 10_000,
} as const;

export type WireResult = {
  connected: boolean;
  written: boolean;
  elapsedMs: number;
  error: string | null;
};
export type LaneAttempt<Result> = ProducerTiming & {
  role: string;
  preparedNs: string;
  startedNs: string | null;
  finishedNs: string | null;
  finishedMs: number | null;
  eventId: string | null;
  sha256: string | null;
  bytes: number;
  result: Result | null;
};
export type ProducerClock = {
  now(): bigint;
  until(deadline: bigint, signal: AbortSignal): Promise<void>;
};
const now = (): bigint => process.hrtime.bigint();
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const deadlineWaitCapacity = 8192;
const deadlineWaitColumns = [
  "sequence",
  "slot",
  "targetMs",
  "requestedMs",
  "originalDelayMs",
  "continuationMs",
  "outcome",
] as const;
const waitOutcomes = {
  pending: 0,
  fulfilled: 1,
  aborted: 2,
  rejected: 3,
} as const;
export type DeadlineWaitReport = {
  schemaVersion: 1;
  capacity: number;
  preallocatedBytes: number;
  columns: typeof deadlineWaitColumns;
  outcomes: typeof waitOutcomes;
  records: number[][];
  units: { time: "milliseconds"; pendingContinuation: -1 };
  clock: {
    source: "process.hrtime.bigint" | "injected";
    laneStartNs: string;
  };
  capability: {
    actualTimerEvidence: boolean;
    reason: "instrumented" | "injected-clock-or-wait" | "timer-api-unavailable";
  };
  counts: {
    waitCalls: number;
    requests: number;
    retained: number;
    overflow: number;
    fulfilled: number;
    aborted: number;
    rejected: number;
    unobservedWaits: number;
  };
  exhausted: boolean;
  interpretation: string;
};

function createDeadlineWaitEvidence(start: bigint, clock: ProducerClock) {
  const width = deadlineWaitColumns.length;
  const data = new Float64Array(deadlineWaitCapacity * width);
  const actualClock = clock.now === now && clock.until === until;
  const actualTimerEvidence = actualClock && typeof delay === "function";
  let waitCalls = 0;
  let requests = 0;
  let retained = 0;
  let overflow = 0;
  let fulfilled = 0;
  let aborted = 0;
  let rejected = 0;
  let unobservedWaits = 0;
  return {
    actualTimerEvidence,
    called() {
      waitCalls++;
    },
    unobserved() {
      unobservedWaits++;
    },
    request(slot: number, target: bigint, originalDelayMs: number): number {
      const requested = now();
      requests++;
      if (retained === deadlineWaitCapacity) {
        overflow++;
        return -1;
      }
      const offset = retained++ * width;
      data[offset] = requests;
      data[offset + 1] = slot;
      data[offset + 2] = Number(target - start) / 1e6;
      data[offset + 3] = Number(requested - start) / 1e6;
      data[offset + 4] = originalDelayMs;
      data[offset + 5] = -1;
      data[offset + 6] = waitOutcomes.pending;
      return offset;
    },
    resumed(offset: number, outcome: 1 | 2 | 3) {
      const continuation = now();
      if (outcome === waitOutcomes.fulfilled) fulfilled++;
      else if (outcome === waitOutcomes.aborted) aborted++;
      else rejected++;
      if (offset < 0) return;
      data[offset + 5] = Number(continuation - start) / 1e6;
      data[offset + 6] = outcome;
    },
    report(): DeadlineWaitReport {
      const records: number[][] = [];
      for (let index = 0; index < retained; index++) {
        const offset = index * width;
        records.push(Array.from(data.subarray(offset, offset + width)));
      }
      return {
        schemaVersion: 1,
        capacity: deadlineWaitCapacity,
        preallocatedBytes: data.byteLength,
        columns: deadlineWaitColumns,
        outcomes: waitOutcomes,
        records,
        units: { time: "milliseconds", pendingContinuation: -1 },
        clock: {
          source: actualClock ? "process.hrtime.bigint" : "injected",
          laneStartNs: start.toString(),
        },
        capability: {
          actualTimerEvidence,
          reason: !actualClock
            ? "injected-clock-or-wait"
            : actualTimerEvidence
              ? "instrumented"
              : "timer-api-unavailable",
        },
        counts: {
          waitCalls,
          requests,
          retained,
          overflow,
          fulfilled,
          aborted,
          rejected,
          unobservedWaits,
        },
        exhausted: overflow > 0,
        interpretation:
          "Only the existing node:timers/promises.setTimeout waits are recorded. Times are relative to laneStartNs and can be negative before load start; requestedMs is an observation immediately before invoking delay with originalDelayMs, not an exact registration timestamp or the runtime's rounded timeout. continuationMs observes promise resumption or rejection, not the exact timer callback/fire time, and -1 means missing only while outcome is pending. Aborted means rejection observed with an aborted signal; it is not an inferred OS cause or a recorded error payload. Early wakes retain separate requests for the same absolute target; no delay, slot or deadline is shifted or backfilled. The first 8192 requests are retained and overflow is explicit. Injected clocks/waits have no actual-timer rows, rather than fabricated timer evidence. All instrumentation overhead remains in the lane metrics.",
      };
    },
  };
}

async function waitUntil(
  deadline: bigint,
  signal: AbortSignal,
  evidence?: ReturnType<typeof createDeadlineWaitEvidence>,
  slot = -1,
): Promise<void> {
  while (now() < deadline) {
    signal.throwIfAborted();
    const originalDelayMs = Math.min(
      1000,
      Math.max(1, Number(deadline - now()) / 1e6),
    );
    const offset = evidence?.request(slot, deadline, originalDelayMs);
    try {
      await delay(originalDelayMs, undefined, { signal });
    } catch (error) {
      if (offset !== undefined)
        evidence!.resumed(
          offset,
          signal.aborted ? waitOutcomes.aborted : waitOutcomes.rejected,
        );
      throw error;
    }
    if (offset !== undefined) evidence!.resumed(offset, waitOutcomes.fulfilled);
  }
}

export function until(deadline: bigint, signal: AbortSignal): Promise<void> {
  return waitUntil(deadline, signal);
}

export function distribution(values: readonly number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number | null =>
    ordered.length ? ordered[Math.ceil(ordered.length * p) - 1]! : null;
  return {
    count: values.length,
    firstMs: values[0] ?? null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maximumMs: ordered.at(-1) ?? null,
    cumulativeMs: values.reduce((total, value) => total + value, 0),
  };
}

export function padded(
  value: unknown,
  bytes: number,
  newline: boolean,
): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  const length = bytes - json.length - (newline ? 1 : 0);
  if (length < 0)
    throw new Error(`Fixture exceeds its fixed ${bytes} byte size`);
  return Buffer.concat(
    [
      json,
      Buffer.alloc(length, 32),
      newline ? Buffer.from("\n") : Buffer.alloc(0),
    ],
    bytes,
  );
}

export function wire(index: number, endpoint: Endpoint) {
  const kind = index % 10;
  const root = Math.floor(index / 10) % 8;
  const event: ClaudeEvent = {
    eventName: "SessionStart",
    sessionId: kind >= 8 ? `rejected-${kind}-${index}` : `profile-root-${root}`,
    project: kind >= 8 ? `rejected-project-${kind}` : `profile-project-${root}`,
    promptId: `uds-${String(index).padStart(4, "0")}`,
  };
  const wrongToken =
    (endpoint.token[0] === "0" ? "1" : "0") + endpoint.token.slice(1);
  const eventId = `50414745-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  return {
    eventId,
    bytes: padded(
      {
        version: 1,
        epoch: endpoint.epoch,
        token: kind === 9 ? wrongToken : endpoint.token,
        eventId,
        event,
      },
      kind === 8 ? 8193 : 8192,
      true,
    ),
    role:
      kind === 8
        ? "oversized"
        : kind === 9
          ? "wrong-token"
          : "authenticated-valid",
  };
}

export function prepareWires(endpoint: Endpoint) {
  return Array.from({ length: udsContract.count }, (_, index) => {
    const frame = wire(index, endpoint);
    return {
      ...frame,
      sha256: createHash("sha256").update(frame.bytes).digest("hex"),
    };
  });
}

// Shared by the driver capture/replay path and the isolated UDS worker.
export async function sendWire(
  bytes: Buffer,
  path: string,
  sockets: Set<Socket>,
  signal: AbortSignal,
  begin?: ProfileTrace["begin"],
): Promise<WireResult> {
  signal.throwIfAborted();
  const start = now();
  let connected = false,
    written = false;
  let failure: string | null = null;
  const endOpen = begin?.("uds.socket.open");
  let socket: Socket;
  try {
    socket = createConnection(path);
  } finally {
    endOpen?.();
  }
  sockets.add(socket);
  const onAbort = (): void => {
    const end = begin?.("uds.socket.abort");
    try {
      failure = "aborted";
      socket.destroy();
    } finally {
      end?.();
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    const end = begin?.("uds.socket.timeout");
    try {
      failure = "500ms client watchdog";
      socket.destroy();
    } finally {
      end?.();
    }
  }, 500);
  try {
    return await new Promise<WireResult>((done) => {
      socket.once("connect", () => {
        const end = begin?.("uds.socket.connect");
        try {
          connected = true;
          socket.end(bytes, () => {
            const endWrite = begin?.("uds.socket.writeComplete");
            try {
              written = true;
            } finally {
              endWrite?.();
            }
          });
        } finally {
          end?.();
        }
      });
      socket.once("error", (error) => {
        const end = begin?.("uds.socket.error");
        try {
          failure = errorText(error);
        } finally {
          end?.();
        }
      });
      socket.once("close", () => {
        const end = begin?.("uds.socket.close");
        try {
          done({
            connected,
            written,
            elapsedMs: Number(now() - start) / 1e6,
            error: failure,
          });
        } finally {
          end?.();
        }
      });
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    socket.destroy();
    sockets.delete(socket);
  }
}

// This is the existing absolute-slot scheduler, shared rather than replicated
// for the worker. The clock seam permits deterministic fixture deadline tests.
export async function fixedLane<Result>(
  count: number,
  intervalMs: number,
  concurrency: number,
  start: bigint,
  make: (index: number) => {
    role: string;
    bytes: number;
    sha256: string | null;
    replay?: boolean;
    eventId?: string;
    prerequisite?: string | null;
    run: () => Promise<Result>;
  },
  signal: AbortSignal,
  clock: ProducerClock = { now, until },
  begin?: ProfileTrace["begin"],
) {
  const cpuStart = process.cpuUsage();
  const deadlineWaits = createDeadlineWaitEvidence(start, clock);
  const msSinceStart = (): number => Number(clock.now() - start) / 1e6;
  const attempts: LaneAttempt<Result>[] = [];
  const inFlight = new Set<Promise<void>>();
  let maximumConcurrent = 0;
  let primaryActive = 0,
    replayActive = 0,
    maximumReplayConcurrent = 0;
  try {
    for (let index = 0; index < count; index++) {
      const scheduled = start + BigInt(index * intervalMs) * 1_000_000n;
      if (!signal.aborted) {
        deadlineWaits.called();
        if (deadlineWaits.actualTimerEvidence)
          await waitUntil(scheduled, signal, deadlineWaits, index);
        else {
          deadlineWaits.unobserved();
          await clock.until(scheduled, signal);
        }
      }
      const endWake = begin?.("producer.wake");
      let wokeMs: number;
      try {
        wokeMs = msSinceStart();
      } finally {
        endWake?.();
      }
      const preparationStartedMs = msSinceStart();
      const endPreparation = begin?.("producer.prepare");
      let input: ReturnType<typeof make>;
      try {
        input = make(index);
      } finally {
        endPreparation?.();
      }
      const prepared = clock.now();
      const entry: LaneAttempt<Result> = {
        index,
        role: input.role,
        scheduledMs: index * intervalMs,
        wokeMs,
        preparationStartedMs,
        preparedMs: Number(prepared - start) / 1e6,
        preparedNs: prepared.toString(),
        decisionMs: 0,
        dispatchReturnedMs: null,
        startedMs: null,
        startedNs: null,
        finishedNs: null,
        finishedMs: null,
        eventId: input.eventId ?? null,
        reason: null,
        sha256: input.sha256,
        bytes: input.bytes,
        result: null,
      };
      attempts.push(entry);
      entry.decisionMs = msSinceStart();
      if (signal.aborted) entry.reason = "aborted";
      else if (entry.decisionMs - entry.scheduledMs >= intervalMs)
        entry.reason = "missed-absolute-slot";
      else if (input.replay ? replayActive >= 32 : primaryActive >= concurrency)
        entry.reason = "concurrency-limit";
      else if (input.prerequisite) entry.reason = input.prerequisite;
      else {
        const launched = clock.now();
        entry.startedNs = launched.toString();
        entry.startedMs = Number(launched - start) / 1e6;
        if (input.replay) replayActive++;
        else primaryActive++;
        maximumConcurrent = Math.max(maximumConcurrent, primaryActive);
        maximumReplayConcurrent = Math.max(
          maximumReplayConcurrent,
          replayActive,
        );
        const endDispatch = begin?.("producer.dispatch");
        let task: Promise<void>;
        try {
          task = (async () => {
            try {
              entry.result = await input.run();
            } catch (error) {
              entry.reason = `attempt-error: ${errorText(error)}`;
            } finally {
              const finished = clock.now();
              entry.finishedNs = finished.toString();
              entry.finishedMs = Number(finished - start) / 1e6;
              if (input.replay) replayActive--;
              else primaryActive--;
            }
          })();
        } finally {
          endDispatch?.();
        }
        entry.dispatchReturnedMs = msSinceStart();
        inFlight.add(task);
        void task.finally(() => inFlight.delete(task));
      }
    }
  } catch (error) {
    // Preserve the original rejection and its identity. Failed/aborted waits
    // are not successful lane reports; extensible errors can carry evidence.
    try {
      if (
        error !== null &&
        (typeof error === "object" || typeof error === "function") &&
        Object.isExtensible(error)
      )
        Object.defineProperty(error, "deadlineWaits", {
          value: deadlineWaits.report(),
          configurable: true,
        });
    } catch {
      /* Diagnostic attachment must never mask the original failure. */
    }
    throw error;
  } finally {
    await Promise.all(inFlight);
  }
  return {
    planned: count,
    started: attempts.filter((entry) => entry.startedMs !== null).length,
    unissued: attempts.filter((entry) => entry.startedMs === null).length,
    maximumConcurrent,
    maximumReplayConcurrent,
    replayConcurrencyLimit: 32,
    concurrencyLimit: concurrency,
    intervalMs,
    deadlineWaits: deadlineWaits.report(),
    producerTiming: {
      cpuMicroseconds: process.cpuUsage(cpuStart),
      wakeDelay: distribution(
        attempts.map((attempt) => attempt.wokeMs - attempt.scheduledMs),
      ),
      preparation: distribution(
        attempts.map(
          (attempt) => attempt.preparedMs - attempt.preparationStartedMs,
        ),
      ),
      synchronousDispatch: distribution(
        attempts.flatMap((attempt) =>
          attempt.startedMs === null || attempt.dispatchReturnedMs === null
            ? []
            : [attempt.dispatchReturnedMs - attempt.startedMs],
        ),
      ),
      missedSlots: diagnoseProducer(attempts, intervalMs),
      interpretation:
        "Wake, preparation, decision, and synchronous dispatch use process.hrtime.bigint. Late wake alone does not identify OS contention, GC, or callback work. CPU totals cover the process including other threads, not an isolated lane. Every fixed slot is retained; none is backfilled.",
    },
    attempts,
  };
}

export type LaneReport<Result> = Awaited<ReturnType<typeof fixedLane<Result>>>;
export type UdsPreparation = {
  elapsedMs: number;
  wireFrames: number;
  retainedWireBytes: number;
  readyNs: string;
  threadId: number;
};
export type UdsWorkerMessage =
  | { type: "ready"; preparation: UdsPreparation }
  | { type: "armed"; startNs: string; atNs: string }
  | {
      type: "done";
      lane: LaneReport<WireResult>;
      completedNs: string;
      trace: TraceReport;
    }
  | { type: "failed"; error: string };
export type UdsCommand =
  | { type: "start"; startNs: string }
  | { type: "cancel" };
export type UdsReport = LaneReport<WireResult> & {
  trace: TraceReport;
  execution: {
    mode: "worker-thread";
    processId: number;
    threadId: number;
    readyNs: string;
    readyJoinedNs: string;
    armedNs: string;
    startNs: string;
    completedNs: string;
    joinedNs: string;
    exitCode: number;
  };
};
export type UdsProducer = {
  preparation: UdsPreparation;
  result: Promise<UdsReport>;
  start(start: bigint): Promise<void>;
  cancel(): Promise<void>;
};

function pending<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // Failure can precede the caller joining readiness or arming.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export async function prepareUdsProducer(
  endpoint: Endpoint,
  options: { workerUrl: URL; signal: AbortSignal },
): Promise<UdsProducer> {
  options.signal.throwIfAborted();
  const worker = new Worker(options.workerUrl, {
    workerData: endpoint,
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
    },
  });
  const ready = pending<UdsPreparation>();
  const armed = pending<void>();
  const result = pending<UdsReport>();
  const exited = pending<void>();
  let failure: Error | undefined;
  let preparation: UdsPreparation | undefined;
  let done: Extract<UdsWorkerMessage, { type: "done" }> | undefined;
  let startNs: string | undefined;
  let armedNs: string | undefined;
  let readyJoinedNs: string | undefined;
  let exitCode: number | undefined;
  let stopping: Promise<void> | undefined;
  let runTimeout: ReturnType<typeof setTimeout> | undefined;
  const reject = (error: Error): void => {
    failure ??= error;
    ready.reject(failure);
    armed.reject(failure);
    result.reject(failure);
  };
  const cancel = (): Promise<void> => {
    if (exitCode !== undefined) return exited.promise;
    reject(new Error("UDS producer cancelled"));
    if (!stopping) {
      worker.postMessage({ type: "cancel" } satisfies UdsCommand);
      stopping = (async () => {
        const timeout = setTimeout(() => {
          void worker.terminate();
        }, 1000);
        try {
          await exited.promise;
        } finally {
          clearTimeout(timeout);
        }
      })();
    }
    return stopping;
  };
  const fail = (error: Error): void => {
    reject(error);
    void cancel();
  };
  const onAbort = (): void => fail(new Error("UDS producer aborted"));
  options.signal.addEventListener("abort", onAbort, { once: true });
  const readyTimeout = setTimeout(
    () => fail(new Error("UDS producer readiness exceeded 5s")),
    5000,
  );
  worker.on("error", fail);
  worker.on("message", (message: UdsWorkerMessage) => {
    if (failure) return;
    switch (message.type) {
      case "ready":
        if (
          preparation ||
          message.preparation.wireFrames !== udsContract.count
        ) {
          fail(new Error("Invalid UDS worker readiness"));
          break;
        }
        preparation = message.preparation;
        clearTimeout(readyTimeout);
        ready.resolve(preparation);
        break;
      case "armed":
        if (
          !preparation ||
          !startNs ||
          armedNs ||
          message.startNs !== startNs
        ) {
          fail(new Error("Invalid UDS worker arm acknowledgement"));
          break;
        }
        armedNs = message.atNs;
        armed.resolve();
        break;
      case "done":
        if (
          !armedNs ||
          done ||
          message.lane.attempts.length !== udsContract.count
        ) {
          fail(new Error("Invalid UDS worker result"));
          break;
        }
        done = message;
        break;
      case "failed":
        fail(new Error(`UDS worker: ${message.error}`));
        break;
      default:
        fail(new Error("Unexpected UDS worker message"));
    }
  });
  worker.once("exit", (code) => {
    exitCode = code;
    clearTimeout(readyTimeout);
    if (runTimeout) clearTimeout(runTimeout);
    options.signal.removeEventListener("abort", onAbort);
    if (
      !failure &&
      code === 0 &&
      preparation &&
      readyJoinedNs &&
      armedNs &&
      startNs &&
      done
    ) {
      result.resolve({
        ...done.lane,
        trace: done.trace,
        execution: {
          mode: "worker-thread",
          processId: process.pid,
          threadId: preparation.threadId,
          readyNs: preparation.readyNs,
          readyJoinedNs,
          armedNs,
          startNs,
          completedNs: done.completedNs,
          joinedNs: now().toString(),
          exitCode: code,
        },
      });
    } else
      reject(
        failure ??
          new Error(`UDS worker exited before a complete result (${code})`),
      );
    exited.resolve();
  });
  if (options.signal.aborted) onAbort();
  try {
    const preparation = await ready.promise;
    readyJoinedNs = now().toString();
    return {
      preparation,
      result: result.promise,
      async start(start) {
        if (failure) throw failure;
        if (startNs) throw new Error("UDS producer may only be armed once");
        startNs = start.toString();
        // Lifecycle watchdog only; slot deadlines and the 500ms socket watchdog
        // are unchanged. The caller's fixed start is never shifted.
        runTimeout = setTimeout(
          () =>
            fail(new Error("UDS producer did not exit within 20s of arming")),
          20_000,
        );
        worker.postMessage({ type: "start", startNs } satisfies UdsCommand);
        await armed.promise;
      },
      cancel,
    };
  } catch (error) {
    await cancel();
    throw error;
  }
}
