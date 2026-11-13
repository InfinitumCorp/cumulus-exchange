/**
 * Drive parity helpers for the hosted function: list views, upload metadata
 * headers and parity requests. Pure functions, so the Node tests cover them;
 * index.ts does the PostgREST calls. cloud/src/parity.mjs is the Node equivalent.
 *
 * Erasable TypeScript only: Node runs it with type stripping in the tests.
 */

export const PREVIEW_CLASSES = ["image", "pdf", "text", "video", "note", "other"];
export const VIEWS = ["active", "trash", "starred", "photos"];

/** PostgREST filters for a list view. Unknown views fall back to active files. */
export function viewFilter(view: string | null): string {
  switch (view) {
    case "trash":
      return "&trashed_at=not.is.null";
    case "starred":
      return "&trashed_at=is.null&starred=is.true";
    case "photos":
      return "&trashed_at=is.null&preview_class=eq.image";
    default:
      return "&trashed_at=is.null";
  }
}

const MEDIA = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const SEALED = /^[A-Za-z0-9+/=_.:-]{1,2048}$/;

export type UploadMeta = { contentType: string; previewClass: string | null; sealedName: string | null };

/** Content type, preview class and sealed name from upload headers. Anything malformed is dropped, not stored. */
export function uploadMeta(headers: { get(name: string): string | null }): UploadMeta {
  const rawType = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const contentType = MEDIA.test(rawType) ? rawType : "application/octet-stream";
  const rawClass = (headers.get("x-cumulus-preview-class") ?? "").trim().toLowerCase();
  const previewClass = PREVIEW_CLASSES.includes(rawClass) ? rawClass : null;
  const rawSealed = (headers.get("x-cumulus-sealed-name") ?? "").trim();
  const sealedName = SEALED.test(rawSealed) ? rawSealed : null;
  return { contentType, previewClass, sealedName };
}

export type ParityRequest =
  | { op: "star"; bucket: string; key: string; starred: boolean }
  | { op: "trash" | "restore"; bucket: string; key: string }
  | { op: "versions"; bucket: string; key: string }
  | { op: "activity" }
  | { op: "security" }
  | { op: "invite" };

export class ParityError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Validate a parity call. GET carries op in the query; POST carries a JSON body. */
export function parseParity(method: string, query: URLSearchParams, body: Record<string, unknown> | null): ParityRequest {
  const reading = method === "GET";
  const op = reading ? query.get("op") ?? "" : text(body?.op);
  if (reading) {
    if (op === "activity" || op === "security") return { op };
    throw new ParityError(404, "NotFound", "Unknown parity operation");
  }
  if (op === "activity" || op === "security") return { op };
  if (op === "invite") return { op };
  const bucket = text(body?.bucket);
  const key = text(body?.key);
  if (op === "star") {
    const flag = body?.starred;
    return { op, bucket, key, starred: flag === true || flag === 1 || flag === "1" || flag === "true" };
  }
  if (op === "trash" || op === "restore" || op === "versions") return { op, bucket, key };
  throw new ParityError(404, "NotFound", "Unknown parity operation");
}

/** What the hosted Drive says about features that live elsewhere. */
export const SECURITY_REPORT = {
  twoFactor: "deferred",
  securityKeys: "deferred",
  authority: "id.cumuluscloud.app",
  sync: "deferred",
  mail: "deferred",
  versions: "not kept",
  reason:
    "2FA and security keys stay at Cumulus://ID. This Drive keeps the latest copy of each file only. Desktop sync and mail delivery are not part of this host.",
};
