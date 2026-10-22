import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGitHub } from "@electron-forge/publisher-github";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// Playwright drives Electron through --inspect, which the production fuses
// disable, so automation uses a separate unfused build of the same app.
const fused = process.env.WATCHLING_UNFUSED !== "1";
const helperStage = resolve("build/helper");
const helperName = "watchling-hook-emitter";

const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
// Release builds sign with Developer ID and notarize; local builds stay ad-hoc signed.
const notarize =
  fused && APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER
    ? {
        appleApiKey: APPLE_API_KEY,
        appleApiKeyId: APPLE_API_KEY_ID,
        appleApiIssuer: APPLE_API_ISSUER,
      }
    : undefined;

function installedAppRunning(): boolean {
  try {
    execFileSync("pgrep", [
      "-f",
      "/Applications/Watchling.app/Contents/MacOS/Watchling$",
    ]);
    return true;
  } catch {
    return false;
  }
}

const config: ForgeConfig = {
  outDir: fused ? "build/release" : "build/unfused",
  packagerConfig: {
    name: "Watchling",
    executableName: "Watchling",
    appBundleId: "dev.watchling.app",
    appCategoryType: "public.app-category.developer-tools",
    icon: "resources/icon",
    asar: true,
    extendInfo: { LSUIElement: true },
    extraResource: [join(helperStage, "helpers")],
    ...(notarize
      ? {
          osxSign: {
            // The defaults also grant camera, microphone, location and photos.
            optionsForFile: () => ({
              entitlements: resolve("resources/entitlements.mac.plist"),
            }),
          },
          osxNotarize: notarize,
        }
      : {}),
  },
  // A fixed name keeps releases/latest/download/Watchling.dmg pointing at the newest build.
  makers: [new MakerDMG({ name: "Watchling" }, ["darwin"])],
  publishers: [
    new PublisherGitHub({
      repository: { owner: "sht02048", name: "watchling" },
      draft: true,
      generateReleaseNotes: true,
    }),
  ],
  hooks: {
    preStart: async () => {
      // The dev build shares the installed app's data directory and single-instance lock.
      if (process.env.HOME !== userInfo().homedir || !installedAppRunning())
        return;
      console.log("Quitting the installed Watchling to run the dev build");
      execFileSync("osascript", ["-e", 'quit app "Watchling"']);
      for (let attempt = 0; attempt < 50 && installedAppRunning(); attempt++)
        await new Promise((done) => setTimeout(done, 100));
    },
    prePackage: async (_config, platform, arch) => {
      if (platform !== "darwin" || arch !== "arm64")
        throw new Error("Watchling builds support macOS on Apple silicon only");
      const swift = ["build", "--package-path", "native/hook-emitter"];
      execFileSync("swift", [...swift, "-c", "release"], { stdio: "inherit" });
      const bin = execFileSync(
        "swift",
        [...swift, "-c", "release", "--show-bin-path"],
        { encoding: "utf8" },
      ).trim();
      await rm(helperStage, { recursive: true, force: true });
      await mkdir(join(helperStage, "helpers"), { recursive: true });
      const helper = join(helperStage, "helpers", helperName);
      await cp(join(bin, helperName), helper);
      await chmod(helper, 0o755);
    },
    postPackage: async (_config, { outputPaths }) => {
      for (const output of outputPaths) {
        const app = join(output, "Watchling.app");
        const helper = join(app, "Contents/Resources/helpers", helperName);
        if (((await stat(helper)).mode & 0o7777) !== 0o755)
          throw new Error("Packaged hook helper must have mode 0755");
        // Without osxSign the fuses plugin re-signs before packaging rewrites Info.plist, so sign the final bundle.
        if (!notarize)
          execFileSync("codesign", ["--sign", "-", "--force", "--deep", app]);
        execFileSync("codesign", ["--verify", "--deep", "--strict", app]);
      }
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        { name: "pet", config: "vite.renderer.config.mts" },
        { name: "sessions", config: "vite.renderer.config.mts" },
      ],
    }),
    ...(fused
      ? [
          new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
          }),
        ]
      : []),
  ],
};

export default config;
