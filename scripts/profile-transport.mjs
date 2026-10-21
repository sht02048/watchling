import { build, stop } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Full contract: node scripts/profile-transport.mjs
// Debug selection (still three fresh runs): --profile N or --profile O
const args = process.argv.slice(2);
let profiles = ["N", "O"];
if (args.length) {
  if (
    args.length !== 2 ||
    args[0] !== "--profile" ||
    !["N", "O"].includes(args[1])
  )
    throw new Error(
      "Usage: node scripts/profile-transport.mjs [--profile N|O]",
    );
  profiles = [args[1]];
}
const output = resolve("test-results/transport-profile.json");
let buildProcess;
const stopBuild = () => {
  if (!buildProcess?.pid) return;
  try {
    process.kill(-buildProcess.pid, "SIGKILL");
  } catch {
    buildProcess.kill("SIGKILL");
  }
};
process.once("SIGINT", stopBuild);
process.once("SIGTERM", stopBuild);
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
  process.removeListener("SIGINT", stopBuild);
  process.removeListener("SIGTERM", stopBuild);
  await build({
    entryPoints: ["tests/profiles/main.ts"],
    outfile: "dist/main/profile.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    target: "node24",
  });
  // Fixture-only access to the existing render closure, not a new product IPC
  // endpoint or a synthetic echo renderer. The already packaged app is untouched.
  const rendererPath = resolve("src/renderer/pet/index.ts");
  const renderer = await readFile(rendererPath, "utf8");
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
  stop();
  const { runProfiles } = await import(
    pathToFileURL(resolve("dist/main/profile-driver.mjs")).href
  );
  const result = await runProfiles({ profiles });
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
  process.removeListener("SIGINT", stopBuild);
  process.removeListener("SIGTERM", stopBuild);
}
