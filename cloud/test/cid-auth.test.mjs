import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { authenticate, createCidVerifier } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
const USERINFO = `${ISSUER}/protocol/openid-connect/userinfo`;
const CID = "cid_0b6f3c2e-6a1d-4f3e-9a4f-2f1c7d1e8b90";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function issuerKeys() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const sign = ({ sub = CID, aud = "cumulus-cloud", iss = ISSUER, typ = "at+jwt", exp = "10m" } = {}) =>
    new SignJWT({ client_id: aud, scope: "openid profile email", sid: "s1" })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  return { jwks, sign };
}

test("Cumulus://ID realm is the default issuer and CID_ISSUER names a mirror", () => {
  const config = loadConfig({});
  assert.equal(config.cidIssuer, ISSUER);
  assert.deepEqual(config.cidAudiences, ["cumulus-cloud", "cumulus-exchange", "cumulus-mail"]);
  assert.equal(loadConfig({ CID_ISSUER: "https://mirror.example/realms/cumulus/" }).cidIssuer, "https://mirror.example/realms/cumulus");
  assert.deepEqual(loadConfig({ CID_AUDIENCES: "cumulus-cloud, scalvs" }).cidAudiences, ["cumulus-cloud", "scalvs"]);
});

test("cid verifier checks the access token against the JWKS, then asks userinfo and caches", async () => {
  const { jwks, sign } = await issuerKeys();
  const calls = [];
  const verifier = createCidVerifier({
    issuer: ISSUER,
    jwks,
    fetchImpl: async (url, init) => {
      calls.push([url, init.headers.authorization]);
      return json(200, { sub: CID, cid: CID, preferred_username: "ada" });
    },
  });
  const token = await sign();
  const req = { headers: { authorization: `Bearer ${token}` } };
  const principal = await authenticate(req, { verifier, bootstrapToken: "bootstrap-token-value", allowBootstrap: true });
  assert.equal(principal.kind, "user");
  assert.equal(principal.cid, CID);
  assert.equal(principal.sub, CID);
  assert.deepEqual(principal.purposes, ["drive.read", "drive.write", "drive.share"]);
  await authenticate(req, { verifier, bootstrapToken: "bootstrap-token-value", allowBootstrap: true });
  assert.deepEqual(calls, [[USERINFO, `Bearer ${token}`]]);
  // The Exchange add-on client is accepted too.
  assert.equal((await verifier(await sign({ aud: "cumulus-exchange" }))).cid, CID);
});

test("cid verifier refuses tokens for another issuer, client, type, key, or subject", async () => {
  const { jwks, sign } = await issuerKeys();
  let userinfoCalls = 0;
  const verifier = createCidVerifier({
    issuer: ISSUER,
    jwks,
    fetchImpl: async () => {
      userinfoCalls += 1;
      return json(200, { sub: CID });
    },
  });
  const rejected = (p) => assert.rejects(p, (err) => err.status === 401);
  await rejected(verifier(await sign({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x" })));
  await rejected(verifier(await sign({ aud: "scalvs" })));
  await rejected(verifier(await sign({ typ: "JWT" })));
  await rejected(verifier(await sign({ exp: "-1m" })));
  await rejected(verifier(await sign({ sub: "not-a-cid" })));
  await rejected(verifier(await (await issuerKeys()).sign()));
  assert.equal(userinfoCalls, 0, "a token that fails offline checks never reaches userinfo");
  const mismatch = createCidVerifier({ issuer: ISSUER, jwks, fetchImpl: async () => json(200, { sub: "cid_someone_else" }) });
  await rejected(mismatch(await sign()));
});

test("cid verifier rejects signed-out tokens and missing CIDs, and keeps bootstrap separate", async () => {
  const rejected = createCidVerifier({ issuer: ISSUER, fetchImpl: async () => json(401, { error: "Not signed in" }) });
  await assert.rejects(rejected("opaque_session_token_abcdefghijkl"), (err) => err.status === 401);
  const noCid = createCidVerifier({ issuer: ISSUER, fetchImpl: async () => json(200, { username: "x" }) });
  await assert.rejects(noCid("opaque_session_token_abcdefghijkl"), (err) => err.status === 401);
  const down = createCidVerifier({ issuer: ISSUER, fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(down("opaque_session_token_abcdefghijkl"), (err) => err.status === 503);
  const bootstrap = await authenticate(
    { headers: { authorization: "Bearer bootstrap-token-value-123456" } },
    { verifier: rejected, bootstrapToken: "bootstrap-token-value-123456", allowBootstrap: true },
  );
  assert.equal(bootstrap.kind, "bootstrap");
  assert.throws(() => createCidVerifier({ issuer: "http://id.example.test" }), /https/);
});
