import { useExchange, readableDatasets, groupsFor } from "@/lib/exchange/store";
import { PRODUCT_LABEL } from "@/lib/exchange/model";

export function QueryView() {
  const datasetsAll = useExchange((state) => state.datasets);
  const tokens = useExchange((state) => state.tokens);
  const datasets = readableDatasets({ datasets: datasetsAll, tokens });
  const queryDatasetId = useExchange((state) => state.queryDatasetId);
  const expression = useExchange((state) => state.expression);
  const queryRows = useExchange((state) => state.queryRows);
  const receipt = useExchange((state) => state.receipt);
  const rollField = useExchange((state) => state.rollField);
  const notice = useExchange((state) => state.notice);
  const setQueryDataset = useExchange((state) => state.setQueryDataset);
  const setExpression = useExchange((state) => state.setExpression);
  const setRollField = useExchange((state) => state.setRollField);
  const runQuery = useExchange((state) => state.runQuery);
  const open = useExchange((state) => state.open);

  const selected = datasetsAll.find((dataset) => dataset.id === queryDatasetId);
  const columns = selected?.columns ?? [];
  const groups = rollField ? groupsFor(queryRows, rollField) : [];

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">Licensed query</h1>
          <p className="lede">
            Filters run in this browser. An active CDAT, or ownership, is required. The receipt is a
            local hash of the filter, not a remote attestation.
          </p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      <div className="filters">
        <select
          className="field"
          aria-label="Dataset"
          value={datasets.some((dataset) => dataset.id === queryDatasetId) ? queryDatasetId : ""}
          onChange={(event) => setQueryDataset(event.target.value)}
        >
          {datasets.length === 0 ? <option value="">Nothing you can read</option> : null}
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {PRODUCT_LABEL[dataset.product]} · {dataset.title}
            </option>
          ))}
        </select>
        <input
          className="search"
          value={expression}
          placeholder='cloud_pct < 20 and acquired contains 2026'
          aria-label="Filter expression"
          onChange={(event) => setExpression(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runQuery();
          }}
        />
        <button className="btn-primary" type="button" onClick={runQuery}>
          Run
        </button>
      </div>
      {selected && !datasets.some((dataset) => dataset.id === selected.id) ? (
        <p className="lede">
          {selected.title} is locked.{" "}
          <button className="btn-quiet" type="button" onClick={() => open(selected.id)}>
            Open the listing
          </button>
        </p>
      ) : null}
      {receipt ? <p className="mono">Enclave receipt {receipt}</p> : null}
      {queryRows.length > 0 ? (
        <>
          <div className="filters">
            <select
              className="field"
              aria-label="Roll up field"
              value={rollField}
              onChange={(event) => setRollField(event.target.value)}
            >
              {columns.map((column) => (
                <option key={column} value={column}>
                  Roll up {column}
                </option>
              ))}
            </select>
          </div>
          {groups.length > 0 ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{rollField}</th>
                    <th>Count</th>
                    <th>Sum</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.key}>
                      <td>{group.key}</td>
                      <td>{group.count}</td>
                      <td>{group.sum === null ? "—" : group.sum}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queryRows.map((row, index) => (
                  <tr key={`${queryDatasetId}-${index}`}>
                    {columns.map((column) => (
                      <td key={column}>{String(row[column] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
