import { createFileRoute } from "@tanstack/react-router";
import { getObjectShares, postShare } from "@/lib/drive/http";

export const Route = createFileRoute("/api/drive/objects/$id/shares")({
  server: {
    handlers: {
      GET: ({ request, params }) => getObjectShares(request, params.id),
      POST: ({ request, params }) => postShare(request, params.id),
    },
  },
});
