import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin")
  throw new Error("pagent v1 supports macOS only");
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
const scratch = await mkdtemp(join(tmpdir(), "pagent-package-"));
try {
  const directory = join(scratch, "app");
  const helpers = join(scratch, "helpers");
  await mkdir(directory);
  await mkdir(helpers);
  await cp("dist", join(directory, "dist"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: "module",
      main: "dist/main/index.js",
    }),
  );
  const helper = join(helpers, "pagent-hook-emitter");
  await cp(join(nativeBin, "pagent-hook-emitter"), helper);
  await chmod(helper, 0o755);
  const outputs = await packager({
    dir: directory,
    name: "pagent",
    platform: "darwin",
    arch: process.arch,
    electronVersion: manifest.devDependencies.electron,
    appBundleId: "local.pagent.desktop",
    appCategoryType: "public.app-category.developer-tools",
    asar: true,
    extraResource: [helpers],
    out: resolve("build"),
    overwrite: true,
    prune: false,
  });
  for (const output of outputs) console.log(output);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
