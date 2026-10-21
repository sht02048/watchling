import { app, protocol } from "electron";
import { join } from "node:path";
import { resolveAppPaths } from "./app-paths.ts";
import { runHookCommand } from "./hook-command.ts";
import { runDesktop } from "./desktop.ts";

app.setName("pagent");
const args = process.argv.slice(process.defaultApp ? 2 : 1);
const paths = resolveAppPaths();
if (args[0] === "hooks") {
  app.setActivationPolicy("prohibited");
  const code = await runHookCommand(
    args,
    paths,
    join(process.resourcesPath, "helpers", "pagent-hook-emitter"),
  );
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
  app.exit(code ?? 2);
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "pagent",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
  await runDesktop(paths.userData);
}
