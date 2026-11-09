// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixtureGeoIpBytes, fixtureGeoSiteBytes } from "./fixtures.mjs";
import { geoDataDir, handleGeoLookup, resetGeoCache } from "./http.mjs";

test("lookup stays disabled and does not require datasets", async () => {
  resetGeoCache();
  const response = await handleGeoLookup(new Request("http://local/api/geo?ip=1.2.3.4"), {});
  assert.deepEqual(await response.json(), { enabled: false });
});

test("lookup uses the synthetic directory only when the env switch is on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-http-"));
  await writeFile(path.join(dir, "geoip.dat"), fixtureGeoIpBytes());
  await writeFile(path.join(dir, "geosite.dat"), fixtureGeoSiteBytes());
  resetGeoCache();
  const env = { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: dir };
  const response = await handleGeoLookup(
    new Request("http://local/api/geo?ip=8.8.8.8&domain=mail.google.com"),
    env,
  );
  assert.deepEqual(await response.json(), {
    enabled: true,
    loaded: true,
    country: null,
    categories: ["google"],
    annotation: "categories google",
  });
  assert.equal(geoDataDir(env), dir);
  resetGeoCache();
  await rm(dir, { recursive: true, force: true });
});

test("a missing dataset reports loaded false and still does not throw", async () => {
  resetGeoCache();
  const response = await handleGeoLookup(new Request("http://local/api/geo"), {
    INFINITUM_GEO_ENABLED: "on",
    INFINITUM_GEO_DIR: path.join(tmpdir(), "geo-missing-does-not-exist"),
  });
  assert.deepEqual(await response.json(), { enabled: true, loaded: false });
  resetGeoCache();
});
