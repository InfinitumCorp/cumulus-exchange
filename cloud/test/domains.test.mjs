import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { call, createTenant, fixture, tokenFor } from "./helpers.mjs";

test("domain defaults name cumuluscloud.app and its three hosts", () => {
  const config = loadConfig({});
  assert.equal(config.rootDomain, "cumuluscloud.app");
  assert.equal(config.idHost, "id.cumuluscloud.app");
  assert.equal(config.cloudHost, "cloud.cumuluscloud.app");
  assert.equal(config.mailHost, "mail.cumuluscloud.app");
  assert.equal(config.issuer, "https://id.cumuluscloud.app/realms/cumulus");
  assert.equal(config.audience, "https://id.cumuluscloud.app");
  assert.equal(config.jwksUrl, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs");
  assert.equal(config.publicBaseUrl, "https://cloud.cumuluscloud.app");
  assert.deepEqual(config.corsOrigins, [
    "https://id.cumuluscloud.app",
    "https://cloud.cumuluscloud.app",
    "https://mail.cumuluscloud.app",
  ]);
  assert.equal(config.corsOrigins.includes("*"), false);
});

test("root domain, host, and CORS overrides replace the defaults", () => {
  const fromRoot = loadConfig({ CUMULUS_ROOT_DOMAIN: "example.test" });
  assert.equal(fromRoot.idHost, "id.example.test");
  assert.equal(fromRoot.cloudHost, "cloud.example.test");
  assert.equal(fromRoot.mailHost, "mail.example.test");
  assert.equal(fromRoot.issuer, "https://id.example.test/realms/cumulus");
  assert.equal(fromRoot.publicBaseUrl, "https://cloud.example.test");

  const explicit = loadConfig({
    CUMULUS_ROOT_DOMAIN: "example.test",
    CUMULUS_ID_HOST: "login.example.test",
    CUMULUS_CLOUD_HOST: "drive.example.test",
    CUMULUS_MAIL_HOST: "inbox.example.test",
    CUMULUS_KEYCLOAK_ISSUER: "https://login.example.test/realms/custom",
    CUMULUS_KEYCLOAK_AUDIENCE: "cumulus-drive",
    CUMULUS_KEYCLOAK_JWKS_URL: "https://login.example.test/jwks",
    CUMULUS_PUBLIC_BASE_URL: "https://drive.example.test",
    CUMULUS_CORS_ORIGINS: "https://drive.example.test, https://inbox.example.test",
  });
  assert.equal(explicit.idHost, "login.example.test");
  assert.equal(explicit.issuer, "https://login.example.test/realms/custom");
  assert.equal(explicit.audience, "cumulus-drive");
  assert.equal(explicit.jwksUrl, "https://login.example.test/jwks");
  assert.equal(explicit.publicBaseUrl, "https://drive.example.test");
  assert.deepEqual(explicit.corsOrigins, ["https://drive.example.test", "https://inbox.example.test"]);
  assert.throws(() => loadConfig({ CUMULUS_CORS_ORIGINS: "*" }), /exact origins/);
  assert.throws(() => loadConfig({ CUMULUS_CORS_ORIGINS: "https://*.cumuluscloud.app" }), /exact origins/);
});

test("share links use the cloud host and CORS echoes only allowlisted origins", async (t) => {
  const fx = await fixture(t, {
    projectBytes: 1000,
    maxFileBytes: 100,
    defaultTenantBytes: 1000,
    defaultTenantObjects: 5,
  });
  await createTenant(fx.port, fx.bootstrapToken, { name: "domain", cid: "cid_domain" });
  const token = await tokenFor(fx.keys.privateKey, "cid_domain", ["drive.write", "drive.share"]);
  const put = await call(fx.port, {
    method: "PUT",
    path: "/v1/objects/photos/a.txt",
    headers: { authorization: `Bearer ${token}`, "x-cumulus-purpose": "drive.write" },
    body: Buffer.from("domain-file"),
  });
  assert.equal(put.status, 200, put.body.toString("utf8"));
  const share = await call(fx.port, {
    method: "POST",
    path: "/v1/shares",
    headers: {
      authorization: `Bearer ${token}`,
      "x-cumulus-purpose": "drive.share",
      "content-type": "application/json",
    },
    body: JSON.stringify({ bucket: "photos", key: "a.txt", ttlSeconds: 60 }),
  });
  assert.equal(share.status, 201, share.body.toString("utf8"));
  const url = JSON.parse(share.body.toString("utf8")).url;
  assert.equal(url.startsWith("https://cloud.cumuluscloud.app/v1/shared?"), true);

  const allowed = await call(fx.port, {
    method: "OPTIONS",
    path: "/v1/objects/photos",
    headers: { origin: "https://mail.cumuluscloud.app" },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], "https://mail.cumuluscloud.app");
  assert.equal(String(allowed.headers["access-control-allow-origin"]).includes("*"), false);

  const denied = await call(fx.port, {
    path: "/v1/limits",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);

  const cloud = await call(fx.port, {
    path: "/v1/limits",
    headers: { origin: "https://cloud.cumuluscloud.app" },
  });
  assert.equal(cloud.headers["access-control-allow-origin"], "https://cloud.cumuluscloud.app");
});
