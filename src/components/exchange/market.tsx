import { useState } from "react";
import { CoverageMap } from "@/components/exchange/coverage";
import {
  MODALITY_LABEL,
  PRODUCT_LABEL,
  REGION_LABEL,
  money,
  type Modality,
  type ProductId,
  type RegionId,
} from "@/lib/exchange/model";
import { scoreOf, useExchange, visibleDatasets } from "@/lib/exchange/store";
import { startConjure, followConjure } from "@/lib/exchange/conjure";

const MENTION = /(^|[^\w@./])@conjure(?![\w-]|\.[a-z])/i;

const PRODUCTS = Object.keys(PRODUCT_LABEL) as ProductId[];
const MODALITIES = Object.keys(MODALITY_LABEL) as Modality[];
const REGIONS = Object.keys(REGION_LABEL) as RegionId[];

export function MarketView() {
  const [coverage, setCoverage] = useState(false);
  const [forecast, setForecast] = useState<{ text: string; busy: boolean } | null>(null);
  const search = useExchange((state) => state.search);
  const product = useExchange((state) => state.product);
  const modality = useExchange((state) => state.modality);
  const region = useExchange((state) => state.region);
  const cloudMax = useExchange((state) => state.cloudMax);
  const notice = useExchange((state) => state.notice);
  const setSearch = useExchange((state) => state.setSearch);
  const setProduct = useExchange((state) => state.setProduct);
  const setModality = useExchange((state) => state.setModality);
  const setRegion = useExchange((state) => state.setRegion);
  const setCloudMax = useExchange((state) => state.setCloudMax);
  const open = useExchange((state) => state.open);
  const datasets = useExchange((state) => state.datasets);
  const rows = visibleDatasets({
    datasets,
    search,
    product,
    modality,
    region,
    cloudMax,
  } as Parameters<typeof visibleDatasets>[0]);
  const listed = datasets.filter((dataset) => dataset.status === "listed").length;
  // "@conjure <question>" in the search box: a live Conjure forecast over the datasets in view.
  async function conjure() {
    if (!MENTION.test(search) || forecast?.busy) return;
    const context = rows.slice(0, 40).map((d) => `- ${d.title} (${PRODUCT_LABEL[d.product]}, ${MODALITY_LABEL[d.modality]}, ${d.region.toUpperCase()}, ${d.status === "listed" ? money(d.priceUsd) : "sold"})`).join("\n");
    setForecast({ text: "Conjure™ is starting a forecast…", busy: true });
    try {
      let result = await startConjure({ data: { text: search, context: context ? `Datasets in view:\n${context}` : "" } });
      if (result.error || !result.mention) return setForecast({ text: result.error || "Write a question after @conjure.", busy: false });
      setForecast({ text: result.text ?? "", busy: true });
      for (let i = 0; i < 300 && result.ticket && !["done", "failed", "cancelled"].includes(result.prediction?.status ?? ""); i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const next = await followConjure({ data: { ticket: result.ticket } });
        if (next.error) break;
        result = { ...result, ...next };
        setForecast({ text: next.text ?? "", busy: true });
      }
      setForecast((f) => (f ? { ...f, busy: false } : f));
    } catch (error) {
      setForecast({ text: error instanceof Error ? error.message : "Conjure is unavailable right now.", busy: false });
    }
  }
  const volume = datasets
    .filter((dataset) => dataset.status === "listed")
    .reduce((sum, dataset) => sum + dataset.priceUsd, 0);

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">License opted-in data</h1>
          <p className="lede">
            Cumulus://Cloud is Cumulus Drive. You keep 85%. One soulbound CDAT per sale. Military
            editions and government workloads stay off the product.
          </p>
        </div>
        <button className="btn" type="button" onClick={() => setCoverage((value) => !value)}>
          {coverage ? "Hide coverage" : "Coverage"}
        </button>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      <div className="stats">
        <div className="stat">
          <span>Listed</span>
          <b>{listed}</b>
        </div>
        <div className="stat">
          <span>Ask</span>
          <b>{money(volume)}</b>
        </div>
        <div className="stat">
          <span>Owner share</span>
          <b>85%</b>
        </div>
        <div className="stat">
          <span>Showing</span>
          <b>{rows.length}</b>
        </div>
      </div>
      <div className="filters">
        <input
          className="search"
          value={search}
          placeholder="Search by meaning — ships, forecast, mosaic, agent"
          aria-label="Search the catalog by meaning, or ask @conjure"
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void conjure();
          }}
        />
        <select
          className="field"
          aria-label="Product"
          value={product}
          onChange={(event) => setProduct(event.target.value as ProductId | "all")}
        >
          <option value="all">All products</option>
          {PRODUCTS.map((id) => (
            <option key={id} value={id}>
              {PRODUCT_LABEL[id]}
            </option>
          ))}
        </select>
        <select
          className="field"
          aria-label="Modality"
          value={modality}
          onChange={(event) => setModality(event.target.value as Modality | "all")}
        >
          <option value="all">All modalities</option>
          {MODALITIES.map((id) => (
            <option key={id} value={id}>
              {MODALITY_LABEL[id]}
            </option>
          ))}
        </select>
        <select
          className="field"
          aria-label="Residency"
          value={region}
          onChange={(event) => setRegion(event.target.value as RegionId | "all")}
        >
          <option value="all">All regions</option>
          {REGIONS.map((id) => (
            <option key={id} value={id}>
              {REGION_LABEL[id]}
            </option>
          ))}
        </select>
      </div>
      <label className="lede">
        Cloud cover at most {cloudMax}%
        <input
          type="range"
          min={0}
          max={100}
          value={cloudMax}
          aria-label="Maximum cloud cover"
          onChange={(event) => setCloudMax(Number(event.target.value))}
        />
      </label>
      {forecast ? (
        <div className="notice" role="status" aria-live="polite" style={{ whiteSpace: "pre-wrap" }}>
          {forecast.text}
        </div>
      ) : null}
      {coverage ? <CoverageMap datasets={rows} onOpen={open} /> : null}
      <div className="list">
        {rows.length === 0 ? (
          <p className="lede">Nothing matches. Clear the meaning search or raise the cloud limit.</p>
        ) : (
          rows.map((dataset) => {
            const score = scoreOf(dataset, search);
            return (
              <button key={dataset.id} className="row" type="button" onClick={() => open(dataset.id)}>
                <span>
                  <span className="row-title">{dataset.title}</span>
                  <span className="row-meta">
                    {" "}
                    {PRODUCT_LABEL[dataset.product]} · {dataset.ownerName}
                    {search.trim() ? ` · match ${Math.round(Math.min(score, 2) * 50)}` : ""}
                    {dataset.status === "sold" ? " · sold" : ""}
                  </span>
                </span>
                <span className="hide-sm mono">{MODALITY_LABEL[dataset.modality]}</span>
                <span className="hide-sm mono">{dataset.region.toUpperCase()}</span>
                <span className="hide-sm mono">{dataset.privacyLevel}</span>
                <span className="row-price">
                  {dataset.status === "listed" ? money(dataset.priceUsd) : "Sold"}
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
