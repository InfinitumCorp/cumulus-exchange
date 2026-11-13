/**
 * A first-use tenant row for a verified Cumulus ID (cid mode only).
 *
 * People sign in with Cumulus ID and get a Drive without an operator inserting
 * `cumulus.tenants` by hand. The free quota matches the console's session-store
 * Drive default (100 MiB, `src/lib/drive/config.ts`). Paid plans raise
 * `max_bytes` on the same row. `name` is the cid so the unique constraints on
 * `name` and `cid` both hold, and a second concurrent insert for the same cid
 * is ignored rather than creating a second tenant.
 *
 * Erasable TypeScript only: Node runs it with type stripping in the tests.
 */

export const DEFAULT_FREE_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_FREE_MAX_OBJECTS = 10_000;

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Tenant quota settings must be positive integers");
  return parsed;
}

export type TenantRow = {
  id: string;
  name: string;
  cid: string;
  max_bytes: number;
  max_objects: number;
  used_bytes: number;
  used_objects: number;
  created_at: string;
};

export function newTenantRow(
  cid: string,
  env: { maxBytes?: string; maxObjects?: string },
  randomHex: string,
  now: Date,
): TenantRow {
  if (!/^[0-9a-f]{16,}$/.test(randomHex)) throw new Error("Tenant id needs random hex");
  return {
    id: `tn_${randomHex.slice(0, 24)}`,
    name: cid,
    cid,
    max_bytes: positive(env.maxBytes, DEFAULT_FREE_MAX_BYTES),
    max_objects: positive(env.maxObjects, DEFAULT_FREE_MAX_OBJECTS),
    used_bytes: 0,
    used_objects: 0,
    created_at: now.toISOString(),
  };
}
