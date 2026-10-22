import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRendererAsset } from "../../src/main/renderer-assets.ts";

const root = "/bundle/.vite/renderer";

test("serves renderer pages and hashed assets with their types", () => {
  assert.deepEqual(
    resolveRendererAsset("GET", "watchling://app/pet/index.html", root),
    { path: `${root}/pet/index.html`, mime: "text/html" },
  );
  assert.deepEqual(
    resolveRendererAsset(
      "GET",
      "watchling://app/sessions/assets/index-CCT2vXRc.js",
      root,
    ),
    {
      path: `${root}/sessions/assets/index-CCT2vXRc.js`,
      mime: "text/javascript",
    },
  );
  assert.deepEqual(
    resolveRendererAsset("GET", "watchling://app/pet/assets/a.css", root),
    { path: `${root}/pet/assets/a.css`, mime: "text/css" },
  );
});

test("refuses anything outside the renderer root or of an unknown type", () => {
  for (const url of [
    "watchling://app/pet/..%2F..%2Fbuild%2Fmain.cjs",
    "watchling://app/..%2F..%2Fbuild%2Fevil.js",
    "watchling://app/..%2Frenderer-x%2Fa.js",
    "watchling://app/pet/%E0.js",
    "watchling://app/",
    "watchling://app/pet",
    "watchling://app/pet/data.json",
    "watchling://app/pet/preload.cjs",
    "watchling://other/pet/index.html",
  ])
    assert.equal(resolveRendererAsset("GET", url, root), undefined, url);
});

test("dot segments stop at the renderer root", () => {
  assert.deepEqual(
    resolveRendererAsset(
      "GET",
      "watchling://app/%2e%2e/%2e%2e/build/main.js",
      root,
    ),
    { path: `${root}/build/main.js`, mime: "text/javascript" },
  );
});

test("serves only GET requests", () => {
  for (const method of ["POST", "PUT", "HEAD"])
    assert.equal(
      resolveRendererAsset(method, "watchling://app/pet/index.html", root),
      undefined,
    );
});
