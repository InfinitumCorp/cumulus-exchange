import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDevPreview } from "../src/dev-preview.mjs";
import { readFile } from "node:fs/promises";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });
}

test("dev preview session can store a file and production has no dev-session route", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cumulus-dev-"));
  const preview = await createDevPreview(dir);
  const { server, port } = await listen((req, res) => preview.middleware(req, res, () => {
    res.writeHead(404);
    res.end();
  }));
  try {
    const session = await request(port, "GET", "/api/drive/dev-session");
    assert.equal(session.status, 200);
    const { token } = JSON.parse(session.body.toString("utf8"));
    const put = await request(
      port,
      "PUT",
      "/api/drive/v1/objects/drive/hello.txt",
      {
        authorization: `Bearer ${token}`,
        "x-cumulus-purpose": "drive.write",
        "content-type": "text/plain",
      },
      Buffer.from("stored-in-drive"),
    );
    assert.equal(put.status, 200, put.body.toString("utf8"));
    const got = await request(port, "GET", "/api/drive/v1/objects/drive/hello.txt", {
      authorization: `Bearer ${token}`,
      "x-cumulus-purpose": "drive.read",
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.toString("utf8"), "stored-in-drive");
    const missing = await request(port, "GET", "/v1/dev-session");
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await preview.close();
  }
  const main = await readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.equal(main.includes("dev-preview"), false);
  assert.equal(main.includes("CUMULUS_DEV_MINT"), false);
});
