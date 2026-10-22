import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import {
  mainTargets,
  rendererTargets,
  staticFiles,
  views,
} from "./esbuild-targets.mjs";

await rm("dist", { recursive: true, force: true });
await Promise.all(
  views.map((view) => mkdir(`dist/renderer/${view}`, { recursive: true })),
);
await Promise.all([
  ...[...mainTargets, ...rendererTargets].map((options) => build(options)),
  ...staticFiles.map(([from, to]) => cp(from, to)),
]);
