import type { AppPaths } from "./app-paths.ts";
import {
  HookManagementError,
  manageClaudeHooks,
  type HookOperation,
} from "../integration/claude/hook-install.ts";

export async function runHookCommand(
  argv: readonly string[],
  paths: AppPaths,
  helperPath: string,
): Promise<number | null> {
  if (argv[0] !== "hooks") return null;
  const operation = argv[1];
  const apply = argv[2] === "--apply";
  if (
    (operation !== "check" &&
      operation !== "install" &&
      operation !== "uninstall") ||
    (argv.length !== 2 &&
      !(argv.length === 3 && apply && operation !== "check"))
  ) {
    process.stdout.write(
      `${JSON.stringify({
        mode: "invalid",
        watchling: {
          status: "invalid-arguments",
          diff: [],
          reason:
            "Use hooks check, hooks install [--apply], or hooks uninstall [--apply]",
        },
      })}\n`,
    );
    return 2;
  }
  try {
    const result = await manageClaudeHooks(
      operation as HookOperation,
      apply,
      paths,
      helperPath,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const exitCode = error instanceof HookManagementError ? error.exitCode : 1;
    process.stdout.write(
      `${JSON.stringify({
        mode: operation === "check" ? "check" : apply ? "apply" : "preview",
        targets: {
          settings: paths.settingsPath,
          manifest: paths.manifestPath,
          helper: helperPath,
          descriptor: paths.descriptorPath,
        },
        watchling: {
          operation,
          status: exitCode === 2 ? "refused" : "failed",
          diff: [],
          reason:
            error instanceof HookManagementError
              ? error.message
              : "Hook I/O or verification failed",
        },
      })}\n`,
    );
    return exitCode;
  }
}
