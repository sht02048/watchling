import { test } from "node:test";
import assert from "node:assert/strict";
import { isInstalledAppLocation } from "../../src/main/app-paths.ts";

const home = "/Users/fixture";

test("installed app locations are the system and user Applications folders", () => {
  for (const path of [
    "/Applications/Watchling.app/Contents/MacOS/Watchling",
    "/Users/fixture/Applications/Watchling.app/Contents/MacOS/Watchling",
  ])
    assert.equal(isInstalledAppLocation(path, home), true, path);
});

test("translocated, mounted, nested, build, and unnormalized locations are not installed", () => {
  for (const path of [
    "/private/var/folders/xy/T/AppTranslocation/0A1B/d/Watchling.app/Contents/MacOS/Watchling",
    "/Volumes/Watchling 0.1.0-arm64/Watchling.app/Contents/MacOS/Watchling",
    "/Users/fixture/Desktop/code/watchling/build/release/Watchling-darwin-arm64/Watchling.app/Contents/MacOS/Watchling",
    "/Applications/Tools/Watchling.app/Contents/MacOS/Watchling",
    "/Applications/Watchling/Contents/MacOS/Watchling",
    "/Applications/../Volumes/Watchling.app/Contents/MacOS/Watchling",
    "/Users/other/Applications/Watchling.app/Contents/MacOS/Watchling",
    "Applications/Watchling.app/Contents/MacOS/Watchling",
  ])
    assert.equal(isInstalledAppLocation(path, home), false, path);
});
