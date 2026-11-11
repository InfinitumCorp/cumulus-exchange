import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const blobRoot = await mkdtemp(path.join(tmpdir(), "cumulus-blob-"));
const pgliteDir = await mkdtemp(path.join(tmpdir(), "cumulus-pg-"));
const emailA = "demo.ada@cumuluscloud.app";
const emailB = "demo.bea@cumuluscloud.app";

process.env.CUMULUS_BLOB_ROOT = blobRoot;
process.env.CUMULUS_PGLITE_DIR = pgliteDir;
process.env.BETTER_AUTH_SECRET = "drive-test-secret-value-with-32-plus";
process.env.CUMULUS_DRIVE_QUOTA_BYTES = "1000";
process.env.CUMULUS_DRIVE_MAX_OBJECT_BYTES = "2000";
process.env.CUMULUS_DRIVE_STALE_MS = "900000";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
delete process.env.GROK_PROJECT_ID;

function textFile(body: string, name: string, key = randomUUID()) {
  return new Request("http://localhost:8080/api/drive/objects", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "idempotency-key": key,
      "x-display-name": name,
    },
    body,
  });
}

async function runChild(role: string, id: string, outFile: string, extra: Record<string, string> = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./scripts/drive-test-register.mjs",
        "src/lib/drive/persist-cli.ts",
        role,
        id,
        outFile,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`persist-cli ${role} exited ${code}: ${err}`));
    });
  });
}

test("filesystem Drive persists, isolates tenants, and enforces quota", async () => {
  const { auth } = await import("@/lib/auth/server");
  const { getSql } = await import("@/lib/db");
  const { readDriveConfig } = await import("@/lib/drive/config");
  const { assertObjectKey } = await import("@/lib/drive/blob-store");
  const {
    closeDrive,
    deleteObject,
    quotaFor,
    reconcileDrive,
    uploadObject,
  } = await import("@/lib/drive/service");
  const http = await import("@/lib/drive/http");
  const { testSessionCookie } = await import("@/lib/drive/test-session");
  await getSql();

  // People sign in with Cumulus ID; the test stands in for its callback.
  const cookieA = await testSessionCookie(auth, emailA, "Ada");
  const cookieB = await testSessionCookie(auth, emailB, "Bea");

  const anon = await http.postObject(textFile("hello", "note.txt"));
  assert.equal(anon.status, 401);

  const uploaded = await http.postObject(
    new Request("http://localhost:8080/api/drive/objects", {
      method: "POST",
      headers: {
        cookie: cookieA,
        "content-type": "text/plain",
        "idempotency-key": randomUUID(),
        "x-display-name": "../../SENTINEL_NAME",
      },
      body: "SENTINEL_CONTENT",
    }),
  );
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const stored = (await uploaded.json()) as { id: string; displayName: string };
  assert.equal(stored.displayName.includes("/"), false);
  assert.equal(stored.displayName.includes(".."), false);

  const listB = await http.getObjects(new Request("http://localhost:8080/api/drive/objects", { headers: { cookie: cookieB } }));
  const listBBody = await listB.text();
  assert.equal(listB.status, 200);
  assert.equal(listBBody.includes(stored.id), false);
  assert.equal(listBBody.includes("SENTINEL_NAME"), false);
  assert.equal(listBBody.includes("SENTINEL_CONTENT"), false);

  const readB = await http.getObject(
    new Request("http://localhost:8080/api/drive/objects/" + stored.id, { headers: { cookie: cookieB } }),
    stored.id,
  );
  const readBBody = await readB.text();
  assert.equal(readB.status, 404);
  assert.equal(readBBody.includes("SENTINEL_CONTENT"), false);

  const deleteB = await http.removeObject(
    new Request("http://localhost:8080/api/drive/objects/" + stored.id, { method: "DELETE", headers: { cookie: cookieB } }),
    stored.id,
  );
  assert.equal(deleteB.status, 404);
  const shareB = await http.postShare(
    new Request("http://localhost:8080/api/drive/objects/" + stored.id + "/shares", {
      method: "POST",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({ consent: true, expiresInSeconds: 3600 }),
    }),
    stored.id,
  );
  assert.equal(shareB.status, 404);

  const readA = await http.getObject(
    new Request("http://localhost:8080/api/drive/objects/" + stored.id, { headers: { cookie: cookieA } }),
    stored.id,
  );
  assert.equal(readA.status, 200);
  assert.equal(await readA.text(), "SENTINEL_CONTENT");

  const noConsent = await http.postShare(
    new Request("http://localhost:8080/share", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ consent: false, expiresInSeconds: 3600 }),
    }),
    stored.id,
  );
  assert.equal(noConsent.status, 400);

  const shared = await http.postShare(
    new Request("http://localhost:8080/share", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ consent: true, expiresInSeconds: 3600 }),
    }),
    stored.id,
  );
  assert.equal(shared.status, 201, await shared.clone().text());
  const share = (await shared.json()) as { id: string; token: string };
  const viaToken = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", {
      headers: { authorization: `Bearer ${share.token}` },
    }),
  );
  assert.equal(viaToken.status, 200);
  assert.equal(await viaToken.text(), "SENTINEL_CONTENT");
  const revoked = await http.removeShare(
    new Request("http://localhost:8080/api/drive/shares/" + share.id, { method: "DELETE", headers: { cookie: cookieA } }),
    share.id,
  );
  assert.equal(revoked.status, 200);
  const afterRevoke = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", {
      headers: { authorization: `Bearer ${share.token}` },
    }),
  );
  assert.equal(afterRevoke.status, 404);

  const expiring = await http.postShare(
    new Request("http://localhost:8080/share", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ consent: true, expiresInSeconds: 60 }),
    }),
    stored.id,
  );
  const expiringBody = (await expiring.json()) as { id: string; token: string };
  const { getPglite } = await import("@/lib/db");
  const pg = await getPglite();
  await pg.query("update drive_share set expires_at = now() - interval '1 minute' where id = $1", [
    expiringBody.id,
  ]);
  const expired = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", {
      headers: { authorization: `Bearer ${expiringBody.token}` },
    }),
  );
  assert.equal(expired.status, 404);

  const sessionA = await auth.api.getSession({ headers: new Headers({ cookie: cookieA }) });
  const userA = sessionA?.user?.id;
  assert.ok(userA);
  const before = await quotaFor(userA);
  const eightHundred = "A".repeat(800);
  const [first, second] = await Promise.all([
    uploadObject({
      userId: userA,
      bytes: new TextEncoder().encode(eightHundred),
      mediaType: "text/plain",
      displayName: "a.txt",
      idempotencyKey: randomUUID(),
    }).then(
      (value) => ({ ok: true as const, value }),
      (err: Error) => ({ ok: false as const, message: err.message }),
    ),
    uploadObject({
      userId: userA,
      bytes: new TextEncoder().encode(eightHundred),
      mediaType: "text/plain",
      displayName: "b.txt",
      idempotencyKey: randomUUID(),
    }).then(
      (value) => ({ ok: true as const, value }),
      (err: Error) => ({ ok: false as const, message: err.message }),
    ),
  ]);
  const wins = [first, second].filter((item) => item.ok);
  assert.equal(wins.length, 1);
  const after = await quotaFor(userA);
  assert.equal(after.bytesStored + after.bytesReserved, before.bytesStored + before.bytesReserved + 800);

  const held = after.bytesReserved;
  const userDirs = await readdir(path.join(blobRoot, "drive"));
  const blockedDir = path.join(blobRoot, "drive", userDirs[0]);
  await chmod(blockedDir, 0o555);
  const failed = await uploadObject({
    userId: userA,
    bytes: new TextEncoder().encode("fail-upload"),
    mediaType: "text/plain",
    displayName: "fail.txt",
    idempotencyKey: randomUUID(),
  }).then(
    () => "stored",
    (err: Error) => err.message,
  );
  await chmod(blockedDir, 0o700);
  assert.equal(failed, "store_failed");
  const released = await quotaFor(userA);
  assert.equal(released.bytesReserved, held);

  const orphanKey = randomUUID();
  await uploadObject({
    userId: userA,
    bytes: new TextEncoder().encode("orphan-pending"),
    mediaType: "text/plain",
    displayName: "orphan.txt",
    idempotencyKey: orphanKey,
  });
  await pg.query(
    "update drive_object set status = 'pending', stored_at = null, created_at = now() - interval '2 hours' where idempotency_key = $1",
    [orphanKey],
  );
  const orphan = await pg.query<{ id: string; byte_size: number; object_key: string }>(
    "select id, byte_size, object_key from drive_object where idempotency_key = $1",
    [orphanKey],
  );
  const { localBlobStore } = await import("@/lib/drive/local-blob");
  const store = localBlobStore(blobRoot);
  await store.remove(orphan.rows[0].object_key);
  await pg.query(
    "update drive_quota set bytes_stored = bytes_stored - $2, bytes_reserved = bytes_reserved + $2 where owner_user_id = $1",
    [userA, orphan.rows[0].byte_size],
  );
  process.env.CUMULUS_DRIVE_STALE_MS = "1000";
  await reconcileDrive();
  const cleaned = await pg.query<{ status: string }>(
    "select status from drive_object where id = $1",
    [orphan.rows[0].id],
  );
  assert.equal(cleaned.rows[0].status, "aborted");

  await deleteObject(userA, stored.id);
  const gone = await http.getObject(
    new Request("http://localhost:8080/api/drive/objects/" + stored.id, { headers: { cookie: cookieA } }),
    stored.id,
  );
  assert.equal(gone.status, 404);

  assert.throws(() => assertObjectKey("drive/../etc/passwd"));
  const link = path.join(path.dirname(blobRoot), `blob-link-${randomUUID()}`);
  await symlink(blobRoot, link);
  process.env.CUMULUS_BLOB_ROOT = link;
  await assert.rejects(readDriveConfig(), /symlink/);
  process.env.CUMULUS_BLOB_ROOT = blobRoot;

  const roundtripId = wins[0].ok ? wins[0].value.id : stored.id;
  const outFile = path.join(blobRoot, "roundtrip-out.txt");
  await closeDrive();
  await runChild("read", roundtripId, outFile, {
    CUMULUS_TEST_EMAIL: emailA,
  });
  const round = await readFile(outFile, "utf8");
  assert.equal(round, eightHundred);
});
