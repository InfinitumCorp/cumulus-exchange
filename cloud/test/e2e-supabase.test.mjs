import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createRemoteJWKSet, jwtVerify } from "jose";
import pg from "pg";
import { createS3Driver } from "../src/storage.mjs";

const API = process.env.API_URL || "http://127.0.0.1:54321";
const DRIVE = process.env.CUMULUS_DRIVE_URL || `${API}/functions/v1/drive`;
const ISSUER = `${API}/auth/v1`;

test(
  "supabase login, drive, quota, and tenant isolation",
  { skip: process.env.CUMULUS_E2E_SUPABASE === "1" ? false : "set CUMULUS_E2E_SUPABASE=1 to run against the local Supabase CLI" },
  async () => {
    for (const name of ["ANON_KEY", "DB_URL", "STORAGE_S3_URL", "S3_PROTOCOL_ACCESS_KEY_ID", "S3_PROTOCOL_ACCESS_KEY_SECRET"]) {
      if (!process.env[name]) throw new Error(`${name} is required`);
    }
    const driver = createS3Driver({
      endpoint: process.env.STORAGE_S3_URL,
      region: process.env.S3_PROTOCOL_REGION || "local",
      bucket: "cumulus-drive",
      accessKeyId: process.env.S3_PROTOCOL_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_PROTOCOL_ACCESS_KEY_SECRET,
      loopbackOnly: true,
    });
    assert.equal(await driver.probe(), true);

    const stamp = randomBytes(3).toString("hex");
    const ada = { email: `ada_${stamp}@cumuluscloud.app`, password: "ada-stack-password", cid: `cid_ada_${stamp}`, name: `ada${stamp}` };
    const bob = { email: `bob_${stamp}@cumuluscloud.app`, password: "bob-stack-password", cid: `cid_bob_${stamp}`, name: `bob${stamp}` };
    const adaUser = await signUp(ada);
    const bobUser = await signUp(bob);
    await bindTenant(adaUser, ada, 40);
    await bindTenant(bobUser, bob, 40);

    const adaToken = await login(ada);
    const bobToken = await login(bob);
    const adaClaims = await verifyToken(adaToken);
    const bobClaims = await verifyToken(bobToken);
    assert.equal(adaClaims.sub, adaUser);
    assert.equal(bobClaims.sub, bobUser);
    assert.equal(adaClaims.app_metadata?.cid, undefined);
    assert.equal(bobClaims.app_metadata?.cid, undefined);
    await assertTenantWritesDenied(adaClaims, adaToken, `tn_${ada.name}`, 40);
    await assertStorageDenied(adaToken, stamp);
    await assertBucketLocked();

    const hello = Buffer.from("hello-from-ada");
    const put = await drive("PUT", "/v1/objects/docs/hello.txt", adaToken, "drive.write", hello);
    assert.equal(put.status, 200, put.body);
    const got = await drive("GET", "/v1/objects/docs/hello.txt", adaToken, "drive.read");
    assert.equal(got.status, 200);
    assert.equal(got.raw.toString("utf8"), "hello-from-ada");

    const usage = await drive("GET", "/v1/usage", adaToken, "drive.read");
    assert.equal(usage.status, 200, usage.body);
    assert.equal(JSON.parse(usage.body).usedBytes, hello.length);

    const hidden = await drive("GET", "/v1/objects/docs/hello.txt", bobToken, "drive.read");
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.includes("hello-from-ada"), false);
    const bobDelete = await drive("DELETE", "/v1/objects/docs/hello.txt", bobToken, "drive.write");
    assert.equal(bobDelete.status, 404);
    await assertIsolated(bobClaims, adaClaims);

    await assertParity(adaToken, bobToken);

    const share = await drive("POST", "/v1/shares", adaToken, "drive.share", Buffer.from(JSON.stringify({
      bucket: "docs",
      key: "hello.txt",
      ttlSeconds: 120,
    })), "application/json");
    assert.equal(share.status, 201, share.body);
    const shareUrl = new URL(JSON.parse(share.body).url);
    assert.equal(shareUrl.host, "cloud.cumuluscloud.app");
    const shared = await fetch(`${DRIVE}${shareUrl.pathname}${shareUrl.search}`);
    assert.equal(shared.status, 200);
    assert.equal(await shared.text(), "hello-from-ada");

    const over = await drive("PUT", "/v1/objects/docs/big.bin", adaToken, "drive.write", Buffer.alloc(30));
    assert.equal(over.status, 403, over.body);
    assert.equal(JSON.parse(over.body).error.code, "QuotaExceeded");

    const photoGone = await drive("DELETE", "/v1/objects/docs/pic.png", adaToken, "drive.write");
    assert.equal(photoGone.status, 204, photoGone.body);
    const removed = await drive("DELETE", "/v1/objects/docs/hello.txt", adaToken, "drive.write");
    assert.equal(removed.status, 204);
    const gone = await drive("GET", "/v1/objects/docs/hello.txt", adaToken, "drive.read");
    assert.equal(gone.status, 404);
    const after = await drive("GET", "/v1/usage", adaToken, "drive.read");
    assert.equal(JSON.parse(after.body).usedBytes, 0);
  },
);

async function signUp(user) {
  const response = await fetch(`${API}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: process.env.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!response.ok) throw new Error(`signup failed: ${response.status}`);
  const body = await response.json();
  if (!body.user?.id) throw new Error("signup did not return a user id");
  return body.user.id;
}

async function login(user) {
  const response = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("login did not return an access token");
  return body.access_token;
}

async function verifyToken(token) {
  const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, keys, { issuer: ISSUER });
  return payload;
}

async function bindTenant(userId, user, maxBytes) {
  const client = new pg.Client({ connectionString: process.env.DB_URL });
  await client.connect();
  try {
    await client.query("insert into cumulus.identities (user_id, cid) values ($1, $2)", [userId, user.cid]);
    await client.query(
      `insert into cumulus.tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at)
       values ($1, $2, $3, $4, 5, 0, 0, $5)`,
      [`tn_${user.name}`, user.name, user.cid, maxBytes, new Date().toISOString()],
    );
  } finally {
    await client.end();
  }
}

async function assertIsolated(bobClaims, adaClaims) {
  const client = new pg.Client({ connectionString: process.env.DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: bobClaims.sub, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const hidden = await client.query("select object_key from cumulus.objects");
    assert.equal(hidden.rows.length, 0);
    await client.query("rollback");
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: adaClaims.sub, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const visible = await client.query("select object_key from cumulus.objects");
    assert.deepEqual(visible.rows.map((row) => row.object_key), ["hello.txt"]);
    await client.query("rollback");
  } finally {
    await client.end();
  }
}

async function assertTenantWritesDenied(claims, token, tenantId, maxBytes) {
  const client = new pg.Client({ connectionString: process.env.DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: claims.sub, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const visible = await client.query("select id, max_bytes, used_bytes from cumulus.tenants");
    assert.deepEqual(
      visible.rows.map((row) => ({ id: row.id, max_bytes: Number(row.max_bytes), used_bytes: Number(row.used_bytes) })),
      [{ id: tenantId, max_bytes: maxBytes, used_bytes: 0 }],
    );
    await expectPrivilegeDenied(
      client,
      "update cumulus.tenants set max_bytes = 1, used_bytes = 9 where id = $1",
      [tenantId],
    );
    await expectPrivilegeDenied(
      client,
      `insert into cumulus.tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at)
       values ('tn_intruder', 'intruder', 'cid_intruder', 1, 1, 9, 0, $1)`,
      [new Date().toISOString()],
    );
    await expectPrivilegeDenied(
      client,
      `insert into cumulus.tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at)
       values ($1, 'taken', 'cid_taken', 1, 1, 7, 0, $2)
       on conflict (id) do update set max_bytes = excluded.max_bytes, used_bytes = excluded.used_bytes`,
      [tenantId, new Date().toISOString()],
    );
    await client.query("rollback");
    const still = await client.query("select max_bytes, used_bytes from cumulus.tenants where id = $1", [tenantId]);
    assert.equal(Number(still.rows[0].max_bytes), maxBytes);
    assert.equal(Number(still.rows[0].used_bytes), 0);
  } finally {
    await client.end();
  }

  const patch = await restAsUser("PATCH", `/tenants?id=eq.${encodeURIComponent(tenantId)}`, token, {
    max_bytes: 1,
    used_bytes: 9,
  });
  assert.ok(patch.status === 401 || patch.status === 403, `UPDATE ${patch.status} ${patch.text}`);
  const inserted = await restAsUser("POST", "/tenants", token, {
    id: "tn_http_intruder",
    name: "httpintruder",
    cid: "cid_http_intruder",
    max_bytes: 1,
    max_objects: 1,
    used_bytes: 9,
    used_objects: 0,
    created_at: new Date().toISOString(),
  });
  assert.ok(inserted.status === 401 || inserted.status === 403, `INSERT ${inserted.status} ${inserted.text}`);
  const upserted = await restAsUser(
    "POST",
    "/tenants",
    token,
    {
      id: tenantId,
      name: "taken",
      cid: "cid_taken",
      max_bytes: 1,
      max_objects: 1,
      used_bytes: 7,
      used_objects: 0,
      created_at: new Date().toISOString(),
    },
    "resolution=merge-duplicates,return=representation",
  );
  assert.ok(upserted.status === 401 || upserted.status === 403, `UPSERT ${upserted.status} ${upserted.text}`);
  const check = new pg.Client({ connectionString: process.env.DB_URL });
  await check.connect();
  try {
    const row = await check.query("select max_bytes, used_bytes from cumulus.tenants where id = $1", [tenantId]);
    assert.equal(Number(row.rows[0].max_bytes), maxBytes);
    assert.equal(Number(row.rows[0].used_bytes), 0);
    const intruder = await check.query("select id from cumulus.tenants where id in ('tn_intruder', 'tn_http_intruder')");
    assert.equal(intruder.rows.length, 0);
  } finally {
    await check.end();
  }
}

async function expectPrivilegeDenied(client, sql, params) {
  await client.query("savepoint neg");
  let error = null;
  try {
    await client.query(sql, params);
  } catch (caught) {
    error = caught;
  }
  await client.query("rollback to savepoint neg");
  assert.ok(error, `expected permission denied for ${sql}`);
  assert.equal(error.code, "42501", error.message);
}

async function restAsUser(method, path, token, body, prefer = "return=representation") {
  const response = await fetch(`${API}/rest/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      apikey: process.env.ANON_KEY,
      "accept-profile": "cumulus",
      "content-profile": "cumulus",
      "content-type": "application/json",
      prefer,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function assertStorageDenied(token, stamp) {
  const marker = `denied-${stamp}`;
  const write = await storageCall("POST", `/storage/v1/object/cumulus-drive/${marker}.txt`, token, "not-stored");
  assert.ok(write.status === 400 || write.status === 401 || write.status === 403, `storage write ${write.status} ${write.text}`);
  assert.equal(write.text.includes("not-stored"), false);
  const put = await storageCall("PUT", `/storage/v1/object/cumulus-drive/${marker}.txt`, token, "not-stored");
  assert.ok(put.status === 400 || put.status === 401 || put.status === 403, `storage put ${put.status} ${put.text}`);
  const read = await storageCall("GET", `/storage/v1/object/cumulus-drive/${marker}.txt`, token);
  assert.notEqual(read.status, 200, read.text);
  assert.equal(read.text.includes("not-stored"), false);
}

async function assertBucketLocked() {
  const client = new pg.Client({ connectionString: process.env.DB_URL });
  await client.connect();
  try {
    const bucket = await client.query("select public, file_size_limit from storage.buckets where id = 'cumulus-drive'");
    assert.equal(bucket.rows.length, 1);
    assert.equal(bucket.rows[0].public, false);
    assert.equal(Number(bucket.rows[0].file_size_limit), 50000000);
    const policies = await client.query(
      "select policyname, roles::text as roles from pg_policies where schemaname = 'storage' and tablename = 'objects'",
    );
    const open = policies.rows.filter((row) => grantsBrowser(row.roles));
    assert.deepEqual(open, []);
  } finally {
    await client.end();
  }
}

function grantsBrowser(rolesText) {
  const text = String(rolesText ?? "").replace(/[{}" ]/g, "");
  if (!text) return true;
  return text.split(",").some((role) => role === "anon" || role === "authenticated" || role === "public");
}

async function storageCall(method, path, token, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      apikey: process.env.ANON_KEY,
      ...(body ? { "content-type": "text/plain" } : {}),
    },
    body,
  });
  return { status: response.status, text: await response.text() };
}

async function drive(method, path, token, purpose, body, contentType) {
  const response = await fetch(`${DRIVE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-cumulus-purpose": purpose,
      ...(body && contentType ? { "content-type": contentType } : {}),
    },
    body,
  });
  const raw = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: raw.toString("utf8"), raw };
}

async function listView(token, view) {
  const listed = await drive("GET", `/v1/objects/docs?view=${view}`, token, "drive.read");
  assert.equal(listed.status, 200, listed.body);
  return JSON.parse(listed.body).objects;
}

async function parityCall(token, purpose, payload) {
  return drive("POST", "/v1/parity", token, purpose, Buffer.from(JSON.stringify({ bucket: "docs", ...payload })), "application/json");
}

async function assertParity(adaToken, bobToken) {
  const photo = await fetch(`${DRIVE}/v1/objects/docs/pic.png`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${adaToken}`,
      "x-cumulus-purpose": "drive.write",
      "content-type": "image/png",
      "x-cumulus-preview-class": "image",
      "x-cumulus-sealed-name": "v1:c2VhbGVk",
    },
    body: Buffer.from("png!!"),
  });
  assert.equal(photo.status, 200, await photo.text());

  const active = await listView(adaToken, "active");
  assert.deepEqual(active.map((o) => o.object_key).sort(), ["hello.txt", "pic.png"]);
  const pic = active.find((o) => o.object_key === "pic.png");
  assert.equal(pic.content_type, "image/png");
  assert.equal(pic.preview_class, "image");
  assert.equal(pic.sealed_name, "v1:c2VhbGVk");
  assert.equal(pic.starred, false);
  assert.deepEqual((await listView(adaToken, "photos")).map((o) => o.object_key), ["pic.png"]);

  const star = await parityCall(adaToken, "drive.write", { op: "star", key: "hello.txt", starred: 1 });
  assert.equal(star.status, 200, star.body);
  assert.deepEqual((await listView(adaToken, "starred")).map((o) => o.object_key), ["hello.txt"]);

  const readOnly = await parityCall(adaToken, "drive.read", { op: "trash", key: "hello.txt" });
  assert.equal(readOnly.status, 403, readOnly.body);
  const trash = await parityCall(adaToken, "drive.write", { op: "trash", key: "hello.txt" });
  assert.equal(trash.status, 200, trash.body);
  assert.deepEqual((await listView(adaToken, "active")).map((o) => o.object_key), ["pic.png"]);
  assert.deepEqual((await listView(adaToken, "trash")).map((o) => o.object_key), ["hello.txt"]);
  assert.deepEqual(await listView(adaToken, "starred"), []);
  const restore = await parityCall(adaToken, "drive.write", { op: "restore", key: "hello.txt" });
  assert.equal(restore.status, 200, restore.body);
  assert.deepEqual(await listView(adaToken, "trash"), []);

  const bobStar = await parityCall(bobToken, "drive.write", { op: "star", key: "hello.txt", starred: 1 });
  assert.equal(bobStar.status, 404, bobStar.body);
  assert.deepEqual(await listView(bobToken, "active"), []);

  const events = await drive("GET", "/v1/parity?op=activity", adaToken, "drive.read");
  assert.equal(events.status, 200, events.body);
  const actions = JSON.parse(events.body).events.map((e) => e.action);
  for (const action of ["upload", "star", "trash", "restore"]) assert.ok(actions.includes(action), `${action} in ${actions}`);
  const bobEvents = await drive("GET", "/v1/parity?op=activity", bobToken, "drive.read");
  assert.equal(JSON.parse(bobEvents.body).events.some((e) => e.object_key === "hello.txt" || e.object_key === "pic.png"), false);

  const security = await drive("GET", "/v1/parity?op=security", adaToken, "drive.read");
  assert.equal(security.status, 200, security.body);
  assert.equal(JSON.parse(security.body).versions, "not kept");
  const versions = await parityCall(adaToken, "drive.write", { op: "versions", key: "hello.txt" });
  assert.deepEqual(JSON.parse(versions.body), { versions: [] });
  const invite = await parityCall(adaToken, "drive.write", { op: "invite", key: "hello.txt", cid: "cid_someone", role: "viewer" });
  assert.equal(invite.status, 501, invite.body);
}
