import { useState } from "react";
import { Overlay2, Switch } from "@blueprintjs/core";
import { CoverageMap } from "@/components/exchange/coverage";
import {
  MODALITY_LABEL,
  PRODUCT_LABEL,
  REGION_LABEL,
  canRead,
  money,
  moneyCents,
  splitAmount,
  splitHolds,
} from "@/lib/exchange/model";
import { useExchange } from "@/lib/exchange/store";

export function DetailView() {
  const [offerOpen, setOfferOpen] = useState(false);
  const id = useExchange((state) => state.selectedId);
  const dataset = useExchange((state) => state.datasets.find((item) => item.id === id));
  const consent = useExchange((state) => state.consents.find((item) => item.datasetId === id));
  const sales = useExchange((state) => state.sales);
  const licenses = useExchange((state) => state.licenses);
  const sale = sales.find((item) => item.datasetId === id && item.status === "completed");
  const offers = licenses.filter((item) => item.datasetId === id);
  const tokens = useExchange((state) => state.tokens);
  const actorCid = useExchange((state) => state.actorCid);
  const notice = useExchange((state) => state.notice);
  const wallet = useExchange((state) => state.walletUsd);
  const license = useExchange((state) => state.license);
  const accept = useExchange((state) => state.accept);
  const revokeLicense = useExchange((state) => state.revokeLicense);
  const setScopeGrant = useExchange((state) => state.setScopeGrant);
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
  const owns = dataset.ownerCid === actorCid;
  const readable = canRead(dataset, tokens, actorCid);
  const affordable = wallet >= dataset.priceUsd;
  const splitOk = sale ? splitHolds(sale, dataset.revSharePct) : true;
  const openOffer = offers.find((item) => item.phase === "offered" && item.licenseeCid === actorCid);

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
          {readable ? (
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
          ) : (
            <p className="lede">Sample rows stay in the owner tenant until a CDAT is accepted.</p>
          )}
          <p className="mono">
            Schema {dataset.schema} · {dataset.sizeEstimate.toLocaleString("en-US")} records ·{" "}
            {dataset.licenseTerms}
          </p>
        </div>
        <aside className="stack">
          <div className="card">
            <h3>{money(dataset.priceUsd)}</h3>
            <p className="lede">
              Owner {dataset.ownerName} receives {moneyCents(parts.ownerCents)}. Platform keeps{" "}
              {moneyCents(parts.platformCents)}. Integer cents, 85/15.
            </p>
            <div className="actions">
              <button
                className="btn-primary"
                type="button"
                disabled={dataset.status !== "listed" || owns || !affordable || Boolean(openOffer)}
                onClick={() => setOfferOpen(true)}
              >
                {openOffer
                  ? "Offer pending"
                  : dataset.status === "sold"
                    ? "Sold"
                    : dataset.status === "revoked"
                      ? "Revoked"
                      : owns
                        ? "Your listing"
                        : affordable
                          ? "Offer to license"
                          : "Insufficient balance"}
              </button>
              {owns && consent?.granted ? (
                <button className="btn" type="button" onClick={() => revoke(dataset.id)}>
                  Revoke consent
                </button>
              ) : null}
            </div>
            {offers
              .filter((item) => item.phase === "offered")
              .map((item) => (
                <div key={item.id} className="actions">
                  <span className="mono">
                    {item.id} · {item.licenseeName} · {moneyCents(item.amountCents)}
                  </span>
                  {owns ? (
                    <button className="btn-primary" type="button" onClick={() => accept(item.id)}>
                      Accept
                    </button>
                  ) : null}
                  {owns || item.licenseeCid === actorCid ? (
                    <button className="btn" type="button" onClick={() => revokeLicense(item.id)}>
                      {owns ? "Decline" : "Withdraw"}
                    </button>
                  ) : null}
                </div>
              ))}
          </div>
          <div className="card">
            <h3>Consent</h3>
            <p className="mono">
              {consent ? `${consent.id} · ${consent.granted ? "opted in" : "revoked"}` : "No grant"}
            </p>
            {consent?.decisions.map((decision) => (
              <Switch
                key={decision.scope}
                checked={decision.granted}
                disabled={!owns}
                label={decision.scope}
                onChange={(event) => setScopeGrant(dataset.id, decision.scope, event.currentTarget.checked)}
              />
            ))}
            {consent?.firmamentTx ? <p className="mono">{consent.firmamentTx}</p> : null}
          </div>
          <Overlay2 isOpen={offerOpen} onClose={() => setOfferOpen(false)}>
            <div className="offer-overlay" role="dialog" aria-label="License offer">
              <h3>Offer {money(dataset.priceUsd)}</h3>
              <p className="lede">
                This places an offer. {dataset.ownerName} accepts it. No payment is sent until then, and
                nothing here charges a card.
              </p>
              <div className="actions">
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => {
                    license(dataset.id);
                    setOfferOpen(false);
                  }}
                >
                  Place offer
                </button>
                <button className="btn" type="button" onClick={() => setOfferOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </Overlay2>
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
