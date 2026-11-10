// @ts-check

import { decodeString, walkMessage } from "./protobuf.mjs";

/**
 * @typedef {{ ip: Uint8Array, prefix: number }} Cidr
 * @typedef {{ code: string, cidrs: Cidr[] }} ReverseEntry
 * @typedef {{ value: string, code: string }} PlainRule
 * @typedef {{ code: string, re: RegExp }} RegexRule
 * @typedef {{
 *   v4: Map<string, string>,
 *   v6: Map<string, string>,
 *   reverse: ReverseEntry[],
 *   full: Map<string, string[]>,
 *   domain: Map<string, string[]>,
 *   plain: PlainRule[],
 *   regex: RegexRule[],
 * }} GeoIndex
 */

/**
 * v2ray Domain.Type
 * Plain = 0, Regex = 1, Domain = 2, Full = 3
 */

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function copyBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/**
 * @param {Uint8Array} buf
 * @returns {Cidr | null}
 */
function parseCidr(buf) {
  const found = {
    ip: /** @type {Uint8Array | null} */ (null),
    prefix: 0,
  };
  walkMessage(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) found.ip = copyBytes(value);
    else if (field === 2 && wire === 0 && typeof value === "bigint") found.prefix = Number(value);
  });
  const ipBytes = found.ip;
  if (!ipBytes) return null;
  const max = ipBytes.length * 8;
  if (!Number.isInteger(found.prefix) || found.prefix < 0 || found.prefix > max) return null;
  if (ipBytes.length !== 4 && ipBytes.length !== 16) return null;
  return { ip: ipBytes, prefix: found.prefix };
}

/**
 * @param {Uint8Array} buf
 * @returns {{ code: string, cidrs: Cidr[], reverse: boolean }}
 */
function parseGeoIp(buf) {
  let code = "";
  /** @type {Cidr[]} */
  const cidrs = [];
  let reverse = false;
  walkMessage(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) code = decodeString(value);
    else if (field === 2 && wire === 2 && value instanceof Uint8Array) {
      const cidr = parseCidr(value);
      if (cidr) cidrs.push(cidr);
    } else if (field === 3 && wire === 0 && typeof value === "bigint") reverse = value !== 0n;
  });
  return { code, cidrs, reverse };
}

/**
 * @param {Uint8Array} buf
 * @returns {{ type: number, value: string }}
 */
function parseDomain(buf) {
  let type = 0;
  let value = "";
  walkMessage(buf, (field, wire, raw) => {
    if (field === 1 && wire === 0 && typeof raw === "bigint") type = Number(raw);
    else if (field === 2 && wire === 2 && raw instanceof Uint8Array) value = decodeString(raw);
  });
  return { type, value };
}

/**
 * @param {Uint8Array} buf
 * @returns {{ code: string, domains: { type: number, value: string }[] }}
 */
function parseGeoSite(buf) {
  let code = "";
  /** @type {{ type: number, value: string }[]} */
  const domains = [];
  walkMessage(buf, (field, wire, value) => {
    if (field === 1 && wire === 2 && value instanceof Uint8Array) code = decodeString(value);
    else if (field === 2 && wire === 2 && value instanceof Uint8Array)
      domains.push(parseDomain(value));
  });
  return { code, domains };
}

/**
 * @param {Uint8Array} ip
 * @param {number} prefix
 * @returns {string}
 */
function networkKey(ip, prefix) {
  const masked = new Uint8Array(ip.length);
  let bits = prefix;
  for (let i = 0; i < ip.length; i += 1) {
    const current = ip[i] ?? 0;
    if (bits >= 8) masked[i] = current;
    else if (bits > 0) masked[i] = current & ((0xff << (8 - bits)) & 0xff);
    bits -= 8;
    if (bits < 0) bits = 0;
  }
  let hex = "";
  for (const byte of masked) hex += byte.toString(16).padStart(2, "0");
  return `${prefix}:${hex}`;
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @param {string} code
 */
function pushCode(map, key, code) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [code]);
    return;
  }
  if (!existing.includes(code)) existing.push(code);
}

/**
 * @param {Uint8Array} ipBytes
 * @param {Uint8Array} siteBytes
 * @returns {GeoIndex}
 */
export function buildIndex(ipBytes, siteBytes) {
  /** @type {GeoIndex} */
  const index = {
    v4: new Map(),
    v6: new Map(),
    reverse: [],
    full: new Map(),
    domain: new Map(),
    plain: [],
    regex: [],
  };
  walkMessage(ipBytes, (field, wire, value) => {
    if (field !== 1 || wire !== 2 || !(value instanceof Uint8Array)) return;
    const entry = parseGeoIp(value);
    if (!entry.code) return;
    if (entry.reverse) {
      index.reverse.push({ code: entry.code, cidrs: entry.cidrs });
      return;
    }
    for (const cidr of entry.cidrs) {
      const map = cidr.ip.length === 16 ? index.v6 : index.v4;
      const key = networkKey(cidr.ip, cidr.prefix);
      if (!map.has(key)) map.set(key, entry.code);
    }
  });
  walkMessage(siteBytes, (field, wire, value) => {
    if (field !== 1 || wire !== 2 || !(value instanceof Uint8Array)) return;
    const entry = parseGeoSite(value);
    if (!entry.code) return;
    for (const domain of entry.domains) {
      const host = domain.value.trim().toLowerCase();
      if (!host) continue;
      if (domain.type === 3) pushCode(index.full, host, entry.code);
      else if (domain.type === 2) pushCode(index.domain, host, entry.code);
      else if (domain.type === 1) {
        if (host.length > 1024) continue;
        try {
          index.regex.push({ code: entry.code, re: new RegExp(host) });
        } catch {
          /* skip a pattern the runtime cannot compile */
        }
      } else index.plain.push({ value: host, code: entry.code });
    }
  });
  return index;
}

/**
 * @param {string} text
 * @returns {Uint8Array | null}
 */
function parseV4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (!part || !/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Uint8Array | null}
 */
function parseV6(text) {
  const zone = text.split("%")[0] ?? "";
  if (!zone) return null;
  const halves = zone.split("::");
  if (halves.length > 2) return null;
  /**
   * @param {string} side
   * @returns {number[] | null}
   */
  const parseSide = (side) => {
    if (!side) return [];
    const groups = side.split(":");
    /** @type {number[]} */
    const values = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      values.push(Number.parseInt(group, 16));
    }
    return values;
  };
  const head = parseSide(halves[0] ?? "");
  if (!head) return null;
  const tail = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!tail) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 8) return null;
  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(missing).fill(0), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    out[index * 2] = (group >> 8) & 0xff;
    out[index * 2 + 1] = group & 0xff;
  });
  return out;
}

/**
 * @param {string} input
 * @returns {Uint8Array | null}
 */
export function parseIp(input) {
  let text = String(input || "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]"));
  const zone = text.split("%")[0] ?? text;
  if (zone.startsWith("::ffff:") && zone.includes(".")) {
    const mapped = parseV4(zone.slice("::ffff:".length));
    if (mapped) return mapped;
  }
  if (zone.includes(".")) return parseV4(zone);
  return parseV6(zone);
}

/**
 * @param {Uint8Array} ip
 * @param {Cidr} cidr
 * @returns {boolean}
 */
function contains(ip, cidr) {
  if (ip.length !== cidr.ip.length) return false;
  let bits = cidr.prefix;
  for (let i = 0; i < ip.length; i += 1) {
    const left = ip[i] ?? 0;
    const right = cidr.ip[i] ?? 0;
    if (bits >= 8) {
      if (left !== right) return false;
    } else if (bits > 0) {
      const mask = (0xff << (8 - bits)) & 0xff;
      if ((left & mask) !== (right & mask)) return false;
    }
    bits -= 8;
    if (bits < 0) bits = 0;
  }
  return true;
}

/**
 * Longest-prefix country code, or null when the address is not listed.
 * @param {GeoIndex} index
 * @param {string} ipText
 * @returns {string | null}
 */
export function lookupCountry(index, ipText) {
  const ip = parseIp(ipText);
  if (!ip) return null;
  const map = ip.length === 16 ? index.v6 : index.v4;
  const max = ip.length * 8;
  for (let prefix = max; prefix >= 0; prefix -= 1) {
    const code = map.get(networkKey(ip, prefix));
    if (code) return code;
  }
  for (const entry of index.reverse) {
    const listed = entry.cidrs.some((cidr) => contains(ip, cidr));
    if (!listed) return entry.code;
  }
  return null;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeDomain(value) {
  let host = String(value || "")
    .trim()
    .toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? "" : host.slice(1, end);
  } else if (host.includes(":") && host.indexOf(":") === host.lastIndexOf(":")) {
    host = host.slice(0, host.indexOf(":"));
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253 || host.includes("/") || host.includes(" ")) return "";
  return host;
}

/**
 * @param {string[]} found
 * @param {Set<string>} seen
 * @param {string[] | undefined} codes
 */
function addCodes(found, seen, codes) {
  if (!codes) return;
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    found.push(code);
  }
}

/**
 * Categories whose domain rules match. Order is full, then parent labels, then plain, then regex.
 * @param {GeoIndex} index
 * @param {string} domain
 * @returns {string[]}
 */
export function lookupCategories(index, domain) {
  const host = normalizeDomain(domain);
  if (!host || host.includes(":")) return [];
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  addCodes(found, seen, index.full.get(host));
  let cursor = host;
  while (cursor) {
    addCodes(found, seen, index.domain.get(cursor));
    const dot = cursor.indexOf(".");
    if (dot === -1) break;
    cursor = cursor.slice(dot + 1);
  }
  for (const rule of index.plain) {
    if (host.includes(rule.value)) addCodes(found, seen, [rule.code]);
  }
  for (const rule of index.regex) {
    if (rule.re.test(host)) addCodes(found, seen, [rule.code]);
  }
  return found;
}
