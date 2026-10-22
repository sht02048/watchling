import { Arch, Platform, build } from "electron-builder";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin")
  throw new Error("Watchling v1 supports macOS only");
if (process.arch !== "arm64")
  throw new Error("Watchling local builds support Apple silicon only");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const nativeBin = execFileSync(
  "swift",
  [
    "build",
    "--package-path",
    "native/hook-emitter",
    "-c",
    "release",
    "--show-bin-path",
  ],
  { encoding: "utf8" },
).trim();
const releaseDirectory = resolve("build/release");
const unfusedDirectory = resolve("build/unfused");
const scratch = await mkdtemp(join(tmpdir(), "watchling-package-"));
try {
  const directory = join(scratch, "app");
  await mkdir(directory);
  await cp("dist", join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: manifest.name,
      productName: "Watchling",
      version: manifest.version,
      description: manifest.description,
      private: true,
      type: "module",
      main: "dist/main/index.js",
    }),
  );
  const helper = join(scratch, "watchling-hook-emitter");
  await cp(join(nativeBin, "watchling-hook-emitter"), helper);
  await chmod(helper, 0o755);
  const config = (output, fused) => ({
    appId: "dev.watchling.app",
    productName: "Watchling",
    electronVersion: manifest.devDependencies.electron,
    directories: { app: directory, output },
    files: ["dist/**/*", "package.json"],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    extraResources: [{ from: helper, to: "helpers/watchling-hook-emitter" }],
    afterPack: (context) =>
      chmod(
        join(
          context.appOutDir,
          "Watchling.app/Contents/Resources/helpers/watchling-hook-emitter",
        ),
        0o755,
      ),
    electronFuses: fused
      ? {
          runAsNode: false,
          enableNodeOptionsEnvironmentVariable: false,
          enableNodeCliInspectArguments: false,
          enableEmbeddedAsarIntegrityValidation: true,
          onlyLoadAppFromAsar: true,
        }
      : null,
    mac: {
      category: "public.app-category.developer-tools",
      target: fused ? ["dmg", "dir"] : ["dir"],
      identity: "-",
      hardenedRuntime: false,
      notarize: false,
      extendInfo: { LSUIElement: true },
    },
    dmg: { artifactName: "Watchling-${version}-${arch}.${ext}" },
    publish: null,
  });
  await rm(releaseDirectory, { recursive: true, force: true });
  await rm(unfusedDirectory, { recursive: true, force: true });
  // Playwright drives Electron through --inspect, which the production fuses
  // disable, so automation uses a separate unfused build of the same app.
  for (const [output, fused] of [
    [releaseDirectory, true],
    [unfusedDirectory, false],
  ]) {
    const artifacts = await build({
      targets: Platform.MAC.createTarget(null, Arch.arm64),
      config: config(output, fused),
      publish: "never",
    });
    const helperPath = join(
      output,
      "mac-arm64/Watchling.app/Contents/Resources/helpers/watchling-hook-emitter",
    );
    if (((await stat(helperPath)).mode & 0o7777) !== 0o755)
      throw new Error("Packaged hook helper must have mode 0755");
    for (const artifact of artifacts) console.log(artifact);
    console.log(join(output, "mac-arm64/Watchling.app"));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
