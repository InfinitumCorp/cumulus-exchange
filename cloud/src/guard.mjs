import { SUPABASE_PROJECT } from "./limits.mjs";

const DENY = ["supabase.co", "supabase.com", SUPABASE_PROJECT.ref, "pooler.supabase"];

/**
 * Hard stop for the known live project. A future swap is a config change plus
 * CUMULUS_ALLOW_SUPABASE=I-understand-this-touches-prod. Tests never set that.
 * @param {string | undefined} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertNotLiveSupabase(value, env = process.env) {
  const text = String(value ?? "").toLowerCase();
  const hit = DENY.find((needle) => text.includes(needle));
  if (!hit) return;
  const allow = env.CUMULUS_ALLOW_SUPABASE === "I-understand-this-touches-prod";
  if (!allow) {
    throw new Error(
      `Refusing live Supabase target (${hit}). Cumulus Drive stays on local disk, local Postgres, or a local container.`,
    );
  }
}

export function assertLoopbackEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("S3 container tests only accept a loopback endpoint");
  }
}
