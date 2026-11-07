import { CoverageMap } from "@/components/exchange/coverage";
import {
  MODALITY_LABEL,
  PRODUCT_LABEL,
  REGION_LABEL,
  money,
  splitAmount,
  splitHolds,
} from "@/lib/exchange/model";
import { session, useExchange } from "@/lib/exchange/store";

export function DetailView() {
  const id = useExchange((state) => state.selectedId);
  const dataset = useExchange((state) => state.datasets.find((item) => item.id === id));
  const consent = useExchange((state) => state.consents.find((item) => item.datasetId === id));
  const sale = useExchange((state) => state.sales.find((item) => item.datasetId === id));
  const notice = useExchange((state) => state.notice);
  const wallet = useExchange((state) => state.walletUsd);
  const license = useExchange((state) => state.license);
  const revoke = useExchange((state) => state.revoke);
  const setView = useExchange((state) => state.setView);

  if (!dataset) {
    return (
      <section className="pane">
        <p className="lede">Pick a listing from the market.</p>
        <button className="btn" type="button" onClick={() => setView("market")}>
          Back to market
        </button>
      </section>
    );
  }

  const parts = splitAmount(dataset.priceUsd, dataset.revSharePct);
  const owns = dataset.ownerCid === session.cid;
  const affordable = wallet >= dataset.priceUsd;
  const splitOk = sale ? splitHolds(sale, dataset.revSharePct) : true;

  return (
    <section className="pane">
      <button className="btn-quiet" type="button" onClick={() => setView("market")}>
        Market
      </button>
      <div className="pane-head">
        <div>
          <h1 className="pane-title">{dataset.title}</h1>
          <p className="lede">{dataset.description}</p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      <div className="split">
        <div className="stack">
          <div className="tags">
            <span className="tag">{PRODUCT_LABEL[dataset.product]}</span>
            <span className="tag">{MODALITY_LABEL[dataset.modality]}</span>
            <span className="tag">{REGION_LABEL[dataset.region]}</span>
            <span className="tag">{dataset.privacyLevel}</span>
            <span className="tag">{dataset.status}</span>
          </div>
          {dataset.bbox ? <CoverageMap datasets={[dataset]} onOpen={() => undefined} /> : null}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {dataset.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataset.rows.slice(0, 4).map((row, index) => (
                  <tr key={`${dataset.id}-${index}`}>
                    {dataset.columns.map((column) => (
                      <td key={column}>{String(row[column] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mono">
            Schema {dataset.schema} · {dataset.sizeEstimate.toLocaleString("en-US")} records ·{" "}
            {dataset.licenseTerms}
          </p>
        </div>
        <aside className="stack">
          <div className="card">
            <h3>{money(dataset.priceUsd)}</h3>
            <p className="lede">
              Owner {dataset.ownerName} receives {money(parts.userShareUsd)}. Platform keeps{" "}
              {money(parts.platformShareUsd)}.
            </p>
            <div className="actions">
              <button
                className="btn-primary"
                type="button"
                disabled={dataset.status !== "listed" || owns || !affordable}
                onClick={() => license(dataset.id)}
              >
                {dataset.status === "sold"
                  ? "Sold"
                  : dataset.status === "revoked"
                    ? "Revoked"
                    : owns
                      ? "Your listing"
                      : affordable
                        ? "License"
                        : "Insufficient balance"}
              </button>
              {owns && consent?.granted ? (
                <button className="btn" type="button" onClick={() => revoke(dataset.id)}>
                  Revoke consent
                </button>
              ) : null}
            </div>
          </div>
          <div className="card">
            <h3>Consent</h3>
            <p className="mono">
              {consent ? `${consent.id} · ${consent.granted ? "granted" : "revoked"}` : "No grant"}
            </p>
            <p className="lede">{dataset.scopes.join(", ")}</p>
            {consent?.firmamentTx ? <p className="mono">{consent.firmamentTx}</p> : null}
          </div>
          {sale ? (
            <div className="card">
              <h3>Last sale</h3>
              <p className="lede">
                {sale.buyerName} · {sale.cdatTokenId} · split {splitOk ? "holds at 85/15" : "does not match"}
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
