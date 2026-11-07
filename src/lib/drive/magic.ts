const ALLOWED = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
] as const;

export type AllowedType = (typeof ALLOWED)[number];

export function isAllowedType(value: string): value is AllowedType {
  return (ALLOWED as readonly string[]).includes(value);
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, count: number): string {
  return String.fromCharCode(...bytes.slice(0, count));
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("nul");
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<html") || head.startsWith("<!doctype html")) {
    throw new Error("markup");
  }
  return text;
}

/** True when the bytes match the declared allowlisted type. */
export function magicMatches(mediaType: AllowedType, bytes: Uint8Array): boolean {
  try {
    if (mediaType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
    if (mediaType === "image/png") {
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    if (mediaType === "image/gif") {
      const head = ascii(bytes, 6);
      return head === "GIF87a" || head === "GIF89a";
    }
    if (mediaType === "image/webp") {
      return ascii(bytes, 4) === "RIFF" && ascii(bytes.slice(8), 4) === "WEBP";
    }
    if (mediaType === "application/pdf") return ascii(bytes, 5) === "%PDF-";
    if (mediaType === "text/plain" || mediaType === "text/csv") {
      decodeText(bytes);
      return true;
    }
    JSON.parse(decodeText(bytes));
    return true;
  } catch {
    return false;
  }
}

/** Private display label. Never used as a filesystem path. */
export function sanitizeDisplayName(raw: string | null): string {
  const cleaned = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "")
    .replace(/\.\./g, "")
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : "file";
}
