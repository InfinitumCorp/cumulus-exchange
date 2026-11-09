import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTrustedOrigins, CANONICAL_ORIGIN, PROPOSED_HOSTS } from "./origins.ts";

const local = ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"];

test("canonical origin is exact and localhost stays allowed", () => {
  const origins = buildTrustedOrigins({
    previewHosts: ["*.grok-sandbox.com"],
    localOrigins: local,
  });
  assert.equal(origins.includes(CANONICAL_ORIGIN), true);
  assert.equal(origins.includes("http://localhost:8080"), true);
  assert.equal(origins.some((origin) => origin.includes("*.cumuluscloud.app")), false);
  for (const host of Object.values(PROPOSED_HOSTS)) {
    assert.equal(origins.some((origin) => origin.includes(host)), false);
  }
});

test("an explicit public URL does not add proposed subdomains", () => {
  const origins = buildTrustedOrigins({
    explicitBaseURL: CANONICAL_ORIGIN,
    previewHosts: ["*.grok-sandbox.com"],
    localOrigins: local,
  });
  assert.deepEqual(origins, [CANONICAL_ORIGIN, ...local]);
});
