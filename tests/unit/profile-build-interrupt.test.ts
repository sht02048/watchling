import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const phase of ["before-helper", "copy-bundle"] as const) {
  test(`profile interruption at ${phase} prevents subsequent build/profile work`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "watchling-build-interrupt-"),
    );
    let child: ReturnType<typeof spawn> | undefined;
    try {
      let source = await readFile(
        resolve("scripts/profile-transport.mjs"),
        "utf8",
      );
      // Run the actual entrypoint with fixture-only I/O dependencies. No build,
      // application, settings mutation or actual profile is launched here.
      for (const [original, replacement] of [
        ['from "vite"', 'from "./build.mjs"'],
        ['from "node:child_process"', 'from "./child.mjs"'],
        ['from "node:fs/promises"', 'from "./fs.mjs"'],
      ]) {
        assert.equal(source.split(original!).length, 2);
        source = source.replace(original!, replacement!);
      }
      await writeFile(join(directory, "entry.mjs"), source);
      await writeFile(
        join(directory, "build.mjs"),
        `
export async function build() { console.log('UNEXPECTED_BUILD'); throw new Error('Continued after interrupt'); }
`,
      );
      await writeFile(
        join(directory, "child.mjs"),
        `
import { EventEmitter } from 'node:events';
export function spawn() {
  console.log('FIXTURE_SPAWN');
  const child = new EventEmitter();
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}
`,
      );
      await writeFile(
        join(directory, "fs.mjs"),
        `
import * as fs from 'node:fs/promises';
export * from 'node:fs/promises';
let copies = 0;
async function barrier() {
  await new Promise(resolve => {
    process.once('SIGTERM', resolve);
    console.log('INTERRUPT_READY');
    // Keep the fixture alive until the actual signal arrives.
    const timer = setInterval(() => {}, 100);
    process.once('SIGTERM', () => clearInterval(timer));
  });
}
export async function mkdtemp(path) {
  const value = await fs.mkdtemp(path);
  if (${JSON.stringify(phase)} === 'before-helper') await barrier();
  return value;
}
export async function readFile(path, ...args) {
  if (String(path).endsWith('/manifest.json')) return JSON.stringify({binaryPath:'/fixture/helper',sha256:'fixture'});
  return fs.readFile(path, ...args);
}
export async function cp() {
  if (++copies !== 1) throw new Error('Copy continued after interrupt');
  await barrier();
}
`,
      );
      child = spawn(
        process.execPath,
        [join(directory, "entry.mjs"), "--diagnostic"],
        {
          cwd: directory,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        signalled = false;
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
      child.stdout!.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        if (!signalled && stdout.includes("INTERRUPT_READY")) {
          signalled = true;
          child!.kill("SIGTERM");
        }
      });
      child.stderr!.on("data", (bytes: Buffer) => {
        stderr += bytes.toString();
      });
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", (code, signal) => resolve({ code, signal }));
      }).finally(() => clearTimeout(timeout));
      assert.equal(signalled, true);
      assert.deepEqual(result, { code: 1, signal: null });
      assert.match(stderr, /Profile build interrupted/);
      assert.doesNotMatch(stdout, /UNEXPECTED_BUILD/);
      assert.equal(
        stdout.match(/FIXTURE_SPAWN/g)?.length,
        phase === "before-helper" ? 1 : 2,
      );
      const report = JSON.parse(
        await readFile(
          join(directory, "test-results/transport-profile.json"),
          "utf8",
        ),
      );
      assert.equal(report.completedRuns, 0);
      assert.equal(report.passed, false);
      assert.deepEqual(report.errors, ["Profile build interrupted"]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
}
