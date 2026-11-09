import { useMemo, useState } from "react";
import { seedDatasets } from "@/lib/exchange/seed";
import {
  PRODUCT_LABEL,
  REGION_LABEL,
  applyRecipe,
  money,
  type ProductId,
  type Recipe,
  type RegionId,
} from "@/lib/exchange/model";
import { peerPrice, useExchange } from "@/lib/exchange/store";

const TEMPLATES = seedDatasets().filter((dataset) => dataset.product !== "observation");

export function CollectView() {
  const datasets = useExchange((state) => state.datasets);
  const notice = useExchange((state) => state.notice);
  const publish = useExchange((state) => state.publish);
  const [product, setProduct] = useState<ProductId | null>(null);
  const [price, setPrice] = useState(0);
  const [region, setRegion] = useState<RegionId>("iad");
  const [scopes, setScopes] = useState<string[]>([]);
  const [redact, setRedact] = useState<string[]>([]);
  const [bucket, setBucket] = useState<string[]>([]);

  const template = TEMPLATES.find((item) => item.product === product) ?? null;
  const recipe: Recipe = useMemo(() => ({ drop: [], redact, bucket }), [redact, bucket]);
  const preview = template ? applyRecipe(template.rows, recipe) : [];
  const suggested = template ? peerPrice(datasets, template.product, template.priceUsd) : 0;

  function choose(next: ProductId) {
    const item = TEMPLATES.find((entry) => entry.product === next);
    if (!item) return;
    setProduct(next);
    setPrice(item.priceUsd);
    setRegion(item.region);
    setScopes([]);
    setRedact([]);
    setBucket([]);
  }

  function toggle(list: string[], column: string, setList: (value: string[]) => void) {
    setList(list.includes(column) ? list.filter((item) => item !== column) : [...list, column]);
  }

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">Collectors</h1>
          <p className="lede">
            Each Infinitum product can package an aggregate after you consent. Hardware platforms and
            military editions do not feed Cumulus://Cloud. ei·det·ic publishes query volume only.
          </p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      <div className="list">
        {TEMPLATES.map((item) => (
          <button
            key={item.product}
            className="row"
            type="button"
            onClick={() => choose(item.product)}
          >
            <span>
              <span className="row-title">{PRODUCT_LABEL[item.product]}</span>
              <span className="row-meta"> {item.title}</span>
            </span>
            <span className="row-price">{money(item.priceUsd)}</span>
          </button>
        ))}
      </div>
      {template ? (
        <div className="card">
          <h3>{template.title}</h3>
          <p className="lede">{template.description}</p>
          <div className="filters">
            <label className="lede">
              Price
              <input
                className="field"
                type="number"
                min={1}
                aria-label="Price in USD"
                value={price}
                onChange={(event) => setPrice(Number(event.target.value))}
              />
            </label>
            <button className="btn" type="button" onClick={() => setPrice(suggested)}>
              Peer price {money(suggested)}
            </button>
            <select
              className="field"
              aria-label="Residency region"
              value={region}
              onChange={(event) => setRegion(event.target.value as RegionId)}
            >
              {(Object.keys(REGION_LABEL) as RegionId[]).map((id) => (
                <option key={id} value={id}>
                  {REGION_LABEL[id]}
                </option>
              ))}
            </select>
          </div>
          <p className="lede">Prep recipe. Redact replaces a column. Bucket rounds numbers to tens.</p>
          <div className="tags">
            {template.columns.map((column) => (
              <span key={column} className="tag">
                {column}{" "}
                <button type="button" className="btn-quiet" onClick={() => toggle(redact, column, setRedact)}>
                  {redact.includes(column) ? "redacted" : "redact"}
                </button>
                <button type="button" className="btn-quiet" onClick={() => toggle(bucket, column, setBucket)}>
                  {bucket.includes(column) ? "bucketed" : "bucket"}
                </button>
              </span>
            ))}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {Object.keys(preview[0] ?? {}).map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, index) => (
                  <tr key={`${template.product}-${index}`}>
                    {Object.keys(preview[0] ?? {}).map((column) => (
                      <td key={column}>{String(row[column] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="lede">Opt in to each scope. Unchecked scopes stay off the exchange.</p>
          {template.scopes.map((scope) => (
            <label className="check" key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                  )
                }
              />
              <span>I consent to license {scope}. This grant can be revoked.</span>
            </label>
          ))}
          <div className="actions">
            <button
              className="btn-primary"
              type="button"
              disabled={scopes.length === 0 || !Number.isFinite(price) || price <= 0}
              onClick={() =>
                publish({
                  product: template.product,
                  title: template.title,
                  description: template.description,
                  rows: template.rows,
                  scopes,
                  licenseTerms: template.licenseTerms,
                  priceUsd: price,
                  region,
                  modality: template.modality,
                  topics: template.topics,
                  recipe,
                })
              }
            >
              List for {money(price || 0)}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
