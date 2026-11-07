import type { Dataset } from "@/lib/exchange/model";

const WIDTH = 640;
const HEIGHT = 320;

function project(lon: number, lat: number) {
  return {
    x: ((lon + 180) / 360) * WIDTH,
    y: ((90 - lat) / 180) * HEIGHT,
  };
}

export function CoverageMap({
  datasets,
  onOpen,
}: {
  datasets: Dataset[];
  onOpen: (id: string) => void;
}) {
  const footprints = datasets.filter((dataset) => dataset.bbox);
  return (
    <svg className="map" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Coverage footprints">
      {Array.from({ length: 7 }, (_, index) => {
        const x = (index / 6) * WIDTH;
        return (
          <line key={`v${index}`} x1={x} y1={0} x2={x} y2={HEIGHT} stroke="var(--color-line)" />
        );
      })}
      {Array.from({ length: 5 }, (_, index) => {
        const y = (index / 4) * HEIGHT;
        return (
          <line key={`h${index}`} x1={0} y1={y} x2={WIDTH} y2={y} stroke="var(--color-line)" />
        );
      })}
      {footprints.map((dataset) => {
        const box = dataset.bbox;
        if (!box) return null;
        const a = project(box[0], box[3]);
        const b = project(box[2], box[1]);
        return (
          <rect
            key={dataset.id}
            x={a.x}
            y={a.y}
            width={Math.max(8, b.x - a.x)}
            height={Math.max(8, b.y - a.y)}
            fill="var(--color-accent)"
            fillOpacity={0.18}
            stroke="var(--color-accent)"
            tabIndex={0}
            role="button"
            aria-label={dataset.title}
            onClick={() => onOpen(dataset.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(dataset.id);
              }
            }}
          >
            <title>{dataset.title}</title>
          </rect>
        );
      })}
    </svg>
  );
}
