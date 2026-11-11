import assert from "node:assert/strict";
import { test } from "node:test";
import { call, createTenant, fixture, tokenFor } from "./helpers.mjs";

test("cloud plane trash, versions, password shares, grants, and deferred security", async (t) => {
  const fx = await fixture(t, {
    projectBytes: 10_000,
    maxFileBytes: 1000,
    defaultTenantBytes: 10_000,
    defaultTenantObjects: 20,
  });
  const alpha = await createTenant(fx.port, fx.bootstrapToken, { name: "alpha", cid: "cid_alpha" });
  const beta = await createTenant(fx.port, fx.bootstrapToken, { name: "beta", cid: "cid_beta" });
  assert.equal(alpha.status, 201);
  assert.equal(beta.status, 201);
  const tokenA = await tokenFor(fx.keys.privateKey, "cid_alpha", ["drive.read", "drive.write", "drive.share"]);
  const tokenB = await tokenFor(fx.keys.privateKey, "cid_beta", ["drive.read", "drive.write", "drive.share"]);
  const headersA = { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.write" };

  const first = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/drive/notes/a.txt",
    headers: { ...headersA, "content-type": "text/plain", "x-cumulus-preview-class": "text" },
    body: Buffer.from("one"),
  });
  assert.equal(first.status, 200, first.body.toString("utf8"));
  const second = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/drive/notes/a.txt",
    headers: { ...headersA, "content-type": "text/plain", "x-cumulus-keep-version": "1" },
    body: Buffer.from("two"),
  });
  assert.equal(second.status, 200, second.body.toString("utf8"));
  const versions = await call(fx.port, {
    path: "/v1/parity?op=versions&bucket=drive&key=notes/a.txt",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(versions.status, 200, versions.body.toString("utf8"));
  const history = JSON.parse(versions.body.toString("utf8")).versions;
  assert.equal(history.length, 1);
  const current = await call(fx.port, {
    path: "/v1/objects/drive/notes/a.txt",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(current.body.toString("utf8"), "two");
  const restored = await call(fx.port, {
    method: "POST",
    path: "/v1/parity",
    headers: { ...headersA, "content-type": "application/json", "x-cumulus-purpose": "drive.write" },
    body: JSON.stringify({ op: "restore-version", bucket: "drive", key: "notes/a.txt", versionId: history[0].id }),
  });
  assert.equal(restored.status, 200, restored.body.toString("utf8"));
  const again = await call(fx.port, {
    path: "/v1/objects/drive/notes/a.txt",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(again.body.toString("utf8"), "one");

  const trashed = await call(fx.port, {
    method: "POST",
    path: "/v1/parity",
    headers: { ...headersA, "content-type": "application/json" },
    body: JSON.stringify({ op: "trash", bucket: "drive", key: "notes/a.txt" }),
  });
  assert.equal(trashed.status, 200);
  const hidden = await call(fx.port, {
    path: "/v1/objects/drive",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(JSON.parse(hidden.body.toString("utf8")).objects.some((item) => item.object_key === "notes/a.txt"), false);
  const trash = await call(fx.port, {
    path: "/v1/objects/drive?view=trash",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(JSON.parse(trash.body.toString("utf8")).objects.some((item) => item.object_key === "notes/a.txt"), true);

  await call(fx.port, {
    method: "POST",
    path: "/v1/parity",
    headers: { ...headersA, "content-type": "application/json" },
    body: JSON.stringify({ op: "restore", bucket: "drive", key: "notes/a.txt" }),
  });
  const share = await call(fx.port, {
    method: "POST",
    path: "/v1/shares",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.share", "content-type": "application/json" },
    body: JSON.stringify({ bucket: "drive", key: "notes/a.txt", ttlSeconds: 60, password: "share-secret", maxDownloads: 1 }),
  });
  assert.equal(share.status, 201, share.body.toString("utf8"));
  const link = JSON.parse(share.body.toString("utf8"));
  assert.equal(link.hasPassword, true);
  const locked = await call(fx.port, { path: link.url });
  assert.equal(locked.status, 401);
  const opened = await call(fx.port, { path: `${link.url}&password=share-secret` });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.toString("utf8"), "one");
  const limited = await call(fx.port, { path: `${link.url}&password=share-secret` });
  assert.equal(limited.status, 403);

  const invite = await call(fx.port, {
    method: "POST",
    path: "/v1/parity",
    headers: { ...headersA, "content-type": "application/json" },
    body: JSON.stringify({ op: "invite", bucket: "drive", key: "notes/a.txt", cid: "cid_beta", role: "viewer" }),
  });
  assert.equal(invite.status, 201, invite.body.toString("utf8"));
  const shared = await call(fx.port, {
    path: "/v1/objects/drive/notes/a.txt",
    headers: { authorization: `Bearer ${tokenB}`, "x-cumulus-purpose": "drive.read" },
  });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.toString("utf8"), "one");
  const security = await call(fx.port, {
    path: "/v1/parity?op=security",
    headers: { authorization: `Bearer ${tokenA}`, "x-cumulus-purpose": "drive.read" },
  });
  const report = JSON.parse(security.body.toString("utf8"));
  assert.equal(report.twoFactor, "deferred");
  assert.equal(report.authority, "id.cumuluscloud.app");
  assert.equal(report.sync, "deferred");
  assert.equal(report.mail, "deferred");
});
