import {
  performance,
  PerformanceObserver,
  type PerformanceEntry,
  type NodeGCPerformanceDetail,
} from "node:perf_hooks";
import { threadId } from "node:worker_threads";

const maximumCapacity = 65_536;
const maximumOperations = 64;
const operationPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const columns = [
  "sequence",
  "kind",
  "operation",
  "startMs",
  "durationMs",
  "threadUserUs",
  "threadSystemUs",
  "gcKind",
  "gcFlags",
  "flags",
  "threadUserStartUs",
  "threadSystemStartUs",
] as const;
const width = columns.length;
const flags = {
  open: 1,
  clockError: 2,
  cpuUnavailable: 4,
  cpuError: 8,
  cpuRegression: 16,
  incompleteAtClose: 32,
} as const;
const noop = (): void => {};

type ThreadCpu = { user: number; system: number };
export type TraceReport = {
  schemaVersion: 2;
  processId: number;
  threadId: number;
  closed: boolean;
  capacity: number;
  limits: {
    operations: 64;
    operationCharacters: 64;
    gcEntriesPerDelivery: number;
    preallocatedBytes: number;
  };
  operations: string[];
  columns: typeof columns;
  kinds: { span: 1; gc: 2 };
  flags: typeof flags;
  records: number[][];
  units: {
    time: "milliseconds";
    cpu: "microseconds";
    cpuStart: "absolute current-thread counters";
    cpuDelta: "inclusive span deltas";
    missing: -1;
  };
  clock: {
    source: "performance.now" | "injected";
    performanceNowMs: number;
    hrtimeBeforeNs: string;
    hrtimeAfterNs: string;
    correlation: string;
  };
  capabilities: {
    threadCpu: {
      source: "process.threadCpuUsage" | "injected" | "unavailable";
      status: "supported" | "unsupported" | "degraded";
      errors: number;
      reason: "available" | "api-unavailable" | "sampling-failed";
    };
    gc: {
      status: "supported" | "unsupported" | "degraded";
      errors: number;
      reason: "available" | "entry-type-unavailable" | "observer-failed";
      disconnected: boolean;
      scope: string;
    };
  };
  counts: {
    written: number;
    retained: number;
    overwritten: number;
    overwrittenGc: number;
    overwrittenOpenSpans: number;
    droppedCompletions: number;
    droppedOperations: number;
    invalidOperations: number;
    beginsAfterClose: number;
    duplicateEnds: number;
    activeSpans: number;
    clockErrors: number;
    gcObserved: number;
    gcDropped: number;
  };
  exhausted: boolean;
  interpretation: string;
};
export type ProfileTrace = {
  begin(operation: string): () => void;
  report(): TraceReport;
  close(): void;
};

// Only static stage labels belong here. Never pass provider IDs, credentials,
// paths or payload-derived text. Measured callbacks retain numeric rows only.
export function createProfileTrace(
  options: {
    capacity?: number;
    clock?: () => number;
    threadCpu?: () => ThreadCpu;
  } = {},
): ProfileTrace {
  const capacity = options.capacity ?? maximumCapacity;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > maximumCapacity)
    throw new RangeError(
      "Profile trace capacity must be an integer from 1 to 65536",
    );
  const data = new Float64Array(capacity * width);
  const names: string[] = [];
  const operations = new Map<string, number>();
  const clock = options.clock ?? (() => performance.now());
  const hrtimeBeforeNs = process.hrtime.bigint().toString();
  const performanceNowMs = performance.now();
  const hrtimeAfterNs = process.hrtime.bigint().toString();
  let closed = false;
  let written = 0;
  let retained = 0;
  let overwritten = 0;
  let overwrittenGc = 0;
  let overwrittenOpenSpans = 0;
  let droppedCompletions = 0;
  let droppedOperations = 0;
  let invalidOperations = 0;
  let beginsAfterClose = 0;
  let duplicateEnds = 0;
  let activeSpans = 0;
  let clockErrors = 0;
  let gcObserved = 0;
  let gcDropped = 0;
  let cpuErrors = 0;
  let cpuSupported = false;
  let cpuReadable = true;
  let gcErrors = 0;
  let gcSupported = false;
  let disconnected = false;
  let observer: PerformanceObserver | undefined;
  const cpuSource = options.threadCpu
    ? "injected"
    : typeof process.threadCpuUsage === "function"
      ? "process.threadCpuUsage"
      : "unavailable";
  const cpu =
    options.threadCpu ??
    (cpuSource === "unavailable" ? undefined : () => process.threadCpuUsage());
  const sampleCpu = (): ThreadCpu | undefined => {
    if (!cpu || !cpuReadable) return undefined;
    try {
      const value = cpu();
      if (
        !Number.isFinite(value.user) ||
        value.user < 0 ||
        !Number.isFinite(value.system) ||
        value.system < 0
      ) {
        cpuErrors++;
        cpuReadable = false;
        return undefined;
      }
      cpuSupported = true;
      return value;
    } catch {
      cpuErrors++;
      cpuReadable = false;
      return undefined;
    }
  };
  sampleCpu();
  const sampleClock = (): number => {
    try {
      const value = clock();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* Capability/error counters must not break measured work. */
    }
    clockErrors++;
    return -1;
  };
  const reserve = (kind: number, operation: number, start: number): number => {
    const offset = (written % capacity) * width;
    if (retained === capacity) {
      overwritten++;
      if (data[offset + 1] === 2) overwrittenGc++;
      if (data[offset + 1] === 1 && data[offset + 9]! & flags.open)
        overwrittenOpenSpans++;
    } else retained++;
    data[offset] = ++written;
    data[offset + 1] = kind;
    data[offset + 2] = operation;
    data[offset + 3] = start;
    data[offset + 4] = -1;
    data[offset + 5] = -1;
    data[offset + 6] = -1;
    data[offset + 7] = -1;
    data[offset + 8] = -1;
    data[offset + 9] = 0;
    data[offset + 10] = -1;
    data[offset + 11] = -1;
    return offset;
  };
  const collectGc = (entries: readonly PerformanceEntry[]): void => {
    if (closed) return;
    gcObserved += entries.length;
    const count = Math.min(entries.length, capacity);
    gcDropped += entries.length - count;
    for (let index = 0; index < count; index++) {
      const entry = entries[index]!;
      if (
        entry.entryType !== "gc" ||
        !Number.isFinite(entry.startTime) ||
        entry.startTime < 0 ||
        !Number.isFinite(entry.duration) ||
        entry.duration < 0
      ) {
        gcDropped++;
        continue;
      }
      const offset = reserve(2, -1, entry.startTime);
      data[offset + 4] = entry.duration;
      const detail = Reflect.get(entry, "detail") as
        | NodeGCPerformanceDetail
        | undefined;
      data[offset + 7] =
        typeof detail?.kind === "number" && Number.isFinite(detail.kind)
          ? detail.kind
          : -1;
      data[offset + 8] =
        typeof detail?.flags === "number" && Number.isFinite(detail.flags)
          ? detail.flags
          : -1;
      data[offset + 9] = flags.cpuUnavailable;
    }
  };
  try {
    const supportedEntryTypes: unknown = Reflect.get(
      PerformanceObserver,
      "supportedEntryTypes",
    );
    if (
      Array.isArray(supportedEntryTypes) &&
      supportedEntryTypes.includes("gc")
    ) {
      observer = new PerformanceObserver((list) => {
        try {
          collectGc(list.getEntries());
        } catch {
          gcErrors++;
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      gcSupported = true;
    }
  } catch {
    gcErrors++;
    try {
      observer?.disconnect();
      disconnected = observer !== undefined;
    } catch {
      gcErrors++;
    }
  }
  const begin = (operation: string): (() => void) => {
    if (closed) {
      beginsAfterClose++;
      return noop;
    }
    if (typeof operation !== "string" || !operationPattern.test(operation)) {
      invalidOperations++;
      return noop;
    }
    let id = operations.get(operation);
    if (id === undefined) {
      if (names.length === maximumOperations) {
        droppedOperations++;
        return noop;
      }
      id = names.length;
      names.push(operation);
      operations.set(operation, id);
    }
    const start = sampleClock();
    const initialCpu = sampleCpu();
    if (closed) {
      beginsAfterClose++;
      return noop;
    }
    const offset = reserve(1, id, start);
    const sequence = written;
    if (initialCpu) {
      data[offset + 10] = initialCpu.user;
      data[offset + 11] = initialCpu.system;
    }
    data[offset + 9] =
      flags.open |
      (start < 0 ? flags.clockError : 0) |
      (initialCpu ? 0 : cpu ? flags.cpuError : flags.cpuUnavailable);
    activeSpans++;
    let ended = false;
    return (): void => {
      if (ended) {
        duplicateEnds++;
        return;
      }
      ended = true;
      activeSpans--;
      if (closed || data[offset] !== sequence) {
        droppedCompletions++;
        return;
      }
      const finalCpu = sampleCpu();
      const end = sampleClock();
      // Injected readers can reenter the tracer. A nested reservation must not
      // be overwritten by an older completion after a sampling call returns.
      if (closed || data[offset] !== sequence) {
        droppedCompletions++;
        return;
      }
      let status = data[offset + 9]! & ~flags.open;
      if (start < 0 || end < start) {
        status |= flags.clockError;
        if (end >= 0 && end < start) clockErrors++;
      } else data[offset + 4] = end - start;
      if (initialCpu && finalCpu) {
        if (
          finalCpu.user < data[offset + 10]! ||
          finalCpu.system < data[offset + 11]!
        )
          status |= flags.cpuRegression;
        else {
          data[offset + 5] = finalCpu.user - data[offset + 10]!;
          data[offset + 6] = finalCpu.system - data[offset + 11]!;
        }
      } else status |= cpu ? flags.cpuError : flags.cpuUnavailable;
      data[offset + 9] = status;
    };
  };
  const close = (): void => {
    if (closed) return;
    if (observer && !disconnected) {
      try {
        collectGc(observer.takeRecords());
      } catch {
        gcErrors++;
      } finally {
        try {
          observer.disconnect();
          disconnected = true;
        } catch {
          gcErrors++;
        }
      }
    }
    closed = true;
    for (let index = 0; index < retained; index++) {
      const offset = index * width;
      if (data[offset + 1] === 1 && data[offset + 9]! & flags.open)
        data[offset + 9] = data[offset + 9]! | flags.incompleteAtClose;
    }
  };
  const report = (): TraceReport => {
    const records: number[][] = [];
    const first = written - retained;
    for (let index = 0; index < retained; index++) {
      const offset = ((first + index) % capacity) * width;
      records.push(Array.from(data.subarray(offset, offset + width)));
    }
    return {
      schemaVersion: 2,
      processId: process.pid,
      threadId,
      closed,
      capacity,
      limits: {
        operations: maximumOperations,
        operationCharacters: 64,
        gcEntriesPerDelivery: capacity,
        preallocatedBytes: data.byteLength,
      },
      operations: [...names],
      columns,
      kinds: { span: 1, gc: 2 },
      flags,
      records,
      units: {
        time: "milliseconds",
        cpu: "microseconds",
        cpuStart: "absolute current-thread counters",
        cpuDelta: "inclusive span deltas",
        missing: -1,
      },
      clock: {
        source: options.clock ? "injected" : "performance.now",
        performanceNowMs,
        hrtimeBeforeNs,
        hrtimeAfterNs,
        correlation:
          "performanceNowMs was sampled between the two process.hrtime.bigint readings; GC startMs uses the runtime performance.now clock even when tests inject a span clock.",
      },
      capabilities: {
        threadCpu: {
          source: cpuSource,
          status: !cpuSupported
            ? "unsupported"
            : cpuErrors
              ? "degraded"
              : "supported",
          errors: cpuErrors,
          reason: !cpu
            ? "api-unavailable"
            : cpuErrors
              ? "sampling-failed"
              : "available",
        },
        gc: {
          status: !gcSupported
            ? "unsupported"
            : gcErrors
              ? "degraded"
              : "supported",
          errors: gcErrors,
          reason: gcErrors
            ? "observer-failed"
            : gcSupported
              ? "available"
              : "entry-type-unavailable",
          disconnected,
          scope:
            "Runtime GC performance entries for this isolate, not thread CPU or a proof of causality. One shared numeric ring; at most capacity entries consumed per delivery, no entry objects retained. Runtime observer pending-queue size is not asserted.",
        },
      },
      counts: {
        written,
        retained,
        overwritten,
        overwrittenGc,
        overwrittenOpenSpans,
        droppedCompletions,
        droppedOperations,
        invalidOperations,
        beginsAfterClose,
        duplicateEnds,
        activeSpans,
        clockErrors,
        gcObserved,
        gcDropped,
      },
      exhausted: overwritten > 0 || droppedOperations > 0 || gcDropped > 0,
      interpretation:
        "Rows are numeric only; operation labels must be static stages, never IDs or payloads. Sequence is reservation/GC-delivery order, not causality or chronological start order. Open/overwritten/invalid samples are explicit, not zero-duration successes. threadUserStartUs/threadSystemStartUs retain the already-sampled absolute current-thread counters at begin; no additional CPU samples are taken. Ending counters are start plus the matching delta only when both are nonnegative and the span is complete without CPU error/regression. Subtract nonoverlapping endpoints on the same process/thread to measure inter-span CPU; never sum nested or overlapping inclusive deltas. Unsupported thread CPU and GC CPU endpoints are -1, never process-total CPU. All tracing overhead remains in the original latency/count measurements; no stall or missed slot is removed.",
    };
  };
  return { begin, report, close };
}
