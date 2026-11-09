import { mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashesFromLock, parseSha256Sum, sha256Hex } from "../src/geo/v2ray-dat.mjs";

export const defaultLockPath = fileURLToPath(new URL("../geo/geo.lock.json", import.meta.url));
export const defaultDest = fileURLToPath(new URL("../var/geo", import.meta.url));

const MAX_BYTES = 80 * 1024 * 1024;
const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

/**
 * Download the lockfile's v2fly datasets into a gitignored directory.
 * Official .sha256sum assets are checked against the lock and against the
 * bytes. A mismatch throws and does not write either file.
 */
export async function fetchGeoDatasets({
  lock,
  lockPath = defaultLockPath,
  dest = defaultDest,
  fetchImpl = globalThis.fetch,
} = {}) {
  const document = lock ?? JSON.parse(await readFile(lockPath, "utf8"));
  hashesFromLock(document);
  const verified = [];
  for (const item of document.datasets) {
    const saveAs = item.saveAs || item.name;
    const sumBytes = await fetchBytes(item.sha256Url, fetchImpl);
    const official = parseSha256Sum(new TextDecoder().decode(sumBytes), item.asset);
    if (official !== item.sha256.toLowerCase()) {
      throw new Error(
        `official sha256sum for ${item.asset} does not match the lockfile (${official} != ${item.sha256.toLowerCase()})`,
      );
    }
    const bytes = await fetchBytes(item.url, fetchImpl);
    const got = await sha256Hex(bytes);
    if (got !== official) {
      throw new Error(`checksum mismatch for ${saveAs}: file ${got}, official ${official}`);
    }
    verified.push({ name: saveAs, bytes });
  }
  await mkdir(dest, { recursive: true });
  const written = [];
  for (const file of verified) {
    await writeAtomic(path.join(dest, file.name), file.bytes);
    written.push(file.name);
  }
  return written;
}

async function fetchBytes(url, fetchImpl) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("geo download redirect is missing a location");
      const next = new URL(location, current);
      if (next.protocol !== "https:" || !REDIRECT_HOSTS.has(next.hostname)) {
        throw new Error("geo download redirect left the official release host");
      }
      current = next.href;
      continue;
    }
    if (!response.ok) throw new Error(`geo download failed (${response.status}) for ${current}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) throw new Error("geo download is larger than expected");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("geo download is larger than expected");
    return bytes;
  }
  throw new Error("geo download redirected too many times");
}

async function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.partial`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  fetchGeoDatasets()
    .then((files) => {
      console.log(JSON.stringify({ msg: "geo datasets verified", dir: defaultDest, files }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "geo fetch failed");
      process.exit(1);
    });
}
