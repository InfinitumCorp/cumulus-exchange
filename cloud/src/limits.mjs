/**
 * Caps chosen so a later swap onto the Infinitum Corp Supabase free project
 * (1 GB total, 50 MB per file) fits without a rewrite. They are software limits.
 * This process does not connect to that project. Free projects also pause when
 * inactive; that cannot be fixed in code and is a launch risk.
 */
export const LIMITS = {
  projectBytes: 1_000_000_000,
  maxFileBytes: 50_000_000,
  defaultTenantBytes: 1_000_000_000,
  defaultTenantObjects: 10_000,
  pausesWhenInactiveIfSwappedToSupabaseFreePlan: true,
};

export const SUPABASE_PROJECT = {
  name: "Infinitum Corp",
  ref: "ivqiskeziohbbtkcvlun",
  region: "eu-west-1",
  plan: "free",
};
