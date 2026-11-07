import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, tokenFor } from "./helpers.mjs";
import { handleFetch } from "../src/fetch-handler.mjs";
import { fetchDrive } from "../src/worker.mjs";

test("Fetch bridge preserves JWT auth, tenant isolation, bytes, and empty deletes", async (t) => {
  const fx = await fixture(t);
  const invoke = (path, init) => handleFetch(new Request(`https://cloud.cumuluscloud.app${path}`, init), fx.app.handle);
  for (const name of ["alpha", "beta"]) {
    const created = await invoke("/v1/tenants", { method: "POST", headers: { authorization: `Bearer ${fx.bootstrapToken}` },
      body: JSON.stringify({ name, cid: `cid_${name}` }) });
    assert.equal(created.status, 201);
  }
  const token = await tokenFor(fx.keys.privateKey, "cid_alpha", ["drive.write"]);
  const headers = { authorization: `Bearer ${token}`, "x-cumulus-purpose": "drive.write" };
  const payload = new Uint8Array([0, 1, 255, 128]);
  assert.equal((await invoke("/v1/objects/files/binary", { method: "PUT", headers, body: payload })).status, 200);
  const read = await invoke("/v1/objects/files/binary", { headers });
  assert.equal(read.status, 200);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), payload);
  const other = await tokenFor(fx.keys.privateKey, "cid_beta", ["drive.read"]);
  assert.equal((await invoke("/v1/objects/files/binary", { headers: { authorization: `Bearer ${other}`, "x-cumulus-purpose": "drive.read" } })).status, 404);
  assert.equal((await invoke("/v1/objects/files/binary")).status, 401);
  const deleted = await invoke("/v1/objects/files/binary", { method: "DELETE", headers });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  const preflight = await invoke("/v1/usage", { method: "OPTIONS", headers: { origin: "https://cloud.cumuluscloud.app" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://cloud.cumuluscloud.app");
});

test("Worker health and missing configuration never open unauthenticated storage", async () => {
  assert.equal((await fetchDrive(new Request("https://cloud.cumuluscloud.app/healthz"), {})).status, 200);
  const response = await fetchDrive(new Request("https://cloud.cumuluscloud.app/v1/usage"), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "NotConfigured");
});
