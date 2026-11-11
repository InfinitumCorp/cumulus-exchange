import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate, createCidVerifier } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Cumulus ID is the default issuer and CID_ISSUER names a mirror", () => {
  assert.equal(loadConfig({}).cidIssuer, "https://id.cumuluscloud.app");
  assert.equal(loadConfig({ CID_ISSUER: "https://ru.mail.cumuluscloud.app/" }).cidIssuer, "https://ru.mail.cumuluscloud.app");
});

test("cid verifier asks Cumulus ID who the bearer is and caches the answer", async () => {
  const calls = [];
  const verifier = createCidVerifier({
    issuer: "https://id.cumuluscloud.app",
    fetchImpl: async (url, init) => {
      calls.push([url, init.headers.authorization]);
      return json(200, { cid: "cid_0b6f3c2e-6a1d-4f3e-9a4f-2f1c7d1e8b90", username: "ada" });
    },
  });
  const token = "opaque_session_token_abcdefghijkl";
  const req = { headers: { authorization: `Bearer ${token}` } };
  const principal = await authenticate(req, { verifier, bootstrapToken: "bootstrap-token-value", allowBootstrap: true });
  assert.equal(principal.kind, "user");
  assert.equal(principal.cid, "cid_0b6f3c2e-6a1d-4f3e-9a4f-2f1c7d1e8b90");
  assert.deepEqual(principal.purposes, ["drive.read", "drive.write", "drive.share"]);
  await authenticate(req, { verifier, bootstrapToken: "bootstrap-token-value", allowBootstrap: true });
  assert.deepEqual(calls, [["https://id.cumuluscloud.app/api/id/userinfo", `Bearer ${token}`]]);
});

test("cid verifier rejects signed-out tokens and missing CIDs, and keeps bootstrap separate", async () => {
  const rejected = createCidVerifier({ issuer: "https://id.cumuluscloud.app", fetchImpl: async () => json(401, { error: "Not signed in" }) });
  await assert.rejects(rejected("opaque_session_token_abcdefghijkl"), (err) => err.status === 401);
  const noCid = createCidVerifier({ issuer: "https://id.cumuluscloud.app", fetchImpl: async () => json(200, { username: "x" }) });
  await assert.rejects(noCid("opaque_session_token_abcdefghijkl"), (err) => err.status === 401);
  const down = createCidVerifier({ issuer: "https://id.cumuluscloud.app", fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(down("opaque_session_token_abcdefghijkl"), (err) => err.status === 503);
  const bootstrap = await authenticate(
    { headers: { authorization: "Bearer bootstrap-token-value-123456" } },
    { verifier: rejected, bootstrapToken: "bootstrap-token-value-123456", allowBootstrap: true },
  );
  assert.equal(bootstrap.kind, "bootstrap");
  assert.throws(() => createCidVerifier({ issuer: "http://id.example.test" }), /https/);
});
