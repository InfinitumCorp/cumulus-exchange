import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadGeoCatalog, prepareGeo, resetGeoCache } from "../src/geo/catalog.mjs";
import { annotateDrive } from "../src/geo/hook.mjs";
import {
  annotatePeer,
  createGeoIndex,
  decodeGeoIPList,
  decodeGeoSiteList,
  encodeGeoIPList,
  encodeGeoSiteList,
  geoEnabled,
  hashesFromLock,
  indexFromBuffers,
  parseSha256Sum,
  sha256Hex,
} from "../src/geo/v2ray-dat.mjs";
import { defaultDest, fetchGeoDatasets } from "../scripts/fetch-geo.mjs";
import { createServer } from "../src/server.mjs";
import { call, listen } from "./helpers.mjs";
import { handleRequest } from "../worker/src/index.mjs";
import { geoipEntries, geositeEntries } from "./fixtures/geo/expected.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/geo/", import.meta.url));
const lockPath = fileURLToPath(new URL("../geo/geo.lock.json", import.meta.url));
const sharedCopy = fileURLToPath(
  new URL("../supabase/functions/_shared/v2ray-dat.mjs", import.meta.url),
);
const canonical = fileURLToPath(new URL("../src/geo/v2ray-dat.mjs", import.meta.url));

const OFFICIAL_GEOIP_SUM =
  "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n";
const OFFICIAL_DLC_SUM =
  "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2  dlc.dat\n";

function bytesResponse(body, status = 200, headers = {}) {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function releaseUrl(asset) {
  const project = asset === "dlc.dat" ? "domain-list-community" : "geoip";
  return {
    url: `https://github.com/v2fly/${project}/releases/download/test/${asset}`,
    sha256Url: `https://github.com/v2fly/${project}/releases/download/test/${asset}.sha256sum`,
  };
}

test("synthetic geoip and geosite fixtures round-trip and answer lookups", async () => {
  const geoip = await readFile(path.join(fixtureDir, "geoip.dat"));
  const geosite = await readFile(path.join(fixtureDir, "geosite.dat"));
  assert.deepEqual(Buffer.from(encodeGeoIPList(geoipEntries)), geoip);
  assert.deepEqual(Buffer.from(encodeGeoSiteList(geositeEntries)), geosite);
  const decodedIp = decodeGeoIPList(geoip);
  const decodedSite = decodeGeoSiteList(geosite);
  assert.equal(decodedIp.length, geoipEntries.length);
  assert.equal(decodedSite[0].domains[0].value, "google.com");
  assert.equal(decodedSite[0].domains.length, 1);
  const index = createGeoIndex(decodedIp, decodedSite);
  assert.equal(index.countryForIp("1.2.3.4"), "US");
  assert.equal(index.countryForIp("1.2.3.200"), "CN");
  assert.equal(index.countryForIp("::ffff:1.2.3.4"), "US");
  assert.equal(index.countryForIp("10.1.2.3"), "PRIVATE");
  assert.equal(index.countryForIp("8.8.8.8"), "OUTSIDE");
  assert.equal(index.countryForIp("2001:db8::1"), "V6");
  assert.equal(index.countryForIp("not-an-ip"), null);
  assert.deepEqual(index.categoriesForDomain("maps.google.com"), ["google"]);
  assert.deepEqual(index.categoriesForDomain("google.com"), ["google"]);
  assert.deepEqual(index.categoriesForDomain("notgoogle.com"), []);
  assert.deepEqual(index.categoriesForDomain("ads.doubleclick.net"), ["ads"]);
  assert.deepEqual(index.categoriesForDomain("cdn.example"), ["cdn"]);
  assert.deepEqual(index.categoriesForDomain("cdn.example.evil"), []);
  assert.deepEqual(index.categoriesForDomain("news.example"), ["news"]);
  assert.deepEqual(index.categoriesForDomain("1.2.3.4"), []);
  const note = annotatePeer(index, {
    ip: "1.2.3.4",
    host: "maps.google.com",
    purpose: "drive.read",
  });
  assert.deepEqual(note, { geoCountry: "US", geoCategories: ["google"], purpose: "drive.read" });
});

test("lockfile matches the official v2fly sha256sum lines and rejects other sources", async () => {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(parseSha256Sum(OFFICIAL_GEOIP_SUM, "geoip.dat"), lock.datasets[0].sha256);
  assert.equal(parseSha256Sum(OFFICIAL_DLC_SUM, "dlc.dat"), lock.datasets[1].sha256);
  assert.equal(lock.datasets[0].tag, "202611080027");
  assert.equal(lock.datasets[1].tag, "20261108011013");
  assert.equal(lock.datasets[1].asset, "dlc.dat");
  assert.equal(lock.datasets[1].saveAs, "geosite.dat");
  assert.deepEqual(hashesFromLock(lock), {
    geoipSha256: lock.datasets[0].sha256,
    geositeSha256: lock.datasets[1].sha256,
  });
  assert.throws(
    () =>
      hashesFromLock({
        datasets: [
          {
            ...lock.datasets[0],
            url: "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat",
            sha256Url: lock.datasets[0].sha256Url,
            name: "geoip.dat",
            asset: "geoip.dat",
            sha256: lock.datasets[0].sha256,
          },
        ],
      }),
    /GPL-3/,
  );
  assert.equal(geoEnabled(undefined), false);
  assert.equal(geoEnabled("0"), false);
  assert.equal(geoEnabled("off"), false);
  assert.equal(geoEnabled("1"), true);
  assert.equal(
    await sha256Hex(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("checksum mismatch refuses the index and the flag-off path does not read files", async () => {
  const geoip = await readFile(path.join(fixtureDir, "geoip.dat"));
  const geosite = await readFile(path.join(fixtureDir, "geosite.dat"));
  await assert.rejects(
    () =>
      indexFromBuffers({
        geoip,
        geosite,
        geoipSha256: "ab".repeat(32),
        geositeSha256: "cd".repeat(32),
      }),
    /geoip\.dat checksum/,
  );
  resetGeoCache();
  const missing = path.join(tmpdir(), "cumulus-geo-missing-does-not-exist");
  assert.equal(
    await loadGeoCatalog({ INFINITUM_GEO_ENABLED: "0", INFINITUM_GEO_DIR: missing }),
    null,
  );
  await assert.rejects(
    () =>
      prepareGeo({
        INFINITUM_GEO_ENABLED: "on",
        INFINITUM_GEO_DIR: missing,
        INFINITUM_GEO_LOCK: lockPath,
      }),
    /geoip\.dat is not in the geo directory/,
  );
});

test("catalog loads a verified directory and a tampered file fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cumulus-geo-"));
  const geoip = await readFile(path.join(fixtureDir, "geoip.dat"));
  const geosite = await readFile(path.join(fixtureDir, "geosite.dat"));
  await writeFile(path.join(dir, "geoip.dat"), geoip);
  await writeFile(path.join(dir, "geosite.dat"), geosite);
  const lockFile = path.join(dir, "geo.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.datasets[0].sha256 = createHash("sha256").update(geoip).digest("hex");
  lock.datasets[1].sha256 = createHash("sha256").update(geosite).digest("hex");
  await writeFile(lockFile, JSON.stringify(lock));
  resetGeoCache();
  const env = {
    INFINITUM_GEO_ENABLED: "true",
    INFINITUM_GEO_DIR: dir,
    INFINITUM_GEO_LOCK: lockFile,
  };
  const index = await loadGeoCatalog(env);
  assert.equal(index.countryForIp("1.2.3.4"), "US");
  geoip[0] ^= 0xff;
  await writeFile(path.join(dir, "geoip.dat"), geoip);
  resetGeoCache();
  await assert.rejects(() => loadGeoCatalog(env), /geoip\.dat checksum/);
});

test("fetch writes only after the official sha256sum and file hash agree", async () => {
  const dest = await mkdtemp(path.join(tmpdir(), "cumulus-geo-fetch-"));
  const geoip = await readFile(path.join(fixtureDir, "geoip.dat"));
  const geosite = await readFile(path.join(fixtureDir, "geosite.dat"));
  const ipHash = createHash("sha256").update(geoip).digest("hex");
  const siteHash = createHash("sha256").update(geosite).digest("hex");
  const lock = {
    datasets: [
      { name: "geoip.dat", asset: "geoip.dat", sha256: ipHash, ...releaseUrl("geoip.dat") },
      {
        name: "geosite.dat",
        asset: "dlc.dat",
        saveAs: "geosite.dat",
        sha256: siteHash,
        ...releaseUrl("dlc.dat"),
      },
    ],
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("geoip.dat.sha256sum")) return bytesResponse(`${ipHash}  geoip.dat\n`);
    if (String(url).endsWith("dlc.dat.sha256sum")) return bytesResponse(`${siteHash}  dlc.dat\n`);
    if (String(url).endsWith("/geoip.dat")) return bytesResponse(geoip);
    if (String(url).endsWith("/dlc.dat")) return bytesResponse(geosite);
    throw new Error(`unexpected ${url}`);
  };
  const written = await fetchGeoDatasets({ lock, dest, fetchImpl });
  assert.deepEqual(written, ["geoip.dat", "geosite.dat"]);
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(dest, "geosite.dat")))
      .digest("hex"),
    siteHash,
  );

  const badDest = await mkdtemp(path.join(tmpdir(), "cumulus-geo-bad-"));
  await assert.rejects(
    () =>
      fetchGeoDatasets({
        lock,
        dest: badDest,
        fetchImpl: async (url) => {
          if (String(url).endsWith("geoip.dat.sha256sum"))
            return bytesResponse(`${"cd".repeat(32)}  geoip.dat\n`);
          throw new Error("file should not be downloaded when the official sum disagrees");
        },
      }),
    /does not match the lockfile/,
  );
  assert.deepEqual(await readdir(badDest), []);

  const fileDest = await mkdtemp(path.join(tmpdir(), "cumulus-geo-file-"));
  await assert.rejects(
    () =>
      fetchGeoDatasets({
        lock,
        dest: fileDest,
        fetchImpl: async (url) => {
          if (String(url).endsWith("geoip.dat.sha256sum"))
            return bytesResponse(`${ipHash}  geoip.dat\n`);
          if (String(url).endsWith("/geoip.dat")) return bytesResponse(Buffer.from("tampered"));
          throw new Error("should not fetch geosite after a mismatch");
        },
      }),
    /checksum mismatch for geoip\.dat/,
  );
  assert.deepEqual(await readdir(fileDest), []);

  let calls = 0;
  await assert.rejects(
    () =>
      fetchGeoDatasets({
        lock: {
          datasets: [
            {
              ...lock.datasets[0],
              url: "https://github.com/v2fly/geoip/releases/download/loyalsoldier/geoip.dat",
            },
          ],
        },
        dest: badDest,
        fetchImpl: async () => {
          calls += 1;
          return bytesResponse("");
        },
      }),
    /GPL-3/,
  );
  assert.equal(calls, 0);
  assert.throws(() => parseSha256Sum("nope\n", "geoip.dat"), /not a SHA-256/);
});

test("downloaded datasets stay gitignored", () => {
  for (const name of ["geoip.dat", "geosite.dat"]) {
    execFileSync("git", ["check-ignore", "-q", `cloud/var/geo/${name}`], { cwd: repoRoot });
  }
  assert.match(defaultDest, /cloud\/var\/geo$/);
});

test("edge bundle copy matches the node loader", async () => {
  const left = await readFile(canonical, "utf8");
  const right = await readFile(sharedCopy, "utf8");
  assert.equal(left, right);
});

test("drive policy annotation is off unless INFINITUM_GEO_ENABLED is set", async () => {
  const events = [];
  const emit = (level, msg, fields) => events.push({ level, msg, fields });
  const req = {
    method: "GET",
    headers: { "x-cumulus-purpose": "drive.read" },
    socket: { remoteAddress: "1.2.3.4" },
  };
  const url = new URL("http://cloud.cumuluscloud.app/v1/usage");
  await annotateDrive(req, url, 200, { INFINITUM_GEO_ENABLED: "" }, emit);
  assert.deepEqual(events, []);

  const dir = await mkdtemp(path.join(tmpdir(), "cumulus-geo-hook-"));
  const geoip = encodeGeoIPList([
    { country: "LOOP", cidrs: [{ ip: Uint8Array.from([127, 0, 0, 1]), prefix: 32 }] },
  ]);
  const geosite = encodeGeoSiteList([
    { category: "cloud", domains: [{ type: 3, value: "cloud.cumuluscloud.app" }] },
  ]);
  await writeFile(path.join(dir, "geoip.dat"), geoip);
  await writeFile(path.join(dir, "geosite.dat"), geosite);
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.datasets[0].sha256 = createHash("sha256").update(geoip).digest("hex");
  lock.datasets[1].sha256 = createHash("sha256").update(geosite).digest("hex");
  const hookLock = path.join(dir, "geo.lock.json");
  await writeFile(hookLock, JSON.stringify(lock));
  const env = {
    INFINITUM_GEO_ENABLED: "yes",
    INFINITUM_GEO_DIR: dir,
    INFINITUM_GEO_LOCK: hookLock,
  };
  resetGeoCache();
  await annotateDrive(req, url, 200, env, emit);
  assert.equal(events.length, 1);
  assert.equal(events[0].msg, "geo annotation");
  assert.equal(events[0].fields.geoCategories[0], "cloud");
  assert.equal(events[0].fields.purpose, "drive.read");
  assert.equal(events[0].fields.ip, undefined);

  const broken = path.join(dir, "missing");
  const failed = [];
  await annotateDrive(req, url, 500, { ...env, INFINITUM_GEO_DIR: broken }, (level, msg, fields) =>
    failed.push({ level, msg, fields }),
  );
  assert.equal(failed[0].level, "error");
  assert.match(failed[0].fields.err, /not in the geo directory/);
});

test("enabled annotation does not change Drive responses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cumulus-geo-http-"));
  const geoip = encodeGeoIPList([
    { country: "LOOP", cidrs: [{ ip: Uint8Array.from([127, 0, 0, 1]), prefix: 32 }] },
  ]);
  const geosite = encodeGeoSiteList([
    { category: "loop", domains: [{ type: 2, value: "localhost" }] },
  ]);
  await writeFile(path.join(dir, "geoip.dat"), geoip);
  await writeFile(path.join(dir, "geosite.dat"), geosite);
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.datasets[0].sha256 = createHash("sha256").update(geoip).digest("hex");
  lock.datasets[1].sha256 = createHash("sha256").update(geosite).digest("hex");
  const hookLock = path.join(dir, "geo.lock.json");
  await writeFile(hookLock, JSON.stringify(lock));
  const events = [];
  const geoEnv = {
    INFINITUM_GEO_ENABLED: "1",
    INFINITUM_GEO_DIR: dir,
    INFINITUM_GEO_LOCK: hookLock,
  };
  resetGeoCache();
  async function boot(env, log) {
    const app = await createServer({
      sqlitePath: path.join(dir, env ? "on.sqlite" : "off.sqlite"),
      blobsDir: path.join(dir, "blobs"),
      masterKey: randomBytes(32),
      bootstrapToken: "bootstrap-token-value",
      shareSecret: "share-secret-value",
      jwks: { keys: [] },
      env,
      log,
    });
    const server = await listen(app.handle);
    return { app, server };
  }
  const off = await boot(undefined, () => {});
  const on = await boot(geoEnv, (level, msg, fields) => events.push({ level, msg, fields }));
  try {
    const plain = await call(off.server.port, { path: "/healthz" });
    const annotated = await call(on.server.port, {
      path: "/healthz",
      headers: { "x-cumulus-purpose": "drive.read" },
    });
    assert.equal(plain.status, 200);
    assert.equal(annotated.status, 200);
    assert.equal(annotated.body.toString("utf8"), plain.body.toString("utf8"));
    const deadline = Date.now() + 2000;
    while (!events.some((event) => event.msg === "geo annotation") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const note = events.find((event) => event.msg === "geo annotation");
    assert.ok(note);
    assert.equal(note.fields.geoCountry, "LOOP");
    assert.equal(note.fields.purpose, "drive.read");
    assert.equal(note.fields.status, 200);
  } finally {
    await on.server.close();
    await off.server.close();
    await on.app.close();
    await off.app.close();
  }
});

test("worker annotation does not change the proxied response", async () => {
  const index = createGeoIndex(
    [{ country: "US", reverse: false, cidrs: [{ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 }] }],
    [],
  );
  const base = {
    SUPABASE_FUNCTION_URL: "https://example.test/functions/v1/drive",
    ASSETS: {
      async fetch() {
        return new Response("console", { status: 200 });
      },
    },
    geoIndex: index,
  };
  const headers = { "cf-connecting-ip": "203.0.113.5" };
  const off = await handleRequest(new Request("https://cloud.cumuluscloud.app/", { headers }), {
    ...base,
    INFINITUM_GEO_ENABLED: "0",
  });
  const on = await handleRequest(new Request("https://cloud.cumuluscloud.app/", { headers }), {
    ...base,
    INFINITUM_GEO_ENABLED: "1",
  });
  assert.equal(off.status, 200);
  assert.equal(on.status, 200);
  const offBody = await off.text();
  const onBody = await on.text();
  assert.equal(onBody, offBody);
  assert.equal(onBody, "console");
});
