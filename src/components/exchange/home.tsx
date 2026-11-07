import { PRODUCT_LABEL } from "@/lib/exchange/model";
import { useExchange } from "@/lib/exchange/store";

const SURFACES = [
  {
    id: "store",
    kicker: "01",
    title: "Store",
    body: "Cumulus Drive. Files, photos, backups, object and archive. File contents stay in the product.",
  },
  {
    id: "build",
    kicker: "02",
    title: "Build",
    body: "Compute and data. Virtual machines, containers, serverless and managed databases on the same account.",
  },
  {
    id: "ai",
    kicker: "03",
    title: "Run AI",
    body: "GPU capacity, inference, vector search and the agent runtime the other Infinitum products use.",
  },
  {
    id: "earn",
    kicker: "04",
    title: "Earn",
    body: "Opt in. License eligible aggregates you own, keep 85%, and receive one soulbound CDAT per sale.",
  },
];

export function HomeView() {
  const setView = useExchange((state) => state.setView);
  const datasets = useExchange((state) => state.datasets);
  const listed = datasets.filter((dataset) => dataset.status === "listed").length;

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">Cumulus://Cloud</h1>
          <p className="lede">
            One product. Cumulus://Cloud is Cumulus Drive. Storage, compute, databases and AI
            infrastructure, with an opt-in license surface for data you choose to offer.
          </p>
        </div>
      </div>
      <div className="stats">
        <div className="stat">
          <span>Product</span>
          <b>{PRODUCT_LABEL.cumulus}</b>
        </div>
        <div className="stat">
          <span>Also</span>
          <b>Cumulus Drive</b>
        </div>
        <div className="stat">
          <span>Owner share</span>
          <b>85%</b>
        </div>
        <div className="stat">
          <span>Listed</span>
          <b>{listed}</b>
        </div>
      </div>
      <div className="surface-grid">
        {SURFACES.map((surface) => (
          <button
            key={surface.id}
            className="card surface"
            type="button"
            onClick={() => setView(surface.id === "store" ? "drive" : surface.id === "earn" ? "market" : "market")}
          >
            <span className="mono">{surface.kicker}</span>
            <h3>{surface.title}</h3>
            <p className="lede">{surface.body}</p>
          </button>
        ))}
      </div>
      <div className="actions">
        <button className="btn-primary" type="button" onClick={() => setView("market")}>
          Open the catalog
        </button>
        <button className="btn" type="button" onClick={() => setView("collect")}>
          Package a set
        </button>
      </div>
    </section>
  );
}
