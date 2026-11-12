/**
 * Canonical Cumulus domain. cumuluscloud.app is registered at Cloudflare for
 * Cumulus://ID, Cumulus://Cloud, and Cumulus://Mail. This module only names
 * hosts. It does not call Cloudflare or change DNS.
 */

export const DEFAULT_ROOT_DOMAIN = "cumuluscloud.app";
/** Cumulus://ID client ids (cumulus-id `src/clients.ts`) whose access tokens Drive accepts. */
export const DEFAULT_CID_AUDIENCES = ["cumulus-cloud", "cumulus-exchange", "cumulus-mail"];

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function hostname(value, label) {
  const host = String(value || "").trim().toLowerCase();
  if (!HOST.test(host) || host.includes("*")) {
    throw new Error(`${label} must be an exact hostname`);
  }
  return host;
}

function exactOrigin(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("*")) {
    throw new Error("CORS origins must be exact origins with no wildcard");
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`CORS origin is not a URL: ${text}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`CORS origin must be http or https: ${text}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`CORS origin must be scheme and host only: ${text}`);
  }
  return url.origin;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const rootDomain = hostname(env.CUMULUS_ROOT_DOMAIN || DEFAULT_ROOT_DOMAIN, "CUMULUS_ROOT_DOMAIN");
  const idHost = hostname(env.CUMULUS_ID_HOST || `id.${rootDomain}`, "CUMULUS_ID_HOST");
  const cloudHost = hostname(env.CUMULUS_CLOUD_HOST || `cloud.${rootDomain}`, "CUMULUS_CLOUD_HOST");
  const mailHost = hostname(env.CUMULUS_MAIL_HOST || `mail.${rootDomain}`, "CUMULUS_MAIL_HOST");
  // Cumulus://ID: people sign in there (OIDC realm issuer). CID_ISSUER points at a mirror.
  const cidIssuer = (env.CID_ISSUER || `https://${idHost}/realms/cumulus`).replace(/\/+$/, "");
  // Client ids whose access tokens (`aud`) Drive accepts: Cloud, the Exchange add-on and Mail.
  const cidAudiences = (env.CID_AUDIENCES || DEFAULT_CID_AUDIENCES.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const issuer = (env.CUMULUS_KEYCLOAK_ISSUER || `https://${idHost}/realms/cumulus`).replace(/\/+$/, "");
  const audience = env.CUMULUS_KEYCLOAK_AUDIENCE || `https://${idHost}`;
  const jwksUrl = env.CUMULUS_KEYCLOAK_JWKS_URL || `${issuer}/protocol/openid-connect/certs`;
  const publicBaseUrl = (env.CUMULUS_PUBLIC_BASE_URL || `https://${cloudHost}`).replace(/\/+$/, "");
  const corsOrigins = env.CUMULUS_CORS_ORIGINS
    ? env.CUMULUS_CORS_ORIGINS.split(",").map((item) => exactOrigin(item))
    : [exactOrigin(`https://${idHost}`), exactOrigin(`https://${cloudHost}`), exactOrigin(`https://${mailHost}`)];
  return {
    rootDomain,
    idHost,
    cloudHost,
    mailHost,
    cidIssuer,
    cidAudiences,
    issuer,
    audience,
    jwksUrl,
    publicBaseUrl,
    corsOrigins,
    mailAddressDomain: rootDomain,
  };
}

/** Headers for one request. Unknown origins get no allow-origin header, never `*`. */
export function corsHeaders(requestOrigin, allowlist) {
  if (!requestOrigin || !allowlist.includes(requestOrigin)) return {};
  return {
    "access-control-allow-origin": requestOrigin,
    vary: "Origin",
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-cumulus-purpose, x-cumulus-tenant",
    "access-control-max-age": "600",
  };
}
