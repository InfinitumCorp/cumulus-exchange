import assert from "node:assert/strict";
import { test } from "node:test";
import { GEO_ROUTING_KEY, readGeoRouting, writeGeoRouting } from "./preference.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

test("geo routing preference defaults off and persists", () => {
  const storage = memory();
  assert.equal(readGeoRouting(null), false);
  assert.equal(readGeoRouting(storage), false);
  writeGeoRouting(storage, true);
  assert.equal(storage.getItem(GEO_ROUTING_KEY), "1");
  assert.equal(readGeoRouting(storage), true);
  writeGeoRouting(storage, false);
  assert.equal(storage.getItem(GEO_ROUTING_KEY), "0");
  assert.equal(readGeoRouting(storage), false);
  writeGeoRouting(null, true);
});
