import { defineConfig } from "vite";

export default defineConfig({
  build: {
    minify: false,
    rollupOptions: { output: { entryFileNames: "preload.cjs" } },
  },
});
