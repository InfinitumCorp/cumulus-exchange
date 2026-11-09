import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { call, createTenant, listen, testKeys, tokenFor, ISSUER, AUDIENCE } from "./helpers.mjs";
import { ensureContainers, POSTGRES_URL, S3_ENDPOINT } from "./containers.mjs";

test("postgres quotas and seaweedfs S3 stub stay on loopback", async (t) => {
  await ensureContainers();
  const keys = await testKeys();
  const masterKey = randomBytes(32);
  const bootstrapToken = `boot_${randomBytes(12).toString("base64url")}`;
  const shareSecret = `share_${randomBytes(12).toString("base64url")}`;
  const dir = await mkdtemp(path.join(tmpdir(), "cumulus-pg-"));
  const suffix = randomBytes(3).toString("hex");

  const postgresApp = await createServer({
    databaseUrl: POSTGRES_URL,
    blobsDir: path.join(dir, "blobs"),
    masterKey,
    bootstrapToken,
    shareSecret,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: keys.jwks,
    limits: { projectBytes: 500, maxFileBytes: 100, defaultTenantBytes: 500, defaultTenantObjects: 10 },
  });
  const postgresHttp = await listen(postgresApp.handle);
  t.after(async () => {
    await postgresHttp.close();
    await postgresApp.close();
  });

  const created = await createTenant(postgresHttp.port, bootstrapToken, {
    name: `pg${suffix}`,
    cid: `cid_pg_${suffix}`,
    quota: { maxBytes: 40, maxObjects: 2 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const token = await tokenFor(keys.privateKey, `cid_pg_${suffix}`, ["drive.read", "drive.write"]);
  const put = await call(postgresHttp.port, {
    method: "PUT",
    path: "/v1/objects/docs/note.txt",
    headers: { authorization: `Bearer ${token}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.from("postgres-bytes"),
  });
  assert.equal(put.status, 200, put.body.toString("utf8"));
  await postgresApp.close();
  await postgresHttp.close();

  const reopened = await createServer({
    databaseUrl: POSTGRES_URL,
    blobsDir: path.join(dir, "blobs"),
    masterKey,
    bootstrapToken,
    shareSecret,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: keys.jwks,
    limits: { projectBytes: 500, maxFileBytes: 100, defaultTenantBytes: 500, defaultTenantObjects: 10 },
  });
  const reopenedHttp = await listen(reopened.handle);
  t.after(async () => {
    await reopenedHttp.close();
    await reopened.close();
  });
  const got = await call(reopenedHttp.port, {
    path: "/v1/objects/docs/note.txt",
    headers: { authorization: `Bearer ${token}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(got.body.toString("utf8"), "postgres-bytes");
  const over = await call(reopenedHttp.port, {
    method: "PUT",
    path: "/v1/objects/docs/big.txt",
    headers: { authorization: `Bearer ${token}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.alloc(30),
  });
  assert.equal(over.status, 403);

  const s3Dir = await mkdtemp(path.join(tmpdir(), "cumulus-s3-"));
  const s3App = await createServer({
    sqlitePath: path.join(s3Dir, "drive.sqlite"),
    storageDriver: "s3",
    s3: {
      endpoint: S3_ENDPOINT,
      region: "us-east-1",
      bucket: "cumulus-drive-test",
      accessKeyId: "cumulus-test",
      secretAccessKey: "cumulus-test-secret",
      loopbackOnly: true,
    },
    masterKey,
    bootstrapToken,
    shareSecret,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: keys.jwks,
    limits: { projectBytes: 1000, maxFileBytes: 100, defaultTenantBytes: 1000, defaultTenantObjects: 10 },
  });
  const s3Http = await listen(s3App.handle);
  t.after(async () => {
    await s3Http.close();
    await s3App.close();
  });
  const s3Tenant = await createTenant(s3Http.port, bootstrapToken, {
    name: `s3${suffix}`,
    cid: `cid_s3_${suffix}`,
  });
  assert.equal(s3Tenant.status, 201, JSON.stringify(s3Tenant.json));
  const s3Token = await tokenFor(keys.privateKey, `cid_s3_${suffix}`, ["drive.read", "drive.write"]);
  const uploaded = await call(s3Http.port, {
    method: "PUT",
    path: "/v1/objects/box/file.txt",
    headers: { authorization: `Bearer ${s3Token}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.from("s3-stub-bytes"),
  });
  assert.equal(uploaded.status, 200, uploaded.body.toString("utf8"));
  const downloaded = await call(s3Http.port, {
    path: "/v1/objects/box/file.txt",
    headers: { authorization: `Bearer ${s3Token}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.body.toString("utf8"), "s3-stub-bytes");
  const removed = await call(s3Http.port, {
    method: "DELETE",
    path: "/v1/objects/box/file.txt",
    headers: { authorization: `Bearer ${s3Token}`, "x-cumulus-purpose": "drive.write" },
  });
  assert.equal(removed.status, 204);
  const gone = await call(s3Http.port, {
    path: "/v1/objects/box/file.txt",
    headers: { authorization: `Bearer ${s3Token}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(gone.status, 404);
});
