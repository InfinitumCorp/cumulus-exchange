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
