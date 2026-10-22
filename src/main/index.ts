import { app, protocol } from "electron";
import { join } from "node:path";
import { isInstalledAppLocation, resolveAppPaths } from "./app-paths.ts";
import { runHookCommand } from "./hook-command.ts";
import { runDesktop } from "./desktop.ts";
import {
  HookManagementError,
  relocateClaudeHooks,
} from "../integration/claude/hook-install.ts";

app.setName("watchling");
const args = process.argv.slice(process.defaultApp ? 2 : 1);
const paths = resolveAppPaths();
const helperPath = join(
  process.resourcesPath,
  "helpers",
  "watchling-hook-emitter",
);
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
  await runDesktop(paths.userData);
  if (app.hasSingleInstanceLock() && isInstalledAppLocation(process.execPath))
    relocateClaudeHooks(paths, helperPath).catch((error: unknown) =>
      console.error(
        error instanceof HookManagementError
          ? `Claude hook relocation failed: ${error.message}`
          : "Claude hook relocation failed",
      ),
    );
}
