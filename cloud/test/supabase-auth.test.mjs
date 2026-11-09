import assert from "node:assert/strict";
import { test } from "node:test";
import { cidFromSupabasePayload, createKeycloakVerifier } from "../src/auth.mjs";
import { HttpError } from "../src/errors.mjs";

test("supabase cid comes from app_metadata", () => {
  const principal = cidFromSupabasePayload({
    sub: "user-1",
    app_metadata: { cid: "cid_ada" },
  });
  assert.equal(principal.cid, "cid_ada");
  assert.equal(principal.sub, "user-1");
  assert.deepEqual(principal.purposes, ["drive.read", "drive.write", "drive.share"]);
});

test("supabase token without a cid is rejected", () => {
  assert.throws(
    () => cidFromSupabasePayload({ sub: "user-1", app_metadata: {} }),
    (error) => error instanceof HttpError && error.status === 401 && error.code === "InvalidToken",
  );
});

test("keycloak verifier is still the other auth mode", () => {
  assert.equal(typeof createKeycloakVerifier, "function");
});
