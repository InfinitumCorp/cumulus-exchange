import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Write `data` to `file` via temp file, fsync, and rename.
 * Mode 0600 so tenant catalogs and ciphertext are not world-readable.
 * @param {string} file
 * @param {string | Buffer} data
 */
export async function atomicWrite(file, data) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  try {
    const dh = await open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Directory fsync is best-effort. The rename is already durable on most filesystems.
  }
}
