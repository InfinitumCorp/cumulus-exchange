import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.mjs";

/**
 * Cumulus://ID (CID) and Keycloak JWT checks.
 * InfinitumCorp/eidetic@dfa7d1a was not readable from this environment (repository
 * not found), so this is the contract William named — CID claim, RS256, issuer,
 * audience, expiry, purpose — not a line-level copy of that commit.
 * A CID string by itself is not authentication.
 */

const CID = /^cid_[a-z0-9_]{1,64}$/;

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
    purposes: ["drive.read", "drive.write", "drive.share"],
    sub: typeof payload.sub === "string" ? payload.sub : "",
  };
}

/** Supabase Auth access tokens. cid is app_metadata.cid, set by the SQL hook. */
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
  if (token.split(".").length === 3) {
    const principal = await verifier(token);
    const hinted = headerValue(req.headers, "x-cumulus-tenant");
    return { kind: "user", ...principal, hintedTenant: hinted || null };
  }
  if (allowBootstrap && safeEqual(token, bootstrapToken)) {
    return { kind: "bootstrap" };
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
