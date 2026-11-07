import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupabaseDriver } from "../src/supabase-storage.mjs";

test("private Supabase storage preserves bytes and uses scoped remove requests", async () => {
  const calls = [];
  const bytes = Buffer.from([0, 255, 128, 42]);
  const driver = createSupabaseDriver({
    url: "https://example.supabase.co",
    secretKey: "sb_secret_test",
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return new Response(options.method === "GET" ? bytes : "{}", { status: 200 });
    },
  });
  const id = "ab".repeat(16);
  await driver.put("tn_owner", id, bytes);
  assert.deepEqual(await driver.get("tn_owner", id), bytes);
  await driver.delete("tn_owner", id);
  assert.equal(calls[0].headers.apikey, "sb_secret_test");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].url, `https://example.supabase.co/storage/v1/object/cumulus-drive/tenants/tn_owner/${id}`);
  assert.deepEqual(JSON.parse(calls[2].body), { prefixes: [`tenants/tn_owner/${id}`] });
  assert.equal(calls[2].url, "https://example.supabase.co/storage/v1/object/cumulus-drive");
  await assert.rejects(driver.get("../other", id), /Unsafe/);
  assert.equal(calls.length, 3);
});

test("storage errors do not leak response bodies or credentials", async () => {
  const driver = createSupabaseDriver({
    url: "https://example.supabase.co", secretKey: "private",
    fetch: async () => new Response("sensitive backend detail", { status: 403 }),
  });
  await assert.rejects(driver.get("tn_owner", "ab".repeat(16)), /^Error: Supabase storage GET failed \(403\)$/);
  assert.throws(() => createSupabaseDriver({ url: "http://example.com", secretKey: "private" }), /HTTPS origin/);
  assert.throws(() => createSupabaseDriver({ url: "https://example.com" }), /required/);
});
