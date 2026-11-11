/** Client-side AES-GCM seal. The server stores the ciphertext and never sees the key. */

const MAGIC = [0x43, 0x4d, 0x4c, 0x53]; // CMLS

export const SEAL_MEDIA_TYPE = "application/vnd.cumulus.sealed";

export async function deriveDriveKey(secret: string, salt: string, iterations = 120_000): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(`cumulus-drive:${salt}`),
      iterations,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sealContent(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(plain)));
  const out = new Uint8Array(4 + 1 + iv.length + cipher.length);
  out.set(MAGIC, 0);
  out[4] = 1;
  out.set(iv, 5);
  out.set(cipher, 17);
  return out;
}

export async function openContent(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 4 + 1 + 12 + 16 || sealed[0] !== MAGIC[0] || sealed[1] !== MAGIC[1] || sealed[2] !== MAGIC[2] || sealed[3] !== MAGIC[3] || sealed[4] !== 1) {
    throw new Error("seal_rejected");
  }
  const iv = sealed.slice(5, 17);
  const cipher = sealed.slice(17);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(cipher));
  return new Uint8Array(plain);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function isSealedName(value: string): boolean {
  return /^cmls1\.[A-Za-z0-9_-]{16,400}$/.test(value);
}

export async function sealName(key: CryptoKey, name: string): Promise<string> {
  const sealed = await sealContent(key, new TextEncoder().encode(name));
  return `cmls1.${bytesToBase64Url(sealed)}`;
}

export async function openName(key: CryptoKey, stored: string): Promise<string> {
  if (!isSealedName(stored)) return stored;
  const plain = await openContent(key, base64UrlToBytes(stored.slice("cmls1.".length)));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
  if (text.includes("\u0000") || text.includes("/") || text.includes("\\")) throw new Error("seal_rejected");
  return text;
}
