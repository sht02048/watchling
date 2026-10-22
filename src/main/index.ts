import { app, Notification, protocol } from "electron";
import { join } from "node:path";
import { resolveAppPaths } from "./app-paths.ts";
import { runHookCommand } from "./hook-command.ts";
import { runDesktop } from "./desktop.ts";
import { canAutoConnect, ClaudeConnection } from "./connection.ts";

app.setName("watchling");
const args = process.argv.slice(process.defaultApp ? 2 : 1);
const paths = resolveAppPaths();
const helperPath = join(
  process.resourcesPath,
  "helpers",
  "watchling-hook-emitter",
);

async function main(): Promise<void> {
  if (args[0] === "hooks") {
    app.setActivationPolicy("prohibited");
    const code = await runHookCommand(args, paths, helperPath);
    await Promise.all([
      new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
      new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
    ]);
    app.exit(code ?? 2);
  } else {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: "watchling",
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      },
    ]);
    await runDesktop(
      paths.userData,
      {},
      new ClaudeConnection({
        paths,
        helperPath,
        available: canAutoConnect(app.isPackaged, process.execPath),
        notify: () => {
          if (!Notification.isSupported()) return;
          new Notification({
            title: "Watchling is connected to Claude Code",
            body: "You can turn this off from the Watchling menu bar icon.",
          }).show();
        },
      }),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
