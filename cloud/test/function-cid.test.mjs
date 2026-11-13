import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { CidError, cidAudiences, cidIssuer, createCidVerifier } from "../supabase/functions/drive/cid.ts";
import { functionPath } from "../supabase/functions/drive/path.ts";

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
const CID = "cid_4f6c1b2e-8d1a-4c3b-9e2f-0a1b2c3d4e5f";
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
const keys = createLocalJWKSet({ keys: [jwk] });

function sign(claims = {}, header = {}) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "k1", ...header })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? "cumulus-cloud")
    .setSubject(claims.sub ?? CID)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(privateKey);
}

function userinfo(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function verifier(fetchImpl, extra = {}) {
  return createCidVerifier({ issuer: ISSUER, audiences: cidAudiences(undefined), keys, jwtVerify, fetchImpl, ...extra });
}

async function rejects(promise, status) {
  await assert.rejects(promise, (error) => error instanceof CidError && error.status === status);
}

test("a live Cumulus ID access token yields its cid, and userinfo is cached", async () => {
  const live = userinfo(200, { sub: CID });
  const verify = verifier(live.fetchImpl);
  const token = await sign();
  assert.equal(await verify(token), CID);
  assert.equal(await verify(token), CID);
  assert.equal(live.calls.length, 1);
  assert.equal(live.calls[0].url, `${ISSUER}/protocol/openid-connect/userinfo`);
  assert.equal(live.calls[0].auth, `Bearer ${token}`);
});

test("signature, typ, issuer, audience and expiry are enforced before userinfo", async () => {
  const live = userinfo(200, { sub: CID });
  const verify = verifier(live.fetchImpl);
  await rejects(verify(await sign({ aud: "someone-else" })), 401);
  await rejects(verify(await sign({ iss: "https://evil.example/realms/cumulus" })), 401);
  await rejects(verify(await sign({}, { typ: "JWT" })), 401);
  await rejects(verify(await sign({ exp: Math.floor(Date.now() / 1000) - 60 })), 401);
  await rejects(verify(await sign({ sub: "not-a-cid" })), 401);
  const other = await generateKeyPair("ES256");
  const forged = await new SignJWT({}).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "k1" })
    .setIssuer(ISSUER).setAudience("cumulus-cloud").setSubject(CID).setExpirationTime("5m").sign(other.privateKey);
  await rejects(verify(forged), 401);
  assert.equal(live.calls.length, 0);
});

test("a signed-out session or a different userinfo subject is rejected", async () => {
  await rejects(verifier(userinfo(401, {}).fetchImpl)(await sign()), 401);
  await rejects(verifier(userinfo(200, { sub: "cid_someone_else" }).fetchImpl)(await sign()), 401);
  await rejects(verifier(userinfo(502, {}).fetchImpl)(await sign()), 503);
});

test("opaque tokens are accepted only on userinfo's word; junk is refused without a call", async () => {
  const live = userinfo(200, { sub: CID });
  const verify = verifier(live.fetchImpl);
  assert.equal(await verify("A".repeat(40)), CID);
  await rejects(verify("short"), 401);
  assert.equal(live.calls.length, 1);
});

test("issuer must be https or loopback", () => {
  assert.equal(cidIssuer(undefined), ISSUER);
  assert.equal(cidIssuer("http://127.0.0.1:8180/realms/cumulus/"), "http://127.0.0.1:8180/realms/cumulus");
  assert.throws(() => cidIssuer("http://id.example/realms/cumulus"));
});

test("console paths reach the function routes through the Worker", () => {
  assert.equal(functionPath("/drive/drive/v1/usage"), "/v1/usage");
  assert.equal(functionPath("/functions/v1/drive/drive/v1/objects/drive"), "/v1/objects/drive");
  assert.equal(functionPath("/drive/v1/usage"), "/v1/usage");
  assert.equal(functionPath("/functions/v1/drive/healthz"), "/healthz");
  assert.equal(functionPath("/drive"), "/");
});
