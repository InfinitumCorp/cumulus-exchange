// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureGeoIpBytes, fixtureGeoSiteBytes } from "./fixtures.mjs";
import { loadGeoDir } from "./load.mjs";
import { buildIndex, lookupCategories, lookupCountry } from "./match.mjs";
import { encodeGeoIpList } from "./protobuf.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("committed synthetic fixtures match the encoder and resolve lookups", async () => {
  const ip = new Uint8Array(await readFile(path.join(fixtureDir, "geoip.dat")));
  const site = new Uint8Array(await readFile(path.join(fixtureDir, "geosite.dat")));
  assert.deepEqual(ip, fixtureGeoIpBytes());
  assert.deepEqual(site, fixtureGeoSiteBytes());

  const index = await loadGeoDir(fixtureDir);
  assert.equal(lookupCountry(index, "1.2.3.5"), "US");
  assert.equal(lookupCountry(index, "1.2.3.4"), "CN");
  assert.equal(lookupCountry(index, "10.1.2.3"), "PRIVATE");
  assert.equal(lookupCountry(index, "9.9.9.9"), null);
  assert.equal(lookupCountry(index, "2001:db8::1"), "US");
  assert.equal(lookupCountry(index, "::ffff:1.2.3.5"), "US");
  assert.equal(lookupCountry(index, "not-an-ip"), null);

  assert.deepEqual(lookupCategories(index, "www.google.com"), ["google"]);
  assert.deepEqual(lookupCategories(index, "mail.google.com"), ["google"]);
  assert.deepEqual(lookupCategories(index, "notgoogle.com"), []);
  assert.deepEqual(lookupCategories(index, "ads.example"), ["category-ads"]);
  assert.deepEqual(lookupCategories(index, "x.ads.example"), ["category-ads"]);
  assert.deepEqual(lookupCategories(index, "foo.doubleclick.net"), ["category-ads"]);
  assert.deepEqual(lookupCategories(index, "ads.tracker.test"), ["regex-sample"]);
  assert.deepEqual(lookupCategories(index, "ads.tracker.test.extra"), []);
});

test("loader reads a directory of synthetic dat files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-fixtures-"));
  await writeFile(path.join(dir, "geoip.dat"), fixtureGeoIpBytes());
  await writeFile(path.join(dir, "geosite.dat"), fixtureGeoSiteBytes());
  const index = await loadGeoDir(dir);
  assert.equal(lookupCountry(index, "10.9.8.7"), "PRIVATE");
  assert.deepEqual(lookupCategories(index, "WWW.GOOGLE.COM."), ["google"]);
  await rm(dir, { recursive: true, force: true });
});

test("reverse match applies only when no positive prefix matches", () => {
  const bytes = encodeGeoIpList([
    {
      code: "US",
      cidrs: [{ ip: Uint8Array.of(1, 2, 3, 0), prefix: 24 }],
    },
    {
      code: "OUTSIDE",
      reverse: true,
      cidrs: [{ ip: Uint8Array.of(1, 2, 3, 0), prefix: 24 }],
    },
  ]);
  const index = buildIndex(bytes, fixtureGeoSiteBytes());
  assert.equal(lookupCountry(index, "1.2.3.9"), "US");
  assert.equal(lookupCountry(index, "9.9.9.9"), "OUTSIDE");
});
