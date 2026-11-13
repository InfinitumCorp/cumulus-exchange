/**
 * Drive API calls the console does not answer itself go to the Supabase Edge
 * Function through `driveProxy` (cloud/worker/src/index.mjs): `/api/drive/v1/*`
 * and `/api/healthz` on any host, and `/v1/*` and `/healthz` (share links) on the
 * cloud host. It applies the CORS allowlist and header filtering and reads
 * SUPABASE_FUNCTION_URL plus the CUMULUS_* host settings from the environment;
 * on the cumulus-cloud Worker, vars and secrets reach `process.env` under
 * `nodejs_compat`. Without SUPABASE_FUNCTION_URL every call is a 503.
 */
import { driveProxy } from "../../../cloud/worker/src/index.mjs";

export async function proxyDrive(request: Request): Promise<Response> {
  const response = await driveProxy(request, process.env);
  return response ?? new Response("Not found", { status: 404 });
}

const handler = ({ request }: { request: Request }) => proxyDrive(request);

/** Same handler for every method the proxy accepts; it rejects the rest. */
export const driveProxyHandlers = {
  GET: handler,
  HEAD: handler,
  PUT: handler,
  POST: handler,
  DELETE: handler,
  OPTIONS: handler,
};
