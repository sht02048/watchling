import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  stateLabels,
  type SemanticState,
} from "../../src/shared/ui-contract.ts";

test("native pet uses isolated UI, continuous animation and a read-only list", async () => {
  const home = await mkdtemp(join(tmpdir(), "pagent-electron-"));
  const application = await electron.launch({
    args: [resolve(".")],
    env: { ...process.env, HOME: home },
  });
  const errors: string[] = [];
  try {
    await expect
      .poll(() =>
        application
          .windows()
          .map((page) => page.url())
          .sort(),
      )
      .toEqual([
        "pagent://app/pet/index.html",
        "pagent://app/sessions/index.html",
      ]);
    const page = application
      .windows()
      .find((page) => page.url() === "pagent://app/pet/index.html")!;
    page.on("pageerror", (error) => errors.push(error.message));
    await expect.poll(() => page.url()).toBe("pagent://app/pet/index.html");
    await expect.poll(() => application.windows().length).toBe(2);
    const sessionPage = application
      .windows()
      .find((window) => window.url().includes("/sessions/"));
    expect(sessionPage).toBeDefined();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().includes("/pet/"))
            ?.isVisible(),
        ),
      )
      .toBe(true);
    const native = await application.evaluate(({ app, BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("/pet/"),
      )!;
      const metrics = app
        .getAppMetrics()
        .find((process) => process.pid === pet.webContents.getOSProcessId());
      return {
        userData: app.getPath("userData"),
        visible: pet.isVisible(),
        alwaysOnTop: pet.isAlwaysOnTop(),
        allSpaces: pet.isVisibleOnAllWorkspaces(),
        focusable: pet.isFocusable(),
        sandbox: metrics?.sandboxed,
      };
    });
    expect(native.userData.startsWith(home)).toBe(true);
    expect(native).toMatchObject({
      visible: true,
      alwaysOnTop: true,
      allSpaces: true,
      focusable: false,
      sandbox: true,
    });
    expect(
      await page.evaluate(() => ({
        require: typeof Reflect.get(window, "require"),
        process: typeof Reflect.get(window, "process"),
        rawIpc: typeof Reflect.get(window.pagent, "ipcRenderer"),
      })),
    ).toEqual({
      require: "undefined",
      process: "undefined",
      rawIpc: "undefined",
    });
    for (const motion of ["reduce", "no-preference"] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      for (const state of [
        "idle",
        "working",
        "unknown",
        "asking",
      ] as SemanticState[]) {
        await application.evaluate(({ BrowserWindow }, state) => {
          const pet = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().includes("/pet/"),
          )!;
          pet.webContents.send("pagent:snapshot-changed", {
            state,
            sessions: [],
            observation: "시험 입력",
          });
        }, state);
        await expect(page.locator("canvas")).toHaveAttribute(
          "aria-label",
          new RegExp(stateLabels[state]),
        );
        const before = await page
          .locator("canvas")
          .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
        await expect
          .poll(() =>
            page
              .locator("canvas")
              .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL()),
          )
          .not.toBe(before);
      }
    }
    await page.mouse.click(3, 3);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("/sessions/"))!
          .isVisible(),
      ),
    ).toBe(false);
    await page.mouse.click(90, 94);
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
    await expect(sessionPage!.locator("#observation")).toContainText(
      "아직 Claude Code 신호를 수신하지 않았어요",
    );
    await sessionPage!.keyboard.press("Escape");
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
      .toBe(false);
    await sessionPage!.evaluate(() => window.pagent.openSessionList());
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("/sessions/"))!
          .isVisible(),
      ),
    ).toBe(false);
    await expect(
      page.evaluate(async () => {
        try {
          await fetch("pagent://app/main/index.js");
          return false;
        } catch {
          return true;
        }
      }),
    ).resolves.toBe(true);
    const helper = join(
      execFileSync(
        "swift",
        [
          "build",
          "--package-path",
          "native/hook-emitter",
          "-c",
          "release",
          "--show-bin-path",
        ],
        { encoding: "utf8" },
      ).trim(),
      "pagent-hook-emitter",
    );
    await new Promise<void>((done, reject) => {
      const child = execFile(
        helper,
        [
          "--installation-id",
          randomUUID(),
          "--descriptor",
          join(native.userData, "endpoint.json"),
        ],
        { timeout: 1000 },
        (error, stdout, stderr) => {
          if (error) return reject(error);
          try {
            expect(stdout).toBe("");
            expect(stderr).toBe("");
            done();
          } catch (failure) {
            reject(failure);
          }
        },
      );
      child.stdin!.on("error", reject);
      child.stdin!.end(
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "fixture-session",
          cwd: "/private/fixture-project",
          prompt: "must-not-leak",
        }),
      );
    });
    await expect
      .poll(() =>
        sessionPage!.evaluate(
          async () => (await window.pagent.getSnapshot()).sessions,
        ),
      )
      .toEqual([
        {
          id: "fixture-",
          project: "fixture-project",
          state: "idle",
          reason: "다음 요청을 기다리고 있어요.",
        },
      ]);
    await expect(sessionPage!.locator("body")).toContainText(
      "fixture-project · fixture-",
    );
    await expect(sessionPage!.locator("#sessions .state")).toHaveText(
      stateLabels.idle,
    );
    await expect(sessionPage!.locator("body")).not.toContainText(
      "must-not-leak",
    );
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "test-results/pet-window.png",
      omitBackground: true,
    });
  } finally {
    await application.close();
    await rm(home, { recursive: true, force: true });
  }
});
