import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createRemoteJWKSet, jwtVerify } from "jose";

const KEYCLOAK = process.env.CUMULUS_KEYCLOAK_URL || "http://127.0.0.1:8088";
const DRIVE = process.env.CUMULUS_DRIVE_URL || "http://127.0.0.1:8092";
const ISSUER = `${KEYCLOAK}/realms/cumulus`;
const AUDIENCE = "https://id.cumuluscloud.app";
const REDIRECT = "http://127.0.0.1:18080/callback";
const BOOTSTRAP = "stack-bootstrap-token";

test("live Keycloak PKCE login and Drive isolation", { skip: process.env.CUMULUS_E2E === "1" ? false : "set CUMULUS_E2E=1 to run against the compose stack" }, async () => {
  const stamp = randomBytes(3).toString("hex");
  const ada = { username: `ada_${stamp}`, password: "ada-stack-password", cid: `cid_ada_${stamp}` };
  const bob = { username: `bob_${stamp}`, password: "bob-stack-password", cid: `cid_bob_${stamp}` };
  await createTenant(ada.cid, `ada${stamp}`, 40);
  await createTenant(bob.cid, `bob${stamp}`, 40);
  const admin = await adminToken();
  await ensureCidAttribute(admin);
  await createKeycloakUser(admin, ada);
  await createKeycloakUser(admin, bob);

  const adaToken = await pkceLogin(ada);
  const bobToken = await pkceLogin(bob);
  const adaClaims = await verifyToken(adaToken);
  const bobClaims = await verifyToken(bobToken);
  assert.equal(adaClaims.cid, ada.cid);
  assert.equal(bobClaims.cid, bob.cid);
  assert.ok(asList(adaClaims.purposes).includes("drive.write"));

  const hello = Buffer.from("hello-from-ada");
  const put = await drive("PUT", "/v1/objects/docs/hello.txt", adaToken, "drive.write", hello);
  assert.equal(put.status, 200, put.body);
  const got = await drive("GET", "/v1/objects/docs/hello.txt", adaToken, "drive.read");
  assert.equal(got.status, 200);
  assert.equal(got.raw.toString("utf8"), "hello-from-ada");

  const hidden = await drive("GET", "/v1/objects/docs/hello.txt", bobToken, "drive.read");
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.includes("hello-from-ada"), false);
  const bobDelete = await drive("DELETE", "/v1/objects/docs/hello.txt", bobToken, "drive.write");
  assert.equal(bobDelete.status, 404);

  const share = await drive("POST", "/v1/shares", adaToken, "drive.share", Buffer.from(JSON.stringify({
    bucket: "docs",
    key: "hello.txt",
    ttlSeconds: 120,
  })), "application/json");
  assert.equal(share.status, 201, share.body);
  const shareUrl = new URL(JSON.parse(share.body).url);
  const shared = await fetch(`${DRIVE}${shareUrl.pathname}${shareUrl.search}`);
  assert.equal(shared.status, 200);
  assert.equal(await shared.text(), "hello-from-ada");

  const over = await drive("PUT", "/v1/objects/docs/big.bin", adaToken, "drive.write", Buffer.alloc(30));
  assert.equal(over.status, 403);
  assert.equal(JSON.parse(over.body).error.code, "QuotaExceeded");

  const removed = await drive("DELETE", "/v1/objects/docs/hello.txt", adaToken, "drive.write");
  assert.equal(removed.status, 204);
  const gone = await drive("GET", "/v1/objects/docs/hello.txt", adaToken, "drive.read");
  assert.equal(gone.status, 404);
});

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

async function verifyToken(token) {
  const keys = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));
  const { payload } = await jwtVerify(token, keys, { issuer: ISSUER, audience: AUDIENCE });
  return payload;
}

async function createTenant(cid, name, maxBytes) {
  const response = await fetch(`${DRIVE}/v1/tenants`, {
    method: "POST",
    headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
    body: JSON.stringify({ name, cid, quota: { maxBytes, maxObjects: 5 } }),
  });
  if (!response.ok) throw new Error(`tenant ${name}: ${response.status} ${await response.text()}`);
}

async function adminToken() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username: "admin",
    password: "admin",
  });
  const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`admin token ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

async function ensureCidAttribute(admin) {
  const current = await fetch(`${KEYCLOAK}/admin/realms/cumulus/users/profile`, {
    headers: { authorization: `Bearer ${admin}` },
  });
  if (!current.ok) throw new Error(`user profile ${current.status}`);
  const profile = await current.json();
  if (!profile.attributes.some((attribute) => attribute.name === "cid")) {
    profile.attributes.push({
      name: "cid",
      displayName: "CID",
      permissions: { view: ["admin", "user"], edit: ["admin"] },
      multivalued: false,
    });
  }
  profile.unmanagedAttributePolicy = "ADMIN_EDIT";
  const saved = await fetch(`${KEYCLOAK}/admin/realms/cumulus/users/profile`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!saved.ok) throw new Error(`save profile ${saved.status} ${await saved.text()}`);
}

async function createKeycloakUser(admin, user) {
  const created = await fetch(`${KEYCLOAK}/admin/realms/cumulus/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({
      username: user.username,
      email: `${user.username}@cumuluscloud.app`,
      enabled: true,
      emailVerified: true,
      attributes: { cid: [user.cid] },
      credentials: [{ type: "password", value: user.password, temporary: false }],
    }),
  });
  if (created.status !== 201) throw new Error(`create user ${created.status} ${await created.text()}`);
  const location = created.headers.get("location");
  const id = location.slice(location.lastIndexOf("/") + 1);
  const password = await fetch(`${KEYCLOAK}/admin/realms/cumulus/users/${id}/reset-password`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "password", value: user.password, temporary: false }),
  });
  if (!password.ok) throw new Error(`password ${password.status} ${await password.text()}`);
  const profile = await fetch(`${KEYCLOAK}/admin/realms/cumulus/users/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({
      username: user.username,
      email: `${user.username}@cumuluscloud.app`,
      firstName: user.username,
      lastName: "Stack",
      enabled: true,
      emailVerified: true,
      attributes: { cid: [user.cid] },
    }),
  });
  if (!profile.ok) throw new Error(`profile ${profile.status} ${await profile.text()}`);
  const roles = [];
  for (const name of ["drive.read", "drive.write", "drive.share"]) {
    const role = await fetch(`${KEYCLOAK}/admin/realms/cumulus/roles/${name}`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    if (!role.ok) throw new Error(`role ${name} ${role.status}`);
    roles.push(await role.json());
  }
  const mapped = await fetch(`${KEYCLOAK}/admin/realms/cumulus/users/${id}/role-mappings/realm`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify(roles),
  });
  if (!mapped.ok) throw new Error(`map roles ${mapped.status} ${await mapped.text()}`);
}

async function pkceLogin(user) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  auth.searchParams.set("client_id", "cumulus-cloud");
  auth.searchParams.set("redirect_uri", REDIRECT);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid");
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  const jar = new CookieJar();
  let response = await fetch(auth, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.store(response);
  let hops = 0;
  while (response.status >= 300 && response.status < 400 && hops < 8) {
    const next = new URL(response.headers.get("location"), response.url || auth);
    if (next.searchParams.get("code")) return exchange(next.searchParams.get("code"), verifier);
    response = await fetch(next, { redirect: "manual", headers: { cookie: jar.header() } });
    jar.store(response);
    hops += 1;
  }
  const page = await response.text();
  const action = page.match(/<form[^>]*action="([^"]+)"/i)?.[1];
  if (!action) throw new Error(`login form missing (${response.status}) ${page.slice(0, 240)}`);
  const form = new URLSearchParams();
  for (const match of page.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
    form.set(decode(match[1]), decode(match[2]));
  }
  form.set("username", user.username);
  form.set("password", user.password);
  const posted = await fetch(new URL(decode(action), response.url || auth), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: form,
  });
  jar.store(posted);
  return followForCode(posted, jar, verifier, auth);
}

async function followForCode(response, jar, verifier, base) {
  let current = response;
  for (let hop = 0; hop < 8; hop += 1) {
    if (current.status < 300 || current.status >= 400) {
      const text = await current.text();
      throw new Error(`login stopped at ${current.status} ${text.slice(0, 240)}`);
    }
    const next = new URL(current.headers.get("location"), current.url || base);
    const code = next.searchParams.get("code");
    if (code) return exchange(code, verifier);
    current = await fetch(next, { redirect: "manual", headers: { cookie: jar.header() } });
    jar.store(current);
  }
  throw new Error("login redirects did not return a code");
}

async function exchange(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "cumulus-cloud",
    redirect_uri: REDIRECT,
    code,
    code_verifier: verifier,
  });
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`token exchange ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

async function drive(method, pathname, token, purpose, body, contentType) {
  const headers = { authorization: `Bearer ${token}`, "x-cumulus-purpose": purpose };
  if (contentType) headers["content-type"] = contentType;
  const response = await fetch(`${DRIVE}${pathname}`, { method, headers, body });
  const raw = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: raw.toString("utf8"), raw };
}

function decode(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  store(response) {
    const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(";")[0];
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  header() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}
