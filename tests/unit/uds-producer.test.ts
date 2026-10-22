import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Endpoint } from "../../src/integration/claude/protocol.ts";
import {
  fixedLane,
  prepareUdsProducer,
  prepareWires,
  sendWire,
  udsContract,
  type DeadlineWaitReport,
  type ProducerClock,
  type UdsProducer,
} from "../profiles/uds-producer.ts";

const workerUrl = new URL("../profiles/uds-worker.ts", import.meta.url);
const endpoint: Endpoint = {
  version: 1,
  epoch: "00000000-0000-4000-8000-000000000000",
  token: "0".repeat(64),
  socketPath: "/not-an-existing-watchling-test-socket",
};
const signal = (): AbortSignal => new AbortController().signal;

const timersPromises = createRequire(import.meta.url)(
  "node:timers/promises",
) as typeof import("node:timers/promises");
function replaceDelay(context: TestContext, replacement: unknown): void {
  const original = Object.getOwnPropertyDescriptor(
    timersPromises,
    "setTimeout",
  )!;
  Object.defineProperty(timersPromises, "setTimeout", {
    ...original,
    value: replacement,
  });
  syncBuiltinESMExports();
  context.after(() => {
    Object.defineProperty(timersPromises, "setTimeout", original);
    syncBuiltinESMExports();
  });
}
function timerFixture(
  context: TestContext,
  initial: bigint,
  onDelay?: (milliseconds: number, index: number, signal?: AbortSignal) => void,
): { delays: number[]; advance(nanoseconds: bigint): void } {
  let current = initial;
  const delays: number[] = [];
  context.mock.method(process.hrtime, "bigint", () => current);
  replaceDelay(
    context,
    async (
      milliseconds: number,
      _value: unknown,
      options: { signal?: AbortSignal },
    ) => {
      const index = delays.length;
      delays.push(milliseconds);
      if (onDelay) onDelay(milliseconds, index, options.signal);
      else current += BigInt(Math.round(milliseconds * 1e6));
    },
  );
  return {
    delays,
    advance(nanoseconds: bigint) {
      current += nanoseconds;
    },
  };
}
function waitField(
  report: DeadlineWaitReport,
  row: number[],
  column: DeadlineWaitReport["columns"][number],
): number {
  return row[report.columns.indexOf(column)]!;
}
function makeWaitInput(index: number) {
  return {
    role: "fixture",
    bytes: 8192,
    sha256: null,
    async run() {
      return index;
    },
  };
}

function clock(
  start: bigint,
  delays: Readonly<Record<number, number>> = {},
): ProducerClock {
  let current = start;
  return {
    now: () => current,
    async until(deadline, abort) {
      abort.throwIfAborted();
      const slot = Number((deadline - start) / 5_000_000n);
      const wake = deadline + BigInt(delays[slot] ?? 0) * 1_000_000n;
      if (wake > current) current = wake;
    },
  };
}

test("all 2000 fixed UDS slots retain exact bytes, hashes, identities and 8/1/1 mix", async () => {
  const frames = prepareWires(endpoint);
  const start = 1_000_000_000n;
  const issued: number[] = [];
  const lane = await fixedLane(
    udsContract.count,
    udsContract.intervalMs,
    udsContract.concurrency,
    start,
    (index) => {
      const frame = frames[index]!;
      return {
        role: frame.role,
        eventId: frame.eventId,
        bytes: frame.bytes.length,
        sha256: frame.sha256,
        async run() {
          issued.push(index);
          return index;
        },
      };
    },
    signal(),
    clock(start),
  );
  assert.equal(lane.started, 2000);
  assert.equal(lane.unissued, 0);
  assert.deepEqual(
    issued,
    Array.from({ length: 2000 }, (_, index) => index),
  );
  assert.equal(new Set(frames.map((frame) => frame.eventId)).size, 2000);
  const mix: Record<string, number> = {};
  for (const [index, frame] of frames.entries()) {
    const kind = index % 10;
    assert.equal(frame.bytes.length, kind === 8 ? 8193 : 8192);
    assert.equal(frame.bytes.at(-1), 10);
    assert.equal(
      frame.sha256,
      createHash("sha256").update(frame.bytes).digest("hex"),
    );
    const parsed = JSON.parse(frame.bytes.toString()) as {
      epoch: string;
      token: string;
      eventId: string;
    };
    assert.equal(parsed.epoch, endpoint.epoch);
    assert.equal(parsed.eventId, frame.eventId);
    assert.equal(parsed.token === endpoint.token, kind !== 9);
    assert.equal(lane.attempts[index]!.scheduledMs, index * 5);
    assert.equal(
      lane.attempts[index]!.startedNs,
      String(start + BigInt(index * 5) * 1_000_000n),
    );
    mix[frame.role] = (mix[frame.role] ?? 0) + 1;
  }
  assert.deepEqual(mix, {
    "authenticated-valid": 1600,
    oversized: 200,
    "wrong-token": 200,
  });
  assert.equal(lane.attempts.at(-1)!.scheduledMs + lane.intervalMs, 10_000);
  assert.equal(lane.deadlineWaits.capability.actualTimerEvidence, false);
  assert.equal(lane.deadlineWaits.capability.reason, "injected-clock-or-wait");
  assert.equal(lane.deadlineWaits.clock.source, "injected");
  assert.equal(lane.deadlineWaits.counts.unobservedWaits, 2000);
  assert.equal(lane.deadlineWaits.counts.requests, 0);
  assert.deepEqual(lane.deadlineWaits.records, []);
});

test("actual deadline wait records early resumptions and retries the same absolute target", async (context) => {
  const start = 1_000_000_000n;
  const fixture = timerFixture(
    context,
    start - 10_000_000n,
    (milliseconds, index) => {
      fixture.advance(index === 0 ? 4_000_000n : BigInt(milliseconds * 1e6));
    },
  );
  const lane = await fixedLane(2, 5, 32, start, makeWaitInput, signal());
  const report = lane.deadlineWaits;
  assert.equal(lane.started, 2);
  assert.deepEqual(
    lane.attempts.map((attempt) => attempt.startedMs),
    [0, 5],
  );
  assert.deepEqual(fixture.delays, [10, 6, 5]);
  assert.equal(report.capability.actualTimerEvidence, true);
  assert.equal(report.clock.source, "process.hrtime.bigint");
  assert.equal(report.clock.laneStartNs, start.toString());
  assert.deepEqual(report.records, [
    [1, 0, 0, -10, 10, -6, report.outcomes.fulfilled],
    [2, 0, 0, -6, 6, 0, report.outcomes.fulfilled],
    [3, 1, 5, 0, 5, 5, report.outcomes.fulfilled],
  ]);
  assert.equal(report.counts.waitCalls, 2);
  assert.equal(report.counts.requests, 3);
  assert.equal(report.counts.fulfilled, 3);
  assert.equal(report.counts.overflow, 0);
  assert.ok(report.records.every((row) => row.every(Number.isFinite)));
  assert.match(report.interpretation, /not the exact timer callback/);
});

test("a late promise continuation remains failed slots rather than a shifted schedule", async (context) => {
  const start = 1_000_000_000n;
  const fixture = timerFixture(
    context,
    start - 10_000_000n,
    (milliseconds, index) => {
      fixture.advance(index === 0 ? 25_000_000n : BigInt(milliseconds * 1e6));
    },
  );
  const lane = await fixedLane(5, 5, 32, start, makeWaitInput, signal());
  const report = lane.deadlineWaits;
  assert.equal(lane.started, 2);
  assert.equal(lane.unissued, 3);
  assert.deepEqual(
    lane.attempts.map((attempt) => attempt.scheduledMs),
    [0, 5, 10, 15, 20],
  );
  assert.ok(
    lane.attempts
      .slice(0, 3)
      .every((attempt) => attempt.reason === "missed-absolute-slot"),
  );
  assert.deepEqual(
    lane.attempts.slice(3).map((attempt) => attempt.startedMs),
    [15, 20],
  );
  assert.deepEqual(report.records, [
    [1, 0, 0, -10, 10, 15, report.outcomes.fulfilled],
    [2, 4, 20, 15, 5, 20, report.outcomes.fulfilled],
  ]);
});

test("deadline evidence retains the original capped and minimum delay arguments", async (context) => {
  const fixture = timerFixture(context, 0n);
  const long = await fixedLane(
    1,
    5,
    32,
    2_500_500_000n,
    makeWaitInput,
    signal(),
  );
  assert.deepEqual(fixture.delays, [1000, 1000, 500.5]);
  assert.deepEqual(
    long.deadlineWaits.records.map((row) =>
      waitField(long.deadlineWaits, row, "originalDelayMs"),
    ),
    fixture.delays,
  );
  const short = await fixedLane(
    1,
    5,
    32,
    2_501_000_000n,
    makeWaitInput,
    signal(),
  );
  assert.equal(fixture.delays.at(-1), 1);
  assert.equal(
    waitField(
      short.deadlineWaits,
      short.deadlineWaits.records[0]!,
      "originalDelayMs",
    ),
    1,
  );
  assert.equal(short.attempts[0]!.startedMs, 0.5);
});

test("deadline wait storage overflows explicitly without stopping waits or backfilling", async (context) => {
  const fixture = timerFixture(context, 0n, () => fixture.advance(1_000_000n));
  const lane = await fixedLane(
    1,
    5,
    32,
    8_195_000_000n,
    makeWaitInput,
    signal(),
  );
  const report = lane.deadlineWaits;
  assert.equal(lane.started, 1);
  assert.equal(lane.attempts[0]!.startedMs, 0);
  assert.equal(report.capacity, 8192);
  assert.equal(report.records.length, 8192);
  assert.equal(report.counts.requests, 8195);
  assert.equal(report.counts.fulfilled, 8195);
  assert.equal(report.counts.overflow, 3);
  assert.equal(fixture.delays.length, 8195);
  assert.equal(report.exhausted, true);
  assert.equal(
    report.preallocatedBytes,
    8192 * report.columns.length * Float64Array.BYTES_PER_ELEMENT,
  );
  assert.equal(waitField(report, report.records.at(-1)!, "sequence"), 8192);
  assert.ok(
    report.records.every(
      (row) => waitField(report, row, "outcome") === report.outcomes.fulfilled,
    ),
  );
});

test("aborted timer waits preserve rejection identity with bounded continuation evidence", async (context) => {
  const start = 1_000_000_000n;
  const abort = new AbortController();
  const failure = new Error("Expected wait abort");
  const fixture = timerFixture(context, start - 10_000_000n, () => {
    fixture.advance(2_000_000n);
    abort.abort(failure);
    throw failure;
  });
  await assert.rejects(
    fixedLane(2, 5, 32, start, makeWaitInput, abort.signal),
    (error: unknown) => {
      assert.equal(error, failure);
      const report = Reflect.get(
        failure,
        "deadlineWaits",
      ) as DeadlineWaitReport;
      assert.deepEqual(report.records, [
        [1, 0, 0, -10, 10, -8, report.outcomes.aborted],
      ]);
      assert.equal(report.counts.aborted, 1);
      assert.equal(report.counts.requests, 1);
      assert.equal(report.counts.fulfilled, 0);
      assert.equal(
        Object.getOwnPropertyDescriptor(failure, "deadlineWaits")!.enumerable,
        false,
      );
      return true;
    },
  );
});

test("non-abort wait failure stays rejected even when its error cannot carry evidence", async (context) => {
  const failure = Object.freeze(new Error("Frozen wait error"));
  timerFixture(context, 0n, () => {
    throw failure;
  });
  await assert.rejects(
    fixedLane(1, 5, 32, 10_000_000n, makeWaitInput, signal()),
    (error: unknown) => {
      assert.equal(error, failure);
      return true;
    },
  );
  assert.equal(Object.hasOwn(failure, "deadlineWaits"), false);
});

test("a rejected timer promise is distinguished from an aborted signal", async (context) => {
  const failure = new Error("Timer promise rejected");
  timerFixture(context, 0n, () => {
    throw failure;
  });
  await assert.rejects(
    fixedLane(1, 5, 32, 10_000_000n, makeWaitInput, signal()),
    (error: unknown) => {
      assert.equal(error, failure);
      const report = Reflect.get(
        failure,
        "deadlineWaits",
      ) as DeadlineWaitReport;
      assert.equal(
        waitField(report, report.records[0]!, "outcome"),
        report.outcomes.rejected,
      );
      assert.equal(report.counts.rejected, 1);
      assert.equal(report.counts.aborted, 0);
      return true;
    },
  );
});

test("unavailable timer APIs do not create synthetic timer evidence or mask failure", async (context) => {
  context.mock.method(process.hrtime, "bigint", () => 0n);
  replaceDelay(context, undefined);
  await assert.rejects(
    fixedLane(1, 5, 32, 10_000_000n, makeWaitInput, signal()),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      const report = Reflect.get(error, "deadlineWaits") as DeadlineWaitReport;
      assert.equal(report.capability.actualTimerEvidence, false);
      assert.equal(report.capability.reason, "timer-api-unavailable");
      assert.equal(report.clock.source, "process.hrtime.bigint");
      assert.equal(report.counts.unobservedWaits, 1);
      assert.equal(report.counts.requests, 0);
      assert.deepEqual(report.records, []);
      return true;
    },
  );
});

test("already expired targets are not invented timer requests", async (context) => {
  const fixture = timerFixture(context, 1_000_000_000n);
  const lane = await fixedLane(3, 5, 32, 0n, makeWaitInput, signal());
  assert.equal(lane.started, 0);
  assert.equal(lane.unissued, 3);
  assert.deepEqual(fixture.delays, []);
  assert.equal(lane.deadlineWaits.capability.actualTimerEvidence, true);
  assert.equal(lane.deadlineWaits.counts.waitCalls, 3);
  assert.equal(lane.deadlineWaits.counts.requests, 0);
  assert.deepEqual(lane.deadlineWaits.records, []);
});

test("expired absolute slots remain unissued instead of shifting or backfilling", async () => {
  const start = 1_000_000_000n;
  const issued: number[] = [];
  const lane = await fixedLane(
    8,
    5,
    32,
    start,
    (index) => ({
      role: "fixture",
      bytes: 8192,
      sha256: null,
      async run() {
        issued.push(index);
      },
    }),
    signal(),
    clock(start, { 1: 10 }),
  );
  assert.deepEqual(issued, [0, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    lane.attempts.map((attempt) => attempt.scheduledMs),
    [0, 5, 10, 15, 20, 25, 30, 35],
  );
  assert.deepEqual(
    lane.attempts
      .filter((attempt) => attempt.reason !== null)
      .map((attempt) => [attempt.index, attempt.reason]),
    [
      [1, "missed-absolute-slot"],
      [2, "missed-absolute-slot"],
    ],
  );
  assert.equal(lane.attempts[3]!.startedNs, String(start + 15_000_000n));
});

test("the shared scheduler refuses a 33rd client without lowering or backfilling load", async () => {
  const start = 1_000_000_000n;
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let scheduled!: () => void;
  const allScheduled = new Promise<void>((done) => {
    scheduled = done;
  });
  let calls = 0;
  const pending = fixedLane(
    40,
    5,
    32,
    start,
    (index) => {
      if (index === 39) scheduled();
      return {
        role: "fixture",
        bytes: 8192,
        sha256: null,
        run() {
          calls++;
          return held;
        },
      };
    },
    signal(),
    clock(start),
  );
  await allScheduled;
  assert.equal(calls, 32);
  release();
  const lane = await pending;
  assert.equal(lane.maximumConcurrent, 32);
  assert.equal(lane.started, 32);
  assert.equal(lane.unissued, 8);
  assert.ok(
    lane.attempts
      .slice(32)
      .every((attempt) => attempt.reason === "concurrency-limit"),
  );
});

async function stalledPeer() {
  const directory = await mkdtemp(join(tmpdir(), "watchling-uds-unit-"));
  const path = join(directory, "socket");
  const peers = new Set<Socket>();
  let accepted!: () => void;
  const connected = new Promise<void>((done) => {
    accepted = done;
  });
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.pause();
    accepted();
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(path, done);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    connected,
    async close() {
      for (const socket of peers) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("socket cancellation closes and awaits an active client", async () => {
  const peer = await stalledPeer();
  const sockets = new Set<Socket>();
  const abort = new AbortController();
  try {
    const pending = sendWire(
      Buffer.alloc(8192, 32),
      peer.path,
      sockets,
      abort.signal,
    );
    await peer.connected;
    abort.abort();
    const result = await pending;
    assert.equal(result.error, "aborted");
    assert.equal(sockets.size, 0);
  } finally {
    abort.abort();
    await peer.close();
  }
});

test("the existing 500ms socket watchdog is retained for a stalled peer", async () => {
  const peer = await stalledPeer();
  const sockets = new Set<Socket>();
  const abort = new AbortController();
  try {
    const result = await sendWire(
      Buffer.alloc(8192, 32),
      peer.path,
      sockets,
      abort.signal,
    );
    assert.equal(result.connected, true);
    assert.equal(result.error, "500ms client watchdog");
    assert.equal(sockets.size, 0);
  } finally {
    abort.abort();
    await peer.close();
  }
});

test("worker readiness is joined before arming and cancellation joins an idle worker", async () => {
  const producer = await prepareUdsProducer(endpoint, {
    workerUrl,
    signal: signal(),
  });
  try {
    assert.equal(producer.preparation.wireFrames, 2000);
    assert.equal(producer.preparation.retainedWireBytes, 16_384_200);
    assert.ok(producer.preparation.threadId > 0);
    await producer.cancel();
    await producer.cancel();
    await assert.rejects(producer.result, /cancelled/);
    await assert.rejects(producer.start(process.hrtime.bigint()), /cancelled/);
  } finally {
    await producer.cancel();
  }
});

test("aborting during worker preparation rejects only after worker shutdown is joined", async () => {
  const abort = new AbortController();
  const pending = prepareUdsProducer(endpoint, {
    workerUrl,
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(pending, /aborted/);
});

test("a worker startup failure rejects instead of leaving readiness pending", async () => {
  await assert.rejects(
    prepareUdsProducer(endpoint, {
      workerUrl: new URL("../profiles/missing-uds-worker.ts", import.meta.url),
      signal: signal(),
    }),
    /Cannot find|not found|ENOENT/,
  );
});

test("cancelling an armed worker interrupts its wait for the unchanged absolute start", async () => {
  const abort = new AbortController();
  const producer = await prepareUdsProducer(endpoint, {
    workerUrl,
    signal: abort.signal,
  });
  try {
    await producer.start(process.hrtime.bigint() + 1_000_000_000n);
    abort.abort();
    await producer.cancel();
    await assert.rejects(producer.result, /aborted/);
  } finally {
    await producer.cancel();
  }
});

test("cancelling an active worker closes its clients and joins shutdown", async () => {
  const peer = await stalledPeer();
  const abort = new AbortController();
  let producer: UdsProducer | undefined;
  try {
    producer = await prepareUdsProducer(
      { ...endpoint, socketPath: peer.path },
      { workerUrl, signal: abort.signal },
    );
    await producer.start(process.hrtime.bigint() - 9_500_000_000n);
    await Promise.race([
      peer.connected,
      producer.result.then(() => {
        throw new Error("Worker finished without opening a client");
      }),
    ]);
    abort.abort();
    await producer.cancel();
    await assert.rejects(producer.result, /aborted/);
  } finally {
    await producer?.cancel();
    await peer.close();
  }
});

test("an expired worker schedule reports all 2000 misses and resolves only after exit", async () => {
  const producer = await prepareUdsProducer(endpoint, {
    workerUrl,
    signal: signal(),
  });
  try {
    const start = process.hrtime.bigint() - 11_000_000_000n;
    await producer.start(start);
    const result = await producer.result;
    assert.equal(result.planned, 2000);
    assert.equal(result.started, 0);
    assert.equal(result.unissued, 2000);
    assert.equal(result.attempts.length, 2000);
    assert.ok(
      result.attempts.every(
        (attempt) => attempt.reason === "missed-absolute-slot",
      ),
    );
    assert.equal(result.execution.startNs, start.toString());
    assert.equal(result.execution.exitCode, 0);
    assert.ok(
      BigInt(result.execution.readyNs) <=
        BigInt(result.execution.readyJoinedNs),
    );
    assert.ok(
      BigInt(result.execution.readyJoinedNs) <=
        BigInt(result.execution.armedNs),
    );
    assert.ok(
      BigInt(result.execution.completedNs) <= BigInt(result.execution.joinedNs),
    );
    await assert.rejects(producer.start(start), /only be armed once/);
  } finally {
    await producer.cancel();
  }
});

test("UDS dispatch progresses on the worker while the calling thread is synchronously blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-uds-worker-"));
  let producer: UdsProducer | undefined;
  try {
    producer = await prepareUdsProducer(
      { ...endpoint, socketPath: join(directory, "missing-socket") },
      { workerUrl, signal: signal() },
    );
    // Keep only the last 300ms of the real fixed schedule in the future. Earlier
    // slots must remain misses, not become a shortened/backfilled load profile.
    const start = process.hrtime.bigint() - 9_700_000_000n;
    await producer.start(start);
    const callerBlocked = process.hrtime.bigint();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    const callerResumed = process.hrtime.bigint();
    const result = await producer.result;
    assert.equal(result.planned, 2000);
    assert.ok(result.unissued >= 1940);
    assert.ok(result.maximumConcurrent <= 32);
    assert.ok(
      result.attempts.some(
        (attempt) =>
          attempt.startedNs !== null &&
          BigInt(attempt.startedNs) >= callerBlocked &&
          BigInt(attempt.startedNs) < callerResumed,
      ),
    );
    assert.equal(result.execution.startNs, start.toString());
  } finally {
    await producer?.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});
