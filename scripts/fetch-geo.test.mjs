// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertV2flyOnly, fetchEntry, fetchLocked, parseSha256Sum } from "./fetch-geo.mjs";

const lockPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/geo/geo.lock.json",
);

test("lockfile pins the v2fly release hashes", async () => {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(lock.vendor, "v2fly");
  assert.deepEqual(lock.excluded, ["Loyalsoldier", "sing-box"]);
  const geoip = lock.assets.find((item) => item.file === "geoip.dat");
  const geosite = lock.assets.find((item) => item.file === "geosite.dat");
  assert.equal(geoip.tag, "202611080027");
  assert.equal(geoip.asset, "geoip.dat");
  assert.equal(geoip.sha256, "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2");
  assert.equal(geoip.license, "CC-BY-SA-4.0");
  assert.equal(geosite.tag, "20261108011013");
  assert.equal(geosite.asset, "dlc.dat");
  assert.equal(geosite.file, "geosite.dat");
  assert.equal(geosite.sha256, "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2");
  assert.equal(geosite.license, "MIT");
});

test("parseSha256Sum accepts the official two-space line", () => {
  const parsed = parseSha256Sum(
    "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n",
  );
  assert.equal(parsed.sha256, "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2");
  assert.equal(parsed.name, "geoip.dat");
});

test("fetch refuses Loyalsoldier and sing-box URLs", () => {
  assert.throws(
    () =>
      assertV2flyOnly({
        url: "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat",
        file: "geoip.dat",
        checksumUrl: "https://github.com/v2fly/geoip/x",
      }),
    /non-v2fly/,
  );
  assert.throws(
    () =>
      assertV2flyOnly({
        url: "https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat",
        file: "geoip.dat",
        checksumUrl: "https://github.com/v2fly/geoip/x",
      }),
    /non-v2fly/,
  );
});

test("checksum mismatch stops before a dataset file is written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-mismatch-"));
  const entry = {
    file: "geoip.dat",
    checksumName: "geoip.dat",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    url: "https://github.com/v2fly/geoip/releases/download/test/geoip.dat",
    checksumUrl: "https://github.com/v2fly/geoip/releases/download/test/geoip.dat.sha256sum",
  };
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith(".sha256sum")) {
      return new Response(
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  geoip.dat\n",
      );
    }
    return new Response(Buffer.from("not-the-dataset"));
  };
  await assert.rejects(fetchEntry(entry, dir, fetchImpl), /does not match the lockfile/);
  await assert.rejects(stat(path.join(dir, "geoip.dat")));
  await rm(dir, { recursive: true, force: true });
});

test("a matching official sum and payload is saved under the lockfile name", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-match-"));
  const payload = Buffer.from("synthetic-geo");
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const entry = {
    file: "geosite.dat",
    checksumName: "dlc.dat",
    sha256,
    url: "https://github.com/v2fly/domain-list-community/releases/download/test/dlc.dat",
    checksumUrl:
      "https://github.com/v2fly/domain-list-community/releases/download/test/dlc.dat.sha256sum",
  };
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith(".sha256sum")) return new Response(`${sha256}  dlc.dat\n`);
    return new Response(payload);
  };
  const saved = await fetchLocked({ assets: [entry] }, dir, fetchImpl);
  assert.equal(saved[0], path.join(dir, "geosite.dat"));
  assert.equal(await readFile(saved[0], "utf8"), "synthetic-geo");
  await rm(dir, { recursive: true, force: true });
});

test("payload hash mismatch does not leave the dataset in place", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-payload-"));
  const entry = {
    file: "geoip.dat",
    checksumName: "geoip.dat",
    sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    url: "https://github.com/v2fly/geoip/releases/download/test/geoip.dat",
    checksumUrl: "https://github.com/v2fly/geoip/releases/download/test/geoip.dat.sha256sum",
  };
  /** @type {typeof fetch} */
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith(".sha256sum")) {
      return new Response(
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  geoip.dat\n",
      );
    }
    return new Response(Buffer.from("tampered"));
  };
  await assert.rejects(fetchEntry(entry, dir, fetchImpl), /checksum mismatch/);
  await assert.rejects(stat(path.join(dir, "geoip.dat")));
  await assert.rejects(stat(path.join(dir, "geoip.dat.tmp")));
  await rm(dir, { recursive: true, force: true });
});
