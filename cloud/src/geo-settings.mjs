// @ts-check

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isGeoEnabled } from "../../src/lib/geo/hook.mjs";

/**
 * @param {string[]} argv
 * @returns {boolean | null}
 */
export function parseGeoFlag(argv) {
  let on = false;
  let off = false;
  for (const arg of argv) {
    if (arg === "--geo") on = true;
    else if (arg === "--no-geo") off = true;
  }
  if (on && off) throw new Error("Pass only one of --geo or --no-geo");
  if (on) return true;
  if (off) return false;
  return null;
}

/**
 * CLI flag, then INFINITUM_GEO_ENABLED, then the persisted file, then off.
 * Only an explicit CLI flag is written back.
 * @param {{ env?: NodeJS.ProcessEnv, argv?: string[], persisted?: boolean | null }} options
 * @returns {{ enabled: boolean, source: "cli" | "env" | "file" | "default", persist: boolean }}
 */
export function resolveGeoEnabled(options = {}) {
  const env = options.env ?? {};
  const flag = parseGeoFlag(options.argv ?? []);
  if (flag === true || flag === false) return { enabled: flag, source: "cli", persist: true };
  const raw = env.INFINITUM_GEO_ENABLED;
  if (raw != null && String(raw).trim() !== "") {
    return { enabled: isGeoEnabled(env), source: "env", persist: false };
  }
  if (options.persisted === true || options.persisted === false) {
    return { enabled: options.persisted, source: "file", persist: false };
  }
  return { enabled: false, source: "default", persist: false };
}

/**
 * @param {string} file
 * @returns {Promise<boolean | null>}
 */
export async function readGeoSetting(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.geoRouting === true) return true;
    if (parsed.geoRouting === false) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {boolean} enabled
 */
export async function writeGeoSetting(file, enabled) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ geoRouting: enabled === true })}\n`);
  await rename(tmp, file);
}
