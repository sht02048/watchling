import { build } from "esbuild";
import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("build/playground");
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/playground/index.ts"],
  outfile: `${output}/index.js`,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome140",
});
await Promise.all(
  ["index.html", "style.css"].map((file) =>
    cp(`src/playground/${file}`, `${output}/${file}`),
  ),
);
const page = `${output}/index.html`;
console.log(page);
if (!process.argv.includes("--no-open")) execFile("open", [page]);
