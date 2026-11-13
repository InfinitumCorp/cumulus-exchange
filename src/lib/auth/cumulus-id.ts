/**
 * "Sign in with Cumulus://ID" for Cumulus://Cloud (Cumulus Exchange).
 *
 * Cumulus://ID is the only way people sign in. It is a standard OpenID Connect
 * provider (contract: cumulus-id `docs/integration.md`):
 *
 *   issuer   https://id.cumuluscloud.app/realms/cumulus
 *   JWKS     <issuer>/protocol/openid-connect/certs   (ES256)
 *   client   public, no secret; every code exchange is bound by PKCE S256
 *
 * This app's own Better Auth runs a `genericOAuth` provider against it
 * (`server.ts`): authorization code + PKCE S256 + `nonce`, and the ID token is
 * verified against the JWKS (signature, `iss`, `aud`, `exp`, `nonce`) before
 * anyone is signed in. The local user is keyed by the ID token's `sub` (the cid).
 * "Create a Cumulus://ID" is the same client with `prompt=create`.
 *
 * Dependency-free so the client can import the provider list. The ID token
 * check that needs `jose` lives in `cumulus-id-token.server.ts`.
 *
 * The issuer is configurable (`CID_ISSUER`) so a mirror can be dropped in. The
 * client id follows the public origin: `cumulus-exchange` on
 * exchange.cumuluscloud.app, `cumulus-cloud` everywhere else; `CID_CLIENT_ID`
 * overrides both.
 */

export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
/** The client id cumulus-id registers for cumuluscloud.app, cloud. and drive.cumuluscloud.app. */
export const DEFAULT_CID_CLIENT_ID = "cumulus-cloud";
/** The add-on client id for the Data Exchange host. */
export const EXCHANGE_CID_CLIENT_ID = "cumulus-exchange";
export const EXCHANGE_ORIGIN = "https://exchange.cumuluscloud.app";

/** OIDC scopes this app asks for. No `offline_access`: the app keeps its own session. */
export const CID_SCOPES = ["openid", "profile", "email"] as const;

export const CUMULUS_ID_PROVIDER_ID = "cumulus-id";
/** Same client and issuer; asks Cumulus://ID to open on "Create a Cumulus ID". */
export const CUMULUS_ID_CREATE_PROVIDER_ID = "cumulus-id-create";

export type SignInProvider = {
  /** Better Auth provider id; also the callback path segment. */
  providerId: string;
  /** Button text. */
  label: string;
  /** Send `prompt=create` so Cumulus://ID opens on account creation. */
  create: boolean;
};

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  { providerId: CUMULUS_ID_PROVIDER_ID, label: "Sign in with Cumulus ID", create: false },
  { providerId: CUMULUS_ID_CREATE_PROVIDER_ID, label: "Create a Cumulus ID", create: true },
];

type CidEnv = { CID_ISSUER?: string; CID_CLIENT_ID?: string; BETTER_AUTH_URL?: string };

export type CidConfig = { issuer: string; clientId: string };

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/** The registered client id for the origin this app is served from. */
export function cidClientIdForOrigin(publicUrl: string | undefined): string {
  return originOf(publicUrl) === EXCHANGE_ORIGIN ? EXCHANGE_CID_CLIENT_ID : DEFAULT_CID_CLIENT_ID;
}

export function cidConfig(env: CidEnv = process.env): CidConfig {
  const issuer = (env.CID_ISSUER?.trim() || DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  const clientId = env.CID_CLIENT_ID?.trim() || cidClientIdForOrigin(env.BETTER_AUTH_URL);
  return { issuer, clientId };
}

/** The issuer's OIDC endpoints (Keycloak-style paths under the realm issuer). */
export function cidEndpoints(issuer: string) {
  const base = issuer.replace(/\/+$/, "");
  const oidc = `${base}/protocol/openid-connect`;
  return {
    discovery: `${base}/.well-known/openid-configuration`,
    authorize: `${oidc}/auth`,
    token: `${oidc}/token`,
    userinfo: `${oidc}/userinfo`,
    jwks: `${oidc}/certs`,
    revoke: `${oidc}/revoke`,
    logout: `${oidc}/logout`,
  };
}

/** Claims this app reads from a verified Cumulus://ID ID token. */
export type CidIdTokenClaims = {
  sub: string;
  cid?: string;
  name?: string;
  preferred_username?: string;
  username?: string;
  handle?: string;
  email?: string;
  email_verified?: boolean;
};

/**
 * Better Auth user info for verified ID token claims. `sub` (the cid) is the
 * stable account id; the user is keyed by it, never by email or username.
 */
export function cidUserInfo(claims: CidIdTokenClaims) {
  const sub = claims.sub;
  const email = (claims.email ?? "").trim().toLowerCase();
  return {
    id: sub,
    sub,
    // Cumulus://ID always reports the person's verified @cumuluscloud.app address.
    email: email || `${sub}@cumulus-id.invalid`,
    emailVerified: Boolean(email) && claims.email_verified !== false,
    name: claims.name || claims.preferred_username || claims.username || claims.handle || "Cumulus",
  };
}
