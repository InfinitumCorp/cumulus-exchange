/**
 * Drive parity helpers for the hosted function: list views, upload metadata
 * headers and parity requests. Pure functions, so the Node tests cover them;
 * index.ts does the PostgREST calls. cloud/src/parity.mjs is the Node equivalent.
 *
 * Erasable TypeScript only: Node runs it with type stripping in the tests.
 */

import { CID } from "./cid.ts";

export const PREVIEW_CLASSES = ["image", "pdf", "text", "video", "note", "other"];
export const VIEWS = ["active", "trash", "starred", "photos"];
const VERSION_ID = /^ver_[a-f0-9]{16}$/;

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

export type UploadMeta = { contentType: string; previewClass: string | null; sealedName: string | null; keepVersion: boolean };

/** Content type, preview class, sealed name, and whether the previous bytes stay. Anything malformed is dropped, not stored. */
export function uploadMeta(headers: { get(name: string): string | null }): UploadMeta {
  const rawType = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const contentType = MEDIA.test(rawType) ? rawType : "application/octet-stream";
  const rawClass = (headers.get("x-cumulus-preview-class") ?? "").trim().toLowerCase();
  const previewClass = PREVIEW_CLASSES.includes(rawClass) ? rawClass : null;
  const rawSealed = (headers.get("x-cumulus-sealed-name") ?? "").trim();
  const sealedName = SEALED.test(rawSealed) ? rawSealed : null;
  const keep = (headers.get("x-cumulus-keep-version") ?? "").trim().toLowerCase();
  return { contentType, previewClass, sealedName, keepVersion: keep === "1" || keep === "true" };
}

export type ParityRequest =
  | { op: "star"; bucket: string; key: string; starred: boolean }
  | { op: "trash" | "restore"; bucket: string; key: string }
  | { op: "versions"; bucket: string; key: string }
  | { op: "restore-version"; bucket: string; key: string; versionId: string }
  | { op: "activity" }
  | { op: "security" }
  | { op: "shared" }
  | { op: "invite"; bucket: string; key: string; cid: string; role: "viewer" | "editor" };

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
  if (op === "activity" || op === "security" || op === "shared") return { op };
  const bucket = text(body?.bucket);
  const key = text(body?.key);
  if (op === "invite") {
    const role = text(body?.role);
    const cid = text(body?.cid);
    if (role !== "viewer" && role !== "editor") throw new ParityError(400, "InvalidRole", "Role must be viewer or editor");
    if (!CID.test(cid)) throw new ParityError(400, "InvalidCid", "Cumulus://ID is not valid");
    return { op, bucket, key, cid, role };
  }
  if (op === "restore-version") {
    const versionId = text(body?.versionId);
    if (!VERSION_ID.test(versionId)) throw new ParityError(400, "NoSuchVersion", "Version not found");
    return { op, bucket, key, versionId };
  }
  if (op === "star") {
    const flag = body?.starred;
    return { op, bucket, key, starred: flag === true || flag === 1 || flag === "1" || flag === "true" };
  }
  if (op === "trash" || op === "restore" || op === "versions") return { op, bucket, key };
  throw new ParityError(404, "NotFound", "Unknown parity operation");
}

const PBKDF2_ITERATIONS = 100_000;

/** Share passwords are hashed before they are stored. The password itself is not kept. */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

/** A missing password and a wrong password both fail. The stored hash is never compared in the clear. */
export async function sharePasswordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = b64d(parts[2]);
  const expected = b64d(parts[3]);
  const actual = new Uint8Array(await deriveBits(password, salt, iterations));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: own(salt), iterations, hash: "SHA-256" }, key, 256);
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

function b64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function b64d(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** What the hosted Drive says about features that live elsewhere. */
export const SECURITY_REPORT = {
  twoFactor: "deferred",
  securityKeys: "deferred",
  authority: "id.cumuluscloud.app",
  sync: "deferred",
  mail: "deferred",
  versions: "kept",
  grants: "cid",
  reason:
    "2FA and security keys stay at Cumulus://ID. This Drive keeps up to 20 earlier copies of each file and stores a grant when you invite another Cumulus ID. Desktop sync and mail delivery are not part of this host.",
};
