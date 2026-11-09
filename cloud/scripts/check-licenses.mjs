import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "node_modules");

/** @param {unknown} license */
export function forbiddenLicense(license) {
  const text = typeof license === "string" ? license : license?.type ? String(license.type) : "";
  if (!text) return "missing";
  if (/AGPL|Affero/i.test(text)) return "AGPL";
  if (/\bLGPL\b/i.test(text)) return "LGPL";
  if (/\bGPL\b/i.test(text) && !/\b(MIT|Apache|BSD|ISC|MPL|PostgreSQL|Unlicense|0BSD)\b/i.test(text)) {
    return "GPL";
  }
  return null;
}

async function packages(dir, found = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      await packages(full, found);
      continue;
    }
    const manifest = path.join(full, "package.json");
    try {
      const json = JSON.parse(await readFile(manifest, "utf8"));
      found.push({ name: json.name || entry.name, license: json.license, dir: full });
    } catch {
      /* not a package root */
    }
  }
  return found;
}

export async function scanLicenses() {
  const rows = await packages(root);
  const blocked = [];
  for (const row of rows) {
    if (row.name === "minio" || row.name?.startsWith("@minio/")) {
      blocked.push(`${row.name}: MinIO is AGPL and must not be linked`);
      continue;
    }
    const reason = forbiddenLicense(row.license);
    if (reason) blocked.push(`${row.name}: ${reason} (${JSON.stringify(row.license)})`);
  }
  return { rows, blocked };
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const { rows, blocked } = await scanLicenses();
  if (blocked.length > 0) {
    console.error(blocked.join("\n"));
    process.exit(1);
  }
  console.log(JSON.stringify({ msg: "license check passed", packages: rows.length }));
}
