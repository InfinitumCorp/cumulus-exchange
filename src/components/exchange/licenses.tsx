import { PRODUCT_LABEL, isActiveToken, money } from "@/lib/exchange/model";
import { session, useExchange } from "@/lib/exchange/store";

export function LicensesView() {
  const tokens = useExchange((state) => state.tokens);
  const datasets = useExchange((state) => state.datasets);
  const notice = useExchange((state) => state.notice);
  const open = useExchange((state) => state.open);
  const setView = useExchange((state) => state.setView);
  const setQueryDataset = useExchange((state) => state.setQueryDataset);
  const held = tokens.filter((token) => token.licensee === session.cid);
  const issued = tokens.filter((token) => token.ownerCid === session.cid);

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">CDAT licenses</h1>
          <p className="lede">
            A sale mints one soulbound license for the term. Revoking consent burns it.
          </p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      <h2 className="pane-title">Held</h2>
      <div className="list">
        {held.length === 0 ? <p className="lede">You have not licensed a set yet.</p> : null}
        {held.map((token) => {
          const dataset = datasets.find((item) => item.id === token.datasetId);
          const live = isActiveToken(token);
          return (
            <button key={token.tokenId} className="row" type="button" onClick={() => open(token.datasetId)}>
              <span>
                <span className="row-title">{dataset?.title ?? token.datasetId}</span>
                <span className="row-meta">
                  {" "}
                  {token.tokenId} · {live ? "active" : "burned or expired"} · through{" "}
                  {token.expiresAt.slice(0, 10)}
                </span>
              </span>
              <span className="row-price">{money(token.amountUsd)}</span>
            </button>
          );
        })}
      </div>
      <h2 className="pane-title">Issued from your data</h2>
      <div className="list">
        {issued.length === 0 ? <p className="lede">No one has licensed your listings.</p> : null}
        {issued.map((token) => {
          const dataset = datasets.find((item) => item.id === token.datasetId);
          return (
            <div key={token.tokenId} className="row">
              <span>
                <span className="row-title">{dataset?.title ?? token.datasetId}</span>
                <span className="row-meta">
                  {" "}
                  {PRODUCT_LABEL[dataset?.product ?? "cumulus"]} · licensee {token.licensee} ·{" "}
                  {token.burned ? "burned" : token.tokenId}
                </span>
              </span>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setQueryDataset(token.datasetId);
                  setView("query");
                }}
              >
                Query
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
