import { log } from "../log.mjs";
import { loadGeoCatalog } from "./catalog.mjs";
import { annotatePeer, geoEnabled } from "./v2ray-dat.mjs";

/**
 * Opt-in policy annotation. INFINITUM_GEO_ENABLED defaults off. When it is
 * off this returns without reading datasets and without writing a log line,
 * so Drive responses and logs stay as they are.
 */
export async function annotateDrive(req, url, status, env = process.env, emit = log) {
  if (!geoEnabled(env?.INFINITUM_GEO_ENABLED)) return;
  try {
    const index = await loadGeoCatalog(env);
    const purpose = headerOne(req.headers?.["x-cumulus-purpose"]);
    const note = annotatePeer(index, {
      ip: peerAddress(req),
      host: url.hostname,
      purpose,
    });
    if (!note) return;
    emit("info", "geo annotation", { method: req.method, status, ...note });
  } catch (error) {
    emit("error", "geo annotation failed", {
      err: error instanceof Error ? error.message : "geo annotation failed",
    });
  }
}

function peerAddress(req) {
  const address = req.socket?.remoteAddress;
  return typeof address === "string" ? address : "";
}

function headerOne(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}
