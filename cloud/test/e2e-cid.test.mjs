import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// cid mode (the default) end to end: the Drive Edge Function runs under Deno on this
// host (scripts/supabase-e2e.sh) against the local Supabase PostgREST and Storage,
// and verifies Cumulus ID access tokens from the issuer this test serves.
const DRIVE = process.env.CID_DRIVE_URL || "http://127.0.0.1:8000";
const PORT = Number(process.env.CID_ISSUER_PORT || 9100);
const ISSUER = `http://127.0.0.1:${PORT}/realms/cumulus`;

test(
  "cid mode: Cumulus ID tokens, first-use tenants, Drive calls and isolation",
  { skip: process.env.CUMULUS_E2E_CID === "1" ? false : "set CUMULUS_E2E_CID=1 (scripts/supabase-e2e.sh)" },
  async () => {
    const issuer = await startIssuer();
    try {
      const stamp = randomBytes(4).toString("hex");
      const ada = `cid_${stamp}-ada0-4000-8000-000000000001`;
      const bob = `cid_${stamp}-b0b0-4000-8000-000000000002`;
      const adaToken = await issuer.token(ada);
      const bobToken = await issuer.token(bob);

      const health = await fetch(`${DRIVE}/healthz`);
      assert.equal(health.status, 200);

      // First call creates Ada's tenant with the free quota.
      const usage = await call("GET", "/drive/v1/usage", adaToken, "drive.read");
      assert.equal(usage.status, 200, usage.text);
      assert.deepEqual(JSON.parse(usage.text), { usedBytes: 0, maxBytes: 104857600, maxFileBytes: 50000000 });
      const again = await call("GET", "/drive/v1/usage", adaToken, "drive.read");
      assert.equal(again.status, 200, again.text);

      const put = await call("PUT", "/drive/v1/objects/drive/notes/hello.txt", adaToken, "drive.write", Buffer.from("hello from cid mode"), {
        "content-type": "text/plain",
        "x-cumulus-preview-class": "text",
      });
      assert.equal(put.status, 200, put.text);
      const got = await call("GET", "/drive/v1/objects/drive/notes/hello.txt", adaToken, "drive.read");
      assert.equal(got.status, 200, got.text);
      assert.equal(got.text, "hello from cid mode");

      const listed = await call("GET", "/drive/v1/objects/drive", adaToken, "drive.read");
      assert.deepEqual(JSON.parse(listed.text).objects.map((o) => [o.object_key, o.content_type, o.preview_class]), [["notes/hello.txt", "text/plain", "text"]]);
      const star = await call("POST", "/drive/v1/parity", adaToken, "drive.write", Buffer.from(JSON.stringify({ op: "star", bucket: "drive", key: "notes/hello.txt", starred: 1 })), { "content-type": "application/json" });
      assert.equal(star.status, 200, star.text);
      const starred = await call("GET", "/drive/v1/objects/drive?view=starred", adaToken, "drive.read");
      assert.equal(JSON.parse(starred.text).objects.length, 1);
      const used = await call("GET", "/drive/v1/usage", adaToken, "drive.read");
      assert.equal(JSON.parse(used.text).usedBytes, Buffer.byteLength("hello from cid mode"));

      // Bob gets his own empty tenant and cannot reach Ada's file.
      const bobList = await call("GET", "/drive/v1/objects/drive", bobToken, "drive.read");
      assert.equal(bobList.status, 200, bobList.text);
      assert.deepEqual(JSON.parse(bobList.text).objects, []);
      const bobGet = await call("GET", "/drive/v1/objects/drive/notes/hello.txt", bobToken, "drive.read");
      assert.equal(bobGet.status, 404);

      // Tokens the function must refuse.
      const wrongAud = await issuer.token(ada, { aud: "someone-else" });
      assert.equal((await call("GET", "/drive/v1/usage", wrongAud, "drive.read")).status, 401);
      const forged = await new SignJWT({}).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "k1" })
        .setIssuer(ISSUER).setAudience("cumulus-cloud").setSubject(ada).setExpirationTime("5m")
        .sign((await generateKeyPair("ES256")).privateKey);
      assert.equal((await call("GET", "/drive/v1/usage", forged, "drive.read")).status, 401);
      assert.equal((await call("GET", "/drive/v1/usage", "", "drive.read")).status, 401);
      const lateToken = await issuer.token(ada);
      issuer.revoke(lateToken);
      assert.equal((await call("GET", "/drive/v1/usage", lateToken, "drive.read")).status, 401);

      const removed = await call("DELETE", "/drive/v1/objects/drive/notes/hello.txt", adaToken, "drive.write");
      assert.equal(removed.status, 204, removed.text);
      const after = await call("GET", "/drive/v1/usage", adaToken, "drive.read");
      assert.equal(JSON.parse(after.text).usedBytes, 0);
    } finally {
      await issuer.close();
    }
  },
);

async function call(method, path, token, purpose, body, headers = {}) {
  const response = await fetch(`${DRIVE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-cumulus-purpose": purpose, ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

/** A minimal Cumulus ID issuer: JWKS, userinfo, ES256 at+jwt access tokens, revocation. */
async function startIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const live = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, ISSUER);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith("/protocol/openid-connect/certs")) return send(200, { keys: [jwk] });
    if (url.pathname.endsWith("/protocol/openid-connect/userinfo")) {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const sub = live.get(token);
      return sub ? send(200, { sub }) : send(401, { error: "invalid_token" });
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  return {
    async token(sub, claims = {}) {
      const token = await new SignJWT({ azp: "cumulus-cloud" })
        .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "k1" })
        .setIssuer(ISSUER).setAudience(claims.aud ?? "cumulus-cloud").setSubject(sub)
        .setIssuedAt().setExpirationTime("10m").sign(privateKey);
      live.set(token, sub);
      return token;
    },
    revoke(token) {
      live.delete(token);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
