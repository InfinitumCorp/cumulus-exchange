import { randomBytes } from "node:crypto";

/** Private ciphertext storage. The secret key stays in the backend runtime. */
export function createSupabaseDriver({ url, secretKey, bucket = "cumulus-drive", fetch: request = fetch }) {
  const base = new URL(url);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/") {
    throw new Error("Supabase URL must be an HTTPS origin");
  }
  if (!secretKey) throw new Error("CUMULUS_SUPABASE_SECRET_KEY is required");
  if (!/^[a-z0-9-]+$/.test(bucket)) throw new Error("Invalid Supabase bucket");
  function location(tenantId, blobId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenantId) || !/^[a-f0-9]{32}$/.test(blobId)) {
      throw new Error("Unsafe storage identifier");
    }
    return `${base.origin}/storage/v1/object/${bucket}/tenants/${tenantId}/${blobId}`;
  }
  async function call(method, target, body) {
    const headers = { apikey: secretKey, "content-type": method === "DELETE" ? "application/json" : "application/octet-stream" };
    // Modern secret keys are not JWTs; legacy service-role keys are.
    if (!secretKey.startsWith("sb_secret_")) headers.authorization = `Bearer ${secretKey}`;
    const response = await request(target, { method, headers, body });
    if (!response.ok) throw new Error(`Supabase storage ${method} failed (${response.status})`);
    return response;
  }
  return {
    kind: "supabase",
    async put(tenantId, blobId, bytes) { await call("POST", location(tenantId, blobId), bytes); },
    async get(tenantId, blobId) {
      return Buffer.from(await (await call("GET", location(tenantId, blobId))).arrayBuffer());
    },
    async delete(tenantId, blobId) {
      location(tenantId, blobId); // Validate before constructing the remove request.
      await call("DELETE", `${base.origin}/storage/v1/object/${bucket}`,
        JSON.stringify({ prefixes: [`tenants/${tenantId}/${blobId}`] }));
    },
    async probe() {
      const id = randomBytes(16).toString("hex");
      await this.put("probe", id, Buffer.from("probe"));
      try { return (await this.get("probe", id)).toString() === "probe"; }
      finally { await this.delete("probe", id); }
    },
  };
}
