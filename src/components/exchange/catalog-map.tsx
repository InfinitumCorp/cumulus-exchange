import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet.markercluster";
import type { Dataset } from "@/lib/exchange/model";
import { createPreviewFeed, type AssetFix } from "@/lib/exchange/stream";

export function CatalogMap({
  datasets,
  onOpen,
}: {
  datasets: Dataset[];
  onOpen: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onOpenRef = useRef(onOpen);
  const dataRef = useRef(datasets);
  const [stream, setStream] = useState("Preview stream · idle");
  onOpenRef.current = onOpen;
  dataRef.current = datasets;
  const signature = datasets.map((dataset) => `${dataset.id}:${dataset.status}`).join("|");

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const pane = node as HTMLElement & { _leaflet_id?: number };
    delete pane._leaflet_id;
    const map = L.map(node, {
      zoomControl: true,
      attributionControl: true,
      minZoom: 1,
      maxZoom: 6,
    }).setView([22, 8], 2);
    const SchematicTiles = L.GridLayer.extend({
      createTile(coords: L.Coords) {
        const tile = document.createElement("canvas");
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        const ctx = tile.getContext("2d");
        if (!ctx) return tile;
        ctx.fillStyle = "#f3f5f7";
        ctx.fillRect(0, 0, size.x, size.y);
        ctx.strokeStyle = "#d6dce1";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(size.x, size.y);
        ctx.moveTo(size.x, 0);
        ctx.lineTo(0, size.y);
        ctx.stroke();
        ctx.fillStyle = "#52606b";
        ctx.font = "12px sans-serif";
        ctx.fillText(`${coords.z}/${coords.x}/${coords.y}`, 8, 18);
        return tile;
      },
    }) as new (options?: L.GridLayerOptions) => L.GridLayer;
    new SchematicTiles({ attribution: "Schematic preview · Infinitum Corporation®" }).addTo(map);
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      iconCreateFunction(group) {
        return L.divIcon({
          className: "asset-cluster",
          html: `<span>${group.getChildCount()}</span>`,
          iconSize: L.point(36, 36),
        });
      },
    });
    map.addLayer(cluster);
    const markers = new Map<string, L.Marker>();
    const paint = (fixes: AssetFix[]) => {
      for (const fix of fixes) {
        const existing = markers.get(fix.id);
        if (existing) {
          existing.setLatLng([fix.lat, fix.lon]);
          continue;
        }
        const marker = L.marker([fix.lat, fix.lon], {
          title: fix.title,
          icon: L.divIcon({
            className: fix.kind === "asset" ? "asset-pin asset-pin-live" : "asset-pin",
            html: "<span></span>",
            iconSize: [14, 14],
          }),
        });
        marker.on("click", () => onOpenRef.current(fix.datasetId));
        cluster.addLayer(marker);
        markers.set(fix.id, marker);
      }
    };
    const feed = createPreviewFeed(dataRef.current);
    paint(feed.snapshot());
    let alive = true;
    feed.subscribe((tick) => {
      if (!alive) return;
      const marker = markers.get(tick.id);
      marker?.setLatLng([tick.lat, tick.lon]);
      setStream(`Preview stream · ${tick.id} · seq ${tick.seq}`);
    });
    feed.start();
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => {
      alive = false;
      feed.stop();
      window.cancelAnimationFrame(frame);
      map.remove();
    };
  }, [signature]);

  return (
    <div className="catalog-map-wrap">
      <div ref={host} className="catalog-map" role="application" aria-label="Catalog map of licensed datasets and assets" />
      <p className="mono">{stream}. Mock SSE. Not a live sensor.</p>
    </div>
  );
}
