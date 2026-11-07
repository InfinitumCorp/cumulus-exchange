import pg from "pg";
import { repository } from "./repository.mjs";
import { createDrive, createHandler } from "./drive.mjs";
import { createSupabaseDriver } from "./supabase-storage.mjs";
import { createKeycloakVerifier } from "./auth.mjs";
import { parseMasterKey } from "./crypto.mjs";
import { loadConfig } from "./config.mjs";
import { createMetrics } from "./metrics.mjs";
import { handleFetch } from "./fetch-handler.mjs";

// Existing envelope encryption buffers file bytes. Keep Worker requests well
// below its 128 MB memory limit until streaming encryption is implemented.
export const WORKER_MAX_FILE_BYTES = 10_000_000;

export async function fetchDrive(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/healthz") return Response.json({ ok: true, service: "cumulus-drive-worker" });
  if (path === "/metrics") return new Response("Not found", { status: 404 });
  const required = ["DATABASE_URL", "CUMULUS_KMS_MASTER_KEY", "CUMULUS_BOOTSTRAP_TOKEN", "CUMULUS_SHARE_SECRET", "CUMULUS_SUPABASE_URL", "CUMULUS_SUPABASE_SECRET_KEY"];
  if (required.some((name) => !env[name])) {
    return Response.json({ error: { code: "NotConfigured", message: "Drive configuration is incomplete" } }, { status: 503 });
  }
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  try {
    const config = loadConfig(env);
    const masterKey = parseMasterKey(env.CUMULUS_KMS_MASTER_KEY);
    await client.connect();
    const query = async (sql, values = []) => {
      const qualified = sql.replaceAll(/\b(tenants|objects|shares)\b/g, "cumulus.$1");
      return (await client.query(qualified, values)).rows;
    };
    const transaction = async (fn) => {
      await query("begin");
      try {
        // Serialize quota changes across isolates and tenants sharing the cap.
        await query("select pg_advisory_xact_lock(764903122)");
        const result = await fn(query);
        await query("commit");
        return result;
      } catch (error) {
        await query("rollback");
        throw error;
      }
    };
    const db = repository(query, transaction, async () => {}, "postgres");
    const storage = createSupabaseDriver({ url: env.CUMULUS_SUPABASE_URL, secretKey: env.CUMULUS_SUPABASE_SECRET_KEY });
    const metrics = createMetrics();
    const drive = createDrive({ db, storage, masterKey, shareSecret: env.CUMULUS_SHARE_SECRET,
      publicBaseUrl: config.publicBaseUrl, metrics, limits: { maxFileBytes: WORKER_MAX_FILE_BYTES } });
    const verifier = createKeycloakVerifier({ issuer: config.issuer, audience: config.audience, jwksUrl: config.jwksUrl });
    return await handleFetch(request, createHandler(drive, { verifier, bootstrapToken: env.CUMULUS_BOOTSTRAP_TOKEN, metrics, corsOrigins: config.corsOrigins }));
  } catch {
    console.error(JSON.stringify({ service: "cumulus-drive", event: "request_failed" }));
    return Response.json({ error: { code: "Unavailable", message: "Drive is temporarily unavailable" } }, { status: 503 });
  } finally {
    await client.end().catch(() => {});
  }
}
