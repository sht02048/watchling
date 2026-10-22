import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { formatConfig, validateConfig } from "./src/config.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const configFile = fileURLToPath(new URL("src/config.json", import.meta.url));

function labSave(): Plugin {
  let written = "";
  return {
    name: "watchling-lab-save",
    apply: "serve",
    async hotUpdate(options) {
      if (options.file === configFile && (await options.read()) === written)
        return [];
    },
    configureServer(server) {
      server.middlewares.use("/__lab/save", async (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          return response.end();
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) {
            response.statusCode = 413;
            return response.end();
          }
        }
        let config;
        try {
          config = validateConfig(JSON.parse(body));
        } catch {
          config = null;
        }
        if (!config) {
          response.statusCode = 400;
          return response.end("Invalid config");
        }
        written = formatConfig(config);
        await writeFile(configFile, written);
        response.end("site/src/config.json");
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  server: { fs: { allow: [repo] } },
  build:
    command === "build"
      ? {
          rolldownOptions: {
            input: {
              index: fileURLToPath(new URL("index.html", import.meta.url)),
            },
          },
        }
      : {},
  plugins: [labSave()],
}));
