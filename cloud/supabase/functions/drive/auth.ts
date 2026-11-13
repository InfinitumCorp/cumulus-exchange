/**
 * Bearer checks for the hosted Drive Edge Function. No runtime imports: `jose`
 * and `fetch` are passed in, so `cloud/test/edge-auth.test.mjs` can load this
 * file under Node (`--experimental-strip-types`) as well as Deno.
 *
 * `cid` (the default) accepts the access token a person got from Cumulus://ID,
 * the same contract as `createCidVerifier` in `cloud/src/auth.mjs`:
 * ES256, `typ: at+jwt`, `iss` = the issuer, `aud` one of the audiences, `exp`,
 * `sub` = the cid. The issuer's `/userinfo` then confirms the session is still
 * live and names the same `sub`. Opaque tokens from the older `/api/id/token`
 * route are accepted on `/userinfo`'s word alone.
 *
 * `supabase` is the earlier mode: a Supabase Auth JWT whose `sub` is mapped to a
 * cid through `cumulus.identities`. That lookup stays in `index.ts`.
 */

// Cumulus ID mints `cid_<uuid>`; older realms used `cid_<lowercase_word>`.
export const CID = /^cid_[a-z0-9_-]{1,64}$/;
export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const DEFAULT_CID_AUDIENCES = ["cumulus-cloud", "cumulus-exchange", "cumulus-mail"];
const OPAQUE = /^[A-Za-z0-9_-]{20,200}$/;

export type AuthMode = "cid" | "supabase";

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Env = (name: string) => string | undefined;

/** Reads the auth settings. `hosted` is the injected SUPABASE_URL, or "". */
export function authSettings(env: Env, hosted: string) {
  const mode = (env("CUMULUS_AUTH_MODE") || "cid").trim();
  if (mode !== "cid" && mode !== "supabase") {
    throw new Error(`Unknown CUMULUS_AUTH_MODE ${mode}. Use cid or supabase.`);
  }
  if (mode === "cid") {
    const issuer = (env("CID_ISSUER") || DEFAULT_CID_ISSUER).trim().replace(/\/+$/, "");
    const audiences = (env("CID_AUDIENCES") || DEFAULT_CID_AUDIENCES.join(","))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const jwksUrl = env("CID_JWKS_URL") || `${issuer}/protocol/openid-connect/certs`;
    return { mode: mode as AuthMode, issuer, audiences, jwksUrl };
  }
  const jwksUrl = env("CUMULUS_JWKS_URL") ?? (hosted ? `${hosted}/auth/v1/.well-known/jwks.json` : "");
  const issuer = env("CUMULUS_JWT_ISSUER") ?? (hosted ? `${hosted}/auth/v1` : "");
  return { mode: mode as AuthMode, issuer, audiences: [] as string[], jwksUrl };
}

type Verify<K> = (token: string, key: K, options: Record<string, unknown>) => Promise<{ payload: Record<string, unknown> }>;

export function createCidVerifier<K>({
  issuer,
  audiences,
  keys,
  jwtVerify,
  fetchImpl = fetch,
  cacheMs = 30_000,
  now = () => Date.now(),
}: {
  issuer: string;
  audiences: string[];
  keys: K;
  jwtVerify: Verify<K>;
  fetchImpl?: typeof fetch;
  cacheMs?: number;
  now?: () => number;
}) {
  const base = String(issuer || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base)) {
    throw new Error("CID issuer must be an https origin");
  }
  if (!audiences.length) throw new Error("CID audiences are required");
  const userinfo = `${base}/protocol/openid-connect/userinfo`;
  const cache = new Map<string, { cid: string; until: number }>();

  async function signedSubject(token: string) {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: base,
        audience: audiences,
        algorithms: ["ES256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "exp"],
        currentDate: new Date(now()),
      }));
    } catch {
      throw new AuthError(401, "InvalidToken", "Cumulus ID token was rejected");
    }
    if (typeof payload.sub !== "string" || !CID.test(payload.sub)) {
      throw new AuthError(401, "InvalidToken", "CID claim is required");
    }
    return payload.sub;
  }

  async function liveSubject(token: string) {
    let res: Response;
    try {
      res = await fetchImpl(userinfo, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AuthError(503, "ServiceUnavailable", "Cumulus ID could not be reached");
    }
    if (res.status === 401 || res.status === 403) {
      cache.delete(token);
      throw new AuthError(401, "InvalidToken", "Cumulus ID token was rejected");
    }
    if (!res.ok) throw new AuthError(503, "ServiceUnavailable", "Cumulus ID could not be reached");
    const profile = await res.json().catch(() => null);
    const sub = typeof profile?.sub === "string" && profile.sub ? profile.sub : profile?.cid;
    if (typeof sub !== "string" || !CID.test(sub)) {
      throw new AuthError(401, "InvalidToken", "CID claim is required");
    }
    return sub;
  }

  /** Returns the verified cid for a bearer token, or throws AuthError. */
  return async function verifyCid(token: string) {
    const isJwt = token.split(".").length === 3;
    if (!isJwt && !OPAQUE.test(token)) throw new AuthError(401, "InvalidToken", "Credential was rejected");
    const hit = cache.get(token);
    if (hit && hit.until > now()) return hit.cid;
    const signed = isJwt ? await signedSubject(token) : null;
    const cid = await liveSubject(token);
    if (signed && signed !== cid) throw new AuthError(401, "InvalidToken", "Cumulus ID token was rejected");
    if (cache.size > 5000) cache.clear();
    cache.set(token, { cid, until: now() + cacheMs });
    return cid;
  };
}
