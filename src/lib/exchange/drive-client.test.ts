import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalReason } from "./drive-client.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("refusal reasons come from either error shape, trimmed and capped", async () => {
  assert.equal(
    await refusalReason(json(501, { error: { code: "NotImplemented", message: "Sharing with another Cumulus ID is not available on this Drive yet; use a share link" } }), "x"),
    "Sharing with another Cumulus ID is not available on this Drive yet; use a share link",
  );
  assert.equal(await refusalReason(json(403, { message: "  Quota\\n reached  " }), "x"), "Quota\\n reached");
  assert.equal(await refusalReason(json(403, { message: "a\n\n b" }), "x"), "a b");
  const long = await refusalReason(json(400, { message: "y".repeat(500) }), "x");
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("unreadable or empty bodies fall back", async () => {
  assert.equal(await refusalReason(new Response("<html>", { status: 502 }), "fallback"), "fallback");
  assert.equal(await refusalReason(json(500, { error: { message: 7 } }), "fallback"), "fallback");
  assert.equal(await refusalReason(json(500, {}), "fallback"), "fallback");
  assert.equal(await refusalReason(new Response(null, { status: 403 }), "fallback"), "fallback");
});
