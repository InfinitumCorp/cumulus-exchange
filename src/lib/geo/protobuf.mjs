// @ts-check

/**
 * Minimal protobuf codec for v2ray GeoIPList and GeoSiteList.
 * Wire types used by those messages are varint (0) and length-delimited (2).
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: bigint, offset: number }}
 */
export function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: pos };
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

/**
 * @param {number | bigint} value
 * @returns {Uint8Array}
 */
export function writeVarint(value) {
  let n = BigInt(value);
  if (n < 0n) throw new Error("negative varint");
  const out = [];
  while (true) {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) byte |= 0x80;
    out.push(byte);
    if (n === 0n) break;
  }
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function concat(parts) {
  let len = 0;
  for (const part of parts) len += part.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @param {number} field
 * @param {number} wire
 * @returns {Uint8Array}
 */
function fieldKey(field, wire) {
  return writeVarint((field << 3) | wire);
}

/**
 * @param {number} field
 * @param {number | bigint} value
 * @returns {Uint8Array}
 */
export function writeVarintField(field, value) {
  return concat([fieldKey(field, 0), writeVarint(value)]);
}

/**
 * @param {number} field
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function writeBytesField(field, bytes) {
  return concat([fieldKey(field, 2), writeVarint(bytes.length), bytes]);
}

/**
 * @param {number} field
 * @param {string} value
 * @returns {Uint8Array}
 */
export function writeStringField(field, value) {
  return writeBytesField(field, textEncoder.encode(value));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeString(bytes) {
  return textDecoder.decode(bytes);
}

/**
 * @param {Uint8Array} buf
 * @param {(field: number, wire: number, value: Uint8Array | bigint) => void} onField
 */
export function walkMessage(buf, onField) {
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!Number.isSafeInteger(field) || field <= 0) throw new Error("invalid protobuf field");
    if (wire === 0) {
      const parsed = readVarint(buf, offset);
      offset = parsed.offset;
      onField(field, wire, parsed.value);
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      const size = Number(len.value);
      if (!Number.isSafeInteger(size) || size < 0 || offset + size > buf.length) {
        throw new Error("truncated length-delimited field");
      }
      onField(field, wire, buf.subarray(offset, offset + size));
      offset += size;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new Error("truncated 64-bit field");
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new Error("truncated 32-bit field");
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

/**
 * @param {{ code: string, reverse?: boolean, cidrs: { ip: Uint8Array, prefix: number }[] }} entry
 * @returns {Uint8Array}
 */
function encodeGeoIp(entry) {
  /** @type {Uint8Array[]} */
  const parts = [writeStringField(1, entry.code)];
  for (const cidr of entry.cidrs) {
    const body = concat([writeBytesField(1, cidr.ip), writeVarintField(2, cidr.prefix)]);
    parts.push(writeBytesField(2, body));
  }
  if (entry.reverse) parts.push(writeVarintField(3, 1));
  return concat(parts);
}

/**
 * @param {{ code: string, reverse?: boolean, cidrs: { ip: Uint8Array, prefix: number }[] }[]} entries
 * @returns {Uint8Array}
 */
export function encodeGeoIpList(entries) {
  return concat(entries.map((entry) => writeBytesField(1, encodeGeoIp(entry))));
}

/**
 * @param {{ type?: number, value: string }} domain
 * @returns {Uint8Array}
 */
function encodeDomain(domain) {
  return concat([writeVarintField(1, domain.type ?? 0), writeStringField(2, domain.value)]);
}

/**
 * @param {{ code: string, domains: { type?: number, value: string }[] }} entry
 * @returns {Uint8Array}
 */
function encodeGeoSite(entry) {
  /** @type {Uint8Array[]} */
  const parts = [writeStringField(1, entry.code)];
  for (const domain of entry.domains) parts.push(writeBytesField(2, encodeDomain(domain)));
  return concat(parts);
}

/**
 * @param {{ code: string, domains: { type?: number, value: string }[] }[]} entries
 * @returns {Uint8Array}
 */
export function encodeGeoSiteList(entries) {
  return concat(entries.map((entry) => writeBytesField(1, encodeGeoSite(entry))));
}
