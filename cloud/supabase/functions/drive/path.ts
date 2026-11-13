/**
 * Route path inside the Drive function. Strips the function prefix the runtime may
 * leave on the URL, then one leading /drive: the console calls /api/drive/v1/...,
 * and the Worker forwards everything after /api.
 */
export function functionPath(pathname: string) {
  for (const prefix of ["/functions/v1/drive", "/drive"]) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return stripDrive(pathname.slice(prefix.length));
  }
  return stripDrive(pathname.startsWith("/") ? pathname : `/${pathname}`);
}

/** The console calls /api/drive/v1/...; the Worker strips /api, so drop one leading /drive here too. */
function stripDrive(path: string) {
  if (path === "/drive") return "/";
  return path.startsWith("/drive/") ? path.slice("/drive".length) : path;
}
