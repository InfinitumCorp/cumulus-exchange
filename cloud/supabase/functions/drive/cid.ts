/**
 * Cumulus://ID access-token check for the hosted Drive function.
 *
 * Same contract as `createCidVerifier` in `cloud/src/auth.mjs`: a JWT must be
 * ES256, `typ: at+jwt`, from `issuer`, with `aud` one of `audiences`, not
 * expired, and `sub` a cid. The issuer's `/userinfo` must then confirm the
 * session is live and name the same subject, so sign-out takes effect at once.
 * Opaque tokens are accepted only on `/userinfo`'s word. Answers are cached per
 * token for `cacheMs`.
 *
 * jose is passed in so Deno (`npm:jose`) and the Node tests (`jose`) share this file.
 * Erasable TypeScript only: Node runs it with type stripping.
 */

// Cumulus ID mints `cid_<uuid>`; older realms used `cid_<lowercase_word>`.
export const CID = /^cid_[a-z0-9_-]{1,64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{20,200}$/;
export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const DEFAULT_CID_AUDIENCES = ["cumulus-cloud", "cumulus-exchange", "cumulus-mail"];

export class CidError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type JwtVerify = (token: string, keys: unknown, options: Record<string, unknown>) => Promise<{ payload: Record<string, unknown> }>;

export type CidVerifierOptions = {
  issuer: string;
  audiences: string[];
  keys: unknown;
  jwtVerify: JwtVerify;
  fetchImpl?: typeof fetch;
  cacheMs?: number;
  now?: () => number;
};

export function cidIssuer(value: string | undefined): string {
  const base = String(value || DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base)) {
    throw new Error("CID issuer must be an https origin");
  }
  return base;
}

export function cidAudiences(value: string | undefined): string[] {
  const list = (value || DEFAULT_CID_AUDIENCES.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("CID audiences are required");
  return list;
}

export function cidJwksUrl(issuer: string, override: string | undefined): string {
  return override || `${issuer}/protocol/openid-connect/certs`;
}

export function createCidVerifier(options: CidVerifierOptions): (token: string) => Promise<string> {
  const { issuer, audiences, keys, jwtVerify } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { cid: string; until: number }>();

  async function signedSubject(token: string): Promise<string> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: audiences,
        algorithms: ["ES256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "exp"],
        currentDate: new Date(now()),
      }));
    } catch {
      throw new CidError(401, "InvalidToken", "Cumulus ID token was rejected");
    }
    if (typeof payload.sub !== "string" || !CID.test(payload.sub)) {
      throw new CidError(401, "InvalidToken", "CID claim is required");
    }
    return payload.sub;
  }

  async function liveSubject(token: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(`${issuer}/protocol/openid-connect/userinfo`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CidError(503, "ServiceUnavailable", "Cumulus ID could not be reached");
    }
    if (res.status === 401 || res.status === 403) {
      cache.delete(token);
      throw new CidError(401, "InvalidToken", "Cumulus ID token was rejected");
    }
    if (!res.ok) throw new CidError(503, "ServiceUnavailable", "Cumulus ID could not be reached");
    const profile = await res.json().catch(() => null);
    const sub = typeof profile?.sub === "string" && profile.sub ? profile.sub : profile?.cid;
    if (typeof sub !== "string" || !CID.test(sub)) throw new CidError(401, "InvalidToken", "CID claim is required");
    return sub;
  }

  return async function verifyCid(token: string): Promise<string> {
    const hit = cache.get(token);
    if (hit && hit.until > now()) return hit.cid;
    const jwt = token.split(".").length === 3;
    if (!jwt && !OPAQUE.test(token)) throw new CidError(401, "InvalidToken", "Cumulus ID token was rejected");
    const signed = jwt ? await signedSubject(token) : null;
    const cid = await liveSubject(token);
    if (signed && signed !== cid) throw new CidError(401, "InvalidToken", "Cumulus ID token was rejected");
    if (cache.size > 5000) cache.clear();
    cache.set(token, { cid, until: now() + cacheMs });
    return cid;
  };
}
