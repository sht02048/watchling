export const views = ["pet", "sessions"];

export const mainTargets = [
  {
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron"],
    target: "node24",
  },
  {
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    target: "node24",
  },
];

export const rendererTargets = views.map((view) => ({
  entryPoints: [`src/renderer/${view}/index.ts`],
  outfile: `dist/renderer/${view}/index.js`,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome140",
}));

export const staticFiles = views.flatMap((view) =>
  ["index.html", "style.css"].map((file) => [
    `src/renderer/${view}/${file}`,
    `dist/renderer/${view}/${file}`,
  ]),
);
