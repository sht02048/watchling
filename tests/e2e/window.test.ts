import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SemanticState } from "../../src/shared/ui-contract.ts";

test("native pet uses isolated UI, continuous animation and a read-only list", async () => {
  const home = await mkdtemp(join(tmpdir(), "pagent-electron-"));
  const application = await electron.launch({
    args: [resolve("dist/main/index.js")],
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
        "attention",
        "unknown",
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
          new RegExp(state),
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
      "실제 연동이 포함되지 않았어요",
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
