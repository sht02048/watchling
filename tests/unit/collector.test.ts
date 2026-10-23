import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCollector } from "../../src/integration/claude/collector.ts";
import type { LossReason } from "../../src/integration/claude/collector.ts";
import type {
  ClaudeEvent,
  Endpoint,
  TransportReceipt,
} from "../../src/integration/claude/protocol.ts";

async function send(path: string, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => socket.end(bytes));
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
}
const event = {
  eventName: "PermissionRequest",
  sessionId: "s1",
  project: "p",
  toolName: "Bash",
} as const;
function frame(endpoint: Endpoint, patch = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      epoch: endpoint.epoch,
      token: endpoint.token,
      eventId: randomUUID(),
      event,
      ...patch,
    }) + "\n",
  );
}
async function endpoint(path: string): Promise<Endpoint> {
  return JSON.parse(await readFile(path, "utf8")) as Endpoint;
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), "Collector did not reach expected state");
}

test("accepts private authenticated metadata and rejects old epochs/tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const received: ClaudeEvent[] = [];
  const losses: LossReason[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(value),
    onLoss: (reason) => losses.push(reason),
  });
  let observed: Endpoint | undefined;
  try {
    observed = await endpoint(collector.descriptorPath);
    assert.equal((await lstat(collector.descriptorPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(observed.socketPath)).mode & 0o777, 0o600);
    await send(observed.socketPath, frame(observed));
    await until(() => received.length === 1);
    assert.deepEqual(received, [event]);
    assert.equal(collector.stats().delivered, 1);
    await send(observed.socketPath, frame(observed, { token: "b".repeat(64) }));
    await send(
      observed.socketPath,
      frame(observed, { epoch: "00000000-0000-4000-8000-000000000000" }),
    );
    await until(() => collector.stats().rejected === 2);
    assert.equal(collector.stats().accepted, 1);
    assert.equal(collector.stats().dedupSize, 1);
    assert.deepEqual(losses, []);
    await assert.rejects(
      startCollector({ directory, onEvent: () => {}, onLoss: () => {} }),
      /already active/,
    );
  } finally {
    await collector.close();
    await collector.close();
    if (observed)
      await assert.rejects(lstat(observed.socketPath), { code: "ENOENT" });
    await assert.rejects(lstat(join(directory, "endpoint.json")), {
      code: "ENOENT",
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated malformed data reports loss without retaining raw content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const losses: LossReason[] = [];
  const collector = await startCollector({
    directory,
    onEvent: () => assert.fail("Invalid input delivered"),
    onLoss: (reason) => losses.push(reason),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    await send(
      target.socketPath,
      frame(target, { event: { ...event, message: "private" } }),
    );
    await until(() => losses.length === 1);
    assert.deepEqual(losses, ["malformed-authenticated-frame"]);
    assert.equal(collector.stats().accepted, 0);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated malformed transport IDs and legacy frames cannot enter the cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const losses: LossReason[] = [];
  const receipts: TransportReceipt[] = [];
  const collector = await startCollector({
    directory,
    onEvent: () => assert.fail("Malformed identity delivered"),
    onLoss: (reason) => losses.push(reason),
    onReceipt: (value) => receipts.push(value),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    for (const eventId of [
      undefined,
      "not-a-uuid",
      "01234567-89AB-4CDE-8F01-23456789ABCD",
    ])
      await send(target.socketPath, frame(target, { eventId }));
    await until(() => collector.stats().rejected === 3);
    assert.deepEqual(losses, Array(3).fill("malformed-authenticated-frame"));
    assert.deepEqual(receipts, []);
    assert.equal(collector.stats().accepted, 0);
    assert.equal(collector.stats().delivered, 0);
    assert.equal(collector.stats().dedupSize, 0);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exact replays do not queue again and identical payloads with distinct UUIDs remain independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const losses: LossReason[] = [];
  const received: {
    event: ClaudeEvent;
    identity: { eventId: string; receivedSeq: number };
  }[] = [];
  const receipts: TransportReceipt[] = [];
  let pending: (() => void) | undefined;
  const collector = await startCollector({
    directory,
    onEvent: (value, identity) => received.push({ event: value, identity }),
    onLoss: (reason) => losses.push(reason),
    onReceipt: (value) => receipts.push(value),
    scheduleDrain: (callback) => {
      pending = callback;
      return () => {
        pending = undefined;
      };
    },
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const eventId = randomUUID();
    const separateId = randomUUID();
    const captured = frame(target, { eventId });
    await send(target.socketPath, captured);
    const queuedBytes = collector.stats().queuedBytes;
    await send(target.socketPath, captured);
    assert.equal(collector.stats().queuedBytes, queuedBytes);
    await send(target.socketPath, frame(target, { eventId: separateId }));
    assert.deepEqual(receipts, [
      { eventId, receivedSeq: 1, disposition: "queued", event },
      { eventId, receivedSeq: 2, disposition: "duplicate", event },
      { eventId: separateId, receivedSeq: 3, disposition: "queued", event },
    ]);
    assert.equal(collector.stats().accepted, 3);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().queued, 2);
    assert.equal(collector.stats().delivered, 0);
    assert.equal(collector.stats().dedupSize, 2);
    while (collector.stats().queued > 0) {
      assert.ok(pending);
      pending();
    }
    assert.deepEqual(received, [
      { event, identity: { eventId, receivedSeq: 1 } },
      { event, identity: { eventId: separateId, receivedSeq: 3 } },
    ]);
    assert.equal(collector.stats().delivered, 2);
    assert.equal(collector.stats().queuedBytes, 0);
    await send(target.socketPath, captured);
    assert.equal(collector.stats().accepted, 4);
    assert.equal(collector.stats().duplicateFrames, 2);
    assert.equal(collector.stats().delivered, 2);
    assert.equal(collector.stats().queued, 0);
    assert.deepEqual(losses, []);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authentication precedes replay lookup and conflicting authenticated ID reuse is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const received: ClaudeEvent[] = [];
  const losses: LossReason[] = [];
  const receipts: TransportReceipt[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(value),
    onLoss: (reason) => losses.push(reason),
    onReceipt: (value) => receipts.push(value),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const eventId = randomUUID();
    const different = { ...event, toolName: "Read" };
    const captured = frame(target, { eventId });
    await send(
      target.socketPath,
      frame(target, { eventId, event: different, token: "b".repeat(64) }),
    );
    await send(
      target.socketPath,
      frame(target, {
        eventId,
        event: different,
        epoch: "00000000-0000-4000-8000-000000000000",
      }),
    );
    assert.equal(collector.stats().rejected, 2);
    assert.equal(collector.stats().dedupSize, 0);
    assert.deepEqual(losses, []);
    assert.equal(receipts.length, 0);
    await send(target.socketPath, captured);
    await until(() => received.length === 1);
    await send(
      target.socketPath,
      frame(target, { eventId, token: "b".repeat(64) }),
    );
    await send(
      target.socketPath,
      frame(target, {
        eventId,
        event: different,
        epoch: "00000000-0000-4000-8000-000000000000",
      }),
    );
    assert.equal(collector.stats().rejected, 4);
    assert.equal(collector.stats().duplicateFrames, 0);
    assert.deepEqual(losses, []);
    assert.equal(receipts.length, 1);
    await send(target.socketPath, frame(target, { eventId, event: different }));
    assert.equal(collector.stats().rejected, 5);
    assert.equal(collector.stats().accepted, 1);
    assert.equal(collector.stats().duplicateFrames, 0);
    assert.equal(collector.stats().dedupSize, 1);
    assert.deepEqual(losses, ["malformed-authenticated-frame"]);
    assert.equal(receipts.length, 1);
    await send(target.socketPath, captured);
    assert.equal(collector.stats().accepted, 2);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().delivered, 1);
    assert.deepEqual(received, [event]);
    assert.deepEqual(
      receipts.map((value) => value.receivedSeq),
      [1, 2],
    );
    assert.equal(receipts[1]!.disposition, "duplicate");
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay content comparison ignores JSON encoding order but preserves nested provider content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const received: ClaudeEvent[] = [];
  const losses: LossReason[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(value),
    onLoss: (reason) => losses.push(reason),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const eventId = randomUUID();
    const metadata: ClaudeEvent = {
      eventName: "PostToolBatch",
      sessionId: "s1",
      project: "p",
      promptId: "prompt-1",
      agentId: "agent-1",
      toolCalls: [{ toolName: "Bash", toolUseId: "toolu_1" }],
      backgroundTasks: [{ id: "t1", type: "local_agent", status: "running" }],
    };
    await send(target.socketPath, frame(target, { eventId, event: metadata }));
    await send(
      target.socketPath,
      frame(target, {
        eventId,
        event: {
          backgroundTasks: [
            { status: "running", type: "local_agent", id: "t1" },
          ],
          toolCalls: [{ toolUseId: "toolu_1", toolName: "Bash" }],
          agentId: "agent-1",
          promptId: "prompt-1",
          project: "p",
          sessionId: "s1",
          eventName: "PostToolBatch",
        },
      }),
    );
    await until(() => received.length === 1);
    assert.deepEqual(received, [metadata]);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.deepEqual(losses, []);
    await send(
      target.socketPath,
      frame(target, {
        eventId,
        event: {
          ...metadata,
          backgroundTasks: [
            { id: "t1", type: "local_agent", status: "completed" },
          ],
        },
      }),
    );
    assert.equal(collector.stats().rejected, 1);
    assert.deepEqual(losses, ["malformed-authenticated-frame"]);
    assert.equal(collector.stats().delivered, 1);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded queue marks overflow and resumes finite batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const received: ClaudeEvent[] = [];
  const losses: LossReason[] = [];
  const receipts: TransportReceipt[] = [];
  let pending: (() => void) | undefined;
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(value),
    onLoss: (value) => losses.push(value),
    onReceipt: (value) => receipts.push(value),
    scheduleDrain: (callback) => {
      pending = callback;
      return () => {
        pending = undefined;
      };
    },
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const captured = frame(target);
    const dropped = frame(target);
    await send(target.socketPath, captured);
    for (let i = 1; i < 128; i++) await send(target.socketPath, frame(target));
    await send(target.socketPath, dropped);
    await send(target.socketPath, frame(target));
    assert.equal(collector.stats().queued, 128);
    assert.equal(collector.stats().maximumQueue, 128);
    assert.equal(collector.stats().overflow, 2);
    assert.equal(collector.stats().authenticatedOverflow, 2);
    assert.equal(collector.stats().queuedBytes, frame(target).length * 128);
    assert.equal(collector.stats().accepted, 128);
    assert.equal(collector.stats().dedupSize, 128);
    assert.deepEqual(
      receipts.slice(128).map((value) => ({
        receivedSeq: value.receivedSeq,
        disposition: value.disposition,
      })),
      [
        { receivedSeq: 129, disposition: "overflow" },
        { receivedSeq: 130, disposition: "overflow" },
      ],
    );
    await send(target.socketPath, captured);
    assert.equal(collector.stats().accepted, 129);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().queued, 128);
    assert.equal(collector.stats().overflow, 2);
    assert.equal(receipts[130]!.disposition, "duplicate");
    assert.deepEqual(losses, ["capacity", "capacity"]);
    while (collector.stats().queued > 0) {
      assert.ok(pending);
      pending();
    }
    assert.equal(received.length, 128);
    assert.equal(collector.stats().delivered, 128);
    assert.equal(collector.stats().queuedBytes, 0);
    // Overflow was not admitted or cached, so retrying it can deliver after drain.
    await send(target.socketPath, dropped);
    assert.equal(collector.stats().accepted, 130);
    assert.equal(collector.stats().queued, 1);
    assert.equal(collector.stats().dedupSize, 129);
    assert.equal(receipts[131]!.receivedSeq, 132);
    assert.equal(receipts[131]!.disposition, "queued");
    while (collector.stats().queued > 0) {
      assert.ok(pending);
      pending();
    }
    assert.equal(collector.stats().delivered, 129);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay suppression is bounded to 4096 retained IDs and FIFO eviction is explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const losses: LossReason[] = [];
  let delivered = 0;
  const collector = await startCollector({
    directory,
    onEvent: () => delivered++,
    onLoss: (reason) => losses.push(reason),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const captured = frame(target);
    await send(target.socketPath, captured);
    for (let i = 1; i < 4096; i++) {
      await send(target.socketPath, frame(target));
      assert.ok(collector.stats().dedupSize <= 4096);
    }
    await until(() => delivered === 4096);
    assert.equal(collector.stats().dedupSize, 4096);
    assert.equal(collector.stats().maximumDedupSize, 4096);
    assert.equal(collector.stats().dedupEvictions, 0);
    await send(target.socketPath, captured);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().dedupEvictions, 0);
    await send(target.socketPath, frame(target));
    await until(() => delivered === 4097);
    assert.equal(collector.stats().dedupEvictions, 1);
    // Duplicate hits do not refresh FIFO retention. Outside the retained window,
    // this formerly admitted frame is eligible again; no infinite guarantee exists.
    await send(target.socketPath, captured);
    await until(() => delivered === 4098);
    assert.equal(collector.stats().accepted, 4099);
    assert.equal(collector.stats().delivered, 4098);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().dedupSize, 4096);
    assert.equal(collector.stats().maximumDedupSize, 4096);
    assert.equal(collector.stats().dedupEvictions, 2);
    assert.equal(collector.stats().overflow, 0);
    assert.deepEqual(losses, []);
  } finally {
    await collector.close();
    assert.equal(collector.stats().dedupSize, 0);
    await rm(directory, { recursive: true, force: true });
  }
});

test("1200 admitted frames account for 1080 independent emissions and 120 exact replays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const received: ClaudeEvent[] = [];
  const identities: { eventId: string; receivedSeq: number }[] = [];
  const receipts: TransportReceipt[] = [];
  const expectedSeqs: number[] = [];
  const losses: LossReason[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (value, identity) => {
      received.push(value);
      identities.push(identity);
    },
    onLoss: (reason) => losses.push(reason),
    onReceipt: (value) => receipts.push(value),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    for (let block = 0; block < 60; block++) {
      const replays: Buffer[] = [];
      for (let i = 0; i < 18; i++) {
        const captured = frame(target);
        if (i < 2) replays.push(captured);
        expectedSeqs.push(block * 20 + i + 1);
        await send(target.socketPath, captured);
      }
      for (const captured of replays) await send(target.socketPath, captured);
    }
    await until(() => received.length === 1080);
    assert.deepEqual(received, Array(1080).fill(event));
    assert.equal(new Set(identities.map((value) => value.eventId)).size, 1080);
    assert.deepEqual(
      identities.map((value) => value.receivedSeq),
      expectedSeqs,
    );
    assert.deepEqual(
      receipts.map((value) => value.receivedSeq),
      Array.from({ length: 1200 }, (_, i) => i + 1),
    );
    assert.equal(
      receipts.filter((value) => value.disposition === "queued").length,
      1080,
    );
    assert.equal(
      receipts.filter((value) => value.disposition === "duplicate").length,
      120,
    );
    const stats = collector.stats();
    assert.equal(stats.accepted, 1200);
    assert.equal(stats.duplicateFrames, 120);
    assert.equal(stats.delivered, 1080);
    assert.equal(stats.queued, 0);
    assert.equal(stats.queuedBytes, 0);
    assert.equal(stats.rejected, 0);
    assert.equal(stats.authenticatedOverflow, 0);
    assert.equal(stats.consumerFailures, 0);
    assert.equal(stats.dedupSize, 1080);
    assert.equal(stats.maximumDedupSize, 1080);
    assert.equal(stats.dedupEvictions, 0);
    assert.deepEqual(losses, []);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture observer failures and mutations cannot change admission or delivery accounting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const received: ClaudeEvent[] = [];
  const losses: LossReason[] = [];
  let observed = 0;
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(value),
    onLoss: (reason) => losses.push(reason),
    onReceipt: (value) => {
      observed++;
      value.event.toolName = "Read";
      throw new Error("Fixture observer failed");
    },
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const captured = frame(target);
    await send(target.socketPath, captured);
    await until(() => received.length === 1);
    await send(target.socketPath, captured);
    assert.deepEqual(received, [event]);
    assert.equal(observed, 2);
    assert.equal(collector.stats().accepted, 2);
    assert.equal(collector.stats().delivered, 1);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().dedupSize, 1);
    assert.equal(collector.stats().queued, 0);
    assert.equal(collector.stats().consumerFailures, 2);
    assert.deepEqual(losses, ["consumer-failed", "consumer-failed"]);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("consumer failure is explicit and a captured replay does not retry delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const losses: LossReason[] = [];
  let attempts = 0;
  const collector = await startCollector({
    directory,
    onEvent: () => {
      attempts++;
      throw new Error("Consumer failed");
    },
    onLoss: (reason) => losses.push(reason),
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const captured = frame(target);
    await send(target.socketPath, captured);
    await until(() => collector.stats().consumerFailures === 1);
    await send(target.socketPath, captured);
    assert.equal(attempts, 1);
    assert.equal(collector.stats().accepted, 2);
    assert.equal(collector.stats().delivered, 0);
    assert.equal(collector.stats().duplicateFrames, 1);
    assert.equal(collector.stats().consumerFailures, 1);
    assert.deepEqual(losses, ["consumer-failed"]);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unauthenticated size and connection pressure cannot assert stream loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const losses: LossReason[] = [];
  const collector = await startCollector({
    directory,
    onEvent: () => assert.fail("Untrusted data delivered"),
    onLoss: (reason) => losses.push(reason),
  });
  const clients: ReturnType<typeof createConnection>[] = [];
  try {
    const target = await endpoint(collector.descriptorPath);
    await send(target.socketPath, Buffer.alloc(8193, 32)).catch(
      (error: NodeJS.ErrnoException) => assert.equal(error.code, "ECONNRESET"),
    );
    await until(() => collector.stats().activeConnections === 0);
    for (let i = 0; i < 16; i++) {
      const socket = createConnection(target.socketPath);
      clients.push(socket);
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.once("connect", resolve));
    }
    await until(() => collector.stats().activeConnections === 16);
    const excess = createConnection(target.socketPath);
    clients.push(excess);
    excess.on("error", () => {});
    await new Promise<void>((resolve) => excess.once("close", resolve));
    assert.ok(collector.stats().overflow >= 2);
    assert.equal(collector.stats().authenticatedOverflow, 0);
    assert.deepEqual(losses, []);
  } finally {
    for (const socket of clients) socket.destroy();
    await collector.close();
    assert.equal(collector.stats().connectionBytes, 0);
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial senders expire and shutdown releases active clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const collector = await startCollector({
    directory,
    onEvent: () => assert.fail("Partial input delivered"),
    onLoss: () => {},
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    const socket = createConnection(target.socketPath);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("{");
    await until(() => collector.stats().activeConnections === 1);
    await until(() => socket.destroyed);
    assert.equal(collector.stats().rejected, 1);
    const active = createConnection(target.socketPath);
    active.on("error", () => {});
    await new Promise<void>((resolve) => active.once("connect", resolve));
    await collector.close();
    await until(() => active.destroyed);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("private directory and descriptor symlink checks never replace user files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const options = { directory, onEvent: () => {}, onLoss: () => {} };
  try {
    await chmod(directory, 0o755);
    await assert.rejects(startCollector(options), /Unsafe private/);
    await chmod(directory, 0o700);
    await symlink(
      join(directory, "missing-referent"),
      join(directory, "endpoint.json"),
    );
    await assert.rejects(startCollector(options), /Unsafe endpoint/);
    assert.equal(
      (await lstat(join(directory, "endpoint.json"))).isSymbolicLink(),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("events recorded while the app was closed replay before live frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchling-collector-test-"));
  const pending = join(directory, "pending");
  await mkdir(pending, { mode: 0o700 });
  const alive = { pid: 4242, startedAt: 1_700_000_000 };
  const record = (sessionId: string, eventName: string, owner = alive) =>
    JSON.stringify({
      ...owner,
      event: { eventName, sessionId, project: "p" },
    });
  const [running, lost, gone, broken] = Array.from({ length: 4 }, randomUUID);
  const files: [string, string, number?][] = [
    [
      running!,
      [
        record(running!, "SessionStart"),
        record(running!, "UserPromptSubmit"),
      ].join("\n") + "\n",
    ],
    [
      lost!,
      [
        '{"lost":true}',
        record(lost!, "UserPromptSubmit"),
        "{broken",
        record(randomUUID(), "Stop"),
        record(lost!, "Stop"),
      ].join("\n") + '\n{"pid":',
    ],
    [
      gone!,
      record(gone!, "UserPromptSubmit", { pid: 4343, startedAt: 1 }) + "\n",
    ],
    [broken!, record(broken!, "UserPromptSubmit") + "\n", 0o644],
  ];
  for (const [sessionId, body, mode] of files)
    await writeFile(join(pending, `${sessionId}.jsonl`), body, {
      mode: mode ?? 0o600,
    });
  await writeFile(join(pending, "notes.txt"), record(running!, "Stop") + "\n", {
    mode: 0o600,
  });
  await mkdir(join(directory, "replay-stale"), { mode: 0o700 });
  const received: string[] = [];
  const checked: unknown[] = [];
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(`${value.sessionId}:${value.eventName}`),
    onLoss: () => assert.fail("Replay reported a transport loss"),
    onSessionLoss: (sessionId) => received.push(`${sessionId}:lost`),
    checkProcesses: async (processes) => {
      checked.push(...processes);
      return processes.filter((entry) => entry.pid === alive.pid);
    },
  });
  try {
    const live = await endpoint(collector.descriptorPath);
    await send(
      live.socketPath,
      frame(live, { event: { ...event, sessionId: running } }),
    );
    await until(() => received.length === 9);
    assert.deepEqual(
      received.filter((entry) => entry.startsWith(running!)),
      [
        `${running}:SessionStart`,
        `${running}:UserPromptSubmit`,
        `${running}:PermissionRequest`,
      ],
    );
    assert.equal(received.at(-1), `${running}:PermissionRequest`);
    assert.deepEqual(
      received.filter((entry) => entry.startsWith(lost!)),
      ["lost", "UserPromptSubmit", "lost", "lost", "Stop", "lost"].map(
        (entry) => `${lost}:${entry}`,
      ),
    );
    assert.equal(checked.length, 3);
    assert.deepEqual(
      (await readdir(directory)).filter(
        (name) => name === "pending" || name.startsWith("replay-"),
      ),
      [],
    );
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
