// @ts-check

import path from "node:path";
import { geoPolicy, isGeoEnabled } from "./hook.mjs";
import { loadGeoDir } from "./load.mjs";
import { lookupCategories, lookupCountry } from "./match.mjs";

/** @type {Promise<import("./match.mjs").GeoIndex> | null} */
let cached = null;
/** @type {string | null} */
let cachedDir = null;

export function resetGeoCache() {
  cached = null;
  cachedDir = null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function geoDataDir(env = process.env) {
  if (env.INFINITUM_GEO_DIR && env.INFINITUM_GEO_DIR.trim()) return env.INFINITUM_GEO_DIR;
  return path.join(process.cwd(), "data", "geo");
}

/**
 * @param {string} dir
 * @returns {Promise<import("./match.mjs").GeoIndex>}
 */
function geoIndex(dir) {
  if (!cached || cachedDir !== dir) {
    cachedDir = dir;
    cached = loadGeoDir(dir).catch((error) => {
      cached = null;
      cachedDir = null;
      throw error;
    });
  }
  return cached;
}

/**
 * Opt-in lookup. When INFINITUM_GEO_ENABLED is off the body is `{ enabled: false }`
 * and the dataset files are not opened.
 * @param {Request} request
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Response>}
 */
export async function handleGeoLookup(request, env = process.env) {
  if (!isGeoEnabled(env)) return Response.json({ enabled: false });
  const url = new URL(request.url);
  const ip = (url.searchParams.get("ip") || "").slice(0, 128);
  const domain = (url.searchParams.get("domain") || "").slice(0, 253);
  try {
    const index = await geoIndex(geoDataDir(env));
    /** @type {Record<string, unknown>} */
    const body = { enabled: true, loaded: true };
    if (ip) body.country = lookupCountry(index, ip);
    if (domain) body.categories = lookupCategories(index, domain);
    const policy = geoPolicy({ ip, domain }, index, true);
    if (policy.annotation) body.annotation = policy.annotation;
    return Response.json(body);
  } catch {
    return Response.json({ enabled: true, loaded: false });
  }
}
