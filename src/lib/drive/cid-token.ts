import { SIGN_IN_PROVIDERS } from "../auth/providers.ts";

/**
 * The signed-in person's Cumulus ID access token, for the cloud Drive
 * (`GET /api/drive/cid-token`, src/routes/api/drive/cid-token.ts).
 *
 * The console's cloud Drive view sends this token to `/api/drive/v1/*`, which the
 * Worker proxies to the Supabase Edge Function; the function verifies it against
 * Cumulus ID (`cloud/supabase/functions/drive/cid.ts`). Better Auth stored the
 * token, encrypted, when the person signed in, and refreshes it when it has
 * expired and Cumulus ID issued a refresh token.
 *
 * 404 unless the cloud Drive is configured, so another host keeps the
 * session-store Drive. 401 when nobody is signed in or no usable token is left.
 * Only Cumulus ID accounts are considered. Responses are never cached.
 *
 * The Better Auth calls are passed in so this can be tested without a database.
 */
export type CidTokenApi = {
  getSession(input: { headers: Headers }): Promise<unknown>;
  listUserAccounts(input: { headers: Headers }): Promise<ReadonlyArray<{ id: string; providerId: string }>>;
  getAccessToken(input: {
    body: { accountId: string };
    headers: Headers;
  }): Promise<{ accessToken?: string | null; accessTokenExpiresAt?: Date | string | null } | null | undefined>;
};

const CID_PROVIDERS = new Set(SIGN_IN_PROVIDERS.map((p) => p.providerId));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function cidDriveToken(
  request: Request,
  deps: { api: CidTokenApi; configured: boolean },
): Promise<Response> {
  if (!deps.configured) {
    return json(404, { error: { code: "NotConfigured", message: "Cloud Drive is not configured here" } });
  }
  const headers = request.headers;
  const session = await deps.api.getSession({ headers }).catch(() => null);
  if (!session) return json(401, { error: { code: "SignInRequired", message: "Sign in with Cumulus ID" } });

  const accounts = await deps.api.listUserAccounts({ headers }).catch(() => []);
  for (const account of accounts.filter((a) => CID_PROVIDERS.has(a.providerId))) {
    try {
      const tokens = await deps.api.getAccessToken({ body: { accountId: account.id }, headers });
      if (tokens?.accessToken) {
        const at = tokens.accessTokenExpiresAt;
        return json(200, {
          token: tokens.accessToken,
          expiresAt: at instanceof Date ? at.toISOString() : at ?? null,
        });
      }
    } catch {
      // Expired with no refresh token, or refresh refused: try the next account.
    }
  }
  return json(401, { error: { code: "SignInAgain", message: "Sign in with Cumulus ID again" } });
}
