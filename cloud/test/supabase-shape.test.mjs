import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("tenant writes are revoked and the access token hook is not installed", async () => {
  const sql = await readFile(new URL("supabase/migrations/20261108120000_tenant_rls_and_bucket.sql", root), "utf8");
  const config = await readFile(new URL("supabase/config.toml", root), "utf8");
  const fn = await readFile(new URL("supabase/functions/drive/index.ts", root), "utf8");
  assert.match(sql, /revoke insert, update, delete on table cumulus\.tenants from anon, authenticated/);
  assert.match(sql, /for select to authenticated/);
  assert.match(sql, /drop function if exists public\.custom_access_token_hook/);
  assert.match(sql, /from cumulus\.identities where user_id/);
  assert.match(sql, /values \('cumulus-drive', 'cumulus-drive', false, 50000000\)/);
  assert.equal(/create policy[^;]*on storage\.objects/i.test(sql), false);
  assert.equal(config.includes("custom_access_token_hook"), false);
  assert.equal(config.includes("[auth.hook.custom_access_token]"), false);
  assert.equal(config.includes("[storage.buckets.cumulus-drive]"), false);
  assert.match(fn, /\/identities\?user_id=eq\./);
  assert.equal(fn.includes("payload.app_metadata"), false);
});
