function num(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Integer out of range");
  return n;
}

function tenantRow(row) {
  if (!row) return null;
  return {
    ...row,
    max_bytes: num(row.max_bytes),
    max_objects: num(row.max_objects),
    used_bytes: num(row.used_bytes),
    used_objects: num(row.used_objects),
  };
}

function objectRow(row) {
  if (!row) return null;
  return { ...row, size_bytes: num(row.size_bytes) };
}

export function repository(query, transaction, close, kind) {
  let closed = false;
  return {
    kind,
    query,
    transaction,
    async close() {
      if (closed) return;
      closed = true;
      await close();
    },
    async getTenantByCid(cid) {
      const rows = await query("select * from tenants where cid = $1", [cid]);
      return tenantRow(rows[0]);
    },
    async getTenant(id) {
      const rows = await query("select * from tenants where id = $1", [id]);
      return tenantRow(rows[0]);
    },
    async insertTenant(row) {
      await query(
        `insert into tenants (id, name, cid, max_bytes, max_objects, used_bytes, used_objects, created_at)
         values ($1, $2, $3, $4, $5, 0, 0, $6)`,
        [row.id, row.name, row.cid, row.maxBytes, row.maxObjects, row.createdAt],
      );
    },
    async getObject(tenantId, bucket, objectKey) {
      const rows = await query(
        "select * from objects where tenant_id = $1 and bucket = $2 and object_key = $3",
        [tenantId, bucket, objectKey],
      );
      return objectRow(rows[0]);
    },
    async listObjects(tenantId, bucket) {
      const rows = await query(
        "select object_key, size_bytes, content_type, created_at from objects where tenant_id = $1 and bucket = $2 order by object_key",
        [tenantId, bucket],
      );
      return rows.map((row) => ({ ...row, size_bytes: num(row.size_bytes) }));
    },
    async projectUsage() {
      const rows = await query(
        "select coalesce(sum(used_bytes), 0) as used_bytes, coalesce(sum(used_objects), 0) as used_objects from tenants",
      );
      return { usedBytes: num(rows[0]?.used_bytes), usedObjects: num(rows[0]?.used_objects) };
    },
    async counts() {
      const tenants = await query("select count(*) as n from tenants");
      const objects = await query("select count(*) as n from objects");
      const shares = await query("select count(*) as n from shares");
      const usage = await this.projectUsage();
      return {
        tenants: num(tenants[0]?.n),
        objects: num(objects[0]?.n),
        shares: num(shares[0]?.n),
        bytes: usage.usedBytes,
      };
    },
    async dump() {
      return {
        tenants: (await query("select * from tenants order by id")).map(tenantRow),
        objects: (await query("select * from objects order by blob_id")).map(objectRow),
        shares: await query("select * from shares order by id"),
      };
    },
    async isEmpty() {
      const counts = await this.counts();
      return counts.tenants === 0 && counts.objects === 0 && counts.shares === 0;
    },
  };
}

