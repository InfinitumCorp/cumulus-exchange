import { Pool, type PoolConfig } from "pg";

/**
 * True inside the Cloudflare Workers runtime (the cumulus-cloud Worker build,
 * `NITRO_PRESET=cloudflare-module`). Workers set this exact user agent.
 */
export function isWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/**
 * Pool options for the current runtime.
 *
 * On Workers a socket opened while handling one request cannot be awaited from
 * another: the runtime cancels the second request as hung. A long-lived pool
 * would hand an earlier request's connection to the next one, so there every
 * connection is used once and closed when it is released. Point DATABASE_URL at
 * a transaction-mode pooler (Supabase's port 6543) so short connections are
 * cheap. Elsewhere the defaults are unchanged.
 */
export function pgPoolOptions(connectionString: string): PoolConfig {
  if (!isWorkersRuntime()) return { connectionString };
  return { connectionString, maxUses: 1, idleTimeoutMillis: 1, max: 5 };
}

export function createPgPool(connectionString: string): Pool {
  return new Pool(pgPoolOptions(connectionString));
}
