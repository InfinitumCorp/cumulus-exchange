import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  corsAllowlist,
  DEFAULT_CORS_ORIGINS,
  driveProxy,
  forwardRequestHeaders,
  functionBase,
  handleRequest,
  route,
} from "../src/index.mjs";

const FUNCTION = "https://example.test/functions/v1/drive";

function env(overrides = {}) {
  return {
    SUPABASE_FUNCTION_URL: FUNCTION,
    ASSETS: {
      async fetch() {
        return new Response("console", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
    ...overrides,
  };
}

test("default CORS allowlist is the three cumuluscloud.app origins", () => {
  assert.deepEqual(corsAllowlist({}), DEFAULT_CORS_ORIGINS);
  assert.equal(DEFAULT_CORS_ORIGINS.includes("*"), false);
  assert.equal(corsAllowlist({ CUMULUS_CORS_ORIGINS: "*" }), null);
  assert.equal(corsAllowlist({ CUMULUS_CORS_ORIGINS: "https://*.cumuluscloud.app" }), null);
  assert.deepEqual(corsAllowlist({ CUMULUS_CORS_ORIGINS: "https://cloud.cumuluscloud.app" }), [
    "https://cloud.cumuluscloud.app",
  ]);
});

test("function URL fails closed unless it is https or loopback", () => {
  assert.equal(functionBase({}), null);
  assert.equal(functionBase({ SUPABASE_FUNCTION_URL: "http://files.example/drive" }), null);
  assert.equal(functionBase({ SUPABASE_FUNCTION_URL: "https://user:pw@example.test/drive" }), null);
  assert.ok(functionBase({ SUPABASE_FUNCTION_URL: FUNCTION }));
  assert.ok(functionBase({ SUPABASE_FUNCTION_URL: "http://127.0.0.1:54321/functions/v1/drive" }));
});

test("only Drive API paths proxy; /v1 proxies only on the cloud host", () => {
  const cloud = route(new URL("https://cloud.cumuluscloud.app/v1/usage?x=1"), {});
  assert.deepEqual(cloud, { kind: "proxy", path: "/v1/usage" });
  const other = route(new URL("https://id.cumuluscloud.app/v1/usage"), {});
  assert.equal(other.kind, "asset");
  const api = route(new URL("https://id.cumuluscloud.app/api/healthz"), {});
  assert.deepEqual(api, { kind: "proxy", path: "/healthz" });
  const drive = route(new URL("https://exchange.cumuluscloud.app/api/drive/v1/objects/drive"), {});
  assert.deepEqual(drive, { kind: "proxy", path: "/drive/v1/objects/drive" });
  for (const own of ["/api/auth/get-session", "/api/drive/objects", "/api/drive/dev-session", "/api/drive/cid-token", "/api/v1/usage"]) {
    assert.equal(route(new URL(`https://cloud.cumuluscloud.app${own}`), {}).kind, "asset", own);
  }
  const page = route(new URL("https://cloud.cumuluscloud.app/"), {});
  assert.equal(page.kind, "asset");
});

test("driveProxy leaves console paths to the console and proxies Drive API paths", async () => {
  const calls = [];
  const app = env({ async fetch(url) { calls.push(String(url)); return new Response("{}", { status: 200 }); } });
  assert.equal(await driveProxy(new Request("https://cloud.cumuluscloud.app/api/auth/get-session"), app), null);
  const proxied = await driveProxy(new Request("https://cloud.cumuluscloud.app/api/drive/v1/usage"), app);
  assert.equal(proxied.status, 200);
  assert.deepEqual(calls, ["https://example.test/functions/v1/drive/drive/v1/usage"]);
});

test("proxy strips hop-by-hop headers and forwards authorization and purpose", async () => {
  const calls = [];
  const app = env({
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          connection: "close",
          "transfer-encoding": "chunked",
          "set-cookie": "session=nope",
          "access-control-allow-origin": "*",
        },
      });
    },
  });
  const request = new Request("https://cloud.cumuluscloud.app/api/drive/v1/usage?x=1", {
    method: "PUT",
    headers: {
      authorization: "Bearer token-1",
      "x-cumulus-purpose": "drive.read",
      "x-cumulus-tenant": "tn_ada",
      "content-type": "application/octet-stream",
      cookie: "session=secret",
      connection: "close, x-secret",
      "x-secret": "nope",
      "transfer-encoding": "chunked",
      host: "cloud.cumuluscloud.app",
      origin: "https://cloud.cumuluscloud.app",
    },
    body: "hello",
  });
  const response = await handleRequest(request, app);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(response.headers.get("access-control-allow-origin"), "https://cloud.cumuluscloud.app");
  assert.equal(response.headers.get("connection"), null);
  assert.equal(response.headers.get("transfer-encoding"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/functions/v1/drive/drive/v1/usage?x=1");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.redirect, "manual");
  const sent = calls[0].init.headers;
  assert.equal(sent.get("authorization"), "Bearer token-1");
  assert.equal(sent.get("x-cumulus-purpose"), "drive.read");
  assert.equal(sent.get("x-cumulus-tenant"), "tn_ada");
  assert.equal(sent.get("content-type"), "application/octet-stream");
  assert.equal(sent.get("cookie"), null);
  assert.equal(sent.get("x-secret"), null);
  assert.equal(sent.get("connection"), null);
  assert.equal(sent.get("transfer-encoding"), null);
  assert.equal(sent.get("host"), null);
});

test("a hop-by-hop Connection token drops that request header", () => {
  const headers = new Headers({
    authorization: "Bearer token-1",
    "x-cumulus-purpose": "drive.write",
    connection: "x-cumulus-purpose",
  });
  const sent = forwardRequestHeaders(headers);
  assert.equal(sent.get("authorization"), "Bearer token-1");
  assert.equal(sent.get("x-cumulus-purpose"), null);
});

test("unknown origins and a missing function URL fail closed", async () => {
  let called = false;
  const denied = await handleRequest(
    new Request("https://cloud.cumuluscloud.app/api/healthz", {
      headers: { origin: "https://evil.example", authorization: "Bearer token-1" },
    }),
    env({
      async fetch() {
        called = true;
        return new Response("nope");
      },
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal(called, false);

  const missing = await handleRequest(new Request("https://cloud.cumuluscloud.app/api/healthz"), env({
    SUPABASE_FUNCTION_URL: "",
    async fetch() {
      called = true;
      return new Response("nope");
    },
  }));
  assert.equal(missing.status, 503);
  assert.equal(called, false);

  const starred = await handleRequest(new Request("https://cloud.cumuluscloud.app/api/healthz"), env({
    CUMULUS_CORS_ORIGINS: "*",
  }));
  assert.equal(starred.status, 503);

  const page = await handleRequest(new Request("https://cloud.cumuluscloud.app/"), env({ SUPABASE_FUNCTION_URL: "" }));
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "console");
});

test("preflight does not call upstream and redirects are refused", async () => {
  let called = false;
  const preflight = await handleRequest(
    new Request("https://cloud.cumuluscloud.app/v1/shared?shareId=1", {
      method: "OPTIONS",
      headers: { origin: "https://id.cumuluscloud.app", "access-control-request-method": "GET" },
    }),
    env({
      async fetch() {
        called = true;
        return new Response("nope");
      },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://id.cumuluscloud.app");
  assert.equal(called, false);

  const redirect = await handleRequest(new Request("https://cloud.cumuluscloud.app/healthz"), env({
    async fetch() {
      return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
    },
  }));
  assert.equal(redirect.status, 502);
  assert.equal((await redirect.json()).error.code, "BadGateway");
});

test("the console is served for non-API paths and assets fail closed when unbound", async () => {
  const page = await handleRequest(new Request("https://id.cumuluscloud.app/market"), env());
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "console");
  const bare = await handleRequest(new Request("https://cloud.cumuluscloud.app/"), { SUPABASE_FUNCTION_URL: FUNCTION });
  assert.equal(bare.status, 503);
});

test("wrangler.toml deploys the console build as cumulus-cloud with no account, KV, D1, or R2", async () => {
  const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.equal(/^\s*account_id\s*=/m.test(toml), false);
  assert.equal(/kv_namespaces|d1_databases|r2_buckets/.test(toml), false);
  assert.match(toml, /^name\s*=\s*"cumulus-cloud"$/m);
  assert.match(toml, /binding\s*=\s*"ASSETS"/);
  // The deployed Worker is the console's Nitro build (cloud/DEPLOY.md).
  assert.match(toml, /^main\s*=\s*"\.\.\/\.\.\/\.output\/server\/index\.mjs"$/m);
  assert.match(toml, /^directory\s*=\s*"\.\.\/\.\.\/\.output\/public"$/m);
  assert.match(toml, /compatibility_flags\s*=\s*\["nodejs_compat"\]/);
  const html = await readFile(new URL("../assets/index.html", import.meta.url), "utf8");
  assert.match(html, /Cumulus/);
});
