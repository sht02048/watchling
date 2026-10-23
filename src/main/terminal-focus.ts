import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalLocation } from "../domain/observations.ts";

export type Run = (file: string, args: string[]) => Promise<void>;

const ORCA = "com.stablyai.orca";
const ORCA_CLI = "Orca.app/Contents/Resources/bin/orca";

const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function focusTerminal(
  terminal: TerminalLocation,
  options: {
    run?: Run;
    applications?: string[];
    exists?: (path: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const exec = options.run ?? run;
  const exists = options.exists ?? executable;
  // Inside tmux the handle can outlive the Orca tab that started the server.
  if (terminal.orcaTerminal && (!terminal.app || terminal.app === ORCA)) {
    for (const directory of options.applications ?? [
      "/Applications",
      join(homedir(), "Applications"),
    ]) {
      const cli = join(directory, ORCA_CLI);
      if (!(await exists(cli))) continue;
      try {
        await exec(cli, [
          "terminal",
          "switch",
          "--terminal",
          terminal.orcaTerminal,
          "--json",
        ]);
      } catch {
        // The handle dies with the Orca runtime; bringing the app forward still helps.
      }
      break;
    }
  }
  if (terminal.app) {
    try {
      await exec("/usr/bin/open", ["-b", terminal.app]);
    } catch {
      // The app may have been removed since the session started.
    }
  }
}
