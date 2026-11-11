import { writeFile } from "node:fs/promises";
import { auth } from "@/lib/auth/server";
import { getSql } from "@/lib/db";
import { getObject, getShared } from "@/lib/drive/http";
import { closeDrive } from "@/lib/drive/service";
import { testSessionCookie } from "@/lib/drive/test-session";

const [role, id, outFile] = process.argv.slice(2);
const email = process.env.CUMULUS_TEST_EMAIL ?? "";
const token = process.env.CUMULUS_TEST_SHARE_TOKEN ?? "";

await getSql();
if (role === "read") {
  const cookie = await testSessionCookie(auth, email, email);
  const response = await getObject(new Request("http://localhost:8080/api/drive/objects/" + id, { headers: { cookie } }), id);
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
} else if (role === "shared") {
  const response = await getShared(
    new Request("http://localhost:8080/api/drive/shared", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  await writeFile(outFile, Buffer.from(await response.arrayBuffer()));
} else {
  console.error("unknown role");
  process.exit(1);
}
await closeDrive();
