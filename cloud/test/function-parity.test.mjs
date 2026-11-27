import assert from "node:assert/strict";
import { test } from "node:test";
import { ParityError, hashSharePassword, parseParity, sharePasswordMatches, uploadMeta, viewFilter } from "../supabase/functions/drive/parity.ts";

// A plain getter, so values a real Headers object would refuse still reach the parser.
const headers = (entries) => {
  const lower = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
};

test("list views map to PostgREST filters, and unknown views show active files", () => {
  assert.equal(viewFilter(null), "&trashed_at=is.null");
  assert.equal(viewFilter("active"), "&trashed_at=is.null");
  assert.equal(viewFilter("trash"), "&trashed_at=not.is.null");
  assert.equal(viewFilter("starred"), "&trashed_at=is.null&starred=is.true");
  assert.equal(viewFilter("photos"), "&trashed_at=is.null&preview_class=eq.image");
  assert.equal(viewFilter("&select=*"), "&trashed_at=is.null");
});

test("upload metadata keeps well-formed values and drops the rest", () => {
  assert.deepEqual(uploadMeta(headers({})), { contentType: "application/octet-stream", previewClass: null, sealedName: null, keepVersion: false });
  assert.deepEqual(
    uploadMeta(headers({ "content-type": "Image/PNG; charset=binary", "x-cumulus-preview-class": "image", "x-cumulus-sealed-name": "v1:abc_DEF-123==", "x-cumulus-keep-version": "1" })),
    { contentType: "image/png", previewClass: "image", sealedName: "v1:abc_DEF-123==", keepVersion: true },
  );
  const bad = uploadMeta(headers({ "content-type": "text/html\r\nx: y", "x-cumulus-preview-class": "exe", "x-cumulus-sealed-name": "<script>" }));
  assert.deepEqual(bad, { contentType: "application/octet-stream", previewClass: null, sealedName: null, keepVersion: false });
  assert.equal(uploadMeta(headers({ "x-cumulus-sealed-name": "a".repeat(2049) })).sealedName, null);
});

test("parity calls are validated before anything touches the database", () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(parseParity("GET", q("op=activity"), null), { op: "activity" });
  assert.deepEqual(parseParity("GET", q("op=security"), null), { op: "security" });
  assert.throws(() => parseParity("GET", q("op=trash"), null), ParityError);
  assert.deepEqual(parseParity("POST", q(""), { op: "star", bucket: "drive", key: "a.txt", starred: 1 }), { op: "star", bucket: "drive", key: "a.txt", starred: true });
  assert.deepEqual(parseParity("POST", q(""), { op: "star", bucket: "drive", key: "a.txt", starred: 0 }), { op: "star", bucket: "drive", key: "a.txt", starred: false });
  assert.deepEqual(parseParity("POST", q(""), { op: "trash", bucket: "drive", key: "a.txt" }), { op: "trash", bucket: "drive", key: "a.txt" });
  assert.deepEqual(parseParity("POST", q(""), { op: "restore", bucket: "drive", key: "a.txt" }), { op: "restore", bucket: "drive", key: "a.txt" });
  assert.deepEqual(parseParity("POST", q(""), { op: "invite", bucket: "drive", key: "a.txt", cid: "cid_11111111-2222-4333-8444-555555555555", role: "viewer" }), {
    op: "invite",
    bucket: "drive",
    key: "a.txt",
    cid: "cid_11111111-2222-4333-8444-555555555555",
    role: "viewer",
  });
  assert.throws(() => parseParity("POST", q(""), { op: "invite", key: "a.txt", cid: "CID_BAD", role: "viewer" }), (error) => error instanceof ParityError && error.code === "InvalidCid");
  assert.deepEqual(parseParity("POST", q(""), { op: "star", bucket: 5, key: null }), { op: "star", bucket: "", key: "", starred: false });
  assert.deepEqual(parseParity("POST", q(""), { op: "restore-version", bucket: "drive", key: "a.txt", versionId: "ver_0123456789abcdef" }), {
    op: "restore-version",
    bucket: "drive",
    key: "a.txt",
    versionId: "ver_0123456789abcdef",
  });
  assert.throws(() => parseParity("POST", q(""), { op: "restore-version" }), (error) => error instanceof ParityError && error.status === 400);
  assert.throws(() => parseParity("POST", q(""), null), ParityError);
});

test("share passwords match only the same secret", async () => {
  const stored = await hashSharePassword("share-secret");
  assert.equal(stored.startsWith("pbkdf2$"), true);
  assert.equal(stored.includes("share-secret"), false);
  assert.equal(await sharePasswordMatches("share-secret", stored), true);
  assert.equal(await sharePasswordMatches("wrong-secret", stored), false);
  assert.equal(await sharePasswordMatches("", stored), false);
});
