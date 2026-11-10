// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex } from "./match.mjs";
import { fixtureGeoIpBytes, fixtureGeoSiteBytes } from "./fixtures.mjs";
import {
  annotateAuditDetail,
  annotateLogFields,
  applyGeoHook,
  geoPolicy,
  isGeoEnabled,
} from "./hook.mjs";

const index = buildIndex(fixtureGeoIpBytes(), fixtureGeoSiteBytes());
const hint = { ip: "1.2.3.4", domain: "www.google.com" };

test("INFINITUM_GEO_ENABLED defaults off", () => {
  assert.equal(isGeoEnabled({}), false);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: "" }), false);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: "0" }), false);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: "false" }), false);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: "off" }), false);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: "1" }), true);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: "true" }), true);
  assert.equal(isGeoEnabled({ INFINITUM_GEO_ENABLED: " YES " }), true);
});

test("policy, audit annotation, and logs stay unchanged when geo routing is off", () => {
  const fields = { err: "disk failed" };
  assert.deepEqual(geoPolicy(hint, index, false), { allow: true, annotation: null });
  assert.equal(annotateAuditDetail("kept the grant", hint, index, false), "kept the grant");
  assert.equal(annotateLogFields(fields, hint, index, false), fields);
  assert.equal(applyGeoHook(fields, hint, null), fields);
  assert.equal(applyGeoHook(fields, hint, { enabled: false, index }), fields);
  assert.equal(applyGeoHook(fields, hint, { enabled: true, index: null }), fields);
});

test("an enabled hook records country and category without denying the subject", () => {
  const policy = geoPolicy(hint, index, true);
  assert.equal(policy.allow, true);
  assert.equal(policy.annotation, "country CN; categories google");
  assert.equal(
    annotateAuditDetail("kept the grant", hint, index, true),
    "kept the grant (country CN; categories google)",
  );
  const fields = { err: "disk failed" };
  const annotated = annotateLogFields(fields, hint, index, true);
  assert.notEqual(annotated, fields);
  assert.equal(annotated.err, "disk failed");
  assert.equal(annotated.geoCountry, "CN");
  assert.deepEqual(annotated.geoCategories, ["google"]);
  assert.equal(annotated.geoAnnotation, "country CN; categories google");
  assert.equal(Object.hasOwn(fields, "geoCountry"), false);
});
