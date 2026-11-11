import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { call, createTenant, fixture, tokenFor } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { ISSUER, AUDIENCE } from "./helpers.mjs";
import { listen } from "./helpers.mjs";

async function runNode(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("upload, download, share, delete, quotas, isolation, and restore", async (t) => {
  const fx = await fixture(t, {
    projectBytes: 1_000,
    maxFileBytes: 100,
    defaultTenantBytes: 1_000,
    defaultTenantObjects: 10,
  });
  const limits = await call(fx.port, { path: "/v1/limits" });
  assert.equal(limits.status, 200);
  const published = JSON.parse(limits.body.toString("utf8"));
  assert.equal(published.driver, "filesystem");
  assert.equal(published.liveSupabase, false);
  assert.equal(published.projectBytes, 1_000);

  const a = await createTenant(fx.port, fx.bootstrapToken, {
    name: "alpha",
    cid: "cid_alpha",
    quota: { maxBytes: 100, maxObjects: 2 },
  });
  const b = await createTenant(fx.port, fx.bootstrapToken, { name: "beta", cid: "cid_beta" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const tokenA = await tokenFor(fx.keys.privateKey, "cid_alpha", ["drive.read", "drive.write", "drive.share"]);
  const tokenB = await tokenFor(fx.keys.privateKey, "cid_beta", ["drive.read", "drive.write", "drive.share"]);
  const readOnly = await tokenFor(fx.keys.privateKey, "cid_alpha", ["drive.read"]);

  const plaintext = Buffer.from("hello-from-alpha");
  const put = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/notes/hello.txt",
    headers: {
      authorization: `Bearer ${tokenA}`,
      "x-cumulus-purpose": "drive.write",
      "content-type": "text/plain",
    },
    body: plaintext,
  });
  assert.equal(put.status, 200, put.body.toString("utf8"));

  const got = await call(fx.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(got.status, 200);
  assert.equal(got.body.toString("utf8"), "hello-from-alpha");

  const denied = await call(fx.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: `Bearer ${tokenB}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.toString("utf8").includes("hello-from-alpha"), false);

  const listed = await call(fx.port, {
    path: "/v1/objects/photos",
    headers: { authorization: `Bearer ${tokenB}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body.toString("utf8")).objects, []);

  const wrongTenant = await call(fx.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: {
      authorization: `Bearer ${tokenA}`,
      "x-cumulus-purpose": "drive.read",
      "x-cumulus-tenant": "tn_someone_else",
    },
  });
  assert.equal(wrongTenant.status, 403);

  const cidOnly = await call(fx.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: "Bearer cid_alpha", "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(cidOnly.status, 401);

  const readerPut = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/nope.txt",
    headers: { authorization: `Bearer ${readOnly}`, "x-cumulus-purpose": "drive.read" },
    body: Buffer.from("nope"),
  });
  assert.equal(readerPut.status, 403);

  const share = await call(fx.port, {
    method: "POST",
    path: "/v1/shares",
    headers: {
      authorization: `Bearer ${tokenA}`,
      "x-cumulus-purpose": "drive.share",
      "content-type": "application/json",
    },
    body: JSON.stringify({ bucket: "photos", key: "notes/hello.txt", ttlSeconds: 60 }),
  });
  assert.equal(share.status, 201, share.body.toString("utf8"));
  const shared = JSON.parse(share.body.toString("utf8"));
  const viaLink = await call(fx.port, { path: shared.url });
  assert.equal(viaLink.status, 200);
  assert.equal(viaLink.body.toString("utf8"), "hello-from-alpha");

  fx.clock.ms += 61_000;
  const expired = await call(fx.port, { path: shared.url });
  assert.equal(expired.status, 403);
  fx.clock.ms -= 61_000;

  const again = await call(fx.port, {
    method: "POST",
    path: "/v1/shares",
    headers: {
      authorization: `Bearer ${tokenA}`,
      "x-cumulus-purpose": "drive.share",
      "content-type": "application/json",
    },
    body: JSON.stringify({ bucket: "photos", key: "notes/hello.txt", ttlSeconds: 60 }),
  });
  const second = JSON.parse(again.body.toString("utf8"));
  const revoked = await call(fx.port, {
    method: "DELETE",
    path: `/v1/shares/${second.shareId}`,
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.share" },
  });
  assert.equal(revoked.status, 204);
  const afterRevoke = await call(fx.port, { path: second.url });
  assert.equal(afterRevoke.status, 403);
  const betaRevoke = await call(fx.port, {
    method: "DELETE",
    path: `/v1/shares/${second.shareId}`,
    headers: { authorization: `Bearer ${tokenB}`, "x-cumulus-purpose": "drive.share" },
  });
  assert.equal(betaRevoke.status, 404);

  const tooBig = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/big.bin",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.alloc(101),
  });
  assert.equal(tooBig.status, 413);

  const filler = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/filler.bin",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.alloc(80),
  });
  assert.equal(filler.status, 200, filler.body.toString("utf8"));
  const over = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/over.bin",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.alloc(10),
  });
  assert.equal(over.status, 403);
  assert.equal(JSON.parse(over.body.toString("utf8")).error.code, "QuotaExceeded");

  const usage = await call(fx.port, {
    path: "/v1/usage",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  const usageJson = JSON.parse(usage.body.toString("utf8"));
  assert.equal(usageJson.usedBytes, 96);

  await fx.app.close();
  const reopened = await createServer({
    sqlitePath: path.join(fx.dir, "drive.sqlite"),
    blobsDir: path.join(fx.dir, "blobs"),
    masterKey: fx.masterKey,
    bootstrapToken: fx.bootstrapToken,
    shareSecret: fx.shareSecret,
    issuer: ISSUER,
    audience: AUDIENCE,
    authMode: "keycloak",
    jwks: fx.keys.jwks,
    limits: { projectBytes: 1_000, maxFileBytes: 100, defaultTenantBytes: 1_000, defaultTenantObjects: 10 },
    now: () => new Date(fx.clock.ms),
  });
  const reopenedHttp = await listen(reopened.handle);
  t.after(async () => {
    await reopenedHttp.close();
    await reopened.close();
  });
  const still = await call(reopenedHttp.port, {
    path: "/v1/usage",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(JSON.parse(still.body.toString("utf8")).usedBytes, 96);
  const stillDenied = await call(reopenedHttp.port, {
    method: "PUT",
    path: "/v1/objects/photos/more.bin",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.alloc(10),
  });
  assert.equal(stillDenied.status, 403);

  const blobRoot = path.join(fx.dir, "blobs");
  const blobs = await findBlobs(blobRoot);
  assert.ok(blobs.length >= 1);
  for (const file of blobs) {
    const stored = await readFile(file);
    assert.equal(stored.includes(plaintext), false);
  }

  const backupDir = await mkdtemp(path.join(tmpdir(), "cumulus-backup-"));
  const cloudRoot = fileURLToPath(new URL("..", import.meta.url));
  await reopened.close();
  await reopenedHttp.close();
  const backed = await runNode(
    [
      "scripts/backup.mjs",
      "backup",
      "--sqlite",
      path.join(fx.dir, "drive.sqlite"),
      "--blobs",
      blobRoot,
      "--dir",
      backupDir,
    ],
    cloudRoot,
  );
  assert.equal(backed.code, 0, backed.stderr);
  const manifest = await readFile(path.join(backupDir, "manifest.json"), "utf8");
  assert.equal(manifest.includes(fx.masterKey.toString("base64")), false);
  assert.equal(manifest.includes("hello-from-alpha"), false);

  const restoredDir = await mkdtemp(path.join(tmpdir(), "cumulus-restored-"));
  const restored = await runNode(
    [
      "scripts/restore.mjs",
      "--sqlite",
      path.join(restoredDir, "drive.sqlite"),
      "--blobs",
      path.join(restoredDir, "blobs"),
      "--dir",
      backupDir,
    ],
    cloudRoot,
  );
  assert.equal(restored.code, 0, restored.stderr);
  const restoredApp = await createServer({
    sqlitePath: path.join(restoredDir, "drive.sqlite"),
    blobsDir: path.join(restoredDir, "blobs"),
    masterKey: fx.masterKey,
    bootstrapToken: fx.bootstrapToken,
    shareSecret: fx.shareSecret,
    issuer: ISSUER,
    audience: AUDIENCE,
    authMode: "keycloak",
    jwks: fx.keys.jwks,
    limits: { projectBytes: 1_000, maxFileBytes: 100, defaultTenantBytes: 1_000, defaultTenantObjects: 10 },
  });
  const restoredHttp = await listen(restoredApp.handle);
  t.after(async () => {
    await restoredHttp.close();
    await restoredApp.close();
  });
  const after = await call(restoredHttp.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(after.status, 200);
  assert.equal(after.body.toString("utf8"), "hello-from-alpha");
  const betaStill = await call(restoredHttp.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: `Bearer ${tokenB}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(betaStill.status, 404);

  const removed = await call(restoredHttp.port, {
    method: "DELETE",
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: `Bearer ${tokenB}`, "x-cumulus-purpose": "drive.write" },
  });
  assert.equal(removed.status, 404);
  const stillThere = await call(restoredHttp.port, {
    path: "/v1/objects/photos/notes/hello.txt",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(stillThere.body.toString("utf8"), "hello-from-alpha");

  const tampered = path.join(backupDir, "tables.json");
  const original = await readFile(tampered);
  await writeFile(tampered, Buffer.concat([original.subarray(0, 10), Buffer.from("X"), original.subarray(11)]));
  const badDir = await mkdtemp(path.join(tmpdir(), "cumulus-bad-"));
  const bad = await runNode(
    [
      "scripts/restore.mjs",
      "--sqlite",
      path.join(badDir, "drive.sqlite"),
      "--blobs",
      path.join(badDir, "blobs"),
      "--dir",
      backupDir,
    ],
    cloudRoot,
  );
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /checksum/i);
});

async function findBlobs(root) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^[a-f0-9]{32}$/.test(entry.name)) files.push(full);
    }
  }
  await walk(root);
  return files;
}

test("traversal and missing purpose fail closed", async (t) => {
  const fx = await fixture(t, { projectBytes: 1000, maxFileBytes: 100, defaultTenantBytes: 1000, defaultTenantObjects: 10 });
  await createTenant(fx.port, fx.bootstrapToken, { name: "gamma", cid: "cid_gamma" });
  const token = await tokenFor(fx.keys.privateKey, "cid_gamma", ["drive.write", "drive.read"]);
  const bad = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/%2e%2e/%2e%2e/secret",
    headers: { authorization: `Bearer ${token}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.from("nope"),
  });
  assert.equal(bad.status, 400);
  const noPurpose = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/ok.txt",
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.from("ok"),
  });
  assert.equal(noPurpose.status, 403);
});
