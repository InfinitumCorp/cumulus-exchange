import { createFileRoute } from "@tanstack/react-router";
import { auth, authConfigured } from "@/lib/auth/server";
import { SIGN_IN_PROVIDERS } from "@/lib/auth/providers";

/**
 * The signed-in person's Cumulus ID access token, for the cloud Drive.
 *
 * The console's cloud Drive view sends this token to `/api/drive/v1/*`, which the
 * Worker proxies to the Supabase Edge Function; the function verifies it against
 * Cumulus ID (`cloud/supabase/functions/drive/cid.ts`). Better Auth stored the
 * token, encrypted, when the person signed in, and refreshes it here when it has
 * expired and Cumulus ID issued a refresh token.
 *
 * 404 unless SUPABASE_FUNCTION_URL is set, so a host without the cloud Drive keeps
 * the session-store Drive. 401 when nobody is signed in or no usable token is left.
 */
const CID_PROVIDERS = new Set(SIGN_IN_PROVIDERS.map((p) => p.providerId));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function cidDriveToken(request: Request): Promise<Response> {
  if (!process.env.SUPABASE_FUNCTION_URL?.trim() || !authConfigured) {
    return json(404, { error: { code: "NotConfigured", message: "Cloud Drive is not configured here" } });
  }
  const headers = request.headers;
  const session = await auth.api.getSession({ headers }).catch(() => null);
  if (!session) return json(401, { error: { code: "SignInRequired", message: "Sign in with Cumulus ID" } });

  const accounts = await auth.api.listUserAccounts({ headers }).catch(() => []);
  for (const account of accounts.filter((a) => CID_PROVIDERS.has(a.providerId))) {
    try {
      const tokens = await auth.api.getAccessToken({ body: { accountId: account.id }, headers });
      if (tokens?.accessToken) {
        return json(200, {
          token: tokens.accessToken,
          expiresAt: tokens.accessTokenExpiresAt ?? null,
        });
      }
    } catch {
      // Expired with no refresh token, or refresh refused: try the next account.
    }
  }
  return json(401, { error: { code: "SignInAgain", message: "Sign in with Cumulus ID again" } });
}

export const Route = createFileRoute("/api/drive/cid-token")({
  server: {
    handlers: {
      GET: ({ request }) => cidDriveToken(request),
    },
  },
});
