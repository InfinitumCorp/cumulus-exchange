import { createFileRoute } from "@tanstack/react-router";
import { driveProxyHandlers } from "@/lib/drive/proxy.server";

// Drive API: proxied to the Supabase Edge Function (see proxy.server.ts).
export const Route = createFileRoute("/api/healthz")({
  server: { handlers: driveProxyHandlers },
});
