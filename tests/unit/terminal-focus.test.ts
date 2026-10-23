import { test } from "node:test";
import assert from "node:assert/strict";
import { focusTerminal } from "../../src/main/terminal-focus.ts";

function recorder(fail: (file: string) => boolean = () => false) {
  const calls: [string, string[]][] = [];
  return {
    calls,
    run: async (file: string, args: string[]) => {
      calls.push([file, args]);
      if (fail(file)) throw new Error("failed");
    },
  };
}

test("an Orca session switches to its terminal tab, then brings Orca forward", async () => {
  const { calls, run } = recorder();
  await focusTerminal(
    { app: "com.stablyai.orca", orcaTerminal: "term_1" },
    {
      run,
      applications: ["/missing", "/Apps"],
      exists: async (path) => path.startsWith("/Apps/"),
    },
  );
  assert.deepEqual(calls, [
    [
      "/Apps/Orca.app/Contents/Resources/bin/orca",
      ["terminal", "switch", "--terminal", "term_1", "--json"],
    ],
    ["/usr/bin/open", ["-b", "com.stablyai.orca"]],
  ]);
});

test("a failed or missing Orca CLI still brings the app forward", async () => {
  for (const exists of [true, false]) {
    const { calls, run } = recorder((file) => file !== "/usr/bin/open");
    await focusTerminal(
      { app: "com.stablyai.orca", orcaTerminal: "term_1" },
      { run, applications: ["/Apps"], exists: async () => exists },
    );
    assert.deepEqual(calls.at(-1), [
      "/usr/bin/open",
      ["-b", "com.stablyai.orca"],
    ]);
    assert.equal(calls.length, exists ? 2 : 1);
  }
});

test("other terminals only bring their app forward, and failures stay quiet", async () => {
  const { calls, run } = recorder(() => true);
  await focusTerminal(
    { app: "com.apple.Terminal" },
    { run, exists: async () => assert.fail("No Orca handle") },
  );
  assert.deepEqual(calls, [["/usr/bin/open", ["-b", "com.apple.Terminal"]]]);
});

test("an Orca handle under another app is left alone", async () => {
  const { calls, run } = recorder();
  await focusTerminal(
    { app: "com.apple.Terminal", orcaTerminal: "term_1" },
    { run, exists: async () => assert.fail("Orca is not this terminal") },
  );
  assert.deepEqual(calls, [["/usr/bin/open", ["-b", "com.apple.Terminal"]]]);
});
