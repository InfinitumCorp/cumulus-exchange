import { auth, authConfigured } from "@/lib/auth/server";
import { DEV_USER_ID } from "@/lib/auth/verify.server";
import { DriveError } from "@/lib/drive/errors";
import { acceptDisplayName, sanitizeDisplayName } from "@/lib/drive/magic";
import { isPreviewClass } from "@/lib/drive/preview-class";
import { listFolders } from "@/lib/drive/parity";
import {
  createShare,
  deleteObject,
  listObjects,
  listShares,
  quotaFor,
  readObject,
  readShared,
  revokeShare,
  uploadObject,
  type ListFilter,
} from "@/lib/drive/service";

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

function assertRequest(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (!site || site === "same-origin" || site === "none") return;
  const dest = request.headers.get("sec-fetch-dest");
  const top =
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.method === "GET" &&
    dest !== "object" &&
    dest !== "embed";
  if (top) return;
  throw new DriveError(403, "cross_site");
}

async function userId(request: Request): Promise<string> {
  assertRequest(request);
  if (!authConfigured) throw new DriveError(401, "unauthorized");
  const session = await auth.api.getSession({ headers: request.headers });
  const id = session?.user?.id;
  if (!id || id === DEV_USER_ID) throw new DriveError(401, "unauthorized");
  return id;
}

async function readBounded(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  const cap = 26_214_400;
  if (declared && /^\d+$/.test(declared) && Number(declared) > cap) {
    throw new DriveError(413, "too_large");
  }
  if (!request.body) throw new DriveError(400, "empty_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new DriveError(413, "too_large");
    }
    chunks.push(step.value);
  }
  if (total === 0) throw new DriveError(400, "empty_body");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function attachment(name: string, mediaType: string, bytes: Uint8Array): Response {
  const safe = sanitizeDisplayName(name).replace(/["\r\n]/g, "");
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": mediaType,
      "content-disposition": `attachment; filename="${safe}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export async function postObject(request: Request): Promise<Response> {
  try {
    const owner = await userId(request);
    const bytes = await readBounded(request);
    const preview = request.headers.get("x-preview-class")?.trim() ?? "";
    const folder = request.headers.get("x-folder-id")?.trim() ?? "";
    const versionOf = request.headers.get("x-version-of")?.trim() ?? "";
    const stored = await uploadObject({
      userId: owner,
      bytes,
      mediaType: request.headers.get("content-type")?.split(";")[0]?.trim() ?? "",
      displayName: acceptDisplayName(request.headers.get("x-display-name")),
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      folderId: folder || null,
      versionOf: versionOf || null,
      previewClass: preview && isPreviewClass(preview) ? preview : null,
    });
    return json(201, stored);
  } catch (err) {
    return fail(err);
  }
}

export async function getObjects(request: Request): Promise<Response> {
  try {
    const owner = await userId(request);
    const url = new URL(request.url);
    const view = url.searchParams.get("view") ?? "";
    const filter: ListFilter = {
      trash: view === "trash",
      starred: view === "starred",
      photos: view === "photos",
      rooted: url.searchParams.has("folder"),
      folderId: url.searchParams.get("folder") || null,
      query: url.searchParams.get("q") ?? undefined,
    };
    const [objects, folders, quota] = await Promise.all([
      listObjects(owner, filter),
      listFolders(owner, {
        trash: view === "trash",
        rooted: url.searchParams.has("folder"),
            parentId: url.searchParams.get("folder") || null,
      }),
      quotaFor(owner),
    ]);
    return json(200, { objects, folders, quota });
  } catch (err) {
    return fail(err);
  }
}

export async function getObject(request: Request, objectId: string): Promise<Response> {
  try {
    const owner = await userId(request);
    const file = await readObject(owner, objectId);
    return attachment(file.meta.displayName, file.meta.mediaType, file.bytes);
  } catch (err) {
    return fail(err);
  }
}

export async function removeObject(request: Request, objectId: string): Promise<Response> {
  try {
    const owner = await userId(request);
    await deleteObject(owner, objectId);
    return json(200, { deleted: objectId });
  } catch (err) {
    return fail(err);
  }
}

export async function postShare(request: Request, objectId: string): Promise<Response> {
  try {
    const owner = await userId(request);
    const body = (await request.json()) as {
      consent?: unknown;
      expiresInSeconds?: unknown;
      password?: unknown;
      maxDownloads?: unknown;
    };
    const created = await createShare({
      userId: owner,
      objectId,
      consent: body.consent === true,
      expiresInSeconds: Number(body.expiresInSeconds),
      password: typeof body.password === "string" ? body.password : undefined,
      maxDownloads: body.maxDownloads == null ? null : Number(body.maxDownloads),
    });
    return json(201, created);
  } catch (err) {
    return fail(err);
  }
}

export async function getObjectShares(request: Request, objectId: string): Promise<Response> {
  try {
    const owner = await userId(request);
    return json(200, { shares: await listShares(owner, objectId) });
  } catch (err) {
    return fail(err);
  }
}

export async function removeShare(request: Request, shareId: string): Promise<Response> {
  try {
    const owner = await userId(request);
    await revokeShare(owner, shareId);
    return json(200, { revoked: shareId });
  } catch (err) {
    return fail(err);
  }
}

export async function getShared(request: Request): Promise<Response> {
  try {
    assertRequest(request);
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) throw new DriveError(401, "unauthorized");
    const file = await readShared(token, request.headers.get("x-share-password") ?? undefined);
    return attachment(file.meta.displayName, file.meta.mediaType, file.bytes);
  } catch (err) {
    return fail(err);
  }
}

export { userId as requireDriveUser };
