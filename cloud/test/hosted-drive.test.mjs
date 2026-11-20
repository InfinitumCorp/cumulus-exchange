import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const ISSUER_PATH = "/realms/cumulus";
const ADA = "cid_11111111-2222-4333-8444-555555555555";
const BOB = "cid_22222222-3333-4444-8555-666666666666";

test("hosted Drive keeps versions, grants a Cumulus ID, and limits a password share", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const state = { tenants: [], objects: [], versions: [], shares: [], grants: [], activity: [], blobs: new Map() };
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (url.pathname === `${ISSUER_PATH}/protocol/openid-connect/certs`) {
      return send(res, 200, { keys: [jwk] });
    }
    if (url.pathname === `${ISSUER_PATH}/protocol/openid-connect/userinfo`) {
      const token = (req.headers.authorization ?? "").slice(7);
      const sub = tokens.get(token);
      if (!sub) return send(res, 401, { error: "invalid_token" });
      return send(res, 200, { sub });
    }
    if (url.pathname.startsWith("/s3/")) {
      if (req.method === "PUT") state.blobs.set(url.pathname, raw);
      if (req.method === "DELETE") state.blobs.delete(url.pathname);
      if (req.method === "GET") {
        const body = state.blobs.get(url.pathname);
        if (!body) return send(res, 404, "");
        res.writeHead(200);
        res.end(body);
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }
    if (url.pathname === "/rest/v1/rpc/note_retained_bytes") {
      const body = JSON.parse(raw.toString("utf8"));
      const tenant = state.tenants.find((row) => row.id === body.p_tenant);
      if (!tenant) return send(res, 400, { code: "23514", message: "tenant" });
      if (body.p_delta > 0 && tenant.used_bytes + body.p_delta > tenant.max_bytes) {
        return send(res, 400, { code: "23514", message: "quota" });
      }
      tenant.used_bytes = Math.max(0, tenant.used_bytes + body.p_delta);
      res.writeHead(204);
      res.end();
      return;
    }
    if (!url.pathname.startsWith("/rest/v1/")) return send(res, 404, { message: "missing" });
    const table = url.pathname.slice("/rest/v1/".length);
    const rows = state[table];
    if (!rows) return send(res, 404, { message: `no ${table}` });
    if (req.method === "POST") {
      const body = JSON.parse(raw.toString("utf8"));
      const conflict = url.searchParams.get("on_conflict");
      if (!(conflict && rows.some((row) => row[conflict] === body[conflict]))) rows.push(body);
      res.writeHead(201);
      res.end();
      return;
    }
    const matched = rows.filter((row) => matches(row, url.searchParams));
    if (req.method === "GET") {
      const ordered = orderRows(matched, url.searchParams.get("order"));
      const limit = Number(url.searchParams.get("limit"));
      return send(res, 200, Number.isInteger(limit) && limit > 0 ? ordered.slice(0, limit) : ordered);
    }
    if (req.method === "PATCH") {
      const body = JSON.parse(raw.toString("utf8"));
      for (const row of matched) Object.assign(row, body);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      state[table] = rows.filter((row) => !matched.includes(row));
      res.writeHead(204);
      res.end();
      return;
    }
    return send(res, 405, { message: "method" });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const mockPort = mock.address().port;
  const issuer = `http://127.0.0.1:${mockPort}${ISSUER_PATH}`;
  const tokens = new Map();
  async function tokenFor(sub) {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "k1" })
      .setIssuer(issuer)
      .setAudience("cumulus-cloud")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    tokens.set(token, sub);
    return token;
  }
  const ada = await tokenFor(ADA);
  const bob = await tokenFor(BOB);
  const child = spawn(
    "npx",
    ["--yes", "deno@2.9.6", "run", "--allow-net", "--allow-env", "--no-lock", "supabase/functions/drive/index.ts"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        CUMULUS_AUTH_MODE: "cid",
        CID_ISSUER: issuer,
        CID_AUDIENCES: "cumulus-cloud",
        CUMULUS_REST_URL: `http://127.0.0.1:${mockPort}/rest/v1`,
        CUMULUS_S3_ENDPOINT: `http://127.0.0.1:${mockPort}/s3`,
        CUMULUS_S3_REGION: "local",
        CUMULUS_S3_ACCESS_KEY: "access",
        CUMULUS_S3_SECRET_KEY: "secret",
        CUMULUS_SERVICE_ROLE_KEY: "service-role-test",
        CUMULUS_KMS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        CUMULUS_SHARE_SECRET: "test-share-secret",
        CUMULUS_PUBLIC_BASE_URL: "https://drive.cumuluscloud.app",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    mock.closeAllConnections?.();
    mock.close();
    mock.unref();
  });
  const drive = "http://127.0.0.1:8000";
  await waitFor(`${drive}/healthz`, child);
  async function call(method, path, token, purpose, body, headers = {}) {
    const response = await fetch(`${drive}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-cumulus-purpose": purpose,
        ...(body ? { "content-type": "application/octet-stream" } : {}),
        ...headers,
      },
      body,
    });
    const raw = Buffer.from(await response.arrayBuffer());
    return { status: response.status, raw, text: raw.toString("utf8") };
  }

  const first = await call("PUT", "/v1/objects/drive/hello.txt", ada, "drive.write", Buffer.from("one"), {
    "content-type": "text/plain",
    "x-cumulus-preview-class": "text",
  });
  assert.equal(first.status, 200, `${first.text}\n${logs}`);
  const read = await call("GET", "/v1/objects/drive/hello.txt", ada, "drive.read");
  assert.equal(read.text, "one");
  const hidden = await call("GET", "/v1/objects/drive/hello.txt", bob, "drive.read");
  assert.equal(hidden.status, 404);

  const second = await call("PUT", "/v1/objects/drive/hello.txt", ada, "drive.write", Buffer.from("two"), {
    "content-type": "text/plain",
    "x-cumulus-keep-version": "1",
  });
  assert.equal(second.status, 200, `${second.text}\n${logs}`);
  const current = await call("GET", "/v1/objects/drive/hello.txt", ada, "drive.read");
  assert.equal(current.text, "two");
  const usage = await call("GET", "/v1/usage", ada, "drive.read");
  assert.equal(JSON.parse(usage.text).usedBytes, 3);
  const history = await call("POST", "/v1/parity", ada, "drive.write", Buffer.from(JSON.stringify({
    op: "versions",
    bucket: "drive",
    key: "hello.txt",
  })), { "content-type": "application/json" });
  assert.equal(history.status, 200, history.text);
  const versions = JSON.parse(history.text).versions;
  assert.equal(versions.length, 1);
  const restored = await call("POST", "/v1/parity", ada, "drive.write", Buffer.from(JSON.stringify({
    op: "restore-version",
    bucket: "drive",
    key: "hello.txt",
    versionId: versions[0].id,
  })), { "content-type": "application/json" });
  assert.equal(restored.status, 200, `${restored.text}\n${logs}`);
  const rolled = await call("GET", "/v1/objects/drive/hello.txt", ada, "drive.read");
  assert.equal(rolled.text, "one");

  const invite = await call("POST", "/v1/parity", ada, "drive.write", Buffer.from(JSON.stringify({
    op: "invite",
    bucket: "drive",
    key: "hello.txt",
    cid: BOB,
    role: "viewer",
  })), { "content-type": "application/json" });
  assert.equal(invite.status, 201, `${invite.text}\n${logs}`);
  const shared = await call("GET", "/v1/objects/drive/hello.txt", bob, "drive.read");
  assert.equal(shared.status, 200, shared.text);
  assert.equal(shared.text, "one");

  const share = await call("POST", "/v1/shares", ada, "drive.share", Buffer.from(JSON.stringify({
    bucket: "drive",
    key: "hello.txt",
    ttlSeconds: 60,
    password: "share-secret",
    maxDownloads: 1,
  })), { "content-type": "application/json" });
  assert.equal(share.status, 201, share.text);
  const link = new URL(JSON.parse(share.text).url);
  assert.equal(link.host, "drive.cumuluscloud.app");
  const denied = await fetch(`${drive}${link.pathname}${link.search}`);
  assert.equal(denied.status, 401);
  const opened = await fetch(`${drive}${link.pathname}${link.search}&password=share-secret`);
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), "one");
  const limited = await fetch(`${drive}${link.pathname}${link.search}&password=share-secret`);
  assert.equal(limited.status, 403);

  const removed = await call("DELETE", "/v1/objects/drive/hello.txt", ada, "drive.write");
  assert.equal(removed.status, 204, removed.text);
  const after = await call("GET", "/v1/usage", ada, "drive.read");
  assert.equal(JSON.parse(after.text).usedBytes, 0, logs);
});

function matches(row, params) {
  for (const [key, value] of params) {
    if (key === "select" || key === "order" || key === "limit" || key === "on_conflict") continue;
    if (value.startsWith("eq.")) {
      if (String(row[key] ?? "") !== value.slice(3)) return false;
    } else if (value === "is.null") {
      if (row[key] != null) return false;
    } else if (value === "is.true") {
      if (row[key] !== true) return false;
    } else if (value === "not.is.null") {
      if (row[key] == null) return false;
    }
  }
  return true;
}

function orderRows(rows, order) {
  if (!order) return rows;
  const [field, direction] = order.split(".");
  return [...rows].sort((left, right) => {
    const diff = String(left[field] ?? "").localeCompare(String(right[field] ?? ""));
    return direction === "desc" ? -diff : diff;
  });
}

function send(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function waitFor(url, child) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (child.exitCode != null) throw new Error(`Drive function exited ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The function is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Drive function did not answer /healthz");
}
