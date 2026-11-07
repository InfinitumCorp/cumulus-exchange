import { Readable } from "node:stream";

/** Bridge the existing authenticated Drive routes to the Workers Fetch API. */
export async function handleFetch(request, handle) {
  const url = new URL(request.url);
  const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
  req.url = url.pathname + url.search;
  req.method = request.method;
  req.headers = Object.fromEntries(request.headers);
  let status = 500;
  let headers = {};
  let body;
  const res = {
    headersSent: false,
    writeHead(code, values = {}) {
      status = code;
      headers = values;
      this.headersSent = true;
      return this;
    },
    end(value) { body = value; },
  };
  await handle(req, res);
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}
