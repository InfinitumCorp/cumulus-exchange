export const GEO_ROUTING_KEY = "infinitum-geo-routing";

export function readGeoRouting(storage: Pick<Storage, "getItem"> | null): boolean {
  if (!storage) return false;
  return storage.getItem(GEO_ROUTING_KEY) === "1";
}

export function writeGeoRouting(storage: Pick<Storage, "setItem"> | null, enabled: boolean): void {
  if (!storage) return;
  storage.setItem(GEO_ROUTING_KEY, enabled ? "1" : "0");
}
