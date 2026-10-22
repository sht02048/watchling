import { build } from "vite";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  cp,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const profileRoot = resolve(".vite/profile");
const define = {
  PET_VITE_DEV_SERVER_URL: "undefined",
  SESSIONS_VITE_DEV_SERVER_URL: "undefined",
};

function bundleNode(entry, fileName, format, bundleDependencies) {
  return build({
    configFile: false,
    logLevel: "warn",
    define,
    ssr: bundleDependencies ? { noExternal: true } : {},
    build: {
      ssr: entry,
      outDir: join(profileRoot, "build"),
      emptyOutDir: false,
      minify: false,
      target: "node24",
      rollupOptions: {
        external: ["electron"],
        output: { format, entryFileNames: fileName },
      },
    },
  });
}

function bundleRenderer(name, plugins = []) {
  return build({
    configFile: false,
    logLevel: "warn",
    root: resolve("src/renderer", name),
    base: "./",
    plugins,
    build: {
      outDir: join(profileRoot, "renderer", name),
      emptyOutDir: true,
      assetsInlineLimit: 0,
    },
  });
}

// Full contract: node scripts/profile-transport.mjs
// Debug selection (still three fresh runs): --profile N or --profile O
const supplied = process.argv.slice(2);
if (supplied.filter((value) => value === "--diagnostic").length > 1)
  throw new Error("Duplicate diagnostic option");
const diagnosticNative = supplied.includes("--diagnostic");
const args = supplied.filter((value) => value !== "--diagnostic");
let profiles = ["N", "O"];
if (args.length) {
  if (
    args.length !== 2 ||
    args[0] !== "--profile" ||
    !["N", "O"].includes(args[1])
  )
    throw new Error(
      "Usage: node scripts/profile-transport.mjs [--profile N|O] [--diagnostic]",
    );
  profiles = [args[1]];
}
const output = resolve("test-results/transport-profile.json");
let buildProcess;
let interrupted = false;
const stopBuild = () => {
  if (!buildProcess?.pid) return;
  try {
    process.kill(-buildProcess.pid, "SIGKILL");
  } catch {
    buildProcess.kill("SIGKILL");
  }
};
const interruptBuild = () => {
  interrupted = true;
  stopBuild();
};
const checkInterrupted = () => {
  if (interrupted) throw new Error("Profile build interrupted");
};
process.once("SIGINT", interruptBuild);
process.once("SIGTERM", interruptBuild);
try {
  // The public CLI and helper MUST come from this freshly built local package.
  await new Promise((done, reject) => {
    buildProcess = spawn("npm", ["run", "make"], {
      stdio: "inherit",
      detached: true,
    });
    buildProcess.once("error", reject);
    buildProcess.once("close", (code, signal) => {
      buildProcess = undefined;
      if (code === 0) done();
      else reject(new Error(`Local app build failed (${code ?? signal})`));
    });
  });
  checkInterrupted();
  if (diagnosticNative) {
    await mkdir(resolve("build/verification"), { recursive: true });
    const directory = await mkdtemp(
      resolve("build/verification/native-trace-helper-"),
    );
    checkInterrupted();
    await new Promise((done, reject) => {
      buildProcess = spawn(
        process.execPath,
        ["scripts/build-diagnostic-helper.mjs", directory],
        {
          stdio: "inherit",
          detached: true,
        },
      );
      buildProcess.once("error", reject);
      buildProcess.once("close", (code, signal) => {
        buildProcess = undefined;
        if (code === 0) done();
        else
          reject(
            new Error(`Diagnostic helper build failed (${code ?? signal})`),
          );
      });
    });
    checkInterrupted();
    const manifest = JSON.parse(
      await readFile(resolve(directory, "manifest.json"), "utf8"),
    );
    checkInterrupted();
    const diagnosticApp = resolve(
      `build/watchling-diagnostic-darwin-${process.arch}/Watchling.app`,
    );
    await rm(diagnosticApp, { recursive: true, force: true });
    checkInterrupted();
    await cp(
      resolve("build/unfused/Watchling-darwin-arm64/Watchling.app"),
      diagnosticApp,
      {
        recursive: true,
        verbatimSymlinks: true,
      },
    );
    checkInterrupted();
    await cp(
      manifest.binaryPath,
      resolve(
        diagnosticApp,
        "Contents/Resources/helpers/watchling-hook-emitter",
      ),
    );
    checkInterrupted();
  }
  await rm(profileRoot, { recursive: true, force: true });
  await bundleNode("tests/profiles/main.ts", "profile.cjs", "cjs", true);
  checkInterrupted();
  await bundleNode("src/preload/index.ts", "preload.cjs", "cjs", true);
  checkInterrupted();
  // Fixture-only access to the existing render closure, not a new product IPC
  // endpoint or a synthetic echo renderer. The already packaged app is untouched.
  const rendererPath = await realpath("src/renderer/pet/index.ts");
  let exposed = false;
  await bundleRenderer("pet", [
    {
      name: "watchling-profile-render",
      transform(code, id) {
        if (id.split("?")[0] !== rendererPath) return undefined;
        exposed = true;
        return (
          code +
          '\nObject.defineProperty(window, "__watchlingProfileRender", { value: render });\n'
        );
      },
      buildEnd() {
        if (!exposed)
          throw new Error("Profile render hook was not applied to the pet");
      },
    },
  ]);
  checkInterrupted();
  await bundleRenderer("sessions");
  checkInterrupted();
  await bundleNode(
    "tests/profiles/uds-worker.ts",
    "profile-uds-worker.mjs",
    "es",
    true,
  );
  checkInterrupted();
  await bundleNode(
    "tests/profiles/transport.ts",
    "profile-driver.mjs",
    "es",
    false,
  );
  checkInterrupted();
  const { runProfiles } = await import(
    pathToFileURL(join(profileRoot, "build", "profile-driver.mjs")).href
  );
  checkInterrupted();
  process.removeListener("SIGINT", interruptBuild);
  process.removeListener("SIGTERM", interruptBuild);
  const result = await runProfiles({ profiles, diagnosticNative });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  stopBuild();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        seed: "0x50414745",
        profilesRequested: profiles,
        passed: false,
        completedRuns: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      },
      null,
      2,
    ) + "\n",
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interruptBuild);
  process.removeListener("SIGTERM", interruptBuild);
}
