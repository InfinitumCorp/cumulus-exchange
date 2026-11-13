// Loads the Edge Function's TypeScript auth module under Node; run with --experimental-strip-types.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { CID, authSettings, createCidVerifier } from "../supabase/functions/drive/auth.ts";

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
const USERINFO = `${ISSUER}/protocol/openid-connect/userinfo`;
const UUID_CID = "cid_0b6f3c2e-6a1d-4f3e-9a4f-2f1c7d1e8b90";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envOf = (vars) => (name) => vars[name];

async function issuerKeys() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" }] });
  const sign = ({ sub = UUID_CID, aud = "cumulus-cloud", iss = ISSUER, typ = "at+jwt", exp = "10m" } = {}) =>
    new SignJWT({ client_id: aud, sid: "s1" })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  return { keys, sign };
}

test("the hosted function defaults to Cumulus://ID and derives its JWKS from the issuer", () => {
  const cid = authSettings(envOf({}), "https://ref.supabase.co");
  assert.equal(cid.mode, "cid");
  assert.equal(cid.issuer, ISSUER);
  assert.equal(cid.jwksUrl, `${ISSUER}/protocol/openid-connect/certs`);
  assert.deepEqual(cid.audiences, ["cumulus-cloud", "cumulus-exchange", "cumulus-mail"]);
  const mirror = authSettings(envOf({ CID_ISSUER: "https://mirror.example/realms/cumulus/", CID_AUDIENCES: "cumulus-cloud, scalvs" }), "");
  assert.equal(mirror.issuer, "https://mirror.example/realms/cumulus");
  assert.deepEqual(mirror.audiences, ["cumulus-cloud", "scalvs"]);
  const supa = authSettings(envOf({ CUMULUS_AUTH_MODE: "supabase" }), "https://ref.supabase.co");
  assert.equal(supa.mode, "supabase");
  assert.equal(supa.issuer, "https://ref.supabase.co/auth/v1");
  assert.equal(supa.jwksUrl, "https://ref.supabase.co/auth/v1/.well-known/jwks.json");
  assert.throws(() => authSettings(envOf({ CUMULUS_AUTH_MODE: "keycloak" }), ""), /CUMULUS_AUTH_MODE/);
});

test("cid_<uuid> and older cid_<word> forms are both accepted", () => {
  assert.equal(CID.test(UUID_CID), true);
  assert.equal(CID.test("cid_ada_1a2b3c"), true);
  assert.equal(CID.test("cid_"), false);
  assert.equal(CID.test("CID_ADA"), false);
  assert.equal(CID.test("cid_a/b"), false);
});

test("a Cumulus://ID access token is verified offline, then confirmed by userinfo and cached", async () => {
  const { keys, sign } = await issuerKeys();
  const calls = [];
  const verify = createCidVerifier({
    issuer: ISSUER,
    audiences: ["cumulus-cloud", "cumulus-exchange"],
    keys,
    jwtVerify,
    fetchImpl: async (url, init) => {
      calls.push([url, init.headers.authorization]);
      return json(200, { sub: UUID_CID });
    },
  });
  const token = await sign();
  assert.equal(await verify(token), UUID_CID);
  assert.equal(await verify(token), UUID_CID);
  assert.deepEqual(calls, [[USERINFO, `Bearer ${token}`]]);
  assert.equal(await verify(await sign({ aud: "cumulus-exchange" })), UUID_CID);
});

test("wrong issuer, audience, type, key, expiry or subject is refused before userinfo", async () => {
  const { keys, sign } = await issuerKeys();
  let userinfoCalls = 0;
  const verify = createCidVerifier({
    issuer: ISSUER,
    audiences: ["cumulus-cloud"],
    keys,
    jwtVerify,
    fetchImpl: async () => {
      userinfoCalls += 1;
      return json(200, { sub: UUID_CID });
    },
  });
  const rejected = (p) => assert.rejects(p, (err) => err.status === 401);
  await rejected(verify(await sign({ iss: "https://ref.supabase.co/auth/v1" })));
  await rejected(verify(await sign({ aud: "scalvs" })));
  await rejected(verify(await sign({ typ: "JWT" })));
  await rejected(verify(await sign({ exp: "-1m" })));
  await rejected(verify(await sign({ sub: "not-a-cid" })));
  await rejected(verify(await (await issuerKeys()).sign()));
  await rejected(verify("not a token"));
  assert.equal(userinfoCalls, 0);
  const mismatch = createCidVerifier({ issuer: ISSUER, audiences: ["cumulus-cloud"], keys, jwtVerify, fetchImpl: async () => json(200, { sub: "cid_someone_else" }) });
  await rejected(mismatch(await sign()));
});

test("signed-out sessions are 401 and an unreachable issuer is 503", async () => {
  const { keys } = await issuerKeys();
  const base = { issuer: ISSUER, audiences: ["cumulus-cloud"], keys, jwtVerify };
  const opaque = "opaque_session_token_abcdefghijkl";
  await assert.rejects(createCidVerifier({ ...base, fetchImpl: async () => json(401, {}) })(opaque), (err) => err.status === 401);
  await assert.rejects(createCidVerifier({ ...base, fetchImpl: async () => json(200, { username: "x" }) })(opaque), (err) => err.status === 401);
  await assert.rejects(
    createCidVerifier({ ...base, fetchImpl: async () => { throw new Error("offline"); } })(opaque),
    (err) => err.status === 503,
  );
  assert.equal(await createCidVerifier({ ...base, fetchImpl: async () => json(200, { sub: UUID_CID }) })(opaque), UUID_CID);
  assert.throws(() => createCidVerifier({ ...base, issuer: "http://id.example.test" }), /https/);
});
