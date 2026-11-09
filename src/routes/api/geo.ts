import { createFileRoute } from "@tanstack/react-router";
import { handleGeoLookup } from "@/lib/geo/http.mjs";

export const Route = createFileRoute("/api/geo")({
  server: {
    handlers: {
      GET: ({ request }) => handleGeoLookup(request),
    },
  },
});
