import { constants, type Stats } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AppPaths } from "../../main/app-paths.ts";
import { hookEvents, isEpoch, isRecord } from "./protocol.ts";

export const SETTINGS_LIMIT = 1024 * 1024;
export const MANIFEST_LIMIT = 128 * 1024;
const LOCK_MAGIC = Buffer.from("pagent-hook-lock-v1\n");
// Darwin sys/fcntl.h defines O_EXLOCK as 0x20. Node forwards numeric open flags
// but does not export this flag; never use it on another platform.
const DARWIN_O_EXLOCK = 0x20;
const uid = process.getuid?.();

export type HookOperation = "check" | "install" | "uninstall";
type JsonObject = Record<string, unknown>;
interface Handler extends JsonObject {
  type: "command";
  command: string;
  timeout: 1;
}
interface OwnedHook {
  event: string;
  matcher: string;
  handler: Handler;
  createdEvent: boolean;
}
interface Manifest {
  version: 1;
  installationId: string;
  settingsPath: string;
  helperPath: string;
  descriptorPath: string;
  createdHooks: boolean;
  hooks: OwnedHook[];
}
interface Snapshot {
  bytes: Buffer;
  hash: string;
  stat: Stats;
}
interface Settings {
  snapshot: Snapshot | null;
  value: JsonObject;
}
interface Location {
  event: string;
  group: JsonObject;
  handler: JsonObject;
}
interface State {
  settings: Settings;
  manifest: Manifest | null;
  manifestSnapshot: Snapshot | null;
  owned: Map<string, Location>;
}
export interface HookReport {
  mode: "check" | "preview" | "apply";
  targets: {
    settings: string;
    manifest: string;
    helper: string;
    descriptor: string;
  };
  pagent: {
    operation: HookOperation;
    status:
      | "installed"
      | "not-installed"
      | "prepared"
      | "partial"
      | "would-install"
      | "would-uninstall";
    diff: { event: string; matcher: string; action: "add" | "remove" }[];
  };
}

export class HookManagementError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2 = 2) {
    super(message);
    this.name = "HookManagementError";
    this.exitCode = exitCode;
  }
}

function refuse(message: string): never {
  throw new HookManagementError(message);
}
function failed(message: string): never {
  throw new HookManagementError(message, 1);
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameSnapshot(a: Snapshot | null, b: Snapshot | null): boolean {
  return a === null
    ? b === null
    : b !== null && sameFile(a.stat, b.stat) && a.hash === b.hash;
}
function safeAbsolute(path: string): boolean {
  return (
    isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path)
  );
}
function validateLayout(paths: AppPaths, helperPath: string): string {
  if (uid === undefined)
    refuse("Hook management requires a Unix user identity");
  if (
    Object.values(paths).some((path) => !safeAbsolute(path)) ||
    !safeAbsolute(helperPath)
  )
    refuse(
      "Hook paths must be normalized absolute paths without control characters",
    );
  const home = dirname(dirname(paths.settingsPath));
  if (
    paths.settingsPath !== join(home, ".claude", "settings.json") ||
    paths.userData !== join(home, "Library", "Application Support", "pagent") ||
    paths.manifestPath !== join(paths.userData, "hooks-installation.json") ||
    paths.lockPath !== join(paths.userData, "hooks-install.lock") ||
    paths.backupDirectory !== join(paths.userData, "hook-backups") ||
    paths.descriptorPath !== join(paths.userData, "endpoint.json")
  )
    refuse("Unsupported hook path layout");
  if (Object.values(paths).includes(helperPath))
    refuse("The helper conflicts with an installer target");
  return home;
}
async function metadata(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (
      hasCode(error, "ENOTDIR") ||
      hasCode(error, "ELOOP") ||
      hasCode(error, "ENAMETOOLONG")
    )
      refuse("Unsupported hook path");
    throw error;
  }
}
function regular(
  stat: Stats,
  privateFile: boolean,
  allowHardLinks = false,
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (allowHardLinks ? stat.nlink < 1 : stat.nlink !== 1) ||
    (privateFile ? (stat.mode & 0o7777) !== 0o600 : (stat.mode & 0o6022) !== 0)
  )
    refuse("Unsafe file type, ownership, links, or permissions");
}
async function directory(
  path: string,
  privateDirectory: boolean,
): Promise<boolean> {
  const stat = await metadata(path);
  if (!stat) return false;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (privateDirectory
      ? (stat.mode & 0o7777) !== 0o700
      : (stat.mode & 0o022) !== 0)
  )
    refuse("Unsafe directory type, ownership, or permissions");
  return true;
}
async function readBounded(
  path: string,
  limit: number,
  privateFile: boolean,
  allowHardLinks = false,
): Promise<Snapshot | null> {
  const before = await metadata(path);
  if (!before) return null;
  regular(before, privateFile, allowHardLinks);
  if (before.size > limit) refuse("Hook file exceeds its size limit");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    regular(stat, privateFile, allowHardLinks);
    if (!sameFile(before, stat)) failed("Hook file changed while opening");
    if (stat.size > limit) refuse("Hook file exceeds its size limit");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) refuse("Hook file exceeds its size limit");
    const after = await file.stat();
    if (
      after.size !== length ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      failed("Hook file changed while reading");
    const bytes = buffer.subarray(0, length);
    return { bytes, hash: hash(bytes), stat: after };
  } finally {
    await file.close();
  }
}
// Compare decimal values, not their notation or their binary approximation.
// A nonzero round-trippable value in a bounded file cannot need an exponent
// with more than seven significant digits, even with cancelling fraction zeros.
function canonicalDecimal(source: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) refuse("Unsupported JSON number");
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits.length === 0) return "0";
  const significant = digits.replace(/0+$/, "");
  const exponentText = match[4] ?? "0";
  const exponentDigits = exponentText.replace(/^[+-]?0*/, "");
  if (exponentDigits.length > 7) refuse("Unsupported JSON number exponent");
  const exponent =
    Number(exponentText) - fraction.length + digits.length - significant.length;
  return `${match[1]}${significant}e${exponent}`;
}
function parse(snapshot: Snapshot): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes),
      (
        _key: string,
        value: unknown,
        context?: { source?: string },
      ): unknown => {
        if (typeof value === "number") {
          const encoded = JSON.stringify(value);
          if (
            !Number.isFinite(value) ||
            Object.is(value, -0) ||
            typeof context?.source !== "string" ||
            typeof encoded !== "string" ||
            canonicalDecimal(context.source) !== canonicalDecimal(encoded)
          )
            refuse(
              "JSON number cannot round-trip without changing its decimal value",
            );
        }
        return value;
      },
    ) as unknown;
  } catch {
    return refuse("Hook file has invalid or unsupported UTF-8 JSON");
  }
}
function settingsObject(value: unknown): JsonObject {
  if (!isRecord(value)) refuse("Claude settings must be a JSON object");
  if ("hooks" in value) {
    if (!isRecord(value.hooks))
      refuse("Claude hooks must be an object of event arrays");
    for (const groups of Object.values(value.hooks)) {
      if (!Array.isArray(groups))
        refuse("Claude hook events must contain arrays");
      for (const group of groups) {
        if (
          !isRecord(group) ||
          ("matcher" in group && typeof group.matcher !== "string") ||
          !Array.isArray(group.hooks) ||
          group.hooks.some(
            (handler) => !isRecord(handler) || typeof handler.type !== "string",
          )
        )
          refuse("Unsupported Claude hook group or handler schema");
      }
    }
  }
  return value;
}
async function readSettings(paths: AppPaths, home: string): Promise<Settings> {
  if (!(await directory(home, false))) refuse("Home directory does not exist");
  await directory(dirname(paths.settingsPath), false);
  const snapshot = await readBounded(paths.settingsPath, SETTINGS_LIMIT, false);
  return { snapshot, value: snapshot ? settingsObject(parse(snapshot)) : {} };
}

export function quoteHookArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function intended(
  installationId: string,
  helperPath: string,
  descriptorPath: string,
): Handler {
  return {
    type: "command",
    command: [
      helperPath,
      "--installation-id",
      installationId,
      "--descriptor",
      descriptorPath,
    ]
      .map(quoteHookArgument)
      .join(" "),
    timeout: 1,
  };
}
function createManifest(
  paths: AppPaths,
  helperPath: string,
  value: JsonObject,
): Manifest {
  const installationId = randomUUID();
  const handler = intended(installationId, helperPath, paths.descriptorPath);
  return {
    version: 1,
    installationId,
    settingsPath: paths.settingsPath,
    helperPath,
    descriptorPath: paths.descriptorPath,
    createdHooks: !("hooks" in value),
    hooks: hookEvents.map((event) => ({
      event,
      matcher: event === "Notification" ? "permission_prompt" : "",
      handler: { ...handler },
      createdEvent: !isRecord(value.hooks) || !(event in value.hooks),
    })),
  };
}
function exactObject(a: unknown, b: unknown): boolean {
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && exactObject(a[key], b[key]))
    );
  }
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((value, index) => exactObject(value, b[index]))
    );
  return a === b;
}
function manifestObject(value: unknown, paths: AppPaths): Manifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isEpoch(value.installationId) ||
    value.settingsPath !== paths.settingsPath ||
    value.descriptorPath !== paths.descriptorPath ||
    typeof value.helperPath !== "string" ||
    !safeAbsolute(value.helperPath) ||
    typeof value.createdHooks !== "boolean" ||
    !Array.isArray(value.hooks) ||
    value.hooks.length !== hookEvents.length ||
    Object.keys(value).length !== 7
  )
    refuse("Unsafe or unsupported installation manifest");
  const handler = intended(
    value.installationId,
    value.helperPath,
    paths.descriptorPath,
  );
  const hooks: OwnedHook[] = [];
  for (const [index, event] of hookEvents.entries()) {
    const item: unknown = value.hooks[index];
    if (
      !isRecord(item) ||
      typeof item.createdEvent !== "boolean" ||
      (value.createdHooks && !item.createdEvent) ||
      !exactObject(item, {
        event,
        matcher: event === "Notification" ? "permission_prompt" : "",
        handler,
        createdEvent: item.createdEvent,
      })
    )
      refuse("Unsafe or unsupported manifest ownership records");
    hooks.push({
      event,
      matcher: event === "Notification" ? "permission_prompt" : "",
      handler: { ...handler },
      createdEvent: item.createdEvent,
    });
  }
  return {
    version: 1,
    installationId: value.installationId,
    settingsPath: paths.settingsPath,
    helperPath: value.helperPath,
    descriptorPath: paths.descriptorPath,
    createdHooks: value.createdHooks,
    hooks,
  };
}
async function privatePaths(paths: AppPaths, home: string): Promise<void> {
  for (const path of [
    join(home, "Library"),
    join(home, "Library", "Application Support"),
  ])
    await directory(path, false);
  await directory(paths.userData, true);
  if (await directory(paths.backupDirectory, true))
    await validateBackups(paths);
  const descriptor = await metadata(paths.descriptorPath);
  if (descriptor) regular(descriptor, true);
  await readLock(paths);
}
function locations(value: JsonObject): Location[] {
  const result: Location[] = [];
  if (!isRecord(value.hooks)) return result;
  for (const [event, groups] of Object.entries(value.hooks)) {
    for (const group of groups as JsonObject[]) {
      for (const handler of group.hooks as JsonObject[])
        result.push({ event, group, handler });
    }
  }
  return result;
}
function ownership(
  value: JsonObject,
  manifest: Manifest | null,
  helperPath: string,
  descriptorPath: string,
): Map<string, Location> {
  const owned = new Map<string, Location>();
  for (const location of locations(value)) {
    const command = location.handler.command;
    const text = JSON.stringify(location.handler);
    const marked = manifest !== null && text.includes(manifest.installationId);
    const helperHint =
      typeof command === "string" &&
      (command.includes(helperPath) ||
        command.includes(quoteHookArgument(helperPath)) ||
        (manifest !== null &&
          (command.includes(manifest.helperPath) ||
            command.includes(quoteHookArgument(manifest.helperPath)))) ||
        (command.includes("--installation-id") &&
          (command.includes("pagent-hook-emitter") ||
            command.includes(descriptorPath) ||
            command.includes(quoteHookArgument(descriptorPath)))));
    if (!marked && !helperHint) continue;
    if (!manifest)
      refuse("Pagent-like handlers exist without a private ownership manifest");
    const expected = manifest.hooks.find(
      (hook) => hook.event === location.event,
    );
    if (
      !expected ||
      location.group.matcher !== expected.matcher ||
      !exactObject(location.handler, expected.handler) ||
      owned.has(expected.event)
    )
      refuse(
        "Owned hook was modified, moved, duplicated, or conflicts with the helper",
      );
    owned.set(expected.event, location);
  }
  return owned;
}
async function inspect(
  paths: AppPaths,
  helperPath: string,
  home: string,
): Promise<State> {
  // Settings are checked before any installer path can be created or changed.
  const settings = await readSettings(paths, home);
  await privatePaths(paths, home);
  const manifestSnapshot = await readBounded(
    paths.manifestPath,
    MANIFEST_LIMIT,
    true,
  );
  const manifest = manifestSnapshot
    ? manifestObject(parse(manifestSnapshot), paths)
    : null;
  return {
    settings,
    manifest,
    manifestSnapshot,
    owned: ownership(
      settings.value,
      manifest,
      helperPath,
      paths.descriptorPath,
    ),
  };
}
async function validateHelper(path: string): Promise<void> {
  const before = await metadata(path);
  if (!before) refuse("The packaged hook helper is missing");
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid ||
    (before.mode & 0o111) === 0 ||
    (before.mode & 0o6022) !== 0 ||
    before.nlink !== 1
  )
    refuse("The packaged hook helper must be a safe, owned regular executable");
  try {
    await access(path, constants.X_OK);
  } catch {
    refuse("The packaged hook helper is not executable");
  }
  const after = await metadata(path);
  if (
    !after ||
    !sameFile(before, after) ||
    before.mode !== after.mode ||
    before.ctimeMs !== after.ctimeMs ||
    before.mtimeMs !== after.mtimeMs
  )
    failed("The hook helper changed during validation");
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function ensureDirectory(
  path: string,
  privateDirectory: boolean,
): Promise<void> {
  if (await directory(path, privateDirectory)) return;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await directory(path, privateDirectory);
  await syncDirectory(dirname(path));
}
async function ensurePrivateDirectories(
  paths: AppPaths,
  home: string,
): Promise<void> {
  for (const path of [
    join(home, "Library"),
    join(home, "Library", "Application Support"),
  ])
    await ensureDirectory(path, false);
  await ensureDirectory(paths.userData, true);
}
async function temporary(path: string, bytes: Buffer): Promise<string> {
  const name = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(
    name,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(name);
    throw error;
  }
  await file.close();
  return name;
}
async function discardTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}
async function publishManifest(
  paths: AppPaths,
  manifest: Manifest,
  lock: OwnedLock,
): Promise<Snapshot> {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > MANIFEST_LIMIT)
    refuse("Installation manifest exceeds its size limit");
  await assertLock(paths, lock);
  const temp = await temporary(paths.manifestPath, bytes);
  try {
    await assertLock(paths, lock);
    if (await metadata(paths.manifestPath))
      failed("Installation manifest changed before publication");
    await rename(temp, paths.manifestPath);
    await syncDirectory(paths.userData);
    try {
      const saved = await readBounded(paths.manifestPath, MANIFEST_LIMIT, true);
      if (!saved || saved.hash !== hash(bytes))
        failed("Installation manifest verification failed");
      return saved;
    } catch {
      failed("Installation manifest verification failed");
    }
  } finally {
    await discardTemporary(temp);
  }
}
interface OwnedLock {
  snapshot: Snapshot;
  parent: Stats;
  file: FileHandle;
}
async function readLock(paths: AppPaths): Promise<Snapshot | null> {
  // An interrupted hard-link publication may leave its private temporary name.
  // Multiple links to this same inode do not split the kernel lock domain.
  const snapshot = await readBounded(
    paths.lockPath,
    LOCK_MAGIC.length,
    true,
    true,
  );
  if (snapshot && !snapshot.bytes.equals(LOCK_MAGIC))
    refuse("Unrecognized installer lock ownership magic");
  return snapshot;
}
async function publishLock(paths: AppPaths): Promise<Snapshot> {
  const existing = await readLock(paths);
  if (existing) return existing;
  const temp = join(paths.userData, `.hooks-install.lock.${randomUUID()}.tmp`);
  const file = await open(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let prepared: Stats | null = null;
  try {
    prepared = await file.stat();
    await file.chmod(0o600);
    await file.writeFile(LOCK_MAGIC);
    await file.sync();
    const source = await readBounded(temp, LOCK_MAGIC.length, true);
    if (
      !source ||
      !sameFile(prepared, source.stat) ||
      !source.bytes.equals(LOCK_MAGIC)
    )
      failed("Installer lock preparation changed");
    await directory(paths.userData, true);
    let linked = false;
    try {
      // Unlike rename, link never replaces a concurrent actor's public target.
      await link(temp, paths.lockPath);
      linked = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    await syncDirectory(paths.userData);
    const published = await readLock(paths);
    if (!published || (linked && !sameFile(prepared, published.stat)))
      failed("Installer lock changed during publication");
    return published;
  } finally {
    try {
      const current = await metadata(temp);
      if (current && prepared && sameFile(current, prepared))
        await unlink(temp);
    } finally {
      await file.close();
    }
  }
}
async function assertLock(paths: AppPaths, lock: OwnedLock): Promise<void> {
  try {
    await directory(paths.userData, true);
    const parent = await metadata(paths.userData);
    const held = await lock.file.stat();
    regular(held, true, true);
    if (
      !parent ||
      !sameFile(parent, lock.parent) ||
      !sameFile(held, lock.snapshot.stat) ||
      held.size !== LOCK_MAGIC.length ||
      !sameSnapshot(lock.snapshot, await readLock(paths))
    )
      failed("Installer lock path or inode changed");
  } catch {
    failed("Installer lock verification failed; retry explicitly");
  }
}
async function acquireLock(paths: AppPaths): Promise<OwnedLock> {
  const parent = await metadata(paths.userData);
  if (!parent) failed("Installer lock parent disappeared");
  const snapshot = await publishLock(paths);
  let file: FileHandle;
  try {
    // The mutating Node/Electron process owns this descriptor. O_EXLOCK acquires
    // the kernel lock atomically with open; O_NONBLOCK makes contention refuse.
    file = await open(
      paths.lockPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        DARWIN_O_EXLOCK,
    );
  } catch (error) {
    if (hasCode(error, "EAGAIN") || hasCode(error, "EWOULDBLOCK"))
      refuse("Installer lock is held by another writer");
    if (
      hasCode(error, "ELOOP") ||
      hasCode(error, "ENOENT") ||
      hasCode(error, "ENOTDIR")
    )
      refuse("Installer lock target changed while opening");
    throw error;
  }
  try {
    const lock = { snapshot, parent, file };
    await assertLock(paths, lock);
    return lock;
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function releaseLock(paths: AppPaths, lock: OwnedLock): Promise<void> {
  try {
    await assertLock(paths, lock);
  } finally {
    // All protected writes and their awaited temporary-file cleanup have settled.
    // Keep the permanent public inode; closing this descriptor releases flock.
    await lock.file.close();
  }
}
const backupName =
  /^hooks-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
async function validateBackups(paths: AppPaths): Promise<Map<string, Stats>> {
  const backups = new Map<string, Stats>();
  for (const name of await readdir(paths.backupDirectory)) {
    const stat = await metadata(join(paths.backupDirectory, name));
    if (!stat) failed("Installer backup changed");
    regular(stat, true);
    if (stat.size > SETTINGS_LIMIT)
      refuse("Installer backup exceeds its size limit");
    if (backupName.test(name)) backups.set(name, stat);
  }
  return backups;
}
async function backup(
  paths: AppPaths,
  snapshot: Snapshot | null,
  lock: OwnedLock,
): Promise<void> {
  await assertLock(paths, lock);
  await ensureDirectory(paths.backupDirectory, true);
  const backups = await validateBackups(paths);
  const names = [...backups.keys()].sort();
  // Prune before creation so even an interrupted write retains at most three backups.
  while (names.length >= 3) {
    const name = names.shift();
    if (name) {
      const path = join(paths.backupDirectory, name);
      const current = await metadata(path);
      const previous = backups.get(name);
      if (!current || !previous || !sameFile(current, previous))
        failed("Installer backup changed before pruning");
      regular(current, true);
      await assertLock(paths, lock);
      await unlink(path);
    }
  }
  const path = join(
    paths.backupDirectory,
    `hooks-${Date.now()}-${randomUUID()}.json`,
  );
  await assertLock(paths, lock);
  const temp = await temporary(path, snapshot?.bytes ?? Buffer.alloc(0));
  try {
    await assertLock(paths, lock);
    await rename(temp, path);
    await syncDirectory(paths.backupDirectory);
  } finally {
    await discardTemporary(temp);
  }
}
function plan(
  state: State,
  manifest: Manifest,
  operation: HookOperation,
): HookReport["pagent"]["diff"] {
  const action = operation === "uninstall" ? "remove" : "add";
  return manifest.hooks
    .filter((hook) =>
      operation === "uninstall"
        ? state.owned.has(hook.event)
        : !state.owned.has(hook.event),
    )
    .map((hook) => ({ event: hook.event, matcher: hook.matcher, action }));
}
function changeSettings(
  state: State,
  manifest: Manifest,
  operation: "install" | "uninstall",
): Buffer {
  const value = state.settings.value;
  if (operation === "install") {
    if (!isRecord(value.hooks)) value.hooks = {};
    const hooks = value.hooks as JsonObject;
    for (const hook of manifest.hooks) {
      if (state.owned.has(hook.event)) continue;
      if (!Object.hasOwn(hooks, hook.event)) hooks[hook.event] = [];
      // A separate group avoids taking ownership of any pre-existing matcher group.
      (hooks[hook.event] as unknown[]).push({
        matcher: hook.matcher,
        hooks: [{ ...hook.handler }],
      });
    }
  } else if (isRecord(value.hooks)) {
    for (const hook of manifest.hooks) {
      const location = state.owned.get(hook.event);
      if (!location) continue;
      const handlers = location.group.hooks as JsonObject[];
      handlers.splice(handlers.indexOf(location.handler), 1);
      const groups = value.hooks[hook.event] as JsonObject[];
      if (
        handlers.length === 0 &&
        exactObject(location.group, { matcher: hook.matcher, hooks: [] })
      )
        groups.splice(groups.indexOf(location.group), 1);
      if (groups.length === 0 && hook.createdEvent)
        delete value.hooks[hook.event];
    }
    if (manifest.createdHooks && Object.keys(value.hooks).length === 0)
      delete value.hooks;
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > SETTINGS_LIMIT)
    refuse("Updated settings exceed their size limit");
  return bytes;
}
async function replaceSettings(
  paths: AppPaths,
  home: string,
  before: Snapshot | null,
  bytes: Buffer,
  lock: OwnedLock,
): Promise<Snapshot> {
  await backup(paths, before, lock);
  await assertLock(paths, lock);
  await ensureDirectory(dirname(paths.settingsPath), false);
  const temp = await temporary(paths.settingsPath, bytes);
  try {
    try {
      await assertLock(paths, lock);
      const current = await readSettings(paths, home);
      if (!sameSnapshot(before, current.snapshot))
        failed("Settings changed before replacement; retry explicitly");
      await assertLock(paths, lock);
    } catch {
      failed("Settings changed before replacement; retry explicitly");
    }
    // This narrows the race; rename is not a CAS against noncooperative writers.
    await rename(temp, paths.settingsPath);
    await syncDirectory(dirname(paths.settingsPath));
    try {
      const written = await readSettings(paths, home);
      if (
        !written.snapshot ||
        written.snapshot.hash !== hash(bytes) ||
        (written.snapshot.stat.mode & 0o7777) !== 0o600
      )
        failed("Settings verification failed; the manifest was retained");
      return written.snapshot;
    } catch {
      failed("Settings verification failed; the manifest was retained");
    }
  } finally {
    await discardTemporary(temp);
  }
}
async function removeManifest(
  paths: AppPaths,
  home: string,
  state: State,
  expected: Snapshot | null,
  lock: OwnedLock,
): Promise<void> {
  try {
    await assertLock(paths, lock);
    if (!state.manifest || !state.manifestSnapshot)
      failed("Installation manifest is missing");
    const current = await readSettings(paths, home);
    if (!sameSnapshot(expected, current.snapshot))
      failed("Settings changed before removal verification");
    if (
      ownership(
        current.value,
        state.manifest,
        state.manifest.helperPath,
        paths.descriptorPath,
      ).size
    )
      failed("Owned hooks remain");
    const manifest = await readBounded(
      paths.manifestPath,
      MANIFEST_LIMIT,
      true,
    );
    if (!sameSnapshot(state.manifestSnapshot, manifest))
      failed("Manifest changed before removal");
    await assertLock(paths, lock);
  } catch {
    failed("Removal verification failed; the manifest was retained");
  }
  await unlink(paths.manifestPath);
  await syncDirectory(paths.userData);
}
function report(
  operation: HookOperation,
  apply: boolean,
  paths: AppPaths,
  helperPath: string,
  state: State,
  diff: HookReport["pagent"]["diff"],
): HookReport {
  let status: HookReport["pagent"]["status"];
  if (operation === "uninstall")
    status = diff.length ? "would-uninstall" : "not-installed";
  else if (operation === "install" && diff.length) status = "would-install";
  else if (!state.manifest) status = "not-installed";
  else
    status =
      state.owned.size === hookEvents.length
        ? "installed"
        : state.owned.size
          ? "partial"
          : "prepared";
  return {
    mode: operation === "check" ? "check" : apply ? "apply" : "preview",
    targets: {
      settings: paths.settingsPath,
      manifest: paths.manifestPath,
      helper: state.manifest?.helperPath ?? helperPath,
      descriptor: paths.descriptorPath,
    },
    pagent: { operation, status, diff },
  };
}

export async function manageClaudeHooks(
  operation: HookOperation,
  apply: boolean,
  paths: AppPaths,
  helperPath: string,
): Promise<HookReport> {
  if (apply && process.platform !== "darwin")
    refuse("Applying Claude hooks requires Darwin kernel locking");
  const home = validateLayout(paths, helperPath);
  let state = await inspect(paths, helperPath, home);
  if (operation === "install") {
    if (state.manifest && state.manifest.helperPath !== helperPath)
      refuse(
        "The helper path moved; uninstall the recorded installation first",
      );
    await validateHelper(helperPath);
  }
  let manifest =
    state.manifest ?? createManifest(paths, helperPath, state.settings.value);
  let diff = plan(state, manifest, operation);
  if (operation === "check")
    return report(operation, false, paths, helperPath, state, diff);
  if (!apply) {
    if (diff.length) changeSettings(state, manifest, operation);
    return report(operation, false, paths, helperPath, state, diff);
  }
  if (
    (operation === "uninstall" && !state.manifest) ||
    (operation === "install" && state.manifest && diff.length === 0)
  )
    return report(operation, true, paths, helperPath, state, diff);

  await ensurePrivateDirectories(paths, home);
  const lock = await acquireLock(paths);
  try {
    state = await inspect(paths, helperPath, home);
    if (operation === "install") {
      if (state.manifest && state.manifest.helperPath !== helperPath)
        refuse(
          "The helper path moved; uninstall the recorded installation first",
        );
      await validateHelper(helperPath);
    }
    manifest =
      state.manifest ?? createManifest(paths, helperPath, state.settings.value);
    diff = plan(state, manifest, operation);
    const result = report(operation, true, paths, helperPath, state, diff);
    if (operation === "uninstall" && !state.manifest) return result;
    // Build and bound the proposed settings before persisting installation intent.
    const bytes = diff.length
      ? changeSettings(state, manifest, operation)
      : null;
    if (operation === "install" && !state.manifest) {
      state.manifestSnapshot = await publishManifest(paths, manifest, lock);
      state.manifest = manifest;
    }
    const written = bytes
      ? await replaceSettings(paths, home, state.settings.snapshot, bytes, lock)
      : state.settings.snapshot;
    if (operation === "uninstall") {
      await removeManifest(paths, home, state, written, lock);
      result.pagent.status = "not-installed";
    } else result.pagent.status = "installed";
    return result;
  } finally {
    await releaseLock(paths, lock);
  }
}
