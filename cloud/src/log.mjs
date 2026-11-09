const REDACT = new Set([
  "authorization",
  "apiKey",
  "api_key",
  "secret",
  "secretAccessKey",
  "masterKey",
  "token",
  "password",
  "wrappedDek",
  "wrappedKek",
  "wrappedSecret",
  "bootstrapToken",
]);

/**
 * One-line JSON log. Sensitive field names are dropped so a request log cannot
 * capture credentials or key material.
 * @param {"info" | "warn" | "error"} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export function log(level, msg, fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT.has(key)) continue;
    if (typeof value === "string" && value.length > 500) safe[key] = `${value.slice(0, 500)}…`;
    else safe[key] = value;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    service: "cumulus-cloud",
    ...safe,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}
