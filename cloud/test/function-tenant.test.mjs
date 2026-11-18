import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FREE_MAX_BYTES, DEFAULT_FREE_MAX_OBJECTS, newTenantRow } from "../supabase/functions/drive/tenant.ts";

const CID = "cid_4f6c1b2e-8d1a-4c3b-9e2f-0a1b2c3d4e5f";
const NOW = new Date("2026-11-13T21:00:00.000Z");

test("a first-use tenant gets the free quota and is keyed by the cid", () => {
  const row = newTenantRow(CID, {}, "0123456789abcdef01234567", NOW);
  assert.deepEqual(row, {
    id: "tn_0123456789abcdef01234567",
    name: CID,
    cid: CID,
    max_bytes: DEFAULT_FREE_MAX_BYTES,
    max_objects: DEFAULT_FREE_MAX_OBJECTS,
    used_bytes: 0,
    used_objects: 0,
    created_at: "2026-11-13T21:00:00.000Z",
  });
  assert.equal(DEFAULT_FREE_MAX_BYTES, 104857600);
});

test("the free quota is configurable and must be a positive integer", () => {
  const row = newTenantRow(CID, { maxBytes: "5000000", maxObjects: "50" }, "ab".repeat(12), NOW);
  assert.equal(row.max_bytes, 5000000);
  assert.equal(row.max_objects, 50);
  assert.equal(newTenantRow(CID, { maxBytes: " " }, "ab".repeat(12), NOW).max_bytes, DEFAULT_FREE_MAX_BYTES);
  for (const bad of ["0", "-1", "1.5", "lots"]) {
    assert.throws(() => newTenantRow(CID, { maxBytes: bad }, "ab".repeat(12), NOW));
  }
  assert.throws(() => newTenantRow(CID, {}, "short", NOW));
});
