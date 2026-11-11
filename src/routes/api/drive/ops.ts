import { createFileRoute } from "@tanstack/react-router";
import { driveOps } from "@/lib/drive/http-parity";

export const Route = createFileRoute("/api/drive/ops")({
  server: {
    handlers: {
      GET: ({ request }) => driveOps(request),
      POST: ({ request }) => driveOps(request),
    },
  },
});
