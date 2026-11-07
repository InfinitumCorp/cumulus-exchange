import { useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money, splitHolds } from "@/lib/exchange/model";
import { session, useExchange } from "@/lib/exchange/store";

export function LedgerView() {
  const [ready, setReady] = useState(false);
  const ledger = useExchange((state) => state.ledger);
  const payouts = useExchange((state) => state.payouts);
  const sales = useExchange((state) => state.sales);
  const datasets = useExchange((state) => state.datasets);
  const platform = useExchange((state) => state.platformUsd);
  const notice = useExchange((state) => state.notice);
  const settle = useExchange((state) => state.settle);
  const reset = useExchange((state) => state.reset);

  useEffect(() => {
    setReady(true);
  }, []);

  const pendingSum = payouts
    .filter((payout) => payout.cid === session.cid && !payout.paid)
    .reduce((sum, payout) => sum + payout.amountUsd, 0);
  const chart = sales.map((sale) => ({
    name: sale.cdatTokenId ?? sale.id.slice(0, 8),
    owner: sale.userShareUsd,
    platform: sale.platformShareUsd,
  }));

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">Firmament preview</h1>
          <p className="lede">
            Hash-chained locally. Production signs each grant, license, and payment with Ed25519.
            Your pending owner share is {money(pendingSum)}. Platform treasury {money(platform)}.
          </p>
        </div>
        <button className="btn" type="button" onClick={reset}>
          Reset demo
        </button>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {ready && chart.length > 0 ? (
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart}>
              <XAxis dataKey="name" tick={{ fill: "var(--color-muted)", fontSize: 11 }} />
              <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="owner" stackId="split" fill="var(--color-accent)" />
              <Bar dataKey="platform" stackId="split" fill="var(--color-ink)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      <h2 className="pane-title">Payouts</h2>
      <div className="list">
        {payouts.map((payout) => {
          const sale = sales.find((item) => item.id === payout.saleId);
          const dataset = datasets.find((item) => item.id === sale?.datasetId);
          const holds = sale && dataset ? splitHolds(sale, dataset.revSharePct) : false;
          return (
            <div key={payout.saleId} className="row">
              <span>
                <span className="row-title">{dataset?.title ?? payout.saleId}</span>
                <span className="row-meta">
                  {" "}
                  {payout.cid} · {payout.paid ? "paid" : "pending"} · split {holds ? "holds" : "check"}
                </span>
              </span>
              {!payout.paid ? (
                <button className="btn" type="button" onClick={() => settle(payout.saleId)}>
                  Settle {money(payout.amountUsd)}
                </button>
              ) : (
                <span className="row-price">Paid</span>
              )}
            </div>
          );
        })}
      </div>
      <h2 className="pane-title">Chain</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Summary</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {[...ledger].reverse().slice(0, 12).map((entry) => (
              <tr key={entry.hash}>
                <td>{entry.index}</td>
                <td>{entry.type}</td>
                <td>{entry.summary}</td>
                <td className="mono">{entry.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="foot">Showing the latest 12 of {ledger.length} preview entries.</p>
    </section>
  );
}
