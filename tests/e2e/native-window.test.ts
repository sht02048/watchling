import { test, expect, _electron as electron } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface HostStatus {
  pid: number;
  frontmostPid: number;
  fullscreen: boolean;
  mouseDowns: number;
  scrolls: number;
  keyDowns: number;
  bounds: { x: number; y: number; width: number; height: number };
}

async function startHost(binary: string) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 0;
  let failure = "";
  child.stderr.on("data", (chunk: Buffer) => {
    failure = (failure + chunk.toString()).slice(-2048);
  });
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(
    () => readyReject?.(new Error(`Desktop host did not start: ${failure}`)),
    10000,
  );
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.ready === true) {
      clearTimeout(readyTimer);
      readyResolve?.();
    }
    if (typeof value.id !== "number") return;
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    clearTimeout(entry.timer);
    if (typeof value.error === "string") entry.reject(new Error(value.error));
    else entry.resolve(value);
  });
  child.on("exit", (code) => {
    clearTimeout(readyTimer);
    const error = new Error(`Desktop host exited (${code}): ${failure}`);
    readyReject?.(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  });
  child.on("error", (error) => {
    clearTimeout(readyTimer);
    readyReject?.(error);
  });
  function command<T = Record<string, unknown>>(
    command: string,
    fields: Record<string, unknown> = {},
  ): Promise<T> {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Desktop command timed out: ${command}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(JSON.stringify({ ...fields, id, command }) + "\n");
    });
  }
  try {
    await ready;
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    command,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      try {
        await command("quit");
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 3000);
        await exited;
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}

// CGEvent delivery and the 20 Hz native hit-test loop need a bounded settling interval.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 180));

test("real macOS input passes through empty pixels without stealing focus, including fullscreen", async ({}, testInfo) => {
  test.setTimeout(120000);
  const temporary = await mkdtemp(join(tmpdir(), "pagent-native-"));
  try {
    const binary = join(temporary, "DesktopHost");
    await promisify(execFile)("swiftc", [
      resolve("tests/native/DesktopHost.swift"),
      "-o",
      binary,
    ]);
    const application = await electron.launch({
      args: [resolve(".")],
      env: { ...process.env, HOME: temporary },
    });
    let applicationClosed = false;
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      await expect
        .poll(() =>
          application
            .windows()
            .some((page) => page.url() === "pagent://app/pet/index.html"),
        )
        .toBe(true);
      await expect
        .poll(() =>
          application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.webContents.getURL().includes("/pet/"))
              ?.isVisible(),
          ),
        )
        .toBe(true);
      host = await startHost(binary);
      await host.command("activate");
      const initial = await host.command<HostStatus>("status");
      const origin = {
        x: Math.round(initial.bounds.x + initial.bounds.width / 2 - 90),
        y: Math.round(initial.bounds.y + initial.bounds.height / 2 - 90),
      };
      await application.evaluate(({ BrowserWindow }, origin) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("/pet/"))!
          .setPosition(origin.x, origin.y);
      }, origin);
      await expect
        .poll(async () => {
          await host!.command("activate");
          return (await host!.command<HostStatus>("status")).frontmostPid;
        })
        .toBe(initial.pid);
      const click = async (x: number, y: number) => {
        await host!.command("move", { x, y });
        await settle();
        await host!.command("down", { x, y });
        await host!.command("up", { x, y });
      };
      const status = () => host!.command<HostStatus>("status");
      await click(origin.x + 3, origin.y + 3);
      await expect
        .poll(async () => (await status()).mouseDowns)
        .toBe(initial.mouseDowns + 1);
      await host.command("scroll", { delta: 80 });
      await expect
        .poll(async () => (await status()).scrolls)
        .toBeGreaterThan(initial.scrolls);
      await host.command("key");
      await expect
        .poll(async () => (await status()).keyDowns)
        .toBe(initial.keyDowns + 1);
      await application.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes("/pet/"),
        )!;
        for (let i = 0; i < 100; i++)
          pet.webContents.send("pagent:snapshot-changed", {
            state: i % 2 ? "working" : "unknown",
            sessions: [],
            companions: 0,
          });
      });
      expect((await status()).frontmostPid).toBe(initial.pid);
      await host.command("key");
      await expect
        .poll(async () => (await status()).keyDowns)
        .toBe(initial.keyDowns + 2);
      await click(origin.x + 90, origin.y + 94);
      await expect
        .poll(() =>
          application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) =>
                window.webContents.getURL().includes("/sessions/"),
              )!
              .isVisible(),
          ),
        )
        .toBe(true);
      expect((await status()).mouseDowns).toBe(initial.mouseDowns + 1);
      const list = application
        .windows()
        .find((page) => page.url().includes("/sessions/"))!;
      await list.keyboard.press("Escape");
      await host.command("activate");
      const down = { x: origin.x + 90, y: origin.y + 94 };
      await host.command("move", down);
      await settle();
      await host.command("down", down);
      for (const delta of [10, 30, 60, 80]) {
        await host.command("drag", { x: down.x + delta, y: down.y - delta });
        await settle();
      }
      await host.command("up", { x: down.x + 80, y: down.y - 80 });
      await expect
        .poll(() =>
          application.evaluate(({ BrowserWindow }) => {
            const { x, y } = BrowserWindow.getAllWindows()
              .find((window) => window.webContents.getURL().includes("/pet/"))!
              .getBounds();
            return { x, y };
          }),
        )
        .toEqual({ x: origin.x + 80, y: origin.y - 80 });
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) =>
              window.webContents.getURL().includes("/sessions/"),
            )!
            .isVisible(),
        ),
      ).toBe(false);
      let finalPosition = { x: origin.x + 80, y: origin.y - 80 };
      const displays = await application.evaluate(
        ({ screen }, point) => ({
          currentId: screen.getDisplayNearestPoint(point).id,
          areas: screen
            .getAllDisplays()
            .map((display) => ({ id: display.id, ...display.workArea })),
        }),
        down,
      );
      const secondary = displays.areas.find(
        (display) => display.id !== displays.currentId,
      );
      if (secondary) {
        await host.command("place", {
          x:
            secondary.x +
            Math.max(
              0,
              Math.floor((secondary.width - initial.bounds.width) / 2),
            ),
          y:
            secondary.y +
            Math.max(
              0,
              Math.floor((secondary.height - initial.bounds.height) / 2),
            ),
        });
        const targetHost = (await status()).bounds;
        const startPoint = { x: finalPosition.x + 90, y: finalPosition.y + 94 };
        const targetPoint = {
          x: Math.round(targetHost.x + targetHost.width / 2),
          y: Math.round(targetHost.y + targetHost.height / 2),
        };
        await host.command("move", startPoint);
        await settle();
        await host.command("down", startPoint);
        await host.command("drag", targetPoint);
        await settle();
        await host.command("up", targetPoint);
        finalPosition = { x: targetPoint.x - 90, y: targetPoint.y - 94 };
        await expect
          .poll(() =>
            application.evaluate(({ BrowserWindow }) => {
              const { x, y } = BrowserWindow.getAllWindows()
                .find((window) =>
                  window.webContents.getURL().includes("/pet/"),
                )!
                .getBounds();
              return { x, y };
            }),
          )
          .toEqual(finalPosition);
      }
      await host.command("fullscreen");
      await expect
        .poll(async () => (await status()).fullscreen, { timeout: 10000 })
        .toBe(true);
      await settle();
      const electronPid = application.process().pid!;
      const visible = await host.command<{
        windows: { width: number; height: number; onscreen: boolean }[];
      }>("observe", { pid: electronPid });
      expect(
        visible.windows.some(
          (window) =>
            window.width === 180 && window.height === 180 && window.onscreen,
        ),
      ).toBe(true);
      const countBefore = (await status()).mouseDowns;
      await click(finalPosition.x + 3, finalPosition.y + 3);
      await expect
        .poll(async () => (await status()).mouseDowns)
        .toBe(countBefore + 1);
      expect((await status()).frontmostPid).toBe(initial.pid);
      const evidence = {
        runtime: await application.evaluate(({ app }) => ({
          version: app.getVersion(),
          electron: process.versions.electron,
        })),
        initial,
        final: await status(),
        visiblePetWindows: visible.windows,
        displays,
        crossDisplayDragVerified: Boolean(secondary),
        verified: [
          "transparent click and scroll",
          "body-only click",
          "100 updates retain external app focus",
          "keyboard input retained",
          "80px physical drag preserves initial offset",
          "fullscreen Space overlay and click-through",
        ],
      };
      await application.close();
      applicationClosed = true;
      const restarted = await electron.launch({
        args: [resolve(".")],
        env: { ...process.env, HOME: temporary },
      });
      try {
        await expect
          .poll(() =>
            restarted.evaluate(({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows().find((window) =>
                window.webContents.getURL().includes("/pet/"),
              );
              if (!window?.isVisible()) return null;
              const { x, y } = window.getBounds();
              return { x, y };
            }),
          )
          .toEqual(finalPosition);
      } finally {
        await restarted.close();
      }
      evidence.verified.push("position restored after process restart");
      const evidencePath = testInfo.outputPath("native-macos-evidence.json");
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      await testInfo.attach("native-macos-evidence", {
        path: evidencePath,
        contentType: "application/json",
      });
    } finally {
      try {
        await host?.close();
      } finally {
        if (!applicationClosed) await application.close();
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
