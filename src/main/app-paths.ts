import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function resolveAppPaths(home = homedir()) {
  if (!isAbsolute(home)) throw new TypeError("Home directory must be absolute");
  const userData = join(home, "Library", "Application Support", "pagent");
  return {
    userData,
    settingsPath: join(home, ".claude", "settings.json"),
    manifestPath: join(userData, "hooks-installation.json"),
    lockPath: join(userData, "hooks-install.lock"),
    backupDirectory: join(userData, "hook-backups"),
    descriptorPath: join(userData, "endpoint.json"),
  };
}
export type AppPaths = ReturnType<typeof resolveAppPaths>;
