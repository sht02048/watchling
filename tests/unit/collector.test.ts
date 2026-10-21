import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCollector } from "../../src/integration/claude/collector.ts";
import type { LossReason } from "../../src/integration/claude/collector.ts";
import type {
  ClaudeEvent,
  Endpoint,
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
  const directory = await mkdtemp(join(tmpdir(), "pagent-collector-test-"));
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
    await send(observed.socketPath, frame(observed, { token: "b".repeat(64) }));
    await send(
      observed.socketPath,
      frame(observed, { epoch: "00000000-0000-4000-8000-000000000000" }),
    );
    await until(() => collector.stats().rejected === 2);
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
  const directory = await mkdtemp(join(tmpdir(), "pagent-collector-test-"));
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

test("bounded queue marks overflow and resumes finite batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-collector-test-"));
  const received: ClaudeEvent[] = [];
  const losses: LossReason[] = [];
  let pending: (() => void) | undefined;
  const collector = await startCollector({
    directory,
    onEvent: (value) => received.push(value),
    onLoss: (value) => losses.push(value),
    scheduleDrain: (callback) => {
      pending = callback;
      return () => {
        pending = undefined;
      };
    },
  });
  try {
    const target = await endpoint(collector.descriptorPath);
    for (let i = 0; i < 130; i++) await send(target.socketPath, frame(target));
    assert.equal(collector.stats().queued, 128);
    assert.equal(collector.stats().maximumQueue, 128);
    assert.equal(collector.stats().overflow, 2);
    assert.equal(collector.stats().authenticatedOverflow, 2);
    assert.equal(collector.stats().queuedBytes, frame(target).length * 128);
    assert.deepEqual(losses, ["capacity", "capacity"]);
    while (collector.stats().queued > 0) {
      assert.ok(pending);
      pending();
    }
    assert.equal(received.length, 128);
    assert.equal(collector.stats().queuedBytes, 0);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unauthenticated size and connection pressure cannot assert stream loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-collector-test-"));
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
  const directory = await mkdtemp(join(tmpdir(), "pagent-collector-test-"));
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
  const directory = await mkdtemp(join(tmpdir(), "pagent-collector-test-"));
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
