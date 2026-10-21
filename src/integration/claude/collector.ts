import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeFrame,
  isEpoch,
  isRecord,
  isToken,
  MAX_FRAME_BYTES,
} from "./protocol.ts";
import type { ClaudeEvent, Endpoint } from "./protocol.ts";

export type LossReason =
  "capacity" | "malformed-authenticated-frame" | "consumer-failed";
export interface CollectorOptions {
  directory: string;
  onEvent: (event: ClaudeEvent) => void;
  onLoss: (reason: LossReason) => void;
  // Dependency injection for deterministic drain-only saturation tests; never IPC.
  scheduleDrain?: (callback: () => void) => () => void;
}
export interface CollectorStats {
  accepted: number;
  rejected: number;
  overflow: number;
  consumerFailures: number;
  activeConnections: number;
  queued: number;
  maximumQueue: number;
  queuedBytes: number;
  connectionBytes: number;
  maximumConnectionBytes: number;
  maximumQueuedBytes: number;
  authenticatedOverflow: number;
  firstAuthenticatedOverflowAt: number | null;
}
const uid = process.getuid!();
const socketPrefix = join(tmpdir(), `pagent-${uid}-`);
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o7777) !== 0o700
  )
    throw new Error("Unsafe private endpoint directory");
}
async function readEndpoint(path: string): Promise<Endpoint | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      (info.mode & 0o7777) !== 0o600
    )
      throw new Error("Unsafe endpoint descriptor");
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev)
        throw new Error("Endpoint descriptor changed");
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) throw new Error("Oversized endpoint descriptor");
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, bytesRead),
        ),
      );
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 4 ||
        value.version !== 1 ||
        !isEpoch(value.epoch) ||
        !isToken(value.token) ||
        typeof value.socketPath !== "string" ||
        !value.socketPath.startsWith(socketPrefix) ||
        !/^pagent-\d+-[A-Za-z0-9]+$/.test(
          dirname(value.socketPath).split("/").at(-1) ?? "",
        ) ||
        value.socketPath !== join(dirname(value.socketPath), "socket")
      )
        throw new Error("Invalid endpoint descriptor");
      return {
        version: 1,
        epoch: value.epoch,
        token: value.token,
        socketPath: value.socketPath,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function activeSocket(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      )
        resolve(false);
      else reject(new Error("Cannot establish endpoint ownership"));
    });
  });
}
async function removeSocket(path: string): Promise<void> {
  try {
    await privateDirectory(dirname(path));
    try {
      const info = await lstat(path);
      if (
        !info.isSocket() ||
        info.uid !== uid ||
        (info.mode & 0o7777) !== 0o600
      )
        throw new Error("Unsafe endpoint socket");
      await unlink(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rmdir(dirname(path));
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export async function startCollector(options: CollectorOptions) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await privateDirectory(options.directory);
  const descriptorPath = join(options.directory, "endpoint.json");
  const previous = await readEndpoint(descriptorPath);
  if (previous) {
    try {
      await privateDirectory(dirname(previous.socketPath));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (await activeSocket(previous.socketPath))
      throw new Error("Endpoint already active");
    await removeSocket(previous.socketPath);
    const current = await readEndpoint(descriptorPath);
    if (current?.epoch !== previous.epoch)
      throw new Error("Endpoint owner changed");
    await unlink(descriptorPath);
  }
  const socketDirectory = await mkdtemp(socketPrefix);
  const endpoint: Endpoint = {
    version: 1,
    epoch: randomUUID(),
    token: randomBytes(32).toString("hex"),
    socketPath: join(socketDirectory, "socket"),
  };
  if (Buffer.byteLength(endpoint.socketPath) >= 104) {
    await rmdir(socketDirectory);
    throw new Error("Unix socket path too long");
  }
  const sockets = new Set<Socket>();
  const queue: { event: ClaudeEvent; bytes: number }[] = [];
  let queuedBytes = 0;
  let connectionBytes = 0;
  const counters = {
    accepted: 0,
    rejected: 0,
    overflow: 0,
    consumerFailures: 0,
    maximumQueue: 0,
    maximumQueuedBytes: 0,
    maximumConnectionBytes: 0,
    authenticatedOverflow: 0,
    firstAuthenticatedOverflowAt: null as number | null,
  };
  function checkBounds(): void {
    assert(sockets.size <= 16 && queue.length <= 128);
    assert(queuedBytes >= 0 && queuedBytes <= 128 * MAX_FRAME_BYTES);
    assert(connectionBytes >= 0 && connectionBytes <= 16 * MAX_FRAME_BYTES);
    counters.maximumQueue = Math.max(counters.maximumQueue, queue.length);
    counters.maximumQueuedBytes = Math.max(
      counters.maximumQueuedBytes,
      queuedBytes,
    );
    counters.maximumConnectionBytes = Math.max(
      counters.maximumConnectionBytes,
      connectionBytes,
    );
  }
  let closing = false;
  let cancelDrain: (() => void) | undefined;
  const schedule =
    options.scheduleDrain ??
    ((callback: () => void) => {
      const immediate = setImmediate(callback);
      return () => clearImmediate(immediate);
    });
  function loss(reason: LossReason): void {
    try {
      options.onLoss(reason);
    } catch {
      console.error("Collector loss handler failed");
    }
  }
  function drain(): void {
    cancelDrain = undefined;
    if (closing) return;
    const start = performance.now();
    for (
      let count = 0;
      count < 16 && queue.length && performance.now() - start < 4;
      count++
    ) {
      const { event, bytes } = queue.shift()!;
      queuedBytes -= bytes;
      checkBounds();
      try {
        options.onEvent(event);
      } catch {
        counters.consumerFailures++;
        loss("consumer-failed");
      }
    }
    if (queue.length) cancelDrain = schedule(drain);
  }
  function authenticated(epoch: unknown, token: unknown): boolean {
    return (
      epoch === endpoint.epoch &&
      isToken(token) &&
      timingSafeEqual(
        Buffer.from(token, "hex"),
        Buffer.from(endpoint.token, "hex"),
      )
    );
  }
  function malformed(bytes: Buffer): void {
    counters.rejected++;
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (isRecord(value) && authenticated(value.epoch, value.token))
        loss("malformed-authenticated-frame");
    } catch {
      /* Unauthenticated malformed input cannot assert a session failure. */
    }
  }
  const server = createServer(
    { pauseOnConnect: true, highWaterMark: MAX_FRAME_BYTES + 1 },
    (socket) => {
      if (closing || sockets.size >= 16) {
        counters.overflow++;
        counters.rejected++;
        socket.destroy();
        return;
      }
      sockets.add(socket);
      checkBounds();
      let buffer = Buffer.alloc(0);
      function releaseBuffer(): void {
        connectionBytes -= buffer.length;
        buffer = Buffer.alloc(0);
        checkBounds();
      }
      let finished = false;
      const deadline = setTimeout(() => {
        if (!finished) malformed(buffer);
        finished = true;
        socket.destroy();
      }, 200);
      socket.once("close", () => {
        clearTimeout(deadline);
        sockets.delete(socket);
        releaseBuffer();
      });
      socket.on("error", () => {
        if (!finished) {
          malformed(buffer);
          finished = true;
        }
        socket.destroy();
      });
      socket.on("end", () => {
        if (!finished) {
          malformed(buffer);
          finished = true;
        }
        socket.destroy();
      });
      socket.on("data", (chunk) => {
        if (finished) return;
        if (buffer.length + chunk.length > MAX_FRAME_BYTES) {
          counters.overflow++;
          malformed(buffer);
          releaseBuffer();
          finished = true;
          socket.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        connectionBytes += chunk.length;
        checkBounds();
        const newline = buffer.indexOf(10);
        if (newline === -1) return;
        finished = true;
        if (newline !== buffer.length - 1) malformed(buffer);
        else {
          const frame = decodeFrame(buffer);
          if (!frame) malformed(buffer);
          else if (!authenticated(frame.epoch, frame.token))
            counters.rejected++;
          else if (queue.length >= 128) {
            counters.overflow++;
            counters.authenticatedOverflow++;
            counters.firstAuthenticatedOverflowAt ??= performance.now();
            loss("capacity");
          } else {
            counters.accepted++;
            queue.push({ event: frame.event, bytes: buffer.length });
            queuedBytes += buffer.length;
            checkBounds();
            if (!cancelDrain) cancelDrain = schedule(drain);
          }
        }
        releaseBuffer();
        socket.destroy();
      });
      socket.resume();
    },
  );
  const temporary = join(options.directory, `.endpoint-${endpoint.epoch}.tmp`);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => {
      if (!closing) loss("capacity");
    });
    await chmod(endpoint.socketPath, 0o600);
    await writeFile(temporary, JSON.stringify(endpoint), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    await link(temporary, descriptorPath);
  } catch (error) {
    closing = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeSocket(endpoint.socketPath);
    throw error;
  } finally {
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
  let closed: Promise<void> | undefined;
  return {
    descriptorPath,
    stats(): CollectorStats {
      return {
        ...counters,
        activeConnections: sockets.size,
        queued: queue.length,
        queuedBytes,
        connectionBytes,
      };
    },
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      cancelDrain?.();
      queue.length = 0;
      queuedBytes = 0;
      checkBounds();
      closed = (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          const current = await readEndpoint(descriptorPath);
          if (current?.epoch === endpoint.epoch) await unlink(descriptorPath);
        } finally {
          await removeSocket(endpoint.socketPath);
        }
      })();
      return closed;
    },
  };
}
