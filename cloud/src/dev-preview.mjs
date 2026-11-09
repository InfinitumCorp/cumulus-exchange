import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from "jose";
import { createServer } from "./server.mjs";
import { loadConfig } from "./config.mjs";
import { parseMasterKey } from "./crypto.mjs";
import { LIMITS } from "./limits.mjs";

const DEMO_CID = "cid_alex";
const DEMO_TENANT = "tn_alex_preview";

/**
 * Dev-server only. Vite's configureServer hook is the only caller.
 * Production `cloud/src/main.mjs` does not import this module and does not mint tokens.
 */
export async function createDevPreview(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const secrets = await loadSecrets(dir);
  const config = loadConfig({});
  const app = await createServer({
    sqlitePath: path.join(dir, "drive.sqlite"),
    blobsDir: path.join(dir, "blobs"),
    masterKey: secrets.masterKey,
    bootstrapToken: secrets.bootstrap,
    shareSecret: secrets.share,
    issuer: config.issuer,
    audience: config.audience,
    jwks: secrets.jwks,
    publicBaseUrl: config.publicBaseUrl,
    limits: LIMITS,
  });
  const existing = await app.drive.db.getTenantByCid(DEMO_CID);
  if (!existing) {
    await app.drive.db.insertTenant({
      id: DEMO_TENANT,
      name: "alex",
      cid: DEMO_CID,
      maxBytes: LIMITS.defaultTenantBytes,
      maxObjects: LIMITS.defaultTenantObjects,
      createdAt: new Date().toISOString(),
    });
  }
  async function token() {
    return new SignJWT({
      cid: DEMO_CID,
      purposes: ["drive.read", "drive.write", "drive.share"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "dev-preview" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject(DEMO_CID)
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(secrets.privateKey);
  }

  return {
    app,
    token,
    middleware(req, res, next) {
      const url = req.url || "/";
      if (!url.startsWith("/api/drive")) {
        next();
        return;
      }
      if (url.startsWith("/api/drive/dev-session")) {
        token()
          .then((accessToken) => {
            const body = JSON.stringify({ token: accessToken, cid: DEMO_CID });
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": Buffer.byteLength(body),
              "cache-control": "no-store",
            });
            res.end(body);
          })
          .catch((error) => {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end(error.message);
          });
        return;
      }
      req.url = url.slice("/api/drive".length) || "/";
      Promise.resolve(app.handle(req, res)).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(error.message);
        }
      });
    },
    close: () => app.close(),
  };
}

async function loadSecrets(dir) {
  const file = path.join(dir, "dev-secrets.json");
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    return {
      masterKey: parseMasterKey(saved.masterKey),
      bootstrap: saved.bootstrap,
      share: saved.share,
      privateKey: await importPKCS8(saved.privateKey, "RS256"),
      jwks: saved.jwks,
    };
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.kid = "dev-preview";
  jwk.use = "sig";
  const saved = {
    masterKey: randomBytes(32).toString("base64"),
    bootstrap: `dev_${randomBytes(24).toString("base64url")}`,
    share: `dev_${randomBytes(24).toString("base64url")}`,
    privateKey: await exportPKCS8(privateKey),
    jwks: { keys: [jwk] },
  };
  await writeFile(file, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  return {
    masterKey: parseMasterKey(saved.masterKey),
    bootstrap: saved.bootstrap,
    share: saved.share,
    privateKey,
    jwks: saved.jwks,
  };
}
