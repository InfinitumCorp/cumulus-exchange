import assert from "node:assert/strict";
import { test } from "node:test";
import { ParityError, parseParity, uploadMeta, viewFilter } from "../supabase/functions/drive/parity.ts";

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
  assert.deepEqual(uploadMeta(headers({})), { contentType: "application/octet-stream", previewClass: null, sealedName: null });
  assert.deepEqual(
    uploadMeta(headers({ "content-type": "Image/PNG; charset=binary", "x-cumulus-preview-class": "image", "x-cumulus-sealed-name": "v1:abc_DEF-123==" })),
    { contentType: "image/png", previewClass: "image", sealedName: "v1:abc_DEF-123==" },
  );
  const bad = uploadMeta(headers({ "content-type": "text/html\r\nx: y", "x-cumulus-preview-class": "exe", "x-cumulus-sealed-name": "<script>" }));
  assert.deepEqual(bad, { contentType: "application/octet-stream", previewClass: null, sealedName: null });
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
  assert.deepEqual(parseParity("POST", q(""), { op: "invite", key: "a.txt" }), { op: "invite" });
  assert.deepEqual(parseParity("POST", q(""), { op: "star", bucket: 5, key: null }), { op: "star", bucket: "", key: "", starred: false });
  assert.throws(() => parseParity("POST", q(""), { op: "restore-version" }), (error) => error instanceof ParityError && error.status === 404);
  assert.throws(() => parseParity("POST", q(""), null), ParityError);
});
