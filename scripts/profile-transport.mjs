import { build, stop } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    buildProcess = spawn("npm", ["run", "build:local-app"], {
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
      `build/pagent-diagnostic-darwin-${process.arch}/pagent.app`,
    );
    await rm(diagnosticApp, { recursive: true, force: true });
    checkInterrupted();
    await cp(resolve("build/unfused/mac-arm64/pagent.app"), diagnosticApp, {
      recursive: true,
      verbatimSymlinks: true,
    });
    checkInterrupted();
    await cp(
      manifest.binaryPath,
      resolve(diagnosticApp, "Contents/Resources/helpers/pagent-hook-emitter"),
    );
    checkInterrupted();
  }
  await build({
    entryPoints: ["tests/profiles/main.ts"],
    outfile: "dist/main/profile.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    target: "node24",
  });
  checkInterrupted();
  // Fixture-only access to the existing render closure, not a new product IPC
  // endpoint or a synthetic echo renderer. The already packaged app is untouched.
  const rendererPath = resolve("src/renderer/pet/index.ts");
  const renderer = await readFile(rendererPath, "utf8");
  checkInterrupted();
  await build({
    stdin: {
      contents:
        renderer +
        '\nObject.defineProperty(window, "__pagentProfileRender", { value: render });\n',
      resolveDir: dirname(rendererPath),
      sourcefile: rendererPath,
      loader: "ts",
    },
    outfile: "dist/renderer/pet/index.js",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome140",
  });
  checkInterrupted();
  await build({
    entryPoints: ["tests/profiles/uds-worker.ts"],
    outfile: "dist/main/profile-uds-worker.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  checkInterrupted();
  await build({
    entryPoints: ["tests/profiles/transport.ts"],
    outfile: "dist/main/profile-driver.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    external: ["electron"],
    target: "node24",
  });
  checkInterrupted();
  stop();
  const { runProfiles } = await import(
    pathToFileURL(resolve("dist/main/profile-driver.mjs")).href
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
  stop();
  process.removeListener("SIGINT", interruptBuild);
  process.removeListener("SIGTERM", interruptBuild);
}
