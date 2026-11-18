import { createFileRoute } from "@tanstack/react-router";
import { auth, authConfigured } from "@/lib/auth/server";
import { cidDriveToken } from "@/lib/drive/cid-token";

// The signed-in person's Cumulus ID access token for the cloud Drive; see src/lib/drive/cid-token.ts.
export const Route = createFileRoute("/api/drive/cid-token")({
  server: {
    handlers: {
      GET: ({ request }) =>
        cidDriveToken(request, {
          configured: Boolean(process.env.SUPABASE_FUNCTION_URL?.trim()) && authConfigured,
          api: {
            getSession: (input) => auth.api.getSession(input),
            listUserAccounts: (input) => auth.api.listUserAccounts(input),
            getAccessToken: (input) => auth.api.getAccessToken(input),
          },
        }),
    },
  },
});
