/**
 * v2ray GeoIPList / GeoSiteList loader for v2fly geoip.dat and
 * domain-list-community dlc.dat (stored as geosite.dat).
 * Loyalsoldier and sing-box lists are GPL-3 and are rejected.
 * No protobuf dependency: only the fields this product looks up are decoded.
 *
 * The Supabase edge bundle keeps an identical copy at
 * cloud/supabase/functions/_shared/v2ray-dat.mjs. A test fails if they diverge.
 */

const PLAIN = 0;
const REGEX = 1;
const SUFFIX = 2;
const FULL = 3;
const MAX_REGEX = 200;

const BANNED = /loyalsoldier|sing-box|singbox|sagernet/i;

export const DOMAIN_PLAIN = PLAIN;
export const DOMAIN_REGEX = REGEX;
export const DOMAIN_SUFFIX = SUFFIX;
export const DOMAIN_FULL = FULL;

export function geoEnabled(value) {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

export function hashesFromLock(lock) {
  if (!lock || !Array.isArray(lock.datasets) || lock.datasets.length === 0) {
    throw new Error("geo lockfile has no datasets");
  }
  const identity = lock.datasets
    .flatMap((item) => [item?.url, item?.sha256Url, item?.project, item?.asset, item?.name, item?.saveAs, item?.tag])
    .filter(Boolean)
    .join("\n");
  if (BANNED.test(identity)) {
    throw new Error("refusing GPL-3 geosite sources (Loyalsoldier and sing-box)");
  }
  let geoipSha256 = "";
  let geositeSha256 = "";
  for (const item of lock.datasets) {
    assertReleaseUrl(item.url);
    assertReleaseUrl(item.sha256Url);
    if (typeof item.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(item.sha256)) {
      throw new Error("lockfile sha256 is invalid");
    }
    const save = item.saveAs || item.name;
    if (save === "geoip.dat") geoipSha256 = item.sha256.toLowerCase();
    else if (save === "geosite.dat") geositeSha256 = item.sha256.toLowerCase();
    else throw new Error("geo lockfile has an unexpected dataset name");
    if (item.asset !== "geoip.dat" && item.asset !== "dlc.dat") {
      throw new Error("geo lockfile asset must be geoip.dat or dlc.dat");
    }
  }
  if (!geoipSha256 || !geositeSha256) {
    throw new Error("geo lockfile must include geoip.dat and geosite.dat");
  }
  return { geoipSha256, geositeSha256 };
}

function assertReleaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("geo URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "github.com") {
    throw new Error("geo URL must be https://github.com/v2fly/");
  }
  const allowed =
    url.pathname.startsWith("/v2fly/geoip/") ||
    url.pathname.startsWith("/v2fly/domain-list-community/");
  if (!allowed) throw new Error("geo URL must be a v2fly geoip or domain-list-community release");
}

export function parseSha256Sum(text, assetName) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) throw new Error("official sha256sum is empty");
  let match = "";
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const hash = parts[0].toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("official sha256sum is not a SHA-256 digest");
    const name = parts.slice(1).join(" ").replace(/^\*/, "");
    if (assetName && name === assetName) match = hash;
  }
  if (!match) throw new Error(`official sha256sum does not name ${assetName}`);
  return match;
}

export async function sha256Hex(bytes) {
  const data = toBytes(bytes);
  const view =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
  const out = new Uint8Array(digest);
  let hex = "";
  for (const byte of out) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export async function indexFromBuffers({ geoip, geosite, geoipSha256, geositeSha256 }) {
  const ipHash = await sha256Hex(geoip);
  const siteHash = await sha256Hex(geosite);
  if (ipHash !== String(geoipSha256 || "").toLowerCase()) {
    throw new Error("geoip.dat checksum does not match the lockfile");
  }
  if (siteHash !== String(geositeSha256 || "").toLowerCase()) {
    throw new Error("geosite.dat checksum does not match the lockfile");
  }
  return createGeoIndex(decodeGeoIPList(geoip), decodeGeoSiteList(geosite));
}

export function decodeGeoIPList(bytes) {
  const entries = [];
  for (const field of fields(toBytes(bytes)).get(1) ?? []) {
    if (field.wire !== 2) continue;
    const body = fields(field.value);
    const country = text(firstBytes(body, 1));
    if (!country) continue;
    const cidrs = [];
    for (const cidrField of body.get(2) ?? []) {
      if (cidrField.wire !== 2) continue;
      const cidr = fields(cidrField.value);
      const ip = firstBytes(cidr, 1);
      if (!ip || (ip.length !== 4 && ip.length !== 16)) continue;
      const prefix = firstVarint(cidr, 2, ip.length * 8);
      if (prefix < 0 || prefix > ip.length * 8) continue;
      cidrs.push({ ip, prefix });
    }
    entries.push({
      country,
      reverse: firstVarint(body, 3, 0) === 1,
      cidrs,
    });
  }
  return entries;
}

export function decodeGeoSiteList(bytes) {
  const entries = [];
  for (const field of fields(toBytes(bytes)).get(1) ?? []) {
    if (field.wire !== 2) continue;
    const body = fields(field.value);
    const category = text(firstBytes(body, 1));
    if (!category) continue;
    const domains = [];
    for (const domainField of body.get(2) ?? []) {
      if (domainField.wire !== 2) continue;
      const domain = fields(domainField.value);
      const value = text(firstBytes(domain, 2));
      if (!value) continue;
      const type = firstVarint(domain, 1, PLAIN);
      for (const attr of domain.get(3) ?? []) {
        if (attr.wire === 2) fields(attr.value);
      }
      domains.push({ type, value });
    }
    entries.push({ category, domains });
  }
  return entries;
}

export function createGeoIndex(geoipEntries, geositeEntries) {
  const positive = new Map();
  const reverse = [];
  for (const entry of geoipEntries) {
    if (entry.reverse) {
      reverse.push(entry);
      continue;
    }
    for (const cidr of entry.cidrs) addCidr(positive, cidr.ip, cidr.prefix, entry.country);
  }
  const full = new Map();
  const suffix = new Map();
  const plain = [];
  const regex = [];
  for (const entry of geositeEntries) {
    for (const domain of entry.domains) {
      const value = domain.value.trim().toLowerCase();
      if (!value) continue;
      if (domain.type === FULL) pushCategory(full, value, entry.category);
      else if (domain.type === SUFFIX)
        pushCategory(suffix, value.replace(/^\.+/, ""), entry.category);
      else if (domain.type === REGEX) {
        if (value.length > MAX_REGEX) continue;
        try {
          regex.push({ re: new RegExp(value), category: entry.category });
        } catch {
          /* skip a rule this runtime cannot compile */
        }
      } else if (domain.type === PLAIN) plain.push({ value, category: entry.category });
    }
  }
  return {
    countryForIp(ip) {
      const bytes = parseIp(ip);
      if (!bytes) return null;
      const bits = bytes.length * 8;
      for (let prefix = bits; prefix >= 0; prefix -= 1) {
        const hit = positive.get(networkKey(bytes, prefix));
        if (hit) return hit;
      }
      for (const entry of reverse) {
        if (!entry.cidrs.some((cidr) => cidrContains(cidr.ip, cidr.prefix, bytes)))
          return entry.country;
      }
      return null;
    },
    categoriesForDomain(domain) {
      const host = normalizeDomain(domain);
      if (!host) return [];
      const seen = new Set();
      const out = [];
      const push = (list) => {
        if (!list) return;
        for (const category of list) {
          if (seen.has(category)) continue;
          seen.add(category);
          out.push(category);
        }
      };
      push(full.get(host));
      let cursor = host;
      while (cursor) {
        push(suffix.get(cursor));
        const dot = cursor.indexOf(".");
        if (dot < 0) break;
        cursor = cursor.slice(dot + 1);
      }
      for (const rule of plain) {
        if (host.includes(rule.value)) push([rule.category]);
      }
      for (const rule of regex) {
        if (rule.re.test(host)) push([rule.category]);
      }
      return out;
    },
  };
}

export function annotatePeer(index, peer = {}) {
  if (!index) return null;
  const geoCountry = peer.ip ? index.countryForIp(peer.ip) : null;
  const geoCategories = peer.host ? index.categoriesForDomain(peer.host) : [];
  if (!geoCountry && geoCategories.length === 0) return null;
  const note = {};
  if (geoCountry) note.geoCountry = geoCountry;
  if (geoCategories.length > 0) note.geoCategories = geoCategories;
  if (typeof peer.purpose === "string" && /^[a-z0-9._-]{1,64}$/i.test(peer.purpose)) {
    note.purpose = peer.purpose;
  }
  return note;
}

export function parseIp(value) {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end > 1) text = text.slice(1, end);
  }
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (text.startsWith("::ffff:") && text.includes("."))
    return parseIpv4(text.slice("::ffff:".length));
  if (text.includes(".")) return parseIpv4(text);
  if (text.includes(":")) return parseIpv6(text);
  return null;
}

export function normalizeDomain(value) {
  if (typeof value !== "string") return "";
  let host = value.trim().toLowerCase();
  if (!host || host.includes("://") || host.includes("/") || host.includes("\\")) return "";
  if (host.startsWith("[")) return "";
  host = host.replace(/\.+$/, "");
  const colon = host.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1)) && host.indexOf(":") === colon) {
    host = host.slice(0, colon);
  }
  if (!host || parseIp(host)) return "";
  if (!/^[a-z0-9._-]+$/.test(host)) return "";
  return host;
}

export function encodeGeoIPList(entries) {
  const parts = [];
  for (const entry of entries) {
    const body = [encodeBytes(1, utf8(entry.country))];
    for (const cidr of entry.cidrs) {
      const message = concat([encodeBytes(1, cidr.ip), encodeVarintField(2, cidr.prefix)]);
      body.push(encodeBytes(2, message));
    }
    if (entry.reverse) body.push(encodeVarintField(3, 1));
    parts.push(encodeBytes(1, concat(body)));
  }
  return concat(parts);
}

export function encodeGeoSiteList(entries) {
  const parts = [];
  for (const entry of entries) {
    const body = [encodeBytes(1, utf8(entry.category))];
    for (const domain of entry.domains) {
      const message = [];
      if (domain.type) message.push(encodeVarintField(1, domain.type));
      message.push(encodeBytes(2, utf8(domain.value)));
      for (const attr of domain.attributes ?? []) {
        const attrBody = [encodeBytes(1, utf8(attr.key))];
        if (typeof attr.bool === "boolean") attrBody.push(encodeVarintField(2, attr.bool ? 1 : 0));
        if (attr.int != null) attrBody.push(encodeVarintField(3, attr.int));
        message.push(encodeBytes(3, concat(attrBody)));
      }
      body.push(encodeBytes(2, concat(message)));
    }
    parts.push(encodeBytes(1, concat(body)));
  }
  return concat(parts);
}

function addCidr(map, ip, prefix, country) {
  remember(map, ip, prefix, country);
  if (isV4Mapped(ip) && prefix >= 96) remember(map, ip.subarray(12), prefix - 96, country);
}

function remember(map, ip, prefix, country) {
  const key = networkKey(ip, prefix);
  if (!map.has(key)) map.set(key, country);
}

function isV4Mapped(ip) {
  if (ip.length !== 16) return false;
  for (let i = 0; i < 10; i += 1) if (ip[i] !== 0) return false;
  return ip[10] === 0xff && ip[11] === 0xff;
}

function networkKey(ip, prefix) {
  const full = Math.floor(prefix / 8);
  const rem = prefix % 8;
  let hex = "";
  for (let i = 0; i < ip.length; i += 1) {
    let byte = 0;
    if (i < full) byte = ip[i];
    else if (i === full && rem) byte = ip[i] & ((0xff << (8 - rem)) & 0xff);
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${ip.length}:${prefix}:${hex}`;
}

function cidrContains(network, prefix, ip) {
  if (network.length !== ip.length) return false;
  if (prefix < 0 || prefix > network.length * 8) return false;
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i += 1) if (network[i] !== ip[i]) return false;
  const rem = prefix % 8;
  if (!rem) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (network[full] & mask) === (ip[full] & mask);
}

function pushCategory(map, key, category) {
  const list = map.get(key);
  if (!list) map.set(key, [category]);
  else if (!list.includes(category)) list.push(category);
}

function parseIpv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(text) {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (value) => (value ? value.split(":") : []);
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = Number.parseInt(groups[i], 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function fields(bytes) {
  const map = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field <= 0) throw new Error("invalid protobuf field");
    let value;
    if (wire === 0) {
      const body = readVarint(bytes, offset);
      offset = body.offset;
      value = body.value;
    } else if (wire === 1) {
      value = take(bytes, offset, 8);
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      value = take(bytes, offset, length.value);
      offset += length.value;
    } else if (wire === 5) {
      value = take(bytes, offset, 4);
      offset += 4;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    const list = map.get(field);
    const item = { wire, value };
    if (list) list.push(item);
    else map.set(field, [item]);
  }
  return map;
}

function readVarint(bytes, offset) {
  let value = 0;
  let mul = 1;
  let pos = offset;
  for (let i = 0; i < 10; i += 1) {
    if (pos >= bytes.length) throw new Error("truncated protobuf varint");
    const byte = bytes[pos];
    pos += 1;
    value += (byte & 0x7f) * mul;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error("protobuf varint is too large");
      return { value, offset: pos };
    }
    mul *= 128;
  }
  throw new Error("protobuf varint is too long");
}

function take(bytes, offset, length) {
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
    throw new Error("truncated protobuf");
  }
  return bytes.subarray(offset, offset + length);
}

function firstBytes(map, field) {
  const item = map.get(field)?.[0];
  if (!item || item.wire !== 2) return null;
  return item.value;
}

function firstVarint(map, field, fallback) {
  const item = map.get(field)?.[0];
  if (!item) return fallback;
  if (item.wire !== 0) throw new Error("unexpected protobuf wire type");
  return item.value;
}

function text(bytes) {
  if (!bytes) return "";
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function utf8(value) {
  return new TextEncoder().encode(String(value));
}

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("varint must be a non-negative integer");
  const out = [];
  let n = value;
  while (n > 127) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

function encodeVarintField(field, value) {
  return concat([encodeVarint(field * 8), encodeVarint(value)]);
}

function encodeBytes(field, bytes) {
  return concat([encodeVarint(field * 8 + 2), encodeVarint(bytes.length), bytes]);
}

function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value);
}
