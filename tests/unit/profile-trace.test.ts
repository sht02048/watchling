import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type {
  PerformanceEntry,
  PerformanceObserver,
  PerformanceObserverCallback,
  PerformanceObserverEntryList,
} from "node:perf_hooks";
import { createProfileTrace, type TraceReport } from "../profiles/trace.ts";
import { fixedLane, type ProducerClock } from "../profiles/uds-producer.ts";

const perfHooks = createRequire(import.meta.url)(
  "node:perf_hooks",
) as typeof import("node:perf_hooks");

function observerFixture(
  context: TestContext,
  options: {
    supported?: boolean;
    failObserve?: boolean;
    pending?: PerformanceEntry[];
  } = {},
) {
  let deliver = (_entries: PerformanceEntry[]): void => {
    throw new Error("Observer not constructed");
  };
  let disconnects = 0;
  let observations = 0;
  const original = Object.getOwnPropertyDescriptor(
    perfHooks,
    "PerformanceObserver",
  )!;
  class Observer {
    static supportedEntryTypes = options.supported === false ? [] : ["gc"];
    constructor(callback: PerformanceObserverCallback) {
      deliver = (entries) =>
        callback(
          { getEntries: () => entries } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
    }
    observe() {
      observations++;
      if (options.failObserve) throw new Error("Unavailable GC observation");
    }
    takeRecords() {
      return options.pending ?? [];
    }
    disconnect() {
      disconnects++;
    }
  }
  Object.defineProperty(perfHooks, "PerformanceObserver", {
    ...original,
    value: Observer,
  });
  syncBuiltinESMExports();
  context.after(() => {
    Object.defineProperty(perfHooks, "PerformanceObserver", original);
    syncBuiltinESMExports();
  });
  return {
    deliver: (entries: PerformanceEntry[]) => deliver(entries),
    disconnects: () => disconnects,
    observations: () => observations,
  };
}

function field(
  report: TraceReport,
  row: number[],
  name: TraceReport["columns"][number],
): number {
  return row[report.columns.indexOf(name)]!;
}
function gcEntry(
  startTime: number,
  duration: number,
  kind = 1,
  flags = 2,
): PerformanceEntry {
  return {
    entryType: "gc",
    startTime,
    duration,
    name: "never-retain-this-entry-name",
    detail: { kind, flags, payload: "never-retain-this-detail" },
  } as unknown as PerformanceEntry;
}

test("nested spans use detached methods and inclusive current-thread CPU deltas", (context) => {
  observerFixture(context, { supported: false });
  let time = 10,
    user = 100,
    system = 20;
  let cpuSamples = 0;
  const { begin, report, close } = createProfileTrace({
    capacity: 4,
    clock: () => time,
    threadCpu: () => {
      cpuSamples++;
      return { user, system };
    },
  });
  const outer = begin("native.dispatch");
  time = 12;
  user = 110;
  system = 23;
  const inner = begin("native.prepare");
  time = 15;
  user = 120;
  system = 25;
  inner();
  time = 20;
  user = 140;
  system = 28;
  outer();
  outer();
  close();
  const result = report();
  assert.deepEqual(
    result.records.map((row) => field(result, row, "durationMs")),
    [10, 3],
  );
  assert.deepEqual(
    result.records.map((row) => field(result, row, "threadUserUs")),
    [40, 10],
  );
  assert.deepEqual(
    result.records.map((row) => field(result, row, "threadSystemUs")),
    [8, 2],
  );
  assert.deepEqual(
    result.records.map((row) => field(result, row, "threadUserStartUs")),
    [100, 110],
  );
  assert.deepEqual(
    result.records.map((row) => field(result, row, "threadSystemStartUs")),
    [20, 23],
  );
  assert.equal(
    cpuSamples,
    5,
    "Only the existing capability/begin/end samples are used",
  );
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.counts.activeSpans, 0);
  assert.equal(result.counts.duplicateEnds, 1);
  assert.equal(result.capabilities.threadCpu.source, "injected");
  assert.equal(result.capabilities.threadCpu.status, "supported");
  assert.ok(
    BigInt(result.clock.hrtimeBeforeNs) <= BigInt(result.clock.hrtimeAfterNs),
  );
});

test("absolute CPU endpoints measure the gap between spans without summing nested work", (context) => {
  observerFixture(context, { supported: false });
  let time = 10,
    user = 100,
    system = 10,
    samples = 0;
  const trace = createProfileTrace({
    capacity: 3,
    clock: () => time,
    threadCpu: () => {
      samples++;
      return { user, system };
    },
  });
  const outer = trace.begin("outer");
  time = 12;
  user = 120;
  system = 12;
  const inner = trace.begin("inner");
  time = 13;
  user = 140;
  system = 15;
  inner();
  time = 20;
  user = 160;
  system = 18;
  outer();
  time = 30;
  user = 220;
  system = 22;
  const next = trace.begin("next");
  time = 32;
  user = 230;
  system = 23;
  next();
  trace.close();
  const report = trace.report();
  const first = report.records[0]!,
    last = report.records[2]!;
  const firstEndingUser =
    field(report, first, "threadUserStartUs") +
    field(report, first, "threadUserUs");
  const firstEndingSystem =
    field(report, first, "threadSystemStartUs") +
    field(report, first, "threadSystemUs");
  assert.deepEqual([firstEndingUser, firstEndingSystem], [160, 18]);
  assert.deepEqual(
    [
      field(report, last, "threadUserStartUs") - firstEndingUser,
      field(report, last, "threadSystemStartUs") - firstEndingSystem,
    ],
    [60, 4],
  );
  assert.equal(samples, 7);
  assert.equal(report.records.length, 3);
  assert.equal(
    report.limits.preallocatedBytes,
    3 * 12 * Float64Array.BYTES_PER_ELEMENT,
  );
  assert.ok(report.records.every((row) => row.every(Number.isFinite)));
});

test("CPU starts are copied numerically even when the supplied sampler reuses an object", (context) => {
  observerFixture(context, { supported: false });
  const counters = { user: 100, system: 10 };
  let samples = 0;
  const trace = createProfileTrace({
    capacity: 1,
    threadCpu: () => {
      samples++;
      return counters;
    },
  });
  const end = trace.begin("stage");
  counters.user = 150;
  counters.system = 14;
  end();
  trace.close();
  const report = trace.report(),
    row = report.records[0]!;
  assert.equal(field(report, row, "threadUserStartUs"), 100);
  assert.equal(field(report, row, "threadSystemStartUs"), 10);
  assert.equal(field(report, row, "threadUserUs"), 50);
  assert.equal(field(report, row, "threadSystemUs"), 4);
  assert.equal(samples, 3);
});

test("caller errors can unwind a span in finally without hiding the exception", (context) => {
  observerFixture(context, { supported: false });
  let time = 1;
  const trace = createProfileTrace({
    clock: () => time,
    threadCpu: () => ({ user: 0, system: 0 }),
  });
  try {
    assert.throws(() => {
      const end = trace.begin("fixture.callback");
      try {
        time = 8;
        throw new Error("Expected caller failure");
      } finally {
        end();
      }
    }, /Expected caller failure/);
    const report = trace.report();
    assert.equal(field(report, report.records[0]!, "durationMs"), 7);
    assert.equal(field(report, report.records[0]!, "flags"), 0);
    assert.equal(report.counts.activeSpans, 0);
  } finally {
    trace.close();
  }
});

test("ring overwrite cannot let a stale reentrant completion corrupt a newer span", (context) => {
  observerFixture(context, { supported: false });
  let time = 0;
  const trace = createProfileTrace({
    capacity: 2,
    clock: () => time++,
    threadCpu: () => ({ user: 0, system: 0 }),
  });
  const stale = trace.begin("outer");
  trace.begin("inner")();
  trace.begin("newer")();
  const before = trace.report().records;
  stale();
  const report = trace.report();
  assert.deepEqual(report.records, before);
  assert.deepEqual(
    report.records.map((row) => field(report, row, "sequence")),
    [2, 3],
  );
  assert.equal(report.counts.overwritten, 1);
  assert.equal(report.counts.overwrittenOpenSpans, 1);
  assert.equal(report.counts.droppedCompletions, 1);
  assert.equal(report.exhausted, true);
  before[0]![0] = -500;
  assert.equal(
    field(trace.report(), trace.report().records[0]!, "sequence"),
    2,
  );
  trace.close();
});

test("operation dictionary and label lengths are bounded and invalid text is not retained", (context) => {
  observerFixture(context, { supported: false });
  const trace = createProfileTrace({
    capacity: 100,
    threadCpu: () => ({ user: 0, system: 0 }),
  });
  try {
    for (let index = 0; index < 64; index++) trace.begin(`stage${index}`)();
    trace.begin("extra-stage")();
    trace.begin("/provider/private/path")();
    trace.begin("x".repeat(65))();
    trace.begin("état")();
    trace.begin("stage0")();
    const report = trace.report();
    assert.equal(report.operations.length, 64);
    assert.equal(report.records.length, 65);
    assert.equal(report.counts.droppedOperations, 1);
    assert.equal(report.counts.invalidOperations, 3);
    assert.equal(report.operations.includes("extra-stage"), false);
    assert.ok(report.records.every((row) => row.every(Number.isFinite)));
    assert.equal(report.exhausted, true);
  } finally {
    trace.close();
  }
});

test("a reentrant clock reader cannot corrupt a newer record during span completion", (context) => {
  observerFixture(context, { supported: false });
  let time = 0;
  let onRead = (): void => {};
  const trace = createProfileTrace({
    capacity: 1,
    clock: () => {
      const callback = onRead;
      onRead = () => {};
      callback();
      return time++;
    },
    threadCpu: () => ({ user: 0, system: 0 }),
  });
  const end = trace.begin("outer");
  onRead = () => trace.begin("reentered")();
  end();
  trace.close();
  const report = trace.report();
  const row = report.records[0]!;
  assert.equal(report.operations[field(report, row, "operation")], "reentered");
  assert.equal(field(report, row, "durationMs"), 1);
  assert.equal(field(report, row, "flags"), 0);
  assert.equal(report.counts.droppedCompletions, 1);
  assert.equal(report.counts.overwrittenOpenSpans, 1);
  assert.equal(report.counts.activeSpans, 0);
});

test("record capacity rejects unsafe allocation and enforces the 65536-record ceiling", (context) => {
  observerFixture(context, { supported: false });
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 65_537])
    assert.throws(() => createProfileTrace({ capacity }), /capacity/);
  const trace = createProfileTrace({
    capacity: 65_536,
    clock: () => 1,
    threadCpu: () => ({ user: 0, system: 0 }),
  });
  try {
    for (let index = 0; index < 65_537; index++) trace.begin("stage")();
    const report = trace.report();
    assert.equal(report.records.length, 65_536);
    assert.equal(report.counts.written, 65_537);
    assert.equal(report.counts.overwritten, 1);
    assert.equal(field(report, report.records[0]!, "sequence"), 2);
  } finally {
    trace.close();
  }
});

test("close flags incomplete spans, disconnects once, and refuses later recording", (context) => {
  const observer = observerFixture(context);
  const { begin, close, report } = createProfileTrace({ capacity: 4 });
  const end = begin("still.running");
  close();
  close();
  begin("after.close")();
  end();
  const result = report();
  assert.equal(observer.disconnects(), 1);
  assert.equal(result.closed, true);
  assert.equal(result.records.length, 1);
  assert.equal(field(result, result.records[0]!, "durationMs"), -1);
  assert.ok(
    field(result, result.records[0]!, "flags") & result.flags.incompleteAtClose,
  );
  assert.equal(result.counts.beginsAfterClose, 1);
  assert.equal(result.counts.droppedCompletions, 1);
});

test("unavailable thread CPU never falls back to process-total CPU", (context) => {
  observerFixture(context, { supported: false });
  const descriptor = Object.getOwnPropertyDescriptor(process, "threadCpuUsage");
  Object.defineProperty(process, "threadCpuUsage", {
    configurable: true,
    value: undefined,
  });
  context.after(() => {
    if (descriptor)
      Object.defineProperty(process, "threadCpuUsage", descriptor);
    else Reflect.deleteProperty(process, "threadCpuUsage");
  });
  context.mock.method(process, "cpuUsage", () => {
    throw new Error("Process CPU must not be sampled");
  });
  const trace = createProfileTrace({ capacity: 1 });
  trace.begin("stage")();
  trace.close();
  const report = trace.report();
  assert.equal(report.capabilities.threadCpu.status, "unsupported");
  assert.equal(report.capabilities.threadCpu.reason, "api-unavailable");
  assert.equal(field(report, report.records[0]!, "threadUserUs"), -1);
  assert.equal(field(report, report.records[0]!, "threadSystemUs"), -1);
  assert.equal(field(report, report.records[0]!, "threadUserStartUs"), -1);
  assert.equal(field(report, report.records[0]!, "threadSystemStartUs"), -1);
  assert.ok(
    field(report, report.records[0]!, "flags") & report.flags.cpuUnavailable,
  );
});

test("thread CPU sampling errors and regressions remain missing rather than fabricated zeroes", (context) => {
  observerFixture(context, { supported: false });
  const unavailable = createProfileTrace({
    capacity: 1,
    threadCpu: () => {
      throw new Error("Not supported by this runtime");
    },
  });
  unavailable.begin("stage")();
  unavailable.close();
  let report = unavailable.report();
  assert.equal(report.capabilities.threadCpu.status, "unsupported");
  assert.equal(report.capabilities.threadCpu.errors, 1);
  assert.equal(field(report, report.records[0]!, "threadUserUs"), -1);
  let call = 0;
  const regressed = createProfileTrace({
    capacity: 1,
    threadCpu: () => ({ user: ++call === 3 ? 2 : 10, system: 4 }),
  });
  regressed.begin("stage")();
  regressed.close();
  report = regressed.report();
  assert.equal(field(report, report.records[0]!, "threadUserUs"), -1);
  assert.equal(field(report, report.records[0]!, "threadUserStartUs"), 10);
  assert.equal(field(report, report.records[0]!, "threadSystemStartUs"), 4);
  assert.ok(
    field(report, report.records[0]!, "flags") & report.flags.cpuRegression,
  );
});

test("a failed ending CPU sample degrades capability without breaking measured work", (context) => {
  observerFixture(context, { supported: false });
  let call = 0;
  const trace = createProfileTrace({
    capacity: 1,
    threadCpu: () => {
      if (++call === 3) throw new Error("Thread CPU read failed");
      return { user: call, system: 0 };
    },
  });
  trace.begin("stage")();
  trace.close();
  const report = trace.report();
  assert.equal(report.capabilities.threadCpu.status, "degraded");
  assert.equal(report.capabilities.threadCpu.errors, 1);
  assert.equal(field(report, report.records[0]!, "threadUserUs"), -1);
  assert.equal(field(report, report.records[0]!, "threadUserStartUs"), 2);
  assert.equal(field(report, report.records[0]!, "threadSystemStartUs"), 0);
  assert.ok(field(report, report.records[0]!, "flags") & report.flags.cpuError);
});

test("throwing, nonfinite and regressing clocks do not masquerade as valid durations", (context) => {
  observerFixture(context, { supported: false });
  for (const failure of ["throw", "nan", "regress"]) {
    let call = 0;
    const trace = createProfileTrace({
      capacity: 1,
      clock: () => {
        if (++call === 1) return 10;
        if (failure === "throw") throw new Error("Clock failed");
        return failure === "nan" ? NaN : 5;
      },
    });
    trace.begin("stage")();
    trace.close();
    const report = trace.report();
    assert.equal(field(report, report.records[0]!, "durationMs"), -1);
    assert.equal(report.counts.clockErrors, 1);
    assert.ok(
      field(report, report.records[0]!, "flags") & report.flags.clockError,
    );
    assert.ok(report.records[0]!.every(Number.isFinite));
  }
});

test("GC records share the bounded numeric ring and omit entry names and arbitrary detail", (context) => {
  const observer = observerFixture(context);
  const trace = createProfileTrace({ capacity: 3 });
  observer.deliver(
    Array.from({ length: 5 }, (_, index) => gcEntry(100 + index, 2, 4, 8)),
  );
  trace.close();
  const report = trace.report();
  assert.equal(report.capabilities.gc.status, "supported");
  assert.equal(report.counts.gcObserved, 5);
  assert.equal(report.counts.gcDropped, 2);
  assert.equal(report.records.length, 3);
  assert.equal(report.operations.length, 0);
  assert.deepEqual(
    report.records.map((row) => field(report, row, "startMs")),
    [100, 101, 102],
  );
  assert.ok(
    report.records.every(
      (row) => field(report, row, "kind") === report.kinds.gc,
    ),
  );
  assert.ok(report.records.every((row) => field(report, row, "gcKind") === 4));
  assert.ok(report.records.every((row) => field(report, row, "gcFlags") === 8));
  assert.ok(
    report.records.every((row) => field(report, row, "threadUserUs") === -1),
  );
  assert.ok(
    report.records.every(
      (row) =>
        field(report, row, "threadUserStartUs") === -1 &&
        field(report, row, "threadSystemStartUs") === -1,
    ),
  );
  assert.equal(JSON.stringify(report).includes("never-retain-this"), false);
  assert.equal(report.exhausted, true);
});

test("GC and span overwrite loss is counted on the same fixed-capacity ring", (context) => {
  const observer = observerFixture(context);
  const trace = createProfileTrace({ capacity: 2 });
  observer.deliver([gcEntry(100, 5), gcEntry(110, 10)]);
  trace.begin("stage")();
  observer.deliver([gcEntry(130, 1)]);
  trace.close();
  const report = trace.report();
  assert.equal(report.records.length, 2);
  assert.equal(report.counts.overwritten, 2);
  assert.equal(report.counts.overwrittenGc, 2);
  assert.deepEqual(
    report.records.map((row) => field(report, row, "kind")),
    [1, 2],
  );
  assert.equal(field(report, report.records[1]!, "threadUserStartUs"), -1);
  assert.equal(field(report, report.records[1]!, "threadSystemStartUs"), -1);
});

test("invalid GC timestamps are dropped, not retained as valid zero-duration work", (context) => {
  const observer = observerFixture(context);
  const trace = createProfileTrace({ capacity: 4 });
  observer.deliver([gcEntry(NaN, 1), gcEntry(10, -1), gcEntry(20, 4)]);
  trace.close();
  const report = trace.report();
  assert.equal(report.counts.gcObserved, 3);
  assert.equal(report.counts.gcDropped, 2);
  assert.equal(report.records.length, 1);
  assert.equal(field(report, report.records[0]!, "startMs"), 20);
  assert.equal(field(report, report.records[0]!, "durationMs"), 4);
  assert.ok(report.records[0]!.every(Number.isFinite));
});

test("tracing overhead remains in absolute slot decisions instead of being subtracted", async () => {
  let current = 0n;
  let dispatched = 0;
  const clock: ProducerClock = {
    now: () => current,
    async until(deadline) {
      if (deadline > current) current = deadline;
    },
  };
  const lane = await fixedLane(
    3,
    5,
    32,
    0n,
    () => ({
      role: "fixture",
      bytes: 8192,
      sha256: null,
      async run() {
        dispatched++;
      },
    }),
    new AbortController().signal,
    clock,
    (operation) => {
      if (operation === "producer.wake") current += 5_000_000n;
      return () => {};
    },
  );
  assert.equal(dispatched, 0);
  assert.equal(lane.started, 0);
  assert.equal(lane.unissued, 3);
  assert.ok(
    lane.attempts.every((attempt) => attempt.reason === "missed-absolute-slot"),
  );
  assert.ok(
    lane.attempts.every(
      (attempt) => attempt.wokeMs - attempt.scheduledMs === 5,
    ),
  );
  assert.deepEqual(
    lane.attempts.map((attempt) => attempt.scheduledMs),
    [0, 5, 10],
  );
});

test("close drains pending GC once and observer deliveries after close cannot modify the ring", (context) => {
  const observer = observerFixture(context, { pending: [gcEntry(25, 5)] });
  const trace = createProfileTrace({ capacity: 2 });
  trace.begin("stage")();
  trace.close();
  const before = trace.report();
  observer.deliver([gcEntry(50, 10)]);
  trace.close();
  assert.deepEqual(trace.report(), before);
  assert.equal(observer.disconnects(), 1);
  assert.equal(before.counts.gcObserved, 1);
  assert.equal(field(before, before.records[1]!, "durationMs"), 5);
  assert.equal(before.capabilities.gc.disconnected, true);
});

test("unsupported or failed GC observation is explicit rather than proof of no GC", (context) => {
  const observer = observerFixture(context, { failObserve: true });
  const trace = createProfileTrace({ capacity: 1 });
  trace.begin("stage")();
  trace.close();
  const report = trace.report();
  assert.equal(observer.observations(), 1);
  assert.equal(observer.disconnects(), 1);
  assert.equal(report.capabilities.gc.status, "unsupported");
  assert.equal(report.capabilities.gc.reason, "observer-failed");
  assert.equal(report.capabilities.gc.errors, 1);
  assert.equal(report.records.length, 1);
});

test("an unavailable GC entry type does not construct an observer", (context) => {
  const observer = observerFixture(context, { supported: false });
  const trace = createProfileTrace({ capacity: 1 });
  trace.close();
  const report = trace.report();
  assert.equal(observer.observations(), 0);
  assert.equal(observer.disconnects(), 0);
  assert.equal(report.capabilities.gc.status, "unsupported");
  assert.equal(report.capabilities.gc.reason, "entry-type-unavailable");
});
