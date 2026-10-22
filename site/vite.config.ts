import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));
const path = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path("src"),
      "@watchling": path("../src"),
      "@resources": path("../resources"),
    },
  },
  server: { fs: { allow: [repo] } },
  plugins: [react()],
});
