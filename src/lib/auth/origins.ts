/**
 * Public host for this app. DNS, TLS, and OAuth client registration are not
 * created here. `https://cumuluscloud.app` is the only Cumulus origin this
 * process trusts, and only as that exact string.
 *
 * People sign in with Cumulus ID (id.cumuluscloud.app) through this app's
 * Better Auth (`/api/auth/*`, see `cumulus-id.ts`); the session cookie is this
 * origin's own. Nothing here accepts a cookie or mailbox from another Infinitum
 * product. The browser demo ledger is a separate hardcoded label and is not
 * that session.
 */
export const CANONICAL_ORIGIN = "https://cumuluscloud.app";
export const CANONICAL_HOST = "cumuluscloud.app";

/**
 * Origins that serve this app. drive.cumuluscloud.app is the canonical Drive
 * host. exchange.cumuluscloud.app is the Data Exchange host. Cookies stay
 * host-only; listing an origin here does not redirect any other host.
 */
export const SERVING_ORIGINS = [
  CANONICAL_ORIGIN,
  "https://drive.cumuluscloud.app",
  "https://exchange.cumuluscloud.app",
] as const;

/** Not trusted origins, not cookie domains, and not live DNS from this repo. */
export const PROPOSED_HOSTS = {
  id: "id.cumuluscloud.app",
  cloud: "cloud.cumuluscloud.app",
  mail: "mail.cumuluscloud.app",
} as const;

/** Demo ledger label only. Not an account and not a mailbox. */
export const DEMO_LEDGER_EMAIL = "demo.alex@cumuluscloud.app";

export function buildTrustedOrigins(input: {
  explicitBaseURL?: string;
  previewHosts: readonly string[];
  localOrigins: readonly string[];
}): string[] {
  const preview = input.previewHosts.flatMap((host) => [host, `https://${host}`, `http://${host}`]);
  const listed = input.explicitBaseURL
    ? [input.explicitBaseURL, ...SERVING_ORIGINS, ...input.localOrigins]
    : [...SERVING_ORIGINS, ...preview, ...input.localOrigins];
  const unique = [...new Set(listed.map((origin) => origin.trim()).filter(Boolean))];
  for (const origin of unique) {
    if (origin.includes("*") && origin.includes("cumuluscloud.app")) {
      throw new Error("refusing a wildcard cumuluscloud.app origin");
    }
  }
  for (const host of Object.values(PROPOSED_HOSTS)) {
    if (unique.some((origin) => origin.includes(host))) {
      throw new Error(`refusing proposed host ${host} as a trusted origin`);
    }
  }
  return unique;
}
