import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sealContent, deriveDriveKey } from "./seal.ts";

const blobRoot = await mkdtemp(path.join(tmpdir(), "cumulus-blob-parity-"));
const pgliteDir = await mkdtemp(path.join(tmpdir(), "cumulus-pg-parity-"));
const password = "test-password-1";
const emailA = "demo.cara@cumuluscloud.app";
const emailB = "demo.dina@cumuluscloud.app";

process.env.CUMULUS_BLOB_ROOT = blobRoot;
process.env.CUMULUS_PGLITE_DIR = pgliteDir;
process.env.BETTER_AUTH_SECRET = "drive-parity-secret-value-32-chars";
process.env.CUMULUS_DRIVE_QUOTA_BYTES = "20000";
process.env.CUMULUS_DRIVE_MAX_OBJECT_BYTES = "8000";
process.env.CUMULUS_DRIVE_STALE_MS = "900000";
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
delete process.env.GROK_PROJECT_ID;

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

function authed(url: string, cookie: string, method = "GET", body?: BodyInit, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { cookie, ...headers },
    body,
  });
}

test("folders, trash, versions, shares, grants, chunks, and sealed files", async () => {
  const { auth } = await import("@/lib/auth/server");
  const { getSql } = await import("@/lib/db");
  const http = await import("@/lib/drive/http");
  const ops = await import("@/lib/drive/http-parity");
  const { closeDrive } = await import("@/lib/drive/service");
  await getSql();
  const headers = new Headers({ origin: "http://localhost:8080" });
  const signA = await auth.api.signUpEmail({
    body: { email: emailA, password, name: "Cara" },
    asResponse: true,
    headers,
  });
  const signB = await auth.api.signUpEmail({
    body: { email: emailB, password, name: "Dina" },
    asResponse: true,
    headers,
  });
  assert.equal(signA.status, 200);
  assert.equal(signB.status, 200);
  const cookieA = cookieHeader(signA);
  const cookieB = cookieHeader(signB);

  const folder = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "folder", name: "Photos" })),
  );
  assert.equal(folder.status, 201, await folder.clone().text());
  const folderBody = (await folder.json()) as { id: string };
  const uploaded = await http.postObject(
    authed("http://localhost:8080/api/drive/objects", cookieA, "POST", "pixel", {
      "content-type": "text/plain",
      "idempotency-key": randomUUID(),
      "x-display-name": "cat.txt",
      "x-folder-id": folderBody.id,
      "x-preview-class": "image",
    }),
  );
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const file = (await uploaded.json()) as { id: string; previewClass: string | null };
  assert.equal(file.previewClass, "image");

  const root = await http.getObjects(authed("http://localhost:8080/api/drive/objects?folder=", cookieA));
  const rootBody = (await root.json()) as { objects: { id: string }[]; folders: { id: string }[]; quota: { bytesStored: number } };
  assert.equal(rootBody.objects.some((item) => item.id === file.id), false);
  assert.equal(rootBody.folders.some((item) => item.id === folderBody.id), true);
  assert.ok(rootBody.quota.bytesStored > 0);

  const inside = await http.getObjects(authed(`http://localhost:8080/api/drive/objects?folder=${folderBody.id}`, cookieA));
  const insideBody = (await inside.json()) as { objects: { id: string }[] };
  assert.equal(insideBody.objects.some((item) => item.id === file.id), true);

  const photos = await http.getObjects(authed("http://localhost:8080/api/drive/objects?view=photos", cookieA));
  assert.equal(((await photos.json()) as { objects: { id: string }[] }).objects.some((item) => item.id === file.id), true);
  const found = await http.getObjects(authed("http://localhost:8080/api/drive/objects?q=cat", cookieA));
  assert.equal(((await found.json()) as { objects: { id: string }[] }).objects.some((item) => item.id === file.id), true);

  const starred = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "star", id: file.id, starred: true })),
  );
  assert.equal(starred.status, 200);
  const stars = await http.getObjects(authed("http://localhost:8080/api/drive/objects?view=starred", cookieA));
  assert.equal(((await stars.json()) as { objects: { id: string }[] }).objects.some((item) => item.id === file.id), true);

  const revised = await http.postObject(
    authed("http://localhost:8080/api/drive/objects", cookieA, "POST", "pixel-2", {
      "content-type": "text/plain",
      "idempotency-key": randomUUID(),
      "x-display-name": "cat.txt",
      "x-version-of": file.id,
      "x-preview-class": "image",
    }),
  );
  assert.equal(revised.status, 201, await revised.clone().text());
  const revision = (await revised.json()) as { id: string };
  const history = await ops.driveOps(authed(`http://localhost:8080/api/drive/ops?op=versions&id=${revision.id}`, cookieA));
  const versions = ((await history.json()) as { versions: { id: string; isCurrent: boolean }[] }).versions;
  assert.equal(versions.length, 2);
  assert.equal(versions.some((item) => item.id === file.id && item.isCurrent === false), true);
  const restored = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "restore-version", id: file.id })),
  );
  assert.equal(restored.status, 200);
  const current = await http.getObject(authed(`http://localhost:8080/api/drive/objects/${file.id}`, cookieA), file.id);
  assert.equal(await current.text(), "pixel");

  const trashed = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "trash", id: file.id })),
  );
  assert.equal(trashed.status, 200);
  const active = await http.getObjects(authed("http://localhost:8080/api/drive/objects", cookieA));
  assert.equal(((await active.json()) as { objects: { id: string }[] }).objects.some((item) => item.id === file.id), false);
  const trash = await http.getObjects(authed("http://localhost:8080/api/drive/objects?view=trash", cookieA));
  assert.equal(((await trash.json()) as { objects: { id: string }[] }).objects.some((item) => item.id === file.id), true);
  const back = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "restore", id: file.id })),
  );
  assert.equal(back.status, 200);

  const shared = await http.postShare(
    authed(
      "http://localhost:8080/api/drive/objects/" + file.id + "/shares",
      cookieA,
      "POST",
      JSON.stringify({ consent: true, expiresInSeconds: 3600, password: "share-secret", maxDownloads: 1 }),
      { "content-type": "application/json" },
    ),
    file.id,
  );
  assert.equal(shared.status, 201, await shared.clone().text());
  const share = (await shared.json()) as { token: string; hasPassword: boolean; maxDownloads: number };
  assert.equal(share.hasPassword, true);
  assert.equal(share.maxDownloads, 1);
  const denied = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", { headers: { authorization: `Bearer ${share.token}` } }),
  );
  assert.equal(denied.status, 401);
  const allowed = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", {
      headers: { authorization: `Bearer ${share.token}`, "x-share-password": "share-secret" },
    }),
  );
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "pixel");
  const limited = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", {
      headers: { authorization: `Bearer ${share.token}`, "x-share-password": "share-secret" },
    }),
  );
  assert.equal(limited.status, 403);

  const identity = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "identity", cid: "cid_cara" })),
  );
  assert.equal(identity.status, 200);
  const grant = await ops.driveOps(
    authed(
      "http://localhost:8080/api/drive/ops",
      cookieA,
      "POST",
      JSON.stringify({ op: "grant", objectId: file.id, grantee: "cid_cara_missing", role: "viewer" }),
    ),
  );
  assert.equal(grant.status, 201);
  const invite = await ops.driveOps(
    authed(
      "http://localhost:8080/api/drive/ops",
      cookieA,
      "POST",
      JSON.stringify({ op: "grant", objectId: revision.id, grantee: emailB, role: "editor" }),
    ),
  );
  assert.equal(invite.status, 201, await invite.clone().text());
  const sharedList = await ops.driveOps(authed("http://localhost:8080/api/drive/ops?op=shared", cookieB));
  const grants = ((await sharedList.json()) as { grants: { objectId: string; role: string }[] }).grants;
  assert.equal(grants.some((item) => item.objectId === revision.id && item.role === "editor"), true);
  const viaGrant = await http.getObject(authed(`http://localhost:8080/api/drive/objects/${revision.id}`, cookieB), revision.id);
  assert.equal(viaGrant.status, 200);
  const editor = await ops.driveOps(
    authed(
      "http://localhost:8080/api/drive/ops",
      cookieB,
      "POST",
      JSON.stringify({
        op: "editor-version",
        objectId: revision.id,
        bytesBase64: Buffer.from("pixel-3").toString("base64"),
        mediaType: "text/plain",
        displayName: "cat.txt",
        idempotencyKey: randomUUID(),
        previewClass: "text",
      }),
    ),
  );
  assert.equal(editor.status, 201, await editor.clone().text());
  const stranger = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieB, "POST", JSON.stringify({ op: "trash", id: file.id })),
  );
  assert.equal(stranger.status, 404);

  const chunk = "hello-chunks";
  const begun = await ops.driveOps(
    authed(
      "http://localhost:8080/api/drive/ops",
      cookieA,
      "POST",
      JSON.stringify({
        op: "upload-begin",
        mediaType: "text/plain",
        displayName: "chunk.txt",
        totalBytes: chunk.length,
        partSize: 6,
        idempotencyKey: randomUUID(),
        previewClass: "text",
      }),
    ),
  );
  assert.equal(begun.status, 201, await begun.clone().text());
  const upload = (await begun.json()) as { uploadId: string; partsExpected: number };
  assert.equal(upload.partsExpected, 2);
  for (const [index, part] of ["hello-", "chunks"].entries()) {
    const written = await ops.driveOps(
      authed(
        "http://localhost:8080/api/drive/ops",
        cookieA,
        "POST",
        JSON.stringify({
          op: "upload-part",
          uploadId: upload.uploadId,
          partNumber: index + 1,
          bytesBase64: Buffer.from(part).toString("base64"),
        }),
      ),
    );
    assert.equal(written.status, 200, await written.clone().text());
  }
  const completed = await ops.driveOps(
    authed("http://localhost:8080/api/drive/ops", cookieA, "POST", JSON.stringify({ op: "upload-complete", uploadId: upload.uploadId })),
  );
  assert.equal(completed.status, 201, await completed.clone().text());
  const chunked = (await completed.json()) as { id: string };
  const chunkBody = await http.getObject(authed(`http://localhost:8080/api/drive/objects/${chunked.id}`, cookieA), chunked.id);
  assert.equal(await chunkBody.text(), chunk);

  const key = await deriveDriveKey(password, emailA, 1_000);
  const sealed = await sealContent(key, new TextEncoder().encode("sealed-body"));
  const sealedName = "cmls1." + "A".repeat(20);
  const sealedUpload = await http.postObject(
    authed("http://localhost:8080/api/drive/objects", cookieA, "POST", Buffer.from(sealed), {
      "content-type": "application/vnd.cumulus.sealed",
      "idempotency-key": randomUUID(),
      "x-display-name": sealedName,
      "x-preview-class": "text",
    }),
  );
  assert.equal(sealedUpload.status, 201, await sealedUpload.clone().text());
  const sealedId = ((await sealedUpload.json()) as { id: string; displayName: string }).id;
  const sealedRead = await http.getObject(authed(`http://localhost:8080/api/drive/objects/${sealedId}`, cookieA), sealedId);
  assert.equal(sealedRead.headers.get("content-type"), "application/vnd.cumulus.sealed");
  const rejected = await http.postObject(
    authed("http://localhost:8080/api/drive/objects", cookieA, "POST", "not-a-seal", {
      "content-type": "application/vnd.cumulus.sealed",
      "idempotency-key": randomUUID(),
      "x-display-name": "bad.seal",
    }),
  );
  assert.equal(rejected.status, 415);

  const handoff = await ops.driveOps(
    authed(
      "http://localhost:8080/api/drive/ops",
      cookieA,
      "POST",
      JSON.stringify({ op: "mail", objectId: chunked.id, consent: true, expiresInSeconds: 3600 }),
    ),
  );
  const handoffBody = (await handoff.json()) as { status: string; channel: string; share: { token: string } };
  assert.equal(handoff.status, 201);
  assert.equal(handoffBody.status, "deferred");
  assert.equal(handoffBody.channel, "cumulus-mail");
  const handed = await http.getShared(
    new Request("http://localhost:8080/api/drive/shared", { headers: { authorization: `Bearer ${handoffBody.share.token}` } }),
  );
  assert.equal(handed.status, 200);

  const security = await ops.driveOps(authed("http://localhost:8080/api/drive/ops?op=security", cookieA));
  const securityBody = (await security.json()) as { twoFactor: string; sync: { status: string }; authority: string };
  assert.equal(securityBody.twoFactor, "deferred");
  assert.equal(securityBody.authority, "id.cumuluscloud.app");
  assert.equal(securityBody.sync.status, "deferred");
  const sessions = await ops.driveOps(authed("http://localhost:8080/api/drive/ops?op=sessions", cookieA));
  const sessionBody = (await sessions.json()) as { sessions: { id: string; token?: string }[] };
  assert.ok(sessionBody.sessions.length > 0);
  assert.equal("token" in sessionBody.sessions[0], false);
  const audit = await ops.driveOps(authed("http://localhost:8080/api/drive/ops?op=audit", cookieA));
  const events = ((await audit.json()) as { events: { action: string }[] }).events;
  assert.equal(events.some((event) => event.action === "upload_stored"), true);
  assert.equal(events.some((event) => event.action === "mail_handoff"), true);

  await closeDrive();
});
