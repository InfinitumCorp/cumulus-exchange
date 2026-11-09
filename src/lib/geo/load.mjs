// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildIndex } from "./match.mjs";

/**
 * Read geoip.dat and geosite.dat from a directory. The directory is gitignored
 * for the upstream files; tests point this at the synthetic fixtures.
 * @param {string} dir
 * @returns {Promise<import("./match.mjs").GeoIndex>}
 */
export async function loadGeoDir(dir) {
  const ip = new Uint8Array(await readFile(path.join(dir, "geoip.dat")));
  const site = new Uint8Array(await readFile(path.join(dir, "geosite.dat")));
  return buildIndex(ip, site);
}
