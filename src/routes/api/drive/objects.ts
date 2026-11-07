import { createFileRoute } from "@tanstack/react-router";
import { getObjects, postObject } from "@/lib/drive/http";

export const Route = createFileRoute("/api/drive/objects")({
  server: {
    handlers: {
      GET: ({ request }) => getObjects(request),
      POST: ({ request }) => postObject(request),
    },
  },
});
