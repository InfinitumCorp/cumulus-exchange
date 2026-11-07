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
    assert.equal(adaClaims.app_metadata.cid, ada.cid);
    assert.equal(bobClaims.app_metadata.cid, bob.cid);

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
      JSON.stringify({ sub: bobClaims.sub, app_metadata: { cid: bobClaims.app_metadata.cid } }),
    ]);
    await client.query("set local role authenticated");
    const hidden = await client.query("select object_key from cumulus.objects");
    assert.equal(hidden.rows.length, 0);
    await client.query("rollback");
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: adaClaims.sub, app_metadata: { cid: adaClaims.app_metadata.cid } }),
    ]);
    await client.query("set local role authenticated");
    const visible = await client.query("select object_key from cumulus.objects");
    assert.deepEqual(visible.rows.map((row) => row.object_key), ["hello.txt"]);
    await client.query("rollback");
  } finally {
    await client.end();
  }
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
