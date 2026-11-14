/** Browser client for the cloud-plane Drive handler mounted at /api/drive. */

export const DRIVE_API = "/api/drive";
export const DRIVE_BUCKET = "drive";

export type DrivePurpose = "drive.read" | "drive.write" | "drive.share";

export function driveHeaders(token: string, purpose: DrivePurpose): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-cumulus-purpose": purpose,
  };
}

export function driveObjectUrl(bucket: string, key?: string): string {
  const base = `${DRIVE_API}/v1/objects/${encodeURIComponent(bucket)}`;
  return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
}

export function previewShareHref(url: string): string {
  try {
    const parsed = new URL(url, "https://cloud.cumuluscloud.app");
    if (parsed.pathname === "/v1/shared") {
      return `${DRIVE_API}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return url;
  }
  return url;
}

/**
 * The reason a Drive call was refused, for the notice line. Reads the cloud
 * function's `{ error: { message } }` and the session store's `{ message }`;
 * anything else, or an unreadable body, gives the fallback.
 */
export async function refusalReason(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown; error?: { message?: unknown } } | null;
  const raw = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : "";
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return fallback;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
