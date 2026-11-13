import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkersRuntime, pgPoolOptions } from "./pg-pool.ts";

const URL_ = "postgres://u:p@127.0.0.1:6543/postgres";

function withUserAgent<T>(userAgent: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test("Node keeps the default long-lived pool", () => {
  assert.equal(isWorkersRuntime(), false);
  assert.deepEqual(pgPoolOptions(URL_), { connectionString: URL_ });
});

test("Cloudflare Workers use each connection once, so no socket outlives its request", () => {
  const options = withUserAgent("Cloudflare-Workers", () => pgPoolOptions(URL_));
  assert.equal(options.connectionString, URL_);
  assert.equal(options.maxUses, 1);
  assert.ok((options.idleTimeoutMillis ?? 0) <= 1);
});
