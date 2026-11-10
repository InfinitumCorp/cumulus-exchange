// @ts-check

import path from "node:path";
import { loadGeoDir } from "../../src/lib/geo/load.mjs";
import { readGeoSetting, resolveGeoEnabled, writeGeoSetting } from "./geo-settings.mjs";

const SETTINGS = "geo-routing.json";

/**
 * Resolve the drive process switch and persist a CLI choice.
 * Returns null when routing stays off. A missing dataset returns enabled with a null index.
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   argv: string[],
 *   dataDir: string,
 *   geoDir: string,
 *   load?: (dir: string) => Promise<import("../../src/lib/geo/match.mjs").GeoIndex>,
 * }} options
 */
export async function prepareGeo(options) {
  const file = path.join(options.dataDir, SETTINGS);
  const persisted = await readGeoSetting(file);
  const decision = resolveGeoEnabled({ env: options.env, argv: options.argv, persisted });
  if (decision.persist) await writeGeoSetting(file, decision.enabled);
  if (!decision.enabled) return null;
  const load = options.load ?? loadGeoDir;
  try {
    const index = await load(options.geoDir);
    return { enabled: true, index, warning: null };
  } catch (error) {
    return {
      enabled: true,
      index: null,
      warning: error instanceof Error ? error.message : "geo datasets unavailable",
    };
  }
}
