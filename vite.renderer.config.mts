/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { contentSecurityPolicy } from "./src/shared/csp.ts";

export default defineConfig((env) => {
  if (!("name" in env.forgeConfigSelf))
    throw new Error("This config is for renderer targets");
  const name = env.forgeConfigSelf.name;
  return {
    root: resolve("src/renderer", name),
    build: {
      outDir: resolve(".vite/renderer", name),
      emptyOutDir: true,
      // The app CSP blocks the data: URLs Vite inlines small assets as.
      assetsInlineLimit: 0,
    },
    server: {
      // Same policy as the packaged app, except HMR needs its websocket.
      headers: { "Content-Security-Policy": contentSecurityPolicy("'self'") },
    },
  };
});
