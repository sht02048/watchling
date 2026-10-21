import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/renderer/pet", { recursive: true });
await mkdir("dist/renderer/sessions", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    target: "node24",
  }),
  build({
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    target: "node24",
  }),
  ...["pet", "sessions"].map(async (view) => {
    await build({
      entryPoints: [`src/renderer/${view}/index.ts`],
      outfile: `dist/renderer/${view}/index.js`,
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "chrome140",
    });
    await Promise.all(
      ["index.html", "style.css"].map((file) =>
        cp(`src/renderer/${view}/${file}`, `dist/renderer/${view}/${file}`),
      ),
    );
  }),
]);
