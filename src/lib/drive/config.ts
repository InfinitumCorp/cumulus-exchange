import { lstat } from "node:fs/promises";
import path from "node:path";
import { DriveError } from "@/lib/drive/errors";

const DEFAULT_QUOTA = 100 * 1024 * 1024;
const DEFAULT_MAX = 25 * 1024 * 1024;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const QUOTA_CAP = 2_000_000_000;

export interface DriveConfig {
  blobRoot: string;
  pgliteDir: string;
  quotaBytes: number;
  maxObjectBytes: number;
  staleMs: number;
}

function positiveInt(name: string, fallback: number, cap: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new DriveError(503, "storage_unconfigured", `${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > cap) {
    throw new DriveError(503, "storage_unconfigured", `${name} is outside 1..${cap}.`);
  }
  return value;
}

async function persistentDir(name: string, configured: string): Promise<string> {
  if (!path.isAbsolute(configured)) {
    throw new DriveError(503, "storage_unconfigured", `${name} must be an absolute path.`);
  }
  const resolved = path.resolve(configured);
  const repo = path.resolve(process.cwd());
  if (resolved === repo || resolved.startsWith(repo + path.sep)) {
    throw new DriveError(503, "storage_unconfigured", `${name} must sit outside the repository.`);
  }
  try {
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DriveError(503, "storage_unconfigured", `${name} must be a real directory, not a symlink.`);
    }
  } catch (err) {
    if (err instanceof DriveError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DriveError(503, "storage_unconfigured", `${name} does not exist yet. Create it on a persistent volume.`);
    }
    throw err;
  }
  return resolved;
}

/**
 * Free self-hosted Drive. Refuses ephemeral hosts and a hosted DATABASE_URL
 * so this process cannot write to paid Postgres by accident.
 */
export async function readDriveConfig(): Promise<DriveConfig> {
  if (process.env.VERCEL || process.env.GROK_PROJECT_ID?.trim()) {
    throw new DriveError(
      503,
      "storage_unconfigured",
      "Drive storage refuses ephemeral hosted disk. Run Node on a persistent volume with CUMULUS_BLOB_ROOT and CUMULUS_PGLITE_DIR.",
    );
  }
  if (process.env.DATABASE_URL?.trim()) {
    throw new DriveError(
      503,
      "storage_unconfigured",
      "Unset DATABASE_URL. This free Drive build stores metadata only in file-backed PGLite at CUMULUS_PGLITE_DIR.",
    );
  }
  const blobRoot = process.env.CUMULUS_BLOB_ROOT?.trim();
  const pgliteDir = process.env.CUMULUS_PGLITE_DIR?.trim();
  if (!blobRoot || !pgliteDir) {
    throw new DriveError(
      503,
      "storage_unconfigured",
      "Set CUMULUS_BLOB_ROOT and CUMULUS_PGLITE_DIR to absolute directories on a persistent volume.",
    );
  }
  const quotaBytes = positiveInt("CUMULUS_DRIVE_QUOTA_BYTES", DEFAULT_QUOTA, QUOTA_CAP);
  const maxObjectBytes = Math.min(
    positiveInt("CUMULUS_DRIVE_MAX_OBJECT_BYTES", DEFAULT_MAX, QUOTA_CAP),
    quotaBytes,
  );
  const staleMs = positiveInt("CUMULUS_DRIVE_STALE_MS", DEFAULT_STALE_MS, 86_400_000);
  return {
    blobRoot: await persistentDir("CUMULUS_BLOB_ROOT", blobRoot),
    pgliteDir: await persistentDir("CUMULUS_PGLITE_DIR", pgliteDir),
    quotaBytes,
    maxObjectBytes,
    staleMs,
  };
}
