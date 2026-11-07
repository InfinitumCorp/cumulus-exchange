import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseMasterKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("CUMULUS_KMS_MASTER_KEY is required (32 bytes, base64 or hex)");
  }
  const trimmed = value.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (buf.length !== 32) throw new Error("CUMULUS_KMS_MASTER_KEY must decode to 32 bytes");
  return buf;
}

function wrapDek(master, dek) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, nonce);
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([nonce, tag, body]).toString("base64")}`;
}

function unwrapDek(master, packed) {
  if (typeof packed !== "string" || !packed.startsWith("v1:")) {
    throw new HttpError(500, "InvalidEnvelope", "Unsupported wrapped key");
  }
  const raw = Buffer.from(packed.slice(3), "base64");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", master, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Envelope encryption. The data key is random per object and stored only wrapped. */
export function createEnvelope(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error("Envelope master key must be 32 bytes");
  }
  return {
    seal(plaintext, aad) {
      const dek = randomBytes(32);
      const nonce = randomBytes(12);
      try {
        const cipher = createCipheriv("aes-256-gcm", dek, nonce);
        cipher.setAAD(Buffer.from(aad));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
          ciphertext,
          envelope: {
            v: 1,
            alg: "AES-256-GCM",
            wrappedDek: wrapDek(masterKey, dek),
            nonce: nonce.toString("base64"),
            tag: tag.toString("base64"),
          },
        };
      } finally {
        dek.fill(0);
      }
    },
    open(ciphertext, envelope, aad) {
      if (!envelope || envelope.v !== 1 || envelope.alg !== "AES-256-GCM") {
        throw new HttpError(500, "InvalidEnvelope", "Unsupported object envelope");
      }
      const dek = unwrapDek(masterKey, envelope.wrappedDek);
      try {
        const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(envelope.nonce, "base64"));
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new HttpError(500, "DecryptFailed", "Object could not be decrypted");
      } finally {
        dek.fill(0);
      }
    },
  };
}

export function signShare(secret, shareId, exp) {
  return createHmac("sha256", secret).update(`${shareId}.${exp}`).digest("hex");
}

export function verifyShare(secret, shareId, exp, signature) {
  const expected = signShare(secret, shareId, exp);
  const left = Buffer.from(expected);
  const right = Buffer.from(String(signature));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
