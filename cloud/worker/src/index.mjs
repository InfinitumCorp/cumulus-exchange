/**
 * Drive API proxy to the Supabase Edge Function. No KV, D1, or R2.
 * The deployed cumulus-cloud Worker is the console's own server build
 * (NITRO_PRESET=cloudflare-module); `server/middleware/drive-proxy.ts` calls
 * `driveProxy` so only Drive API paths reach the function and everything else,
 * `/api/auth/*` included, stays with the console. `handleRequest` keeps the
 * older static-assets mode for tests and local use.
 * This module does not call the live project unless SUPABASE_FUNCTION_URL is set
 * at deploy time. Tests pass their own fetch implementation.
 */

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const FORWARD = ["authorization", "x-cumulus-purpose", "x-cumulus-tenant", "content-type", "accept"];
const RESPONSE_PASS = new Set([
  "content-type",
  "content-disposition",
  "cache-control",
  "etag",
  "accept-ranges",
  "content-length",
]);
const METHODS = new Set(["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"]);

const DEFAULT_ORIGINS = [
  "https://id.cumuluscloud.app",
  "https://cloud.cumuluscloud.app",
  "https://mail.cumuluscloud.app",
];

export function corsAllowlist(env) {
  const raw = env.CUMULUS_CORS_ORIGINS;
  if (raw == null || raw === "") {
    return [
      originForHost(env.CUMULUS_ID_HOST, "id.cumuluscloud.app"),
      originForHost(env.CUMULUS_CLOUD_HOST, "cloud.cumuluscloud.app"),
      originForHost(env.CUMULUS_MAIL_HOST, "mail.cumuluscloud.app"),
    ];
  }
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return null;
  const origins = [];
  for (const item of items) {
    const origin = exactOrigin(item);
    if (!origin) return null;
    origins.push(origin);
  }
  return origins;
}

function originForHost(host, fallback) {
  return `https://${host || fallback}`;
}

function exactOrigin(value) {
  if (!value || value.includes("*")) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function functionBase(env) {
  const raw = env.SUPABASE_FUNCTION_URL;
  if (!raw || raw.includes("*")) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return url;
  return null;
}

export function route(url, env) {
  const path = url.pathname;
  const cloudHost = String(env.CUMULUS_CLOUD_HOST || "cloud.cumuluscloud.app").toLowerCase();
  const onCloud = url.hostname.toLowerCase() === cloudHost;
  // Only Drive API calls leave the console: /api/drive/v1/* (the console's cloud
  // Drive) and /api/healthz. Other /api paths (/api/auth, the console's own
  // /api/drive routes) belong to the console server.
  if (path === "/api/healthz" || path.startsWith("/api/drive/v1/")) {
    return { kind: "proxy", path: path.slice("/api".length) };
  }
  if (onCloud && (path === "/healthz" || path === "/v1" || path.startsWith("/v1/"))) {
    return { kind: "proxy", path };
  }
  return { kind: "asset" };
}

export function hopNames(headers) {
  const names = new Set(HOP);
  const connection = headers.get("connection");
  if (connection) {
    for (const part of connection.split(",")) {
      const name = part.trim().toLowerCase();
      if (name && name !== "close") names.add(name);
    }
  }
  return names;
}

export function forwardRequestHeaders(headers) {
  const blocked = hopNames(headers);
  const out = new Headers();
  for (const name of FORWARD) {
    if (blocked.has(name)) continue;
    const value = headers.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

function proxyTarget(base, path, search) {
  const url = new URL(base.href);
  const prefix = url.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${prefix}${suffix === "/" ? "" : suffix}` || "/";
  url.search = search;
  return url;
}

function json(status, body, extra) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", ...(extra || {}) });
  return new Response(JSON.stringify(body), { status, headers });
}

function corsHeaders(origin, allowlist) {
  if (!origin || !allowlist.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-cumulus-purpose, x-cumulus-tenant",
    "access-control-max-age": "600",
  };
}

function applyCors(headers, origin, allowlist) {
  for (const [name, value] of Object.entries(corsHeaders(origin, allowlist))) {
    headers.set(name, value);
  }
}

/** The Drive proxy response for a Drive API path, or null to let the console handle it. */
export async function driveProxy(request, env) {
  const url = new URL(request.url);
  const decision = route(url, env);
  if (decision.kind === "asset") return null;
  return proxy(request, env, url, decision.path);
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const decision = route(url, env);
  if (decision.kind === "asset") return serveAsset(request, env);
  return proxy(request, env, url, decision.path);
}

async function serveAsset(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return json(503, { error: { code: "Config", message: "Static assets are not configured" } });
  }
  return env.ASSETS.fetch(request);
}

async function proxy(request, env, url, path) {
  const allowlist = corsAllowlist(env);
  const base = functionBase(env);
  const origin = request.headers.get("origin");
  if (!allowlist || !base) {
    return json(503, { error: { code: "Config", message: "Drive proxy is not configured" } });
  }
  if (origin && !allowlist.includes(origin)) {
    return json(403, { error: { code: "OriginDenied", message: "Origin is not allowed" } });
  }
  if (!METHODS.has(request.method)) {
    return json(405, { error: { code: "MethodNotAllowed", message: "Method is not allowed" } }, corsHeaders(origin, allowlist));
  }
  if (request.method === "OPTIONS") {
    const headers = new Headers();
    applyCors(headers, origin, allowlist);
    return new Response(null, { status: 204, headers });
  }
  const target = proxyTarget(base, path, url.search);
  const headers = forwardRequestHeaders(request.headers);
  const fetchImpl = env.fetch ?? globalThis.fetch;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      duplex: hasBody ? "half" : undefined,
    });
  } catch {
    return json(502, { error: { code: "BadGateway", message: "Drive request failed" } }, corsHeaders(origin, allowlist));
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, { error: { code: "BadGateway", message: "Upstream redirect was refused" } }, corsHeaders(origin, allowlist));
  }
  const blocked = hopNames(upstream.headers);
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || lower === "set-cookie" || lower.startsWith("access-control-")) continue;
    if (!RESPONSE_PASS.has(lower)) continue;
    responseHeaders.set(name, value);
  }
  applyCors(responseHeaders, origin, allowlist);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export default { fetch: handleRequest };

export const DEFAULT_CORS_ORIGINS = DEFAULT_ORIGINS;
