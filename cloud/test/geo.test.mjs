// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createHandler } from "../src/drive.mjs";
import { prepareGeo } from "../src/geo.mjs";
import { resolveGeoEnabled } from "../src/geo-settings.mjs";
import { loadGeoDir } from "../../src/lib/geo/load.mjs";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/geo/fixtures",
);

test("config geo switch defaults off", () => {
  assert.equal(loadConfig({}).geoEnabled, false);
  assert.equal(loadConfig({ INFINITUM_GEO_ENABLED: "1" }).geoEnabled, true);
  assert.equal(loadConfig({ INFINITUM_GEO_ENABLED: "0" }).geoEnabled, false);
});

test("geo routing resolution defaults off and lets an explicit env zero win", () => {
  assert.deepEqual(resolveGeoEnabled({ env: {}, argv: [], persisted: null }), {
    enabled: false,
    source: "default",
    persist: false,
  });
  assert.equal(resolveGeoEnabled({ env: {}, argv: [], persisted: true }).enabled, true);
  assert.equal(
    resolveGeoEnabled({ env: { INFINITUM_GEO_ENABLED: "0" }, argv: [], persisted: true }).enabled,
    false,
  );
  assert.equal(
    resolveGeoEnabled({ env: { INFINITUM_GEO_ENABLED: "1" }, argv: ["--no-geo"], persisted: true })
      .enabled,
    false,
  );
  assert.equal(resolveGeoEnabled({ env: {}, argv: ["--geo"], persisted: false }).enabled, true);
  assert.throws(() => resolveGeoEnabled({ argv: ["--geo", "--no-geo"] }), /only one/);
});

test("CLI flag persists and a missing dataset does not throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-setting-"));
  const on = await prepareGeo({
    env: {},
    argv: ["--geo"],
    dataDir: dir,
    geoDir: fixtures,
  });
  assert.equal(on?.enabled, true);
  assert.ok(on?.index);
  const saved = JSON.parse(await readFile(path.join(dir, "geo-routing.json"), "utf8"));
  assert.equal(saved.geoRouting, true);
  const again = await prepareGeo({ env: {}, argv: [], dataDir: dir, geoDir: fixtures });
  assert.equal(again?.enabled, true);
  const forced = await prepareGeo({
    env: { INFINITUM_GEO_ENABLED: "0" },
    argv: [],
    dataDir: dir,
    geoDir: fixtures,
  });
  assert.equal(forced, null);
  const missing = await prepareGeo({
    env: { INFINITUM_GEO_ENABLED: "1" },
    argv: [],
    dataDir: dir,
    geoDir: path.join(dir, "absent"),
  });
  assert.equal(missing?.enabled, true);
  assert.equal(missing?.index, null);
  assert.match(missing?.warning || "", /ENOENT|no such file/i);
  await rm(dir, { recursive: true, force: true });
});

test("drive error logs gain geo fields only when the hook is on", async () => {
  const index = await loadGeoDir(fixtures);
  const drive = {
    db: {
      query: async () => {
        throw new Error("disk failed");
      },
    },
    storage: { kind: "filesystem" },
  };
  const req = {
    method: "GET",
    url: "/readyz",
    headers: { host: "mail.google.com:443" },
    socket: { remoteAddress: "1.2.3.5" },
  };
  /** @param {object | null} geo */
  async function capture(geo) {
    /** @type {string[]} */
    const lines = [];
    const original = console.error;
    console.error = (line) => {
      lines.push(String(line));
    };
    try {
      const handle = createHandler(drive, { geo, corsOrigins: [] });
      const res = {
        headersSent: false,
        writeHead() {},
        end() {},
      };
      await handle(req, res);
    } finally {
      console.error = original;
    }
    return lines.map((line) => JSON.parse(line));
  }
  const off = await capture(null);
  assert.equal(off.length, 1);
  assert.equal(off[0].err, "disk failed");
  assert.equal(off[0].geoCountry, undefined);
  assert.equal(off[0].geoAnnotation, undefined);
  const on = await capture({ enabled: true, index });
  assert.equal(on[0].err, "disk failed");
  assert.equal(on[0].geoCountry, "US");
  assert.deepEqual(on[0].geoCategories, ["google"]);
  assert.equal(on[0].service, "cumulus-cloud");
  assert.equal(off[0].service, "cumulus-cloud");
});
