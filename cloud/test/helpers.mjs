import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { randomBytes } from "node:crypto";

const domain = loadConfig({});
export const ISSUER = domain.issuer;
export const AUDIENCE = domain.audience;

export async function testKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.kid = "test";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

export async function tokenFor(privateKey, cid, purposes) {
  return new SignJWT({ cid, purposes })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(cid)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

export function call(port, { method = "GET", path: pathname = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let requestPath = pathname;
    if (requestPath.startsWith("http://") || requestPath.startsWith("https://")) {
      const target = new URL(requestPath);
      requestPath = `${target.pathname}${target.search}`;
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: requestPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

export async function listen(handler) {
  const server = http.createServer(handler);
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  let closed = false;
  return {
    port,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function fixture(t, limits) {
  const dir = await mkdtemp(path.join(tmpdir(), "cumulus-drive-"));
  const keys = await testKeys();
  const masterKey = randomBytes(32);
  const bootstrapToken = `boot_${randomBytes(18).toString("base64url")}`;
  const shareSecret = `share_${randomBytes(18).toString("base64url")}`;
  const clock = { ms: Date.parse("2026-11-07T00:00:00Z") };
  const app = await createServer({
    sqlitePath: path.join(dir, "drive.sqlite"),
    blobsDir: path.join(dir, "blobs"),
    masterKey,
    bootstrapToken,
    shareSecret,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: keys.jwks,
    limits,
    now: () => new Date(clock.ms),
  });
  const httpServer = await listen(app.handle);
  t.after(async () => {
    await httpServer.close();
    await app.close();
  });
  return { dir, keys, masterKey, bootstrapToken, shareSecret, clock, app, port: httpServer.port };
}

export async function createTenant(port, bootstrapToken, { name, cid, quota }) {
  const response = await call(port, {
    method: "POST",
    path: "/v1/tenants",
    headers: {
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, cid, quota }),
  });
  return { status: response.status, json: JSON.parse(response.body.toString("utf8")) };
}
