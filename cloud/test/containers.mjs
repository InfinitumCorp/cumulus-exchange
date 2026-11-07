import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const composeFile = fileURLToPath(new URL("../deploy/docker-compose.yml", import.meta.url));

function compose(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-f", composeFile, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose exited ${code}`));
    });
  });
}

async function waitForPostgres() {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? pg.Pool;
  const deadline = Date.now() + 40000;
  let last = null;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: "postgres://cumulus:cumulus@127.0.0.1:54329/cumulus" });
    try {
      await pool.query("select 1");
      await pool.end();
      return;
    } catch (error) {
      last = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw last ?? new Error("postgres was not ready");
}

async function waitForS3() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8333/");
      if (response.status < 500) return;
    } catch {
      /* gateway still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("seaweedfs S3 was not ready");
}

let started = null;

export function ensureContainers() {
  if (!started) {
    started = (async () => {
      await compose(["up", "-d"]);
      await waitForPostgres();
      await waitForS3();
    })();
  }
  return started;
}

export const POSTGRES_URL = "postgres://cumulus:cumulus@127.0.0.1:54329/cumulus";
export const S3_ENDPOINT = "http://127.0.0.1:8333";
