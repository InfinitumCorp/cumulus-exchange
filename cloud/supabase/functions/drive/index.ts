import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.2.9";
import { CID, CidError, cidAudiences, cidIssuer, cidJwksUrl, createCidVerifier } from "./cid.ts";
import { functionPath } from "./path.ts";

/**
 * Cumulus Drive on Supabase Edge Functions.
 * CUMULUS_AUTH_MODE=cid (the default): people sign in with Cumulus://ID. The function
 * checks the Cumulus ID access token itself (see ./cid.ts); the verified sub is the cid.
 * PostgREST does not accept Cumulus ID tokens, so metadata calls use the service role,
 * and every query is filtered by the tenant row that matches the verified cid.
 * CUMULUS_AUTH_MODE=supabase (opt-in): Supabase Auth JWTs. Metadata goes through
 * PostgREST as the user so row level security applies, and cid is loaded from
 * cumulus.identities by the verified JWT sub.
 * The project-wide access token hook is not enabled. A cid claim on a Supabase token is ignored.
 * Blob keys match the Node S3 driver: tenants/<tenantId>/<blobId>
 * in the private bucket cumulus-drive. This file is not deployed by CI.
 */

const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const FILE_CAP = 50_000_000;
const STORAGE_BUCKET = "cumulus-drive";
const PURPOSES = ["drive.read", "drive.write", "drive.share"];
const ACTIONS: Record<string, string[]> = {
  "drive.read": ["object.get", "usage.get"],
  "drive.write": ["object.put", "object.delete", "usage.get"],
  "drive.share": ["share.create", "object.get"],
};

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hostedSupabaseUrl() {
  return (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
}

function refuseLive(value: string) {
  const textValue = value.toLowerCase();
  const hit = ["supabase.co", "supabase.com", "ivqiskeziohbbtkcvlun", "pooler.supabase"].find((needle) => textValue.includes(needle));
  if (!hit) return;
  if (Deno.env.get("CUMULUS_ALLOW_SUPABASE") === "I-understand-this-touches-prod") return;
  // Hosted Edge Functions inject SUPABASE_URL; that is this project's runtime, not a local accident.
  if (hostedSupabaseUrl()) return;
  throw new Error(`Refusing live Supabase target (${hit})`);
}

const hosted = hostedSupabaseUrl();
const restUrl = (Deno.env.get("CUMULUS_REST_URL") ?? (hosted ? `${hosted}/rest/v1` : "http://kong:8000/rest/v1")).replace(/\/+$/, "");
const s3Endpoint = Deno.env.get("CUMULUS_S3_ENDPOINT") ?? "";
const jwksUrl = Deno.env.get("CUMULUS_JWKS_URL") ?? (hosted ? `${hosted}/auth/v1/.well-known/jwks.json` : "");
const issuer = Deno.env.get("CUMULUS_JWT_ISSUER") ?? (hosted ? `${hosted}/auth/v1` : "");
const anonKey = Deno.env.get("CUMULUS_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("CUMULUS_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const accessKey = Deno.env.get("CUMULUS_S3_ACCESS_KEY") ?? "";
const secretKey = Deno.env.get("CUMULUS_S3_SECRET_KEY") ?? "";
const region = Deno.env.get("CUMULUS_S3_REGION") ?? "local";
const shareSecret = Deno.env.get("CUMULUS_SHARE_SECRET") ?? "";
const publicBase = (Deno.env.get("CUMULUS_PUBLIC_BASE_URL") ?? "https://drive.cumuluscloud.app").replace(/\/+$/, "");
for (const value of [restUrl, s3Endpoint, jwksUrl, issuer]) refuseLive(value);
const authMode = Deno.env.get("CUMULUS_AUTH_MODE") || "cid";
if (authMode !== "cid" && authMode !== "supabase") throw new Error("CUMULUS_AUTH_MODE must be cid or supabase");
const jwks = authMode === "supabase" && jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;
const verifyCid = authMode === "cid" ? cidVerifier() : null;

function cidVerifier() {
  const base = cidIssuer(Deno.env.get("CID_ISSUER"));
  return createCidVerifier({
    issuer: base,
    audiences: cidAudiences(Deno.env.get("CID_AUDIENCES")),
    keys: createRemoteJWKSet(new URL(cidJwksUrl(base, Deno.env.get("CID_JWKS_URL")))),
    jwtVerify: jwtVerify as never,
  });
}

/** `db` is the bearer and apikey for PostgREST: the user's own token in supabase mode, the service role in cid mode. */
type Principal = { cid: string; sub: string; purpose: string; hint: string | null; db: { token: string; key: string } };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = functionPath(url.pathname);
  try {
    if (req.method === "GET" && path === "/healthz") return json(200, { ok: true, service: "cumulus-drive" });
    if (req.method === "GET" && path === "/v1/shared") return await shared(url);
    const principal = await verify(req);
    if (req.method === "GET" && path === "/v1/usage") return json(200, await usage(principal));
    if (req.method === "POST" && path === "/v1/shares") return json(201, await createShare(principal, await req.json()));
    const located = objectPath(path);
    if (!located) return json(404, { error: { code: "NotFound", message: "Unknown route" } });
    if (req.method === "PUT" && located.key) {
      return json(200, await putObject(principal, located.bucket, located.key, new Uint8Array(await req.arrayBuffer())));
    }
    if (req.method === "GET" && located.key) return await download(principal, located.bucket, located.key);
    if (req.method === "GET" && !located.key) return json(200, await listObjects(principal, located.bucket, url.searchParams.get("view")));
    if (req.method === "DELETE" && located.key) {
      await deleteObject(principal, located.bucket, located.key);
      return new Response(null, { status: 204 });
    }
    return json(405, { error: { code: "MethodNotAllowed", message: "Method is not allowed" } });
  } catch (error) {
    const mapped = error instanceof ApiError ? error : new ApiError(500, "InternalError", "Internal error");
    if (!(error instanceof ApiError)) console.error(JSON.stringify({ msg: "drive error", err: error instanceof Error ? error.message : "unknown" }));
    return json(mapped.status, { error: { code: mapped.code, message: mapped.status === 500 ? "Internal error" : mapped.message } });
  }
});

function objectPath(path: string) {
  const prefix = "/v1/objects/";
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { bucket: decodeURIComponent(rest), key: null };
  return { bucket: decodeURIComponent(rest.slice(0, slash)), key: decodeURIComponent(rest.slice(slash + 1)) };
}

function assertBucket(bucket: string) {
  if (!BUCKET.test(bucket) || bucket.includes("..")) throw new ApiError(400, "InvalidBucketName", "Bucket name is not allowed");
}

function assertKey(key: string) {
  if (!key || key.length > 1024 || key.includes("\0") || key.includes("\\") || key.startsWith("/")) {
    throw new ApiError(400, "InvalidObjectName", "Object key is not allowed");
  }
  if (key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ApiError(400, "InvalidObjectName", "Object key is not allowed");
  }
}

function requirePurpose(principal: Principal, action: string) {
  if (!principal.purpose) throw new ApiError(403, "PurposeRequired", "x-cumulus-purpose is required");
  if (!PURPOSES.includes(principal.purpose) || !(ACTIONS[principal.purpose] ?? []).includes(action)) {
    throw new ApiError(403, "AccessDenied", "Purpose does not allow this action");
  }
}

async function verify(req: Request): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new ApiError(401, "AccessDenied", "Missing bearer token");
  const token = header.slice(7).trim();
  const purpose = req.headers.get("x-cumulus-purpose") ?? "";
  const hint = req.headers.get("x-cumulus-tenant");
  if (verifyCid) {
    if (!serviceKey) throw new ApiError(500, "Config", "Drive auth is not configured");
    let cid: string;
    try {
      cid = await verifyCid(token);
    } catch (error) {
      if (error instanceof CidError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
    return { cid, sub: cid, purpose, hint, db: { token: serviceKey, key: serviceKey } };
  }
  if (!jwks || !issuer || !anonKey) throw new ApiError(500, "Config", "Drive auth is not configured");
  let payload;
  try {
    payload = (await jwtVerify(token, jwks, { issuer, algorithms: ["ES256", "RS256"] })).payload;
  } catch {
    throw new ApiError(401, "InvalidToken", "Supabase token was rejected");
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!SUB.test(sub)) throw new ApiError(401, "InvalidToken", "Subject is required");
  const rows = await rest(token, anonKey, `/identities?user_id=eq.${encodeURIComponent(sub)}&select=cid`);
  const cid = rows?.[0]?.cid;
  if (typeof cid !== "string" || !CID.test(cid)) throw new ApiError(401, "InvalidToken", "CID is not bound to this user");
  return { cid, sub, purpose, hint, db: { token, key: anonKey } };
}

async function tenant(principal: Principal) {
  const rows = await rest(principal.db.token, principal.db.key, `/tenants?cid=eq.${encodeURIComponent(principal.cid)}&select=id,used_bytes,max_bytes`);
  const row = rows?.[0];
  if (!row) throw new ApiError(403, "AccessDenied", "CID is not bound to a tenant");
  if (principal.hint && principal.hint !== row.id) throw new ApiError(403, "AccessDenied", "Tenant hint does not match the CID");
  return row as { id: string; used_bytes: number | string; max_bytes: number | string };
}

async function usage(principal: Principal) {
  requirePurpose(principal, "usage.get");
  const row = await tenant(principal);
  return { usedBytes: Number(row.used_bytes), maxBytes: Number(row.max_bytes), maxFileBytes: FILE_CAP };
}

async function putObject(principal: Principal, bucket: string, key: string, bytes: Uint8Array) {
  requirePurpose(principal, "object.put");
  assertBucket(bucket);
  assertKey(key);
  if (bytes.byteLength > FILE_CAP) throw new ApiError(413, "EntityTooLarge", "Object exceeds the per-file cap");
  const owner = await tenant(principal);
  const blobId = hex(crypto.getRandomValues(new Uint8Array(16)));
  const sealed = await seal(bytes, `${owner.id}\n${blobId}`);
  const objectKey = `tenants/${owner.id}/${blobId}`;
  await s3("PUT", objectKey, sealed.ciphertext);
  try {
    const existing = await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}&select=blob_id`);
    if (existing?.[0]) {
      await rest(principal.db.token, principal.db.key, `/shares?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
      await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
    }
    await rest(principal.db.token, principal.db.key, "/objects", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        tenant_id: owner.id,
        bucket,
        object_key: key,
        size_bytes: bytes.byteLength,
        blob_id: blobId,
        sha256: await sha256(sealed.ciphertext),
        plaintext_sha256: await sha256(bytes),
        content_type: "application/octet-stream",
        envelope_json: JSON.stringify(sealed.envelope),
        created_at: new Date().toISOString(),
      }),
    });
    if (existing?.[0]) await s3("DELETE", `tenants/${owner.id}/${existing[0].blob_id}`).catch(() => undefined);
  } catch (error) {
    await s3("DELETE", objectKey).catch(() => undefined);
    throw error;
  }
  return { size: bytes.byteLength, sha256: await sha256(bytes) };
}

async function download(principal: Principal, bucket: string, key: string) {
  requirePurpose(principal, "object.get");
  assertBucket(bucket);
  assertKey(key);
  const owner = await tenant(principal);
  const rows = await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}&select=blob_id,envelope_json,content_type,sha256,plaintext_sha256`);
  if (!rows?.[0]) throw new ApiError(404, "NoSuchKey", "Object not found");
  return await plaintextResponse(owner.id, rows[0]);
}

/** Active objects only. Stars, trash and photos are console parity views that this schema does not store. */
async function listObjects(principal: Principal, bucket: string, view: string | null) {
  requirePurpose(principal, "object.get");
  assertBucket(bucket);
  const owner = await tenant(principal);
  if (view && view !== "active") return { objects: [] };
  const rows = await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&select=object_key,size_bytes,content_type,created_at&order=object_key.asc`);
  return { objects: rows ?? [] };
}

async function deleteObject(principal: Principal, bucket: string, key: string) {
  requirePurpose(principal, "object.delete");
  assertBucket(bucket);
  assertKey(key);
  const owner = await tenant(principal);
  const rows = await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}&select=blob_id`);
  if (!rows?.[0]) throw new ApiError(404, "NoSuchKey", "Object not found");
  await rest(principal.db.token, principal.db.key, `/shares?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
  await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
  await s3("DELETE", `tenants/${owner.id}/${rows[0].blob_id}`).catch(() => undefined);
}

async function createShare(principal: Principal, body: { bucket?: string; key?: string; ttlSeconds?: number }) {
  requirePurpose(principal, "share.create");
  const bucket = body.bucket ?? "";
  const key = body.key ?? "";
  assertBucket(bucket);
  assertKey(key);
  if (!Number.isInteger(body.ttlSeconds) || (body.ttlSeconds ?? 0) < 1 || (body.ttlSeconds ?? 0) > 900) {
    throw new ApiError(400, "InvalidTtl", "Share links expire in 1 to 900 seconds");
  }
  const owner = await tenant(principal);
  const rows = await rest(principal.db.token, principal.db.key, `/objects?tenant_id=eq.${owner.id}&bucket=eq.${encodeURIComponent(bucket)}&object_key=eq.${encodeURIComponent(key)}&select=blob_id`);
  if (!rows?.[0]) throw new ApiError(404, "NoSuchKey", "Object not found");
  const id = `shr_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const exp = Math.floor(Date.now() / 1000) + (body.ttlSeconds as number);
  await rest(principal.db.token, principal.db.key, "/shares", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      id,
      tenant_id: owner.id,
      bucket,
      object_key: key,
      expires_at: new Date(exp * 1000).toISOString(),
      revoked_at: null,
      created_at: new Date().toISOString(),
    }),
  });
  const sig = await hmacHex(text(shareSecret), `${id}.${exp}`);
  return { shareId: id, expiresAt: new Date(exp * 1000).toISOString(), url: `${publicBase}/v1/shared?shareId=${encodeURIComponent(id)}&exp=${exp}&sig=${sig}` };
}

async function shared(url: URL) {
  const shareId = url.searchParams.get("shareId") ?? "";
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!shareId || !Number.isInteger(exp) || !safeEqual(await hmacHex(text(shareSecret), `${shareId}.${exp}`), sig)) {
    throw new ApiError(403, "AccessDenied", "Share link is not valid");
  }
  if (Math.floor(Date.now() / 1000) > exp) throw new ApiError(403, "ExpiredToken", "Share link has expired");
  const shares = await rest(serviceKey, serviceKey, `/shares?id=eq.${encodeURIComponent(shareId)}&select=tenant_id,bucket,object_key,expires_at,revoked_at`);
  const share = shares?.[0];
  if (!share || share.revoked_at || Date.parse(share.expires_at) !== exp * 1000) throw new ApiError(403, "AccessDenied", "Share link is not valid");
  const objects = await rest(serviceKey, serviceKey, `/objects?tenant_id=eq.${share.tenant_id}&bucket=eq.${encodeURIComponent(share.bucket)}&object_key=eq.${encodeURIComponent(share.object_key)}&select=blob_id,envelope_json,content_type,sha256,plaintext_sha256`);
  if (!objects?.[0]) throw new ApiError(404, "NoSuchKey", "Object not found");
  return await plaintextResponse(share.tenant_id, objects[0]);
}

async function plaintextResponse(tenantId: string, row: { blob_id: string; envelope_json: string; content_type: string; sha256: string; plaintext_sha256: string }) {
  const ciphertext = await s3("GET", `tenants/${tenantId}/${row.blob_id}`);
  if ((await sha256(ciphertext)) !== row.sha256) throw new ApiError(500, "ChecksumMismatch", "Stored bytes failed the checksum");
  const envelope = JSON.parse(row.envelope_json);
  const plaintext = await open(ciphertext, envelope, `${tenantId}\n${row.blob_id}`);
  if ((await sha256(plaintext)) !== row.plaintext_sha256) throw new ApiError(500, "ChecksumMismatch", "Decrypted bytes failed the checksum");
  return new Response(plaintext, { status: 200, headers: { "content-type": row.content_type } });
}

async function rest(token: string, apikey: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("apikey", apikey);
  headers.set("accept-profile", "cumulus");
  headers.set("content-profile", "cumulus");
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${restUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const code = body?.code;
    const message = String(body?.message ?? "");
    if (code === "23514" && message.includes("quota")) throw new ApiError(403, "QuotaExceeded", "Tenant quota exceeded");
    if (code === "23514" && message.includes("file cap")) throw new ApiError(413, "EntityTooLarge", "Object exceeds the per-file cap");
    throw new ApiError(response.status === 401 ? 401 : 500, response.status === 401 ? "InvalidToken" : "InternalError", message || "Request failed");
  }
  return body;
}

async function s3(method: "PUT" | "GET" | "DELETE", key: string, body?: Uint8Array) {
  const endpoint = new URL(s3Endpoint);
  const parts = [STORAGE_BUCKET, ...key.split("/")].map(encodeURIComponent);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${parts.join("/")}`;
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const datestamp = amzdate.slice(0, 8);
  const payload = body ?? new Uint8Array();
  const payloadHash = await sha256(payload);
  const signHost = Deno.env.get("CUMULUS_S3_SIGN_HOST") || endpoint.host;
  const canonicalHeaders = `host:${signHost}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [method, endpoint.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzdate, scope, await sha256(text(canonical))].join("\n");
  const signature = await hmacHex(await signingKey(datestamp), stringToSign);
  const response = await fetch(endpoint, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzdate,
    },
    body: method === "PUT" ? body : undefined,
  });
  if (!response.ok) {
    const detail = await response.text();
    const code = detail.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? "unknown";
    console.error(JSON.stringify({ msg: "s3", method, status: response.status, code }));
    throw new ApiError(500, "StorageError", "Object storage request failed");
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function signingKey(datestamp: string) {
  let key = await hmacRaw(text(`AWS4${secretKey}`), datestamp);
  key = await hmacRaw(key, region);
  key = await hmacRaw(key, "s3");
  return await hmacRaw(key, "aws4_request");
}

async function seal(plaintext: Uint8Array, aad: string) {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const dataKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: text(aad) }, dataKey, plaintext));
  return {
    ciphertext: encrypted.slice(0, -16),
    envelope: { v: 1, alg: "AES-256-GCM", nonce: b64(nonce), tag: b64(encrypted.slice(-16)), wrappedDek: await wrapKey(dek) },
  };
}

async function open(ciphertext: Uint8Array, envelope: { v: number; alg: string; nonce: string; tag: string; wrappedDek: string }, aad: string) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== "AES-256-GCM") throw new ApiError(500, "InvalidEnvelope", "Unsupported object envelope");
  const dek = await unwrapKey(envelope.wrappedDek);
  const dataKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(envelope.nonce), additionalData: text(aad) }, dataKey, concat(ciphertext, b64d(envelope.tag))));
  } catch {
    throw new ApiError(500, "DecryptFailed", "Object could not be decrypted");
  }
}

async function wrapKey(dek: Uint8Array) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", masterKey(), "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, dek));
  return `v1:${b64(concat(concat(nonce, encrypted.slice(-16)), encrypted.slice(0, -16)))}`;
}

async function unwrapKey(packed: string) {
  if (!packed.startsWith("v1:")) throw new ApiError(500, "InvalidEnvelope", "Unsupported wrapped key");
  const raw = b64d(packed.slice(3));
  const key = await crypto.subtle.importKey("raw", masterKey(), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, concat(raw.slice(28), raw.slice(12, 28))));
}

function masterKey() {
  const bytes = b64d(Deno.env.get("CUMULUS_KMS_MASTER_KEY") ?? "");
  if (bytes.byteLength !== 32) throw new ApiError(500, "Config", "Master key must be 32 bytes");
  return bytes;
}

async function hmacRaw(key: Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, text(value)));
}

async function hmacHex(key: Uint8Array, value: string) {
  return hex(await hmacRaw(key, value));
}

async function sha256(bytes: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function text(value: string) {
  return new TextEncoder().encode(value);
}

function b64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function b64d(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concat(left: Uint8Array, right: Uint8Array) {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

function safeEqual(left: string, right: string) {
  const a = text(left);
  const b = text(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
