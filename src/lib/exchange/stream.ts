import type { Dataset, RegionId } from "@/lib/exchange/model";

export const REGION_CENTER: Record<RegionId, { lat: number; lon: number }> = {
  iad: { lat: 39.04, lon: -77.49 },
  lhr: { lat: 51.47, lon: -0.45 },
  fra: { lat: 50.03, lon: 8.57 },
  nrt: { lat: 35.77, lon: 140.39 },
  syd: { lat: -33.94, lon: 151.18 },
};

export interface AssetFix {
  id: string;
  datasetId: string;
  title: string;
  kind: "dataset" | "asset";
  lat: number;
  lon: number;
}

export interface AssetTick {
  id: string;
  datasetId: string;
  lat: number;
  lon: number;
  at: string;
  seq: number;
}

export function positionOf(dataset: Dataset): { lat: number; lon: number } {
  if (dataset.bbox) {
    const [west, south, east, north] = dataset.bbox;
    return { lat: (south + north) / 2, lon: (west + east) / 2 };
  }
  return REGION_CENTER[dataset.region];
}

export function assetFixes(datasets: Dataset[]): AssetFix[] {
  return datasets
    .filter((dataset) => dataset.status === "listed" || dataset.status === "sold")
    .map((dataset) => {
      const at = positionOf(dataset);
      return {
        id: `asset_${dataset.id}`,
        datasetId: dataset.id,
        title: dataset.title,
        kind: dataset.modality === "aggregate" ? "dataset" : "asset",
        lat: at.lat,
        lon: at.lon,
      };
    });
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Deterministic preview drift for observation assets. Not a live sensor feed. */
export function drift(fix: AssetFix, seq: number): AssetFix {
  if (fix.kind !== "asset") return fix;
  const step = (seq % 8) - 3;
  return {
    ...fix,
    lat: round6(fix.lat + step * 0.01),
    lon: round6(fix.lon + step * 0.01),
  };
}

export function encodeSse(tick: AssetTick): string {
  return `event: asset\ndata: ${JSON.stringify(tick)}\n\n`;
}

export function decodeSse(frame: string): AssetTick | null {
  const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(6)) as Partial<AssetTick>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.datasetId !== "string" ||
      typeof parsed.lat !== "number" ||
      typeof parsed.lon !== "number" ||
      typeof parsed.seq !== "number"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      datasetId: parsed.datasetId,
      lat: parsed.lat,
      lon: parsed.lon,
      at: typeof parsed.at === "string" ? parsed.at : "",
      seq: parsed.seq,
    };
  } catch {
    return null;
  }
}

export function createPreviewFeed(datasets: Dataset[], intervalMs = 2000) {
  let seq = 0;
  let fixes = assetFixes(datasets);
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(tick: AssetTick) => void>();
  return {
    snapshot: () => fixes.map((fix) => ({ ...fix })),
    subscribe(listener: (tick: AssetTick) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        seq += 1;
        fixes = fixes.map((fix) => drift(fix, seq));
        const moved = fixes.find((fix) => fix.kind === "asset");
        if (!moved) return;
        const tick: AssetTick = {
          id: moved.id,
          datasetId: moved.datasetId,
          lat: moved.lat,
          lon: moved.lon,
          at: new Date().toISOString(),
          seq,
        };
        const decoded = decodeSse(encodeSse(tick));
        if (!decoded) return;
        for (const listener of listeners) listener(decoded);
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
