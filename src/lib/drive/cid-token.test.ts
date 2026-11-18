import assert from "node:assert/strict";
import { test } from "node:test";
import { cidDriveToken, type CidTokenApi } from "./cid-token.ts";

const request = () => new Request("https://cloud.cumuluscloud.app/api/drive/cid-token", { headers: { cookie: "session=1" } });

function api(overrides: Partial<CidTokenApi> & { calls?: string[] } = {}): CidTokenApi & { calls: string[] } {
  const calls = overrides.calls ?? [];
  return {
    calls,
    getSession: overrides.getSession ?? (async () => ({ user: { id: "u1" } })),
    listUserAccounts: overrides.listUserAccounts ?? (async () => [{ id: "acc1", providerId: "cumulus-id" }]),
    getAccessToken:
      overrides.getAccessToken ??
      (async ({ body }) => {
        calls.push(body.accountId);
        return { accessToken: `tok-${body.accountId}`, accessTokenExpiresAt: new Date("2026-11-13T23:00:00.000Z") };
      }),
  };
}

async function read(response: Response) {
  return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
}

test("not configured: 404, and Better Auth is never asked", async () => {
  const deps = api({ getSession: async () => { throw new Error("must not be called"); } });
  const res = await read(await cidDriveToken(request(), { api: deps, configured: false }));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "NotConfigured");
});

test("no session, or a session lookup that throws: 401 SignInRequired", async () => {
  for (const getSession of [async () => null, async () => { throw new Error("db down"); }]) {
    const res = await read(await cidDriveToken(request(), { api: api({ getSession }), configured: true }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "SignInRequired");
    assert.equal(res.cache, "no-store");
  }
});

test("returns the Cumulus ID token with its expiry, uncached", async () => {
  const res = await read(await cidDriveToken(request(), { api: api(), configured: true }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { token: "tok-acc1", expiresAt: "2026-11-13T23:00:00.000Z" });
  assert.equal(res.cache, "no-store");
});

test("only Cumulus ID accounts are used; another provider's token is never returned", async () => {
  const calls: string[] = [];
  const deps = api({
    calls,
    listUserAccounts: async () => [
      { id: "gate1", providerId: "grok-gate" },
      { id: "cid2", providerId: "cumulus-id-create" },
    ],
  });
  const res = await read(await cidDriveToken(request(), { api: deps, configured: true }));
  assert.deepEqual(calls, ["cid2"]);
  assert.equal(res.body.token, "tok-cid2");
});

test("an account whose token cannot be refreshed is skipped for the next one", async () => {
  const calls: string[] = [];
  const deps = api({
    calls,
    listUserAccounts: async () => [
      { id: "old", providerId: "cumulus-id" },
      { id: "new", providerId: "cumulus-id" },
    ],
    getAccessToken: async ({ body }) => {
      calls.push(body.accountId);
      if (body.accountId === "old") throw new Error("refresh refused");
      return { accessToken: "tok-new", accessTokenExpiresAt: null };
    },
  });
  const res = await read(await cidDriveToken(request(), { api: deps, configured: true }));
  assert.deepEqual(calls, ["old", "new"]);
  assert.deepEqual(res.body, { token: "tok-new", expiresAt: null });
});

test("no usable token on any account: 401 SignInAgain", async () => {
  for (const deps of [
    api({ listUserAccounts: async () => [] }),
    api({ listUserAccounts: async () => { throw new Error("db down"); } }),
    api({ getAccessToken: async () => ({ accessToken: "" }) }),
    api({ getAccessToken: async () => { throw new Error("expired"); } }),
    api({ listUserAccounts: async () => [{ id: "g", providerId: "grok-gate" }] }),
  ]) {
    const res = await read(await cidDriveToken(request(), { api: deps, configured: true }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "SignInAgain");
  }
});
