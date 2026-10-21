import { test } from "node:test";
import assert from "node:assert/strict";
import { isInstalledAppLocation } from "../../src/main/app-paths.ts";

const home = "/Users/fixture";

test("installed app locations are the system and user Applications folders", () => {
  for (const path of [
    "/Applications/pagent.app/Contents/MacOS/pagent",
    "/Users/fixture/Applications/pagent.app/Contents/MacOS/pagent",
  ])
    assert.equal(isInstalledAppLocation(path, home), true, path);
});

test("translocated, mounted, nested, build, and unnormalized locations are not installed", () => {
  for (const path of [
    "/private/var/folders/xy/T/AppTranslocation/0A1B/d/pagent.app/Contents/MacOS/pagent",
    "/Volumes/pagent 0.1.0-arm64/pagent.app/Contents/MacOS/pagent",
    "/Users/fixture/Desktop/code/pagent/build/release/mac-arm64/pagent.app/Contents/MacOS/pagent",
    "/Applications/Tools/pagent.app/Contents/MacOS/pagent",
    "/Applications/pagent/Contents/MacOS/pagent",
    "/Applications/../Volumes/pagent.app/Contents/MacOS/pagent",
    "/Users/other/Applications/pagent.app/Contents/MacOS/pagent",
    "Applications/pagent.app/Contents/MacOS/pagent",
  ])
    assert.equal(isInstalledAppLocation(path, home), false, path);
});
