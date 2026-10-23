import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isClaudeEvent,
  isEpoch,
  isRecord,
  MAX_FRAME_BYTES,
  type ClaudeEvent,
} from "./protocol.ts";

// The helper stops near 256 KB, but concurrent appends can pass its size check together.
const MAX_SPOOL_BYTES = 524_288;
const MAX_SPOOL_SESSIONS = 32;
// A helper exits within 150 ms of starting, so this outlasts any that opened the old directory.
export const SPOOL_SETTLE_MS = 300;

export interface ClaudeProcess {
  pid: number;
  startedAt: number;
}
export interface SpooledSession {
  sessionId: string;
  // null marks where events went missing.
  entries: (ClaudeEvent | null)[];
}
export type ProcessCheck = (
  processes: ClaudeProcess[],
) => Promise<ClaudeProcess[]>;

const uid = process.getuid!();
const execFileAsync = promisify(execFile);

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function runningProcesses(
  processes: ClaudeProcess[],
): Promise<ClaudeProcess[]> {
  const pids = [...new Set(processes.map((entry) => entry.pid))];
  if (!pids.length) return [];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "pid=,lstart=", "-p", pids.join(",")],
      { env: { ...process.env, LC_ALL: "C" }, timeout: 2000 },
    ));
  } catch (error) {
    // ps exits 1 when any listed process is gone but still prints the others.
    stdout =
      isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
  }
  const started = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    const time = match ? Date.parse(match[2]!) / 1000 : NaN;
    if (match && Number.isFinite(time)) started.set(Number(match[1]), time);
  }
  return processes.filter((entry) => {
    const time = started.get(entry.pid);
    return time !== undefined && Math.abs(time - entry.startedAt) <= 1;
  });
}

// Run after the endpoint is published: a helper that then finds no endpoint has
// already opened the old directory, and one that opens a new directory finds the endpoint.
export async function claimSpool(
  directory: string,
  epoch: string,
): Promise<string | null> {
  for (const name of await readdir(directory))
    if (name.startsWith("replay-"))
      await rm(join(directory, name), { recursive: true, force: true });
  const claimed = join(directory, `replay-${epoch}`);
  try {
    await rename(join(directory, "pending"), claimed);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  return claimed;
}

async function readPrivateFile(path: string): Promise<Buffer | null> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.uid !== uid ||
    (info.mode & 0o7777) !== 0o600 ||
    info.size > MAX_SPOOL_BYTES
  )
    return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(MAX_SPOOL_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytesRead > MAX_SPOOL_BYTES ? null : bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function parseSession(
  sessionId: string,
  bytes: Buffer,
): { session: SpooledSession; process: ClaudeProcess | null } {
  const session: SpooledSession = { sessionId, entries: [] };
  let owner: ClaudeProcess | null = null;
  const lines = bytes.toString("utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1) {
      if (line) session.entries.push(null);
      break;
    }
    let value: unknown;
    try {
      value =
        Buffer.byteLength(line) <= MAX_FRAME_BYTES ? JSON.parse(line) : null;
    } catch {
      value = null;
    }
    if (isRecord(value) && Object.keys(value).length === 1 && value.lost) {
      session.entries.push(null);
      continue;
    }
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      !Number.isInteger(value.pid) ||
      (value.pid as number) <= 1 ||
      (value.pid as number) > 99_999 ||
      !Number.isInteger(value.startedAt) ||
      (value.startedAt as number) < 0 ||
      !isClaudeEvent(value.event) ||
      value.event.sessionId !== sessionId ||
      "inputFingerprint" in value.event
    ) {
      session.entries.push(null);
      continue;
    }
    session.entries.push(value.event);
    owner = { pid: value.pid as number, startedAt: value.startedAt as number };
  }
  return { session, process: owner };
}

export async function readSpool(
  path: string,
  check: ProcessCheck,
): Promise<SpooledSession[]> {
  try {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.uid !== uid ||
      (info.mode & 0o7777) !== 0o700
    )
      return [];
    const found: { session: SpooledSession; process: ClaudeProcess }[] = [];
    for (const name of (await readdir(path)).sort()) {
      if (found.length >= MAX_SPOOL_SESSIONS) break;
      const sessionId = name.slice(0, -".jsonl".length);
      if (!name.endsWith(".jsonl") || !isEpoch(sessionId)) continue;
      const bytes = await readPrivateFile(join(path, name));
      if (!bytes) continue;
      const { session, process } = parseSession(sessionId, bytes);
      if (process) found.push({ session, process });
    }
    const running = await check(found.map((entry) => entry.process));
    return found
      .filter((entry) =>
        running.some(
          (alive) =>
            alive.pid === entry.process.pid &&
            alive.startedAt === entry.process.startedAt,
        ),
      )
      .map((entry) => entry.session);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
