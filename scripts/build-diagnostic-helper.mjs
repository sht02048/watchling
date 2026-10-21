import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length)
  throw new Error(
    "Usage: node scripts/build-diagnostic-helper.mjs <outputDirectory>",
  );
if (process.platform !== "darwin")
  throw new Error("The diagnostic helper supports macOS only");

await mkdir(resolve(output), { recursive: true, mode: 0o700 });
const outputDirectory = await realpath(resolve(output));
const binaryPath = join(outputDirectory, "pagent-hook-emitter");
const manifestPath = join(outputDirectory, "manifest.json");
// Refuse all existing outputs, including symlinks, release and packaged helpers.
for (const path of [binaryPath, manifestPath]) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing diagnostic output: ${path}`);
}

const scratch = await mkdtemp(join(tmpdir(), "pagent-diagnostic-swift-"));
try {
  const arguments_ = [
    "build",
    "--package-path",
    fileURLToPath(new URL("../native/hook-emitter", import.meta.url)),
    "--scratch-path",
    scratch,
    "-c",
    "release",
    "-Xswiftc",
    "-DPAGENT_NATIVE_TRACE",
  ];
  execFileSync("swift", arguments_, { stdio: "inherit" });
  const binDirectory = execFileSync(
    "swift",
    [...arguments_, "--show-bin-path"],
    { encoding: "utf8" },
  ).trim();
  const source = join(binDirectory, "pagent-hook-emitter");
  const sha256 = createHash("sha256")
    .update(await readFile(source))
    .digest("hex");
  await copyFile(source, binaryPath, constants.COPYFILE_EXCL);
  await chmod(binaryPath, 0o755);
  await writeFile(manifestPath, JSON.stringify({ binaryPath, sha256 }) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(manifestPath, 0o600);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
