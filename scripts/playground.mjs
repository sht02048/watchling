import { build } from "esbuild";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const output = resolve("build/playground");
const companionConfig = resolve("src/renderer/pet/companions.json");
const pages = ["index", "companions"];

await mkdir(output, { recursive: true });
await Promise.all(
  pages.map((page) =>
    build({
      entryPoints: [`src/playground/${page}.ts`],
      outfile: `${output}/${page}.js`,
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome140",
    }),
  ),
);
await Promise.all(
  ["index.html", "style.css", "companions.html", "companions.css"].map((file) =>
    cp(`src/playground/${file}`, `${output}/${file}`),
  ),
);

const numberKeys = [
  "seed",
  "count",
  "size",
  "radiusX",
  "radiusY",
  "speed",
  "spread",
  "bob",
  "bobSpeed",
  "wobble",
  "spikes",
  "spikeLength",
  "lightness",
  "depth",
  "eye",
  "eyeY",
  "blush",
  "surface",
];
function validConfig(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    ["head", "sides", "climb", "orbit", "wander", "hop"].includes(value.mode) &&
    Object.keys(value).length === numberKeys.length + 1 &&
    numberKeys.every((key) => Number.isFinite(value[key]))
  );
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/companions") {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4096) return response.writeHead(413).end();
    }
    let config;
    try {
      config = JSON.parse(body);
    } catch {
      return response.writeHead(400).end();
    }
    if (!validConfig(config)) return response.writeHead(400).end();
    await writeFile(companionConfig, `${JSON.stringify(config, null, 2)}\n`);
    return response.writeHead(200).end("src/renderer/pet/companions.json");
  }
  const path = normalize(
    join(
      output,
      request.url === "/" ? "index.html" : request.url.split("?")[0],
    ),
  );
  if (!path.startsWith(output)) return response.writeHead(403).end();
  try {
    const content = await readFile(path);
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});

if (process.argv.includes("--no-serve")) process.exit(0);
server.listen(5178, "127.0.0.1", () => {
  const url = "http://127.0.0.1:5178/";
  console.log(`${url} · ${url}companions.html`);
  if (!process.argv.includes("--no-open")) execFile("open", [url]);
});
