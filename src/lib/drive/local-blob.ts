import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { assertObjectKey, type BlobStore } from "@/lib/drive/blob-store";
import { DriveError } from "@/lib/drive/errors";

const OPEN_WRITE =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const OPEN_READ = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

/**
 * Jail every object under a real directory the process created.
 * Symlinks are refused. Keys never become path segments from the caller.
 */
export async function prepareBlobRoot(configured: string): Promise<string> {
  if (!path.isAbsolute(configured)) {
    throw new DriveError(503, "storage_unconfigured", "CUMULUS_BLOB_ROOT must be an absolute path.");
  }
  const resolved = path.resolve(configured);
  const repo = path.resolve(process.cwd());
  if (resolved === repo || resolved.startsWith(repo + path.sep)) {
    throw new DriveError(
      503,
      "storage_unconfigured",
      "CUMULUS_BLOB_ROOT must sit outside the repository, on a persistent volume.",
    );
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new DriveError(
      503,
      "storage_unconfigured",
      "CUMULUS_BLOB_ROOT must be a real directory, not a symlink.",
    );
  }
  await chmod(resolved, 0o700);
  const real = await realpath(resolved);
  const realInfo = await lstat(real);
  if (realInfo.isSymbolicLink() || !realInfo.isDirectory()) {
    throw new DriveError(503, "storage_unconfigured", "CUMULUS_BLOB_ROOT resolved through a symlink.");
  }
  return real;
}

export function localBlobStore(root: string): BlobStore {
  function location(key: string): string {
    assertObjectKey(key);
    const parts = key.split("/");
    const full = path.resolve(root, ...parts);
    if (full !== path.join(root, ...parts) || !full.startsWith(root + path.sep)) {
      throw new DriveError(500, "storage_path_rejected");
    }
    return full;
  }

  return {
    async put(key, bytes) {
      const dest = location(key);
      const parent = path.dirname(dest);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentInfo = await lstat(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
        throw new DriveError(500, "storage_path_rejected");
      }
      let existing = false;
      try {
        const destInfo = await lstat(dest);
        existing = true;
        if (destInfo.isSymbolicLink()) throw new DriveError(500, "storage_path_rejected");
      } catch (err) {
        if (existing) throw err;
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (existing) throw new DriveError(409, "object_collision");
      const tmpDir = path.join(root, ".tmp");
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const tmp = path.join(tmpDir, randomUUID());
      const handle = await open(tmp, OPEN_WRITE, 0o600);
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(tmp, dest);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      await chmod(dest, 0o600);
      const finalInfo = await lstat(dest);
      if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) {
        await rm(dest, { force: true });
        throw new DriveError(500, "storage_path_rejected");
      }
    },
    async get(key) {
      const dest = location(key);
      const info = await lstat(dest);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new DriveError(500, "storage_path_rejected");
      }
      const handle = await open(dest, OPEN_READ);
      try {
        return await readFile(handle);
      } finally {
        await handle.close();
      }
    },
    async remove(key) {
      const dest = location(key);
      try {
        const info = await lstat(dest);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new DriveError(500, "storage_path_rejected");
        }
        await rm(dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    },
    async exists(key) {
      try {
        const info = await lstat(location(key));
        return info.isFile() && !info.isSymbolicLink();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },
  };
}
