import frontend from "../.output/server/index.mjs";
import { fetchDrive } from "../cloud/src/worker.mjs";

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/") || ["/healthz", "/readyz", "/metrics"].includes(path)) {
      return fetchDrive(request, env);
    }
    return frontend.fetch(request, env, ctx);
  },
};
