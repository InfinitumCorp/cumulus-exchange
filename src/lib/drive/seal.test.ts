import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveDriveKey, isSealedName, openContent, openName, sealContent, sealName } from "./seal.ts";
import { magicMatches } from "./magic.ts";
import { nameMatches, previewClassFor } from "./preview-class.ts";
import { accountSecurityStatus } from "./account-security.ts";
import { syncDesign } from "./sync-design.ts";

test("client seal round-trips bytes and names and rejects a different key", async () => {
  const key = await deriveDriveKey("correct horse battery", "ada@cumuluscloud.app", 1_000);
  const other = await deriveDriveKey("other secret phrase", "ada@cumuluscloud.app", 1_000);
  const plain = new TextEncoder().encode("quarterly-notes");
  const sealed = await sealContent(key, plain);
  assert.equal(magicMatches("application/vnd.cumulus.sealed", sealed), true);
  assert.deepEqual(await openContent(key, sealed), plain);
  await assert.rejects(openContent(other, sealed));
  const tampered = new Uint8Array(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(openContent(key, tampered));
  const stored = await sealName(key, "Q3 plan.pdf");
  assert.equal(isSealedName(stored), true);
  assert.equal(stored.includes("Q3"), false);
  assert.equal(await openName(key, stored), "Q3 plan.pdf");
});

test("preview class, search, and deferred account controls stay explicit", () => {
  assert.equal(previewClassFor("image/png"), "image");
  assert.equal(previewClassFor("video/mp4"), "video");
  assert.equal(previewClassFor("text/plain", "today.note"), "note");
  assert.equal(nameMatches("Budget", "bud"), true);
  assert.equal(nameMatches("Budget", "zzz"), false);
  const mp4 = new Uint8Array(16);
  mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
  assert.equal(magicMatches("video/mp4", mp4), true);
  assert.equal(magicMatches("video/webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00])), true);
  assert.equal(accountSecurityStatus().twoFactor, "deferred");
  assert.equal(accountSecurityStatus().securityKeys, "deferred");
  assert.equal(accountSecurityStatus().authority, "id.cumuluscloud.app");
  assert.equal(syncDesign().status, "deferred");
});
