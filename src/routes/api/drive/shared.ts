import { createFileRoute } from "@tanstack/react-router";
import { getShared } from "@/lib/drive/http";

export const Route = createFileRoute("/api/drive/shared")({
  server: {
    handlers: {
      GET: ({ request }) => getShared(request),
    },
  },
});
