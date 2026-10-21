import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSnapshotPublisher,
  type SnapshotAccounting,
  type SnapshotPublisherOptions,
} from "../../src/main/snapshot-publisher.ts";
import type { Snapshot } from "../../src/shared/ui-contract.ts";

function snapshot(observation: string): Snapshot {
  return { state: "idle", sessions: [], observation };
}

function encodedBytes(value: Snapshot): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sizedSnapshot(bytes: number): Snapshot {
  const padding = bytes - encodedBytes(snapshot(""));
  return snapshot(
    "한".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3),
  );
}

function clock() {
  let atMs = 0;
  const tasks: {
    callback: () => void;
    delayMs: number;
    atMs: number;
    cancelled: boolean;
    fired: boolean;
  }[] = [];
  return {
    tasks,
    now: () => atMs,
    schedule: (callback: () => void, delayMs: number) => {
      const task = {
        callback,
        delayMs,
        atMs: atMs + delayMs,
        cancelled: false,
        fired: false,
      };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    advance: (durationMs: number) => {
      const endMs = atMs + durationMs;
      for (;;) {
        const task = tasks.find(
          (candidate) =>
            !candidate.cancelled && !candidate.fired && candidate.atMs <= endMs,
        );
        if (!task) break;
        atMs = task.atMs;
        task.fired = true;
        task.callback();
      }
      atMs = endMs;
    },
  };
}

function fixture(ids = [1, 2]) {
  const scheduler = clock();
  const sent: { windowId: number; snapshot: Snapshot; atMs: number }[] = [];
  const records: SnapshotAccounting[] = [];
  const state = {
    snapshot: snapshot("initial"),
    materializations: 0,
    targets: [] as ReturnType<SnapshotPublisherOptions["getTargets"]>[number][],
  };
  function target(id: number) {
    return {
      id,
      send: (value: Snapshot) => {
        sent.push({ windowId: id, snapshot: value, atMs: scheduler.now() });
      },
    };
  }
  state.targets = ids.map(target);
  const options: SnapshotPublisherOptions = {
    getSnapshot: () => {
      state.materializations++;
      return state.snapshot;
    },
    getTargets: () => state.targets,
    onAccounting: (record) => records.push(record),
    schedule: scheduler.schedule,
    now: scheduler.now,
  };
  return {
    scheduler,
    state,
    sent,
    records,
    options,
    target,
    publisher: createSnapshotPublisher(options),
  };
}

test("coalesces bursts globally, materializes latest state, and waits 50 ms per batch", () => {
  const { publisher, scheduler, state, sent } = fixture();
  for (let i = 0; i < 100; i++) {
    state.snapshot = snapshot(`burst-${i}`);
    publisher.request();
  }
  assert.equal(publisher.isPending(), true);
  assert.equal(scheduler.tasks.length, 1);
  assert.equal(scheduler.tasks[0]?.delayMs, 50);
  scheduler.advance(49);
  state.snapshot = snapshot("latest before flush");
  publisher.request();
  assert.equal(
    scheduler.tasks.length,
    1,
    "A coalesced request must not reset the timer",
  );
  assert.equal(state.materializations, 0);
  assert.equal(sent.length, 0);
  scheduler.advance(1);
  assert.equal(state.materializations, 1);
  assert.deepEqual(
    sent.map((value) => value.windowId),
    [1, 2],
  );
  assert.ok(sent.every((value) => value.snapshot === state.snapshot));
  assert.deepEqual(
    sent.map((value) => value.atMs),
    [50, 50],
  );
  assert.equal(publisher.isPending(), false);

  state.snapshot = snapshot("next batch");
  publisher.request();
  scheduler.advance(49);
  assert.equal(sent.length, 2);
  scheduler.advance(1);
  assert.equal(state.materializations, 2);
  assert.deepEqual(
    sent.map((value) => value.atMs),
    [50, 50, 100, 100],
  );
  assert.ok(sent.slice(2).every((value) => value.snapshot === state.snapshot));
  assert.equal(publisher.isPending(), false);
});

test("accounts for every per-window mutation using only unpublished counts and bytes", () => {
  const { publisher, scheduler, state, records } = fixture();
  state.snapshot = snapshot("private contents 한");
  const bytes = encodedBytes(state.snapshot);
  publisher.request();
  scheduler.advance(50);
  assert.deepEqual(records, [
    { windowId: 1, kind: "scheduled", pending: 1, bytes: 0, atMs: 0 },
    { windowId: 2, kind: "scheduled", pending: 1, bytes: 0, atMs: 0 },
    { windowId: 1, kind: "materialized", pending: 1, bytes, atMs: 50 },
    { windowId: 2, kind: "materialized", pending: 1, bytes, atMs: 50 },
    { windowId: 1, kind: "published", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "published", pending: 0, bytes: 0, atMs: 50 },
  ]);
  assert.equal(JSON.stringify(records).includes("private contents"), false);
});

test("accepts an exactly 128 KiB UTF-8 snapshot", () => {
  const { publisher, scheduler, state, sent, records } = fixture();
  state.snapshot = sizedSnapshot(128 * 1024);
  assert.equal(encodedBytes(state.snapshot), 128 * 1024);
  assert.ok(JSON.stringify(state.snapshot).length < 128 * 1024);
  publisher.request();
  scheduler.advance(50);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((value) => value.snapshot === state.snapshot));
  assert.deepEqual(
    records
      .filter((record) => record.kind === "materialized")
      .map((record) => record.bytes),
    [128 * 1024, 128 * 1024],
  );
  assert.equal(publisher.isPending(), false);
});

test("refuses one byte over 128 KiB before any send and releases the batch", () => {
  const { publisher, scheduler, state, sent, records } = fixture();
  state.snapshot = sizedSnapshot(128 * 1024 + 1);
  assert.equal(encodedBytes(state.snapshot), 128 * 1024 + 1);
  publisher.request();
  assert.throws(() => scheduler.advance(50), /128 KiB encoded payload limit/);
  assert.deepEqual(sent, []);
  assert.equal(state.materializations, 1);
  assert.equal(publisher.isPending(), false);
  assert.deepEqual(records, [
    { windowId: 1, kind: "scheduled", pending: 1, bytes: 0, atMs: 0 },
    { windowId: 2, kind: "scheduled", pending: 1, bytes: 0, atMs: 0 },
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
  ]);
  state.snapshot = snapshot("bounded again");
  publisher.request();
  scheduler.advance(50);
  assert.equal(sent.length, 2);
  assert.equal(state.materializations, 2);
  assert.equal(publisher.isPending(), false);
});

test("cancellation drops every pending window and stale callbacks cannot flush a new batch", () => {
  const { publisher, scheduler, state, sent, records } = fixture();
  publisher.request();
  const stale = scheduler.tasks[0];
  assert.ok(stale);
  scheduler.advance(30);
  publisher.cancel();
  publisher.cancel();
  assert.equal(stale.cancelled, true);
  assert.equal(publisher.isPending(), false);
  assert.deepEqual(records.slice(2), [
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 30 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 30 },
  ]);
  state.snapshot = snapshot("after cancellation");
  publisher.request();
  stale.callback();
  assert.equal(state.materializations, 0);
  assert.equal(sent.length, 0);
  assert.equal(publisher.isPending(), true);
  scheduler.advance(50);
  assert.equal(state.materializations, 1);
  assert.deepEqual(
    sent.map((value) => value.atMs),
    [80, 80],
  );
  assert.equal(publisher.isPending(), false);
});

test("refreshes targets at flush, cancelling removed windows and scheduling new windows", () => {
  const { publisher, scheduler, state, sent, records, target } = fixture();
  publisher.request();
  const remaining = state.targets[1];
  assert.ok(remaining);
  state.targets = [remaining, target(3)];
  scheduler.advance(50);
  const bytes = encodedBytes(state.snapshot);
  assert.deepEqual(
    sent.map((value) => value.windowId),
    [2, 3],
  );
  assert.deepEqual(records.slice(2), [
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 3, kind: "scheduled", pending: 1, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "materialized", pending: 1, bytes, atMs: 50 },
    { windowId: 3, kind: "materialized", pending: 1, bytes, atMs: 50 },
    { windowId: 2, kind: "published", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 3, kind: "published", pending: 0, bytes: 0, atMs: 50 },
  ]);
  assert.equal(publisher.isPending(), false);
});

test("releases pending state when all targets disappear before flush", () => {
  const { publisher, scheduler, state, sent, records, target } = fixture();
  publisher.request();
  state.targets = [];
  scheduler.advance(50);
  assert.equal(sent.length, 0);
  assert.equal(state.materializations, 1);
  assert.deepEqual(
    records
      .slice(2)
      .map((record) => [
        record.windowId,
        record.kind,
        record.pending,
        record.bytes,
      ]),
    [
      [1, "cancelled", 0, 0],
      [2, "cancelled", 0, 0],
    ],
  );
  assert.equal(publisher.isPending(), false);
  state.targets = [target(3)];
  publisher.request();
  scheduler.advance(50);
  assert.deepEqual(
    sent.map((value) => value.windowId),
    [3],
  );
});

test("does not send to a target removed synchronously by an earlier send", () => {
  const { publisher, scheduler, state, sent, records } = fixture();
  const first = state.targets[0];
  assert.ok(first);
  const send = first.send;
  first.send = (value) => {
    send(value);
    state.targets = state.targets.filter((target) => target.id !== 2);
  };
  publisher.request();
  scheduler.advance(50);
  assert.deepEqual(
    sent.map((value) => value.windowId),
    [1],
  );
  assert.deepEqual(records.slice(-2), [
    { windowId: 1, kind: "published", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
  ]);
  assert.equal(publisher.isPending(), false);
});

test("fails fast on a send error, preserves the error, and cancels every unpublished target", () => {
  const { publisher, scheduler, state, sent, records, target } = fixture([
    1, 2, 3,
  ]);
  const failure = new Error("sender failed");
  const second = state.targets[1];
  assert.ok(second);
  second.send = () => {
    throw failure;
  };
  publisher.request();
  assert.throws(
    () => scheduler.advance(50),
    (error) => error === failure,
  );
  assert.deepEqual(
    sent.map((value) => value.windowId),
    [1],
  );
  assert.deepEqual(records.slice(-3), [
    { windowId: 1, kind: "published", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 3, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
  ]);
  assert.equal(publisher.isPending(), false);
  state.targets = [target(1), target(2), target(3)];
  publisher.request();
  scheduler.advance(50);
  assert.deepEqual(
    sent.map((value) => value.windowId),
    [1, 1, 2, 3],
  );
  assert.equal(publisher.isPending(), false);
});

test("scheduling failure releases all reservations and can be retried", () => {
  const { scheduler, options, records, sent } = fixture();
  const failure = new Error("scheduler failed");
  let failing = true;
  const publisher = createSnapshotPublisher({
    ...options,
    schedule: (callback, delayMs) => {
      if (failing) throw failure;
      return scheduler.schedule(callback, delayMs);
    },
  });
  assert.throws(
    () => publisher.request(),
    (error) => error === failure,
  );
  assert.equal(publisher.isPending(), false);
  assert.deepEqual(records.slice(-2), [
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 0 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 0 },
  ]);
  failing = false;
  publisher.request();
  scheduler.advance(50);
  assert.equal(sent.length, 2);
});

test("snapshot materialization failure is rethrown after releasing every target", () => {
  const { scheduler, options, records, sent } = fixture();
  const failure = new Error("snapshot failed");
  const publisher = createSnapshotPublisher({
    ...options,
    getSnapshot: () => {
      throw failure;
    },
  });
  publisher.request();
  assert.throws(
    () => scheduler.advance(50),
    (error) => error === failure,
  );
  assert.deepEqual(sent, []);
  assert.equal(publisher.isPending(), false);
  assert.deepEqual(
    records
      .slice(-2)
      .map((record) => [
        record.windowId,
        record.kind,
        record.pending,
        record.bytes,
      ]),
    [
      [1, "cancelled", 0, 0],
      [2, "cancelled", 0, 0],
    ],
  );
});

test("cancellation during materialization releases both windows before any send", () => {
  const { scheduler, options, records, sent, state } = fixture();
  let publisher: ReturnType<typeof createSnapshotPublisher>;
  publisher = createSnapshotPublisher({
    ...options,
    onAccounting: (record) => {
      records.push(record);
      if (record.kind === "materialized") publisher.cancel();
    },
  });
  publisher.request();
  scheduler.advance(50);
  assert.deepEqual(sent, []);
  assert.deepEqual(records.slice(2), [
    {
      windowId: 1,
      kind: "materialized",
      pending: 1,
      bytes: encodedBytes(state.snapshot),
      atMs: 50,
    },
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
  ]);
  assert.equal(publisher.isPending(), false);
});

test("requests reentered during send wait for another 50 ms without overlapping reservations", () => {
  const { publisher, scheduler, state, sent, records } = fixture();
  const first = state.targets[0];
  assert.ok(first);
  const send = first.send;
  let requested = false;
  first.send = (value) => {
    send(value);
    if (!requested) {
      requested = true;
      state.snapshot = snapshot("changed during send");
      for (let i = 0; i < 100; i++) publisher.request();
    }
  };
  publisher.request();
  scheduler.advance(50);
  assert.deepEqual(
    sent.map((value) => value.snapshot.observation),
    ["initial", "initial"],
  );
  assert.equal(publisher.isPending(), true);
  scheduler.advance(49);
  assert.equal(sent.length, 2);
  scheduler.advance(1);
  assert.deepEqual(
    sent.map((value) => value.atMs),
    [50, 50, 100, 100],
  );
  assert.deepEqual(
    sent.slice(2).map((value) => value.snapshot.observation),
    ["changed during send", "changed during send"],
  );
  assert.equal(state.materializations, 2);
  const counts = new Map<number, number>();
  for (const record of records) {
    const change =
      record.kind === "scheduled" ? 1 : record.kind === "materialized" ? 0 : -1;
    const count = (counts.get(record.windowId) ?? 0) + change;
    assert.ok(
      count >= 0 && count <= 1,
      "A reentrant request overlapped a reservation",
    );
    assert.equal(record.pending, count);
    counts.set(record.windowId, count);
  }
  assert.deepEqual([...counts.values()], [0, 0]);
  assert.equal(publisher.isPending(), false);
});

test("cleanup errors do not hide the original failure or leave other windows pending", () => {
  const { scheduler, options, records, sent } = fixture();
  const failure = new Error("accounting failed");
  const cleanupFailure = new Error("cancellation accounting failed");
  const publisher = createSnapshotPublisher({
    ...options,
    onAccounting: (record) => {
      records.push(record);
      if (record.kind === "materialized") throw failure;
      if (record.kind === "cancelled" && record.windowId === 1)
        throw cleanupFailure;
    },
  });
  publisher.request();
  assert.throws(
    () => scheduler.advance(50),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, cleanupFailure]);
      return true;
    },
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(records.slice(-2), [
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 50 },
  ]);
  assert.equal(publisher.isPending(), false);
});

test("timer cancellation errors surface only after all reservations are released", () => {
  const { scheduler, options, records, sent } = fixture();
  const failure = new Error("timer cancellation failed");
  const publisher = createSnapshotPublisher({
    ...options,
    schedule: (callback, delayMs) => {
      const stop = scheduler.schedule(callback, delayMs);
      return () => {
        stop();
        throw failure;
      };
    },
  });
  publisher.request();
  assert.throws(
    () => publisher.cancel(),
    (error) => error === failure,
  );
  assert.equal(publisher.isPending(), false);
  assert.deepEqual(records.slice(-2), [
    { windowId: 1, kind: "cancelled", pending: 0, bytes: 0, atMs: 0 },
    { windowId: 2, kind: "cancelled", pending: 0, bytes: 0, atMs: 0 },
  ]);
  scheduler.advance(50);
  assert.deepEqual(sent, []);
});

test("duplicate target IDs are rejected instead of reserving or sending twice", () => {
  const { options, records, sent } = fixture([1, 1]);
  const publisher = createSnapshotPublisher(options);
  assert.throws(() => publisher.request(), /target IDs must be unique/);
  assert.deepEqual(records, []);
  assert.deepEqual(sent, []);
  assert.equal(publisher.isPending(), false);
});
