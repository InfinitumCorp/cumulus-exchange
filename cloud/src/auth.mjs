import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.mjs";

/**
 * Cumulus ID (CID) bearer checks, plus the older Keycloak and Supabase JWT modes.
 * People sign in with Cumulus ID (https://id.cumuluscloud.app); `createCidVerifier`
 * is the default. The others stay for existing deployments that set
 * CUMULUS_AUTH_MODE explicitly.
 * InfinitumCorp/eidetic@dfa7d1a was not readable from this environment (repository
 * not found), so this is the contract William named — CID claim, RS256, issuer,
 * audience, expiry, purpose — not a line-level copy of that commit.
 * A CID string by itself is not authentication.
 */

// Cumulus ID mints `cid_<uuid>`; older realms used `cid_<lowercase_word>`.
const CID = /^cid_[a-z0-9_-]{1,64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{20,200}$/;
const ALL_PURPOSES = ["drive.read", "drive.write", "drive.share"];

function headerValue(headers, name) {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function cidFromSupabasePayload(payload) {
  const cid = payload?.app_metadata?.cid;
  if (typeof cid !== "string" || !CID.test(cid)) {
    throw new HttpError(401, "InvalidToken", "CID claim is required");
  }
  return {
    cid,
    purposes: [...ALL_PURPOSES],
    sub: typeof payload.sub === "string" ? payload.sub : "",
  };
}

/**
 * Cumulus ID verifier. Asks the issuer who the bearer is (`GET /api/id/userinfo`),
 * which works for both the opaque session tokens and the signed JWTs Cumulus ID
 * issues, and honours sign-out at once. A person owns their own Drive, so a
 * verified CID gets every Drive purpose. Answers are cached for a short time
 * per token so a page of requests is one round trip.
 *
 * `issuer` is configurable (CID_ISSUER) so a mirror that loads in Russia can be used.
 */
export function createCidVerifier({ issuer, fetchImpl = fetch, cacheMs = 30_000, now = () => Date.now() }) {
  const base = String(issuer || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    throw new Error("CID issuer must be an https origin");
  }
  const cache = new Map();
  async function verifyCid(token) {
    const hit = cache.get(token);
    if (hit && hit.until > now()) return hit.principal;
    let res;
    try {
      res = await fetchImpl(`${base}/api/id/userinfo`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(503, "ServiceUnavailable", "Cumulus ID could not be reached");
    }
    if (res.status === 401 || res.status === 403) {
      cache.delete(token);
      throw new HttpError(401, "InvalidToken", "Cumulus ID token was rejected");
    }
    if (!res.ok) throw new HttpError(503, "ServiceUnavailable", "Cumulus ID could not be reached");
    const profile = await res.json().catch(() => null);
    const cid = profile?.cid;
    if (typeof cid !== "string" || !CID.test(cid)) {
      throw new HttpError(401, "InvalidToken", "CID claim is required");
    }
    const principal = { cid, purposes: [...ALL_PURPOSES], sub: cid };
    if (cache.size > 5000) cache.clear();
    cache.set(token, { principal, until: now() + cacheMs });
    return principal;
  }
  verifyCid.acceptsOpaque = true;
  return verifyCid;
}

/**
 * Node-process Supabase verifier. It still reads app_metadata.cid.
 * The free launch path does not use this verifier. The Edge Function resolves
 * cid from cumulus.identities, and the project-wide access token hook is off.
 */
export function createSupabaseVerifier({ issuer, jwksUrl }) {
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  return async function verifyJwt(token) {
    let payload;
    try {
      const result = await jwtVerify(token, keys, {
        issuer,
        algorithms: ["ES256", "RS256"],
      });
      payload = result.payload;
    } catch {
      throw new HttpError(401, "InvalidToken", "Supabase token was rejected");
    }
    return cidFromSupabasePayload(payload);
  };
}

export function createKeycloakVerifier({ issuer, audience, jwks, jwksUrl }) {
  const keys = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : createLocalJWKSet(jwks);
  return async function verifyJwt(token) {
    let payload;
    try {
      const result = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ["RS256"],
      });
      payload = result.payload;
    } catch {
      throw new HttpError(401, "InvalidToken", "Keycloak token was rejected");
    }
    if (typeof payload.cid !== "string" || !CID.test(payload.cid)) {
      throw new HttpError(401, "InvalidToken", "CID claim is required");
    }
    const purposes = Array.isArray(payload.purposes) ? payload.purposes.filter((item) => typeof item === "string") : [];
    return { cid: payload.cid, purposes, sub: typeof payload.sub === "string" ? payload.sub : "" };
  };
}

export async function authenticate(req, { verifier, bootstrapToken, allowBootstrap }) {
  const header = headerValue(req.headers, "authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new HttpError(401, "AccessDenied", "Missing bearer token");
  }
  const token = header.slice("Bearer ".length).trim();
  if (allowBootstrap && token.split(".").length !== 3 && safeEqual(token, bootstrapToken)) {
    return { kind: "bootstrap" };
  }
  if (token.split(".").length === 3 || (verifier.acceptsOpaque && OPAQUE.test(token))) {
    const principal = await verifier(token);
    const hinted = headerValue(req.headers, "x-cumulus-tenant");
    return { kind: "user", ...principal, hintedTenant: hinted || null };
  }
  throw new HttpError(401, "InvalidToken", "Credential was rejected");
}

export function requirePurpose(principal, purpose, action) {
  if (!principal || principal.kind !== "user") {
    throw new HttpError(403, "AccessDenied", "Access denied");
  }
  if (!purpose) throw new HttpError(403, "PurposeRequired", "x-cumulus-purpose is required");
  if (!principal.purposes.includes(purpose)) {
    throw new HttpError(403, "AccessDenied", "Purpose is not granted on this CID");
  }
  const allowed = {
    "drive.read": ["object.get", "object.list", "usage.get"],
    "drive.write": ["object.get", "object.list", "object.put", "object.delete", "usage.get"],
    "drive.share": ["share.create", "share.revoke", "object.get", "object.list"],
  };
  const actions = allowed[purpose] ?? [];
  if (!actions.includes(action)) {
    throw new HttpError(403, "AccessDenied", "Purpose does not allow this action");
  }
}
