import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import {
  CUMULUS_ID_CREATE_PROVIDER_ID,
  CUMULUS_ID_PROVIDER_ID,
  DEFAULT_CID_CLIENT_ID,
  DEFAULT_CID_ISSUER,
  EXCHANGE_CID_CLIENT_ID,
  SIGN_IN_PROVIDERS,
  cidConfig,
  cidEndpoints,
  cidUserInfo,
} from "./cumulus-id.ts";
import { verifyCidIdToken } from "./cumulus-id-token.server.ts";

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

async function signer() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { typ?: string; iss?: string; aud?: string | string[]; exp?: string } = {}) =>
    new SignJWT({ cid: "cid_7c1e", email: "ada@cumuluscloud.app", email_verified: true, name: "Ada", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: opts.typ ?? "JWT" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? "cumulus-cloud")
      .setSubject("cid_7c1e")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);
  return { keys, sign };
}

describe("Cumulus://ID sign-in", () => {
  it("offers only Cumulus ID: sign in, then create", () => {
    assert.deepEqual(
      SIGN_IN_PROVIDERS.map((p) => [p.providerId, p.label, p.create]),
      [
        [CUMULUS_ID_PROVIDER_ID, "Sign in with Cumulus ID", false],
        [CUMULUS_ID_CREATE_PROVIDER_ID, "Create a Cumulus ID", true],
      ],
    );
  });

  it("defaults to the cumulus realm issuer and the cumulus-cloud client", () => {
    assert.deepEqual(cidConfig({}), { issuer: DEFAULT_CID_ISSUER, clientId: DEFAULT_CID_CLIENT_ID });
    assert.equal(DEFAULT_CID_ISSUER, ISSUER);
    assert.equal(DEFAULT_CID_CLIENT_ID, "cumulus-cloud");
  });

  it("uses the cumulus-exchange client on exchange.cumuluscloud.app only", () => {
    assert.equal(cidConfig({ BETTER_AUTH_URL: "https://exchange.cumuluscloud.app" }).clientId, EXCHANGE_CID_CLIENT_ID);
    assert.equal(cidConfig({ BETTER_AUTH_URL: "https://exchange.cumuluscloud.app/" }).clientId, "cumulus-exchange");
    assert.equal(cidConfig({ BETTER_AUTH_URL: "https://cloud.cumuluscloud.app" }).clientId, "cumulus-cloud");
    assert.equal(cidConfig({ BETTER_AUTH_URL: "https://exchange.cumuluscloud.app.evil.test" }).clientId, "cumulus-cloud");
    assert.equal(cidConfig({ BETTER_AUTH_URL: "https://exchange.cumuluscloud.app", CID_CLIENT_ID: "x" }).clientId, "x");
  });

  it("takes a mirror issuer from CID_ISSUER", () => {
    assert.deepEqual(cidConfig({ CID_ISSUER: " https://mirror.example/realms/cumulus/ ", CID_CLIENT_ID: "x" }), {
      issuer: "https://mirror.example/realms/cumulus",
      clientId: "x",
    });
  });

  it("derives the OIDC endpoints from the issuer", () => {
    const e = cidEndpoints(ISSUER);
    assert.equal(e.discovery, `${ISSUER}/.well-known/openid-configuration`);
    assert.equal(e.authorize, `${ISSUER}/protocol/openid-connect/auth`);
    assert.equal(e.token, `${ISSUER}/protocol/openid-connect/token`);
    assert.equal(e.jwks, `${ISSUER}/protocol/openid-connect/certs`);
    assert.equal(e.logout, `${ISSUER}/protocol/openid-connect/logout`);
  });

  it("keys the user by sub", () => {
    assert.deepEqual(cidUserInfo({ sub: "cid_1", email: "Alex@cumuluscloud.app", email_verified: true, preferred_username: "alex" }), {
      id: "cid_1",
      sub: "cid_1",
      email: "alex@cumuluscloud.app",
      emailVerified: true,
      name: "alex",
    });
    assert.equal(cidUserInfo({ sub: "cid_2" }).emailVerified, false);
  });
});

describe("Cumulus://ID ID token", () => {
  const config = { issuer: ISSUER, clientId: "cumulus-cloud" };

  it("accepts a signed token for this issuer and client, and checks the nonce", async () => {
    const { keys, sign } = await signer();
    const token = await sign({ nonce: "n1" });
    const claims = await verifyCidIdToken(config, token, { keys, nonce: "n1" });
    assert.equal(claims.sub, "cid_7c1e");
    assert.equal(claims.email, "ada@cumuluscloud.app");
    await assert.rejects(verifyCidIdToken(config, token, { keys, nonce: "other" }), /nonce/);
  });

  it("refuses another issuer, another client, an expired token, an access token and a foreign key", async () => {
    const { keys, sign } = await signer();
    await assert.rejects(verifyCidIdToken(config, await sign({}, { iss: "https://cognito-idp.us-east-1.amazonaws.com/x" }), { keys }));
    await assert.rejects(verifyCidIdToken(config, await sign({}, { aud: "scalvs" }), { keys }));
    await assert.rejects(verifyCidIdToken(config, await sign({}, { exp: "-1m" }), { keys }));
    await assert.rejects(verifyCidIdToken(config, await sign({}, { typ: "at+jwt" }), { keys }), /access token/);
    await assert.rejects(verifyCidIdToken(config, await sign({}, { aud: ["cumulus-cloud", "scalvs"] }), { keys }), /another client/);
    const other = await signer();
    await assert.rejects(verifyCidIdToken(config, await other.sign({}), { keys }));
  });
});
