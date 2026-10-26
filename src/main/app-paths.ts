import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";

export function resolveAppPaths(home = homedir()) {
  if (!isAbsolute(home)) throw new TypeError("Home directory must be absolute");
  const userData = join(home, "Library", "Application Support", "watchling");
  return {
    userData,
    settingsPath: join(home, ".claude", "settings.json"),
    manifestPath: join(userData, "hooks-installation.json"),
    lockPath: join(userData, "hooks-install.lock"),
    backupDirectory: join(userData, "hook-backups"),
    descriptorPath: join(userData, "endpoint.json"),
    pluginDirectory: join(userData, "claude-mod"),
  };
}
export type AppPaths = ReturnType<typeof resolveAppPaths>;

export function isInstalledAppLocation(
  executablePath: string,
  home = homedir(),
): boolean {
  if (
    !isAbsolute(executablePath) ||
    normalize(executablePath) !== executablePath
  )
    return false;
  const roots = ["/Applications"];
  if (isAbsolute(home)) roots.push(join(home, "Applications"));
  return roots.some(
    (root) =>
      dirname(dirname(dirname(dirname(executablePath)))) === root &&
      /\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath),
  );
}
