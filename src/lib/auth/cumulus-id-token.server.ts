/**
 * Verify a Cumulus://ID ID token (server-only: pulls in `jose`).
 *
 * Checks the ES256 signature against the issuer's JWKS, then `iss`, `aud`
 * (this app's client id), `exp`, and — when the caller has one — `nonce`.
 * Better Auth's generic OIDC provider already checks the same token with the
 * nonce it generated; this second check pins the issuer and client id to this
 * app's own configuration instead of whatever discovery returned.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { cidEndpoints, type CidConfig, type CidIdTokenClaims } from "./cumulus-id.ts";

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** The issuer's JWKS, fetched on demand and cached by `jose`. */
export function cidJwks(issuer: string): JWTVerifyGetKey {
  const url = cidEndpoints(issuer).jwks;
  let keys = remoteKeys.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url));
    remoteKeys.set(url, keys);
  }
  return keys;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

export async function verifyCidIdToken(
  config: CidConfig,
  idToken: string,
  options: { keys?: JWTVerifyGetKey; nonce?: string; currentDate?: Date } = {},
): Promise<CidIdTokenClaims> {
  const { payload, protectedHeader } = await jwtVerify(idToken, options.keys ?? cidJwks(config.issuer), {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ["ES256"],
    requiredClaims: ["sub", "exp", "iat"],
    currentDate: options.currentDate,
  });
  // An access token (`typ: at+jwt`) has the same iss/aud; it is not proof of a sign-in.
  if (typeof protectedHeader.typ === "string" && protectedHeader.typ.toLowerCase().endsWith("at+jwt")) {
    throw new Error("Cumulus ID returned an access token where an ID token was expected");
  }
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new Error("Cumulus ID token nonce does not match this sign-in");
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) {
    throw new Error("Cumulus ID token was issued to another client");
  }
  const sub = str(payload.sub);
  if (!sub) throw new Error("Cumulus ID token has no subject");
  return {
    sub,
    cid: str(payload.cid),
    name: str(payload.name),
    preferred_username: str(payload.preferred_username),
    username: str(payload.username),
    handle: str(payload.handle),
    email: str(payload.email),
    email_verified: typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
  };
}
