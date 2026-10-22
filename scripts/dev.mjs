import { context } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import {
  mainTargets,
  rendererTargets,
  staticFiles,
  views,
} from "./esbuild-targets.mjs";

const electron = createRequire(import.meta.url)("electron");
let app;
let restarting = false;
let timer;

function log(message) {
  console.log(`[dev] ${message}`);
}

function installedAppRunning() {
  try {
    execFileSync("pgrep", [
      "-f",
      "/Applications/Watchling.app/Contents/MacOS/Watchling$",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function quitInstalledApp() {
  if (process.env.HOME !== userInfo().homedir || !installedAppRunning()) return;
  log("Quitting the installed Watchling to run the dev build");
  execFileSync("osascript", ["-e", 'quit app "Watchling"']);
  for (let attempt = 0; attempt < 50 && installedAppRunning(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
}

function launch() {
  const env = { ...process.env, WATCHLING_DEV: "1" };
  // Electron-based tools such as Claude Code export this, which would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, ["."], { stdio: "inherit", env });
  const current = app;
  current.on("exit", (code) => {
    if (current !== app || restarting) return;
    log(`App exited (code ${code}); stopping dev mode`);
    process.exit(0);
  });
}

function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!app) return launch();
    log("Main changed; restarting the app");
    restarting = true;
    app.once("exit", () => {
      restarting = false;
      launch();
    });
    app.kill("SIGTERM");
  }, 150);
}

const firstBuilds = [];
function notify(onRebuild) {
  let resolveFirst;
  firstBuilds.push(new Promise((resolve) => (resolveFirst = resolve)));
  let first = true;
  return {
    name: "watchling-dev",
    setup(build) {
      build.onEnd((result) => {
        if (first) {
          first = false;
          resolveFirst();
        } else if (!result.errors.length) onRebuild();
      });
    },
  };
}

await rm("dist", { recursive: true, force: true });
await Promise.all(
  views.map((view) => mkdir(`dist/renderer/${view}`, { recursive: true })),
);
await Promise.all(staticFiles.map(([from, to]) => cp(from, to)));
const contexts = await Promise.all([
  ...mainTargets.map((options) =>
    context({ ...options, plugins: [notify(restart)] }),
  ),
  ...rendererTargets.map((options) =>
    context({ ...options, plugins: [notify(() => {})] }),
  ),
]);
await Promise.all(contexts.map((ctx) => ctx.watch()));
await Promise.all(firstBuilds);

watch("src/renderer", { recursive: true }, (_, file) => {
  if (!file) return;
  const pair = staticFiles.find(([from]) => from.endsWith(file));
  if (pair) cp(pair[0], pair[1]).catch(() => {});
});

await quitInstalledApp();
launch();
log("Watching for changes: renderer edits reload, main edits restart");

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    restarting = true;
    app?.kill("SIGTERM");
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(0);
  });
