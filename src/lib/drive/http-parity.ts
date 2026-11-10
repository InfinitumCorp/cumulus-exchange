import { DriveError } from "@/lib/drive/errors";
import { requireDriveUser } from "@/lib/drive/http";
import {
  beginUpload,
  completeUpload,
  createFolder,
  createGrant,
  editorVersion,
  listAudit,
  listFolders,
  listSessions,
  listSharedWithMe,
  listVersions,
  mailHandoff,
  purgeOwned,
  restoreObject,
  restoreVersion,
  revokeGrant,
  revokeSession,
  securityReport,
  setIdentity,
  setStar,
  trashObject,
  writeUploadPart,
} from "@/lib/drive/parity";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(err: unknown): Response {
  if (err instanceof DriveError) return json(err.status, { error: err.code, message: err.message });
  console.error("[drive]", err);
  return json(500, { error: "store_failed", message: "store_failed" });
}

function sessionToken(cookie: string | null): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name?.includes("session_token") || name?.endsWith(".session_token")) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export async function driveOps(request: Request): Promise<Response> {
  try {
    const owner = await requireDriveUser(request);
    const url = new URL(request.url);
    const op = url.searchParams.get("op") ?? "";
    if (request.method === "GET") {
      if (op === "folders") {
        return json(200, {
          folders: await listFolders(owner, {
            trash: url.searchParams.get("view") === "trash",
            rooted: url.searchParams.has("parent"),
            parentId: url.searchParams.get("parent") || null,
          }),
        });
      }
      if (op === "versions") return json(200, { versions: await listVersions(owner, url.searchParams.get("id") ?? "") });
      if (op === "shared") return json(200, { grants: await listSharedWithMe(owner) });
      if (op === "audit") return json(200, { events: await listAudit(owner) });
      if (op === "sessions") return json(200, { sessions: await listSessions(owner, sessionToken(request.headers.get("cookie"))) });
      if (op === "security") return json(200, securityReport());
      throw new DriveError(404, "not_found");
    }
    if (request.method !== "POST") throw new DriveError(405, "method_not_allowed");
    const raw = await request.text();
    if (raw.length > 2_000_000) throw new DriveError(413, "too_large");
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    const action = typeof body.op === "string" ? body.op : op;
    if (action === "folder") {
      return json(201, await createFolder(owner, String(body.name ?? ""), typeof body.parentId === "string" ? body.parentId : null));
    }
    if (action === "trash") {
      await trashObject(owner, String(body.id ?? ""));
      return json(200, { trashed: body.id });
    }
    if (action === "restore") {
      await restoreObject(owner, String(body.id ?? ""));
      return json(200, { restored: body.id });
    }
    if (action === "purge") {
      await purgeOwned(owner, String(body.id ?? ""));
      return json(200, { deleted: body.id });
    }
    if (action === "star") {
      await setStar(owner, String(body.id ?? ""), body.starred === true);
      return json(200, { starred: body.starred === true });
    }
    if (action === "versions") return json(200, { versions: await listVersions(owner, String(body.id ?? "")) });
    if (action === "restore-version") {
      await restoreVersion(owner, String(body.id ?? ""));
      return json(200, { restored: body.id });
    }
    if (action === "grant") {
      return json(201, await createGrant({
        userId: owner,
        objectId: typeof body.objectId === "string" ? body.objectId : null,
        folderId: typeof body.folderId === "string" ? body.folderId : null,
        grantee: String(body.grantee ?? ""),
        role: String(body.role ?? ""),
      }));
    }
    if (action === "revoke-grant") {
      await revokeGrant(owner, String(body.id ?? ""));
      return json(200, { revoked: body.id });
    }
    if (action === "identity") return json(200, await setIdentity(owner, String(body.cid ?? "")));
    if (action === "mail") {
      return json(201, await mailHandoff({
        userId: owner,
        objectId: String(body.objectId ?? ""),
        consent: body.consent === true,
        expiresInSeconds: Number(body.expiresInSeconds),
      }));
    }
    if (action === "upload-begin") {
      return json(201, await beginUpload({
        userId: owner,
        mediaType: String(body.mediaType ?? ""),
        displayName: String(body.displayName ?? ""),
        totalBytes: Number(body.totalBytes),
        partSize: Number(body.partSize),
        idempotencyKey: String(body.idempotencyKey ?? ""),
        folderId: typeof body.folderId === "string" ? body.folderId : null,
        versionOf: typeof body.versionOf === "string" ? body.versionOf : null,
        previewClass: typeof body.previewClass === "string" ? body.previewClass : null,
      }));
    }
    if (action === "upload-part") {
      const bytes = Buffer.from(String(body.bytesBase64 ?? ""), "base64");
      await writeUploadPart({
        userId: owner,
        uploadId: String(body.uploadId ?? ""),
        partNumber: Number(body.partNumber),
        bytes,
      });
      return json(200, { stored: true });
    }
    if (action === "upload-complete") return json(201, await completeUpload(owner, String(body.uploadId ?? "")));
    if (action === "editor-version") {
      const bytes = Buffer.from(String(body.bytesBase64 ?? ""), "base64");
      return json(201, await editorVersion({
        userId: owner,
        objectId: String(body.objectId ?? ""),
        bytes,
        mediaType: String(body.mediaType ?? "text/plain"),
        displayName: String(body.displayName ?? "file"),
        idempotencyKey: String(body.idempotencyKey ?? ""),
        previewClass: typeof body.previewClass === "string" ? body.previewClass : null,
      }));
    }
    if (action === "security") return json(200, securityReport());
    throw new DriveError(404, "not_found");
  } catch (err) {
    if (err instanceof SyntaxError) return json(400, { error: "bad_json", message: "bad_json" });
    return fail(err);
  }
}
