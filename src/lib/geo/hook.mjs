// @ts-check

import { lookupCategories, lookupCountry } from "./match.mjs";

const ON = new Set(["1", "true", "yes", "on"]);

/**
 * Process opt-in. Unset, empty, and every value other than the on-tokens are off.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isGeoEnabled(env = process.env) {
  const raw = env.INFINITUM_GEO_ENABLED;
  if (raw == null) return false;
  return ON.has(String(raw).trim().toLowerCase());
}

/**
 * @param {import("./match.mjs").GeoIndex} index
 * @param {{ ip?: string, domain?: string }} hint
 * @returns {{ country: string | null, categories: string[], annotation: string | null }}
 */
function classify(index, hint) {
  const country = hint.ip ? lookupCountry(index, hint.ip) : null;
  const categories = hint.domain ? lookupCategories(index, hint.domain) : [];
  /** @type {string[]} */
  const parts = [];
  if (country) parts.push(`country ${country}`);
  if (categories.length > 0) parts.push(`categories ${categories.join(",")}`);
  return { country, categories, annotation: parts.length > 0 ? parts.join("; ") : null };
}

/**
 * Policy classification. When geo routing is off the subject is unchanged and allowed.
 * Enabling the hook records country and category. It does not deny the request.
 * @param {{ ip?: string, domain?: string }} hint
 * @param {import("./match.mjs").GeoIndex | null | undefined} index
 * @param {boolean} enabled
 * @returns {{ allow: true, annotation: string | null }}
 */
export function geoPolicy(hint, index, enabled) {
  if (enabled !== true || !index) return { allow: true, annotation: null };
  return { allow: true, annotation: classify(index, hint).annotation };
}

/**
 * @param {string} detail
 * @param {{ ip?: string, domain?: string }} hint
 * @param {import("./match.mjs").GeoIndex | null | undefined} index
 * @param {boolean} enabled
 * @returns {string}
 */
export function annotateAuditDetail(detail, hint, index, enabled) {
  const policy = geoPolicy(hint, index, enabled);
  if (!policy.annotation) return detail;
  return `${detail} (${policy.annotation})`;
}

/**
 * @param {Record<string, unknown>} fields
 * @param {{ ip?: string, domain?: string }} hint
 * @param {import("./match.mjs").GeoIndex | null | undefined} index
 * @param {boolean} enabled
 * @returns {Record<string, unknown>}
 */
export function annotateLogFields(fields, hint, index, enabled) {
  if (enabled !== true || !index) return fields;
  const result = classify(index, hint);
  if (!result.country && result.categories.length === 0) return fields;
  /** @type {Record<string, unknown>} */
  const next = { ...fields };
  if (result.country) next.geoCountry = result.country;
  if (result.categories.length > 0) next.geoCategories = result.categories;
  if (result.annotation) next.geoAnnotation = result.annotation;
  return next;
}

/**
 * @param {{ socket?: { remoteAddress?: string }, headers?: { host?: string | string[] } }} req
 * @returns {{ ip: string, domain: string }}
 */
export function requestHint(req) {
  const address = req.socket?.remoteAddress;
  const host = req.headers?.host;
  const domain = Array.isArray(host) ? host[0] : host;
  return {
    ip: typeof address === "string" ? address : "",
    domain: typeof domain === "string" ? domain : "",
  };
}

/**
 * @param {Record<string, unknown>} fields
 * @param {{ ip?: string, domain?: string }} hint
 * @param {{ enabled?: boolean, index?: import("./match.mjs").GeoIndex | null } | null | undefined} geo
 * @returns {Record<string, unknown>}
 */
export function applyGeoHook(fields, hint, geo) {
  if (!geo || geo.enabled !== true || !geo.index) return fields;
  return annotateLogFields(fields, hint, geo.index, true);
}
