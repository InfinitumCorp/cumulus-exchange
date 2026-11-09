import { useState } from "react";
import { isActiveToken, moneyCents, type CdatToken } from "@/lib/exchange/model";
import { useExchange } from "@/lib/exchange/store";

export function LicensesView() {
  const tokens = useExchange((state) => state.tokens);
  const licenses = useExchange((state) => state.licenses);
  const datasets = useExchange((state) => state.datasets);
  const actorCid = useExchange((state) => state.actorCid);
  const notice = useExchange((state) => state.notice);
  const open = useExchange((state) => state.open);
  const accept = useExchange((state) => state.accept);
  const revokeLicense = useExchange((state) => state.revokeLicense);
  const rejectTransfer = useExchange((state) => state.rejectTransfer);
  const [transferTo, setTransferTo] = useState("cid_north");
  const held = tokens.filter((token) => token.licensee === actorCid);
  const issued = tokens.filter((token) => token.ownerCid === actorCid);
  const mine = licenses.filter(
    (license) => license.ownerCid === actorCid || license.licenseeCid === actorCid,
  );

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">CDAT licenses</h1>
          <p className="lede">
            A sale mints one soulbound license. It is read-only and cannot be transferred. Revoking
            consent burns it.
          </p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      <h2 className="pane-title">Offers</h2>
      <div className="list">
        {mine.filter((license) => license.phase === "offered").length === 0 ? (
          <p className="lede">No open offers for this preview tenant.</p>
        ) : null}
        {mine
          .filter((license) => license.phase === "offered")
          .map((license) => {
            const dataset = datasets.find((item) => item.id === license.datasetId);
            const owner = license.ownerCid === actorCid;
            return (
              <div key={license.id} className="row">
                <span>
                  <span className="row-title">{dataset?.title ?? license.datasetId}</span>
                  <span className="row-meta">
                    {" "}
                    {license.phase} · {license.licenseeName} · {moneyCents(license.amountCents)}
                  </span>
                </span>
                {owner ? (
                  <button className="btn-primary" type="button" onClick={() => accept(license.id)}>
                    Accept
                  </button>
                ) : null}
                <button className="btn" type="button" onClick={() => revokeLicense(license.id)}>
                  {owner ? "Decline" : "Withdraw"}
                </button>
              </div>
            );
          })}
      </div>
      <h2 className="pane-title">Held</h2>
      <div className="list">
        {held.length === 0 ? <p className="lede">This tenant does not hold a CDAT yet.</p> : null}
        {held.map((token) => (
          <CdatCard
            key={token.tokenId}
            token={token}
            title={datasets.find((item) => item.id === token.datasetId)?.title ?? token.datasetId}
            transferTo={transferTo}
            onTransferTo={setTransferTo}
            onOpen={() => open(token.datasetId)}
            onReject={() => rejectTransfer(token.tokenId, transferTo)}
          />
        ))}
      </div>
      <h2 className="pane-title">Issued from your data</h2>
      <div className="list">
        {issued.length === 0 ? <p className="lede">No CDAT has been minted from this tenant.</p> : null}
        {issued.map((token) => (
          <CdatCard
            key={token.tokenId}
            token={token}
            title={datasets.find((item) => item.id === token.datasetId)?.title ?? token.datasetId}
            transferTo={transferTo}
            onTransferTo={setTransferTo}
            onOpen={() => open(token.datasetId)}
            onReject={() => rejectTransfer(token.tokenId, transferTo)}
          />
        ))}
      </div>
    </section>
  );
}

function CdatCard({
  token,
  title,
  transferTo,
  onTransferTo,
  onOpen,
  onReject,
}: {
  token: CdatToken;
  title: string;
  transferTo: string;
  onTransferTo: (value: string) => void;
  onOpen: () => void;
  onReject: () => void;
}) {
  const live = isActiveToken(token);
  return (
    <article className="card">
      <h3>{title}</h3>
      <p className="mono">
        {token.tokenId} · soulbound · non-transferable · {live ? "active" : "burned or expired"}
      </p>
      <dl className="cdat-fields">
        <div>
          <dt>Licensee</dt>
          <dd>{token.licensee}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{token.ownerCid}</dd>
        </div>
        <div>
          <dt>Terms</dt>
          <dd>{token.terms}</dd>
        </div>
        <div>
          <dt>Through</dt>
          <dd>{token.expiresAt.slice(0, 10)}</dd>
        </div>
        <div>
          <dt>Preview tx</dt>
          <dd>{token.firmamentTx ?? "preview"}</dd>
        </div>
      </dl>
      <div className="actions">
        <button className="btn" type="button" onClick={onOpen}>
          Dataset
        </button>
        <input
          className="field"
          aria-label="CID that cannot receive this CDAT"
          value={transferTo}
          onChange={(event) => onTransferTo(event.target.value)}
        />
        <button className="btn" type="button" onClick={onReject}>
          Transfer
        </button>
      </div>
    </article>
  );
}
