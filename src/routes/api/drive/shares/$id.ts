import { createFileRoute } from "@tanstack/react-router";
import { removeShare } from "@/lib/drive/http";

export const Route = createFileRoute("/api/drive/shares/$id")({
  server: {
    handlers: {
      DELETE: ({ request, params }) => removeShare(request, params.id),
    },
  },
});
