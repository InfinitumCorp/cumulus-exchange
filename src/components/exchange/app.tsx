import { useEffect } from "react";
import { CollectView } from "@/components/exchange/collect";
import { DetailView } from "@/components/exchange/detail";
import { LedgerView } from "@/components/exchange/ledger";
import { LicensesView } from "@/components/exchange/licenses";
import { MarketView } from "@/components/exchange/market";
import { QueryView } from "@/components/exchange/query";
import { money } from "@/lib/exchange/model";
import { session, useExchange, type View } from "@/lib/exchange/store";

const NAV: { id: View; label: string }[] = [
  { id: "market", label: "Market" },
  { id: "licenses", label: "Licenses" },
  { id: "ledger", label: "Ledger" },
  { id: "query", label: "Query" },
  { id: "collect", label: "Collect" },
];

export function ExchangeApp() {
  const view = useExchange((state) => state.view);
  const wallet = useExchange((state) => state.walletUsd);
  const setView = useExchange((state) => state.setView);
  const hydrate = useExchange((state) => state.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-kicker">Infinitum · Cumulus://Cloud</div>
          <div className="brand-title">Data Exchange</div>
        </div>
        <div className="identity">
          <span>{session.mail}</span>
          <span className="wallet">{money(wallet)}</span>
        </div>
      </header>
      <nav className="nav" aria-label="Exchange">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            data-active={view === item.id || (view === "detail" && item.id === "market")}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <main className="main">
          {view === "market" && <MarketView />}
          {view === "detail" && <DetailView />}
          {view === "licenses" && <LicensesView />}
          {view === "ledger" && <LedgerView />}
          {view === "query" && <QueryView />}
          {view === "collect" && <CollectView />}
        </main>
      </div>
    </div>
  );
}
