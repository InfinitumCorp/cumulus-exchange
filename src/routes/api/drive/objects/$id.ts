import { createFileRoute } from "@tanstack/react-router";
import { getObject, removeObject } from "@/lib/drive/http";

export const Route = createFileRoute("/api/drive/objects/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getObject(request, params.id),
      DELETE: ({ request, params }) => removeObject(request, params.id),
    },
  },
});
