import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGeoIndex,
  decodeGeoIPList,
  decodeGeoSiteList,
  geoEnabled,
  hashesFromLock,
} from "./v2ray-dat.mjs";

const defaultDir = fileURLToPath(new URL("../../var/geo", import.meta.url));
const defaultLock = fileURLToPath(new URL("../../geo/geo.lock.json", import.meta.url));

const cache = new Map();

export function resetGeoCache() {
  cache.clear();
}

export function geoDir(env = process.env) {
  return path.resolve(env.INFINITUM_GEO_DIR || defaultDir);
}

export function geoLockPath(env = process.env) {
  return path.resolve(env.INFINITUM_GEO_LOCK || defaultLock);
}

/**
 * Load checksum-verified v2fly datasets. Returns null when the flag is off
 * and does not touch the filesystem in that case.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadGeoCatalog(env = process.env) {
  if (!geoEnabled(env.INFINITUM_GEO_ENABLED)) return null;
  const dir = geoDir(env);
  const lockPath = geoLockPath(env);
  const key = `${dir}\n${lockPath}`;
  if (!cache.has(key)) cache.set(key, readCatalog(dir, lockPath));
  return cache.get(key);
}

export async function prepareGeo(env = process.env) {
  if (!geoEnabled(env.INFINITUM_GEO_ENABLED)) return null;
  return loadGeoCatalog(env);
}

async function readCatalog(dir, lockPath) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const { geoipSha256, geositeSha256 } = hashesFromLock(lock);
  const geoip = await readDataset(dir, "geoip.dat");
  const geosite = await readDataset(dir, "geosite.dat");
  if (sha256(geoip) !== geoipSha256)
    throw new Error("geoip.dat checksum does not match the lockfile");
  if (sha256(geosite) !== geositeSha256)
    throw new Error("geosite.dat checksum does not match the lockfile");
  return createGeoIndex(decodeGeoIPList(geoip), decodeGeoSiteList(geosite));
}

async function readDataset(dir, name) {
  if (name !== "geoip.dat" && name !== "geosite.dat") throw new Error("unknown geo dataset");
  try {
    return await readFile(path.join(dir, name));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`${name} is not in the geo directory. Run node cloud/scripts/fetch-geo.mjs`);
    }
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
