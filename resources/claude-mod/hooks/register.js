// No hook fires when the user interrupts a turn or dismisses a permission
// prompt with Esc, but the engine's turn.complete does, so each main-loop turn
// end is reported through the same helper the hooks run.

// A queued prompt, or a Stop hook that keeps Claude going, starts the next turn
// at once, and that turn owns the session.
export const NEXT_TURN_GRACE_MS = 1000;

// Bumped by anything that starts main-loop work after a turn ends.
let generation = 0;

async function readInstallation($) {
  const root = $.plugin.root.replace(/\/+$/, "");
  const path = `${root.slice(0, root.lastIndexOf("/"))}/hooks-installation.json`;
  if (!(await $.fs.exists(path))) return null;
  const { helperPath, installationId, descriptorPath } =
    JSON.parse(await $.fs.read(path)) ?? {};
  const valid =
    typeof helperPath === "string" &&
    helperPath.startsWith("/") &&
    helperPath.endsWith("/Contents/Resources/helpers/watchling-hook-emitter") &&
    typeof descriptorPath === "string" &&
    descriptorPath.startsWith("/") &&
    typeof installationId === "string";
  return valid ? { helperPath, installationId, descriptorPath } : null;
}

async function reportTurnEnd($, event) {
  const installation = await readInstallation($);
  if (!installation) return;
  await $.process.run(
    [
      installation.helperPath,
      "--installation-id",
      installation.installationId,
      "--descriptor",
      installation.descriptorPath,
    ],
    { stdin: JSON.stringify(event), timeoutMs: 5000 },
  );
}

export function register(on) {
  on("prompt.submit", async ($, e, next) => {
    generation += 1;
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) generation += 1;
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId !== undefined) return done;
    const ended = generation;
    // Read now: /clear or /resume within the grace period switches sessions.
    const event = {
      hook_event_name: "TurnEnded",
      session_id: await $.session.id(),
      cwd: await $.session.cwd(),
    };
    $.clock.after(NEXT_TURN_GRACE_MS, () => {
      if (generation !== ended) return;
      reportTurnEnd($, event).catch((error) =>
        $.ui.log(`Could not report a turn end: ${String(error)}`, {
          to: "debug",
        }),
      );
    });
    return done;
  });
}
