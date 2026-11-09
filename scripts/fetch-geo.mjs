// @ts-check

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data/geo/geo.lock.json",
);

/**
 * @param {string} text
 * @returns {{ sha256: string, name: string }}
 */
export function parseSha256Sum(text) {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));
  if (!line) throw new Error("sha256sum file is empty");
  const match = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line);
  if (!match || !match[1] || !match[2]) throw new Error("sha256sum file is not a checksum line");
  return { sha256: match[1].toLowerCase(), name: match[2] };
}

/**
 * v2fly releases only. Loyalsoldier and sing-box lists are GPL-3 and are refused.
 * @param {Record<string, unknown>} entry
 */
export function assertV2flyOnly(entry) {
  const blob = JSON.stringify(entry).toLowerCase();
  if (blob.includes("loyalsoldier") || blob.includes("sing-box") || blob.includes("singbox")) {
    throw new Error("refusing non-v2fly geo dataset");
  }
  const url = String(entry.url || "");
  const checksumUrl = String(entry.checksumUrl || "");
  if (
    !url.startsWith("https://github.com/v2fly/") ||
    !checksumUrl.startsWith("https://github.com/v2fly/")
  ) {
    throw new Error("geo dataset URL must be a v2fly GitHub release");
  }
  if (entry.file !== "geoip.dat" && entry.file !== "geosite.dat") {
    throw new Error("geo lockfile file name is not allowed");
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} destDir
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function fetchEntry(entry, destDir, fetchImpl = fetch) {
  assertV2flyOnly(entry);
  const expected = String(entry.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw new Error(`lockfile hash for ${entry.file} is not sha256`);
  const checksumUrl = String(entry.checksumUrl);
  const sumResponse = await fetchImpl(checksumUrl, { redirect: "follow" });
  if (!sumResponse.ok) {
    throw new Error(`checksum download failed for ${entry.file}: ${sumResponse.status}`);
  }
  const parsed = parseSha256Sum(await sumResponse.text());
  if (parsed.sha256 !== expected) {
    throw new Error(
      `official sha256sum for ${entry.file} does not match the lockfile (${parsed.sha256})`,
    );
  }
  if (parsed.name !== entry.checksumName) {
    throw new Error(
      `official sha256sum for ${entry.file} names ${parsed.name}, not ${entry.checksumName}`,
    );
  }
  const dataResponse = await fetchImpl(String(entry.url), { redirect: "follow" });
  if (!dataResponse.ok)
    throw new Error(`download failed for ${entry.file}: ${dataResponse.status}`);
  const bytes = Buffer.from(await dataResponse.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${entry.file}: expected ${expected} got ${actual}`);
  }
  await mkdir(destDir, { recursive: true });
  const finalPath = path.join(destDir, String(entry.file));
  const tmp = `${finalPath}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, finalPath);
  return finalPath;
}

/**
 * @param {{ assets?: Record<string, unknown>[] }} lock
 * @param {string} destDir
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string[]>}
 */
export async function fetchLocked(lock, destDir, fetchImpl = fetch) {
  if (!Array.isArray(lock.assets) || lock.assets.length === 0)
    throw new Error("geo lockfile has no assets");
  /** @type {string[]} */
  const saved = [];
  for (const entry of lock.assets) {
    saved.push(await fetchEntry(entry, destDir, fetchImpl));
  }
  return saved;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  const dest = process.env.INFINITUM_GEO_DIR || path.dirname(LOCK_PATH);
  try {
    const files = await fetchLocked(lock, dest);
    console.log(JSON.stringify({ msg: "geo datasets verified", files }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "geo fetch failed");
    process.exit(1);
  }
}
