import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isInstalledAppLocation, type AppPaths } from "./app-paths.ts";
import {
  HookManagementError,
  manageClaudeHooks,
  relocateClaudeHooks,
} from "../integration/claude/hook-install.ts";
import { isRecord } from "../integration/claude/protocol.ts";

export interface ConnectionPreferences {
  optedOut: boolean;
  noticeShown: boolean;
}
const defaults: ConnectionPreferences = { optedOut: false, noticeShown: false };

export class PreferenceStore {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  async load(): Promise<ConnectionPreferences> {
    try {
      const file = await open(join(this.directory, "preferences.json"), "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(257);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 256)
          throw new Error("Preference data exceeds size limit");
        text = buffer.toString("utf8", 0, bytesRead);
      } finally {
        await file.close();
      }
      const value: unknown = JSON.parse(text);
      if (
        isRecord(value) &&
        typeof value.optedOut === "boolean" &&
        typeof value.noticeShown === "boolean"
      )
        return { optedOut: value.optedOut, noticeShown: value.noticeShown };
      console.warn("Preferences skipped: invalid data");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        console.warn("Preferences skipped: unreadable data");
    }
    return { ...defaults };
  }

  async save(preferences: ConnectionPreferences): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, "preferences.json");
    const temporary = join(this.directory, `.preferences.${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          optedOut: preferences.optedOut,
          noticeShown: preferences.noticeShown,
        }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function canAutoConnect(
  packaged: boolean,
  executablePath: string,
  home?: string,
): boolean {
  return packaged && isInstalledAppLocation(executablePath, home);
}

function describe(error: unknown): string {
  return error instanceof HookManagementError
    ? `Claude Code connection failed: ${error.message}`
    : "Claude Code connection failed";
}

export class ClaudeConnection {
  readonly available: boolean;
  private readonly paths: AppPaths;
  private readonly helperPath: string;
  private readonly notify: () => void;
  private readonly preferences: PreferenceStore;
  private work: Promise<unknown> = Promise.resolve();
  constructor(options: {
    paths: AppPaths;
    helperPath: string;
    available: boolean;
    notify: () => void;
  }) {
    this.paths = options.paths;
    this.helperPath = options.helperPath;
    this.available = options.available;
    this.notify = options.notify;
    this.preferences = new PreferenceStore(options.paths.userData);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.work.then(task);
    this.work = result.catch(() => undefined);
    return result;
  }

  start(): Promise<void> {
    if (!this.available) return Promise.resolve();
    return this.serialize(async () => {
      try {
        await relocateClaudeHooks(this.paths, this.helperPath);
        const preferences = await this.preferences.load();
        if (preferences.optedOut) return;
        const result = await manageClaudeHooks(
          "install",
          true,
          this.paths,
          this.helperPath,
        );
        if (
          preferences.noticeShown ||
          !result.watchling.diff.some((change) => change.action === "add")
        )
          return;
        this.notify();
        await this.preferences.save({ ...preferences, noticeShown: true });
      } catch (error) {
        console.error(describe(error));
      }
    });
  }

  isConnected(): Promise<boolean> {
    return this.serialize(async () => {
      try {
        const result = await manageClaudeHooks(
          "check",
          false,
          this.paths,
          this.helperPath,
        );
        return result.watchling.status === "installed";
      } catch {
        return false;
      }
    });
  }

  setConnected(connected: boolean): Promise<void> {
    if (!this.available) return Promise.resolve();
    return this.serialize(async () => {
      try {
        const preferences = await this.preferences.load();
        await this.preferences.save({ ...preferences, optedOut: !connected });
        await manageClaudeHooks(
          connected ? "install" : "uninstall",
          true,
          this.paths,
          this.helperPath,
        );
      } catch (error) {
        console.error(describe(error));
      }
    });
  }
}
