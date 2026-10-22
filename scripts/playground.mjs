import { build } from "esbuild";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const output = resolve("build/playground");
const pages = ["index", "companions", "attention"];
const labs = {
  "/api/companions": {
    file: "src/renderer/pet/companions.json",
    modes: ["head", "sides", "climb", "orbit", "wander", "hop"],
  },
  "/api/attention": {
    file: "src/renderer/pet/attention.json",
    modes: ["bang", "interrobang", "question", "bubble", "kizuki", "ping"],
  },
};

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
  [
    "index.html",
    "style.css",
    "companions.html",
    "companions.css",
    "attention.html",
  ].map((file) => cp(`src/playground/${file}`, `${output}/${file}`)),
);

async function validConfig(value, lab) {
  if (value === null || typeof value !== "object") return false;
  const current = JSON.parse(await readFile(resolve(lab.file), "utf8"));
  const keys = Object.keys(current);
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) =>
      key === "mode"
        ? lab.modes.includes(value.mode)
        : Number.isFinite(value[key]),
    )
  );
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const server = createServer(async (request, response) => {
  const lab = labs[request.url];
  if (request.method === "POST" && lab) {
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
    if (!(await validConfig(config, lab))) return response.writeHead(400).end();
    await writeFile(resolve(lab.file), `${JSON.stringify(config, null, 2)}\n`);
    return response.writeHead(200).end(lab.file);
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
  console.log(`${url} · ${url}companions.html · ${url}attention.html`);
  if (!process.argv.includes("--no-open")) execFile("open", [url]);
});
