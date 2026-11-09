import { FirmSuite } from "@/lib/firm/FirmSuite";
import { useEffect } from "react";
import { CollectView } from "@/components/exchange/collect";
import { DriveView } from "@/components/exchange/drive";
import { DetailView } from "@/components/exchange/detail";
import { HomeView } from "@/components/exchange/home";
import { LedgerView } from "@/components/exchange/ledger";
import { LicensesView } from "@/components/exchange/licenses";
import { MarketView } from "@/components/exchange/market";
import { QueryView } from "@/components/exchange/query";
import { HTMLSelect } from "@blueprintjs/core";
import { money, PREVIEW_TENANTS } from "@/lib/exchange/model";
import { session, useExchange, type View } from "@/lib/exchange/store";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Cloud", icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5" },
  { id: "drive", label: "Drive", icon: "M4 4h16v16H4z" },
  { id: "market", label: "Market", icon: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { id: "licenses", label: "Licenses", icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" },
  { id: "ledger", label: "Ledger", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" },
  { id: "query", label: "Query", icon: "M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z" },
  { id: "collect", label: "Collect", icon: "M12 5v14 M5 12h14" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function ExchangeApp() {
  const view = useExchange((state) => state.view);
  const wallet = useExchange((state) => state.walletUsd);
  const actorCid = useExchange((state) => state.actorCid);
  const setActor = useExchange((state) => state.setActor);
  const setView = useExchange((state) => state.setView);
  const hydrate = useExchange((state) => state.hydrate);
  const actor = PREVIEW_TENANTS.find((tenant) => tenant.cid === actorCid);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-kicker">Infinitum Corporation®</div>
          <div className="brand-title">Cumulus://Cloud</div>
          <div className="brand-sub">Cumulus Drive</div>
        </div>
        <div className="identity">
          <HTMLSelect
            aria-label="Preview tenant"
            minimal
            value={actorCid}
            onChange={(event) => setActor(event.currentTarget.value)}
          >
            {PREVIEW_TENANTS.map((tenant) => (
              <option key={tenant.cid} value={tenant.cid}>
                {tenant.name}
              </option>
            ))}
          </HTMLSelect>
          <span className="hide-sm">{actor?.mail ?? session.mail}</span>
          <span className="wallet">{money(wallet)}</span>
        </div>
      </header>
      <nav className="nav desktop-nav" aria-label="Cumulus://Cloud">
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
          {view === "home" && <HomeView />}
          {view === "drive" && <DriveView />}
          {view === "market" && <MarketView />}
          {view === "detail" && <DetailView />}
          {view === "licenses" && <LicensesView />}
          {view === "ledger" && <LedgerView />}
          {view === "query" && <QueryView />}
          {view === "collect" && <CollectView />}
          {view === "home" && <FirmSuite product="cumulus-exchange" />}
        </main>
      </div>
      <nav className="tabbar" aria-label="Cumulus://Cloud">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            data-active={view === item.id || (view === "detail" && item.id === "market")}
            onClick={() => setView(item.id)}
          >
            <Icon d={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
