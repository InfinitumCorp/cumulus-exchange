import { create } from "zustand";
import {
  appendEntry,
  applyRecipe,
  canRead,
  columnsOf,
  enclaveReceipt,
  filterRows,
  isActiveToken,
  meaningScore,
  REV_SHARE,
  rollup,
  SESSION_CID,
  SESSION_MAIL,
  SESSION_NAME,
  splitAmount,
  splitHolds,
  suggestPrice,
  termExpiry,
  type CdatToken,
  type ConsentRecord,
  type Dataset,
  type LedgerEntry,
  type LicenseSale,
  type Modality,
  type Payout,
  type ProductId,
  type Recipe,
  type RegionId,
  type SampleRow,
} from "@/lib/exchange/model";
import { seedBooks } from "@/lib/exchange/seed";

export type View = "home" | "drive" | "market" | "detail" | "licenses" | "ledger" | "query" | "collect";

const STORAGE_KEY = "cumulus-exchange-v1";

interface Persisted {
  datasets: Dataset[];
  consents: ConsentRecord[];
  sales: LicenseSale[];
  tokens: CdatToken[];
  payouts: Payout[];
  ledger: LedgerEntry[];
  walletUsd: number;
  platformUsd: number;
  nextOnchainId: number;
}

export interface ExchangeState extends Persisted {
  view: View;
  selectedId: string | null;
  search: string;
  product: ProductId | "all";
  modality: Modality | "all";
  region: RegionId | "all";
  cloudMax: number;
  notice: string;
  queryDatasetId: string;
  expression: string;
  queryRows: SampleRow[];
  receipt: string;
  rollField: string;
  setView: (view: View) => void;
  open: (id: string) => void;
  setSearch: (search: string) => void;
  setProduct: (product: ProductId | "all") => void;
  setModality: (modality: Modality | "all") => void;
  setRegion: (region: RegionId | "all") => void;
  setCloudMax: (cloudMax: number) => void;
  license: (datasetId: string) => void;
  settle: (saleId: string) => void;
  revoke: (datasetId: string) => void;
  publish: (input: {
    product: ProductId;
    title: string;
    description: string;
    rows: SampleRow[];
    scopes: string[];
    licenseTerms: string;
    priceUsd: number;
    region: RegionId;
    modality: Modality;
    topics: Record<string, number>;
    recipe: Recipe;
  }) => void;
  runQuery: () => void;
  setQueryDataset: (id: string) => void;
  setExpression: (expression: string) => void;
  setRollField: (field: string) => void;
  reset: () => void;
  hydrate: () => void;
}

function books(): Persisted {
  return { ...seedBooks(), walletUsd: 2400 };
}

function persist(state: Persisted) {
  if (typeof window === "undefined") return;
  const snapshot: Persisted = {
    datasets: state.datasets,
    consents: state.consents,
    sales: state.sales,
    tokens: state.tokens,
    payouts: state.payouts,
    ledger: state.ledger,
    walletUsd: state.walletUsd,
    platformUsd: state.platformUsd,
    nextOnchainId: state.nextOnchainId,
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function stamp(iso?: string) {
  return iso ?? new Date().toISOString();
}

export const useExchange = create<ExchangeState>((set, get) => ({
  ...books(),
  view: "home",
  selectedId: null,
  search: "",
  product: "all",
  modality: "all",
  region: "all",
  cloudMax: 100,
  notice: "",
  queryDatasetId: "ds_storage",
  expression: "",
  queryRows: [],
  receipt: "",
  rollField: "",
  setView: (view) => set({ view }),
  open: (id) => set({ view: "detail", selectedId: id, notice: "" }),
  setSearch: (search) => set({ search }),
  setProduct: (product) => set({ product }),
  setModality: (modality) => set({ modality }),
  setRegion: (region) => set({ region }),
  setCloudMax: (cloudMax) => set({ cloudMax }),
  license: (datasetId) => {
    const state = get();
    const dataset = state.datasets.find((item) => item.id === datasetId);
    if (!dataset || dataset.status !== "listed") {
      set({ notice: "That set is not listed." });
      return;
    }
    if (dataset.ownerCid === SESSION_CID) {
      set({ notice: "You already own this set. Another CID has to license it." });
      return;
    }
    if (state.walletUsd < dataset.priceUsd) {
      set({ notice: "FIRM wallet balance is short of the license price." });
      return;
    }
    const at = stamp();
    const parts = splitAmount(dataset.priceUsd, dataset.revSharePct);
    const saleId = `sale_${dataset.id}_${at.slice(11, 19).replace(/:/g, "")}`;
    const tokenId = `cdat_${state.nextOnchainId}`;
    let ledger = appendEntry(
      state.ledger,
      "license",
      at,
      `${tokenId} licenses ${dataset.id} to ${SESSION_CID} until ${termExpiry(dataset.licenseTerms, at)}`,
    );
    const firmamentTx = ledger[ledger.length - 1]?.hash;
    ledger = appendEntry(
      ledger,
      "payment",
      at,
      `${saleId} ${parts.amountUsd} owner ${parts.userShareUsd} platform ${parts.platformShareUsd}`,
    );
    const sale: LicenseSale = {
      id: saleId,
      datasetId,
      buyerId: SESSION_CID,
      buyerName: SESSION_NAME,
      ...parts,
      soldAt: at,
      status: "completed",
      cdatTokenId: tokenId,
    };
    const token: CdatToken = {
      tokenId,
      onchainId: state.nextOnchainId,
      datasetId,
      saleId,
      licensee: SESSION_CID,
      ownerCid: dataset.ownerCid,
      terms: dataset.licenseTerms,
      amountUsd: parts.amountUsd,
      issuedAt: at,
      expiresAt: termExpiry(dataset.licenseTerms, at),
      burned: false,
      firmamentTx,
    };
    const payout: Payout = {
      saleId,
      cid: dataset.ownerCid,
      amountUsd: parts.userShareUsd,
      paid: false,
    };
    const next: Persisted = {
      datasets: state.datasets.map((item) =>
        item.id === datasetId ? { ...item, status: "sold" } : item,
      ),
      consents: state.consents,
      sales: [sale, ...state.sales],
      tokens: [token, ...state.tokens],
      payouts: [payout, ...state.payouts],
      ledger,
      walletUsd: Math.round((state.walletUsd - parts.amountUsd) * 100) / 100,
      platformUsd: Math.round((state.platformUsd + parts.platformShareUsd) * 100) / 100,
      nextOnchainId: state.nextOnchainId + 1,
    };
    persist(next);
    set({
      ...next,
      notice: `Licensed. ${tokenId} issued. Owner share ${parts.userShareUsd.toFixed(2)} is pending settlement. Split check ${splitHolds(sale, dataset.revSharePct) ? "holds" : "failed"}.`,
      view: "licenses",
      queryDatasetId: datasetId,
    });
  },
  settle: (saleId) => {
    const state = get();
    const payout = state.payouts.find((item) => item.saleId === saleId);
    if (!payout || payout.paid) {
      set({ notice: "Nothing to settle." });
      return;
    }
    const at = stamp();
    const ledger = appendEntry(
      state.ledger,
      "payment",
      at,
      `payout ${saleId} ${payout.amountUsd} to ${payout.cid}`,
    );
    const walletUsd =
      payout.cid === SESSION_CID
        ? Math.round((state.walletUsd + payout.amountUsd) * 100) / 100
        : state.walletUsd;
    const next: Persisted = {
      ...state,
      payouts: state.payouts.map((item) =>
        item.saleId === saleId ? { ...item, paid: true, paidAt: at } : item,
      ),
      ledger,
      walletUsd,
    };
    persist(next);
    set({
      ...next,
      notice:
        payout.cid === SESSION_CID
          ? `Settled ${payout.amountUsd.toFixed(2)} into your FIRM wallet.`
          : `Settled ${payout.amountUsd.toFixed(2)} to ${payout.cid}.`,
    });
  },
  revoke: (datasetId) => {
    const state = get();
    const dataset = state.datasets.find((item) => item.id === datasetId);
    const consent = state.consents.find((item) => item.datasetId === datasetId);
    if (!dataset || dataset.ownerCid !== SESSION_CID || !consent?.granted) {
      set({ notice: "Only the owning CID can revoke a live grant." });
      return;
    }
    const at = stamp();
    const ledger = appendEntry(state.ledger, "revoke", at, `${consent.id} revoked ${datasetId}`);
    const hash = ledger[ledger.length - 1]?.hash;
    const next: Persisted = {
      ...state,
      datasets: state.datasets.map((item) =>
        item.id === datasetId ? { ...item, status: "revoked" } : item,
      ),
      consents: state.consents.map((item) =>
        item.id === consent.id ? { ...item, granted: false, timestamp: at, firmamentTx: hash } : item,
      ),
      tokens: state.tokens.map((token) =>
        token.datasetId === datasetId ? { ...token, burned: true } : token,
      ),
      ledger,
    };
    persist(next);
    set({
      ...next,
      notice: "Consent revoked. The listing is off the exchange and any CDAT for it is burned.",
    });
  },
  publish: (input) => {
    const state = get();
    const rows = applyRecipe(input.rows, input.recipe);
    const columns = columnsOf(rows);
    if (columns.length === 0) {
      set({ notice: "A listing needs at least one column after the prep recipe." });
      return;
    }
    const at = stamp();
    const id = `ds_${state.nextOnchainId}_${input.product}`;
    const consentId = `consent_${id}`;
    let ledger = appendEntry(
      state.ledger,
      "grant",
      at,
      `${SESSION_CID} granted ${input.scopes.join(",")} on ${id}`,
    );
    const firmamentTx = ledger[ledger.length - 1]?.hash;
    ledger = appendEntry(ledger, "list", at, `${id} listed at ${input.priceUsd} USD`);
    const dataset: Dataset = {
      id,
      ownerCid: SESSION_CID,
      ownerName: SESSION_NAME,
      product: input.product,
      title: input.title,
      description: input.description,
      schema: columns.join(","),
      columns,
      rows,
      sizeEstimate: rows.length * 1200,
      privacyLevel: "aggregated",
      licenseTerms: input.licenseTerms,
      priceUsd: input.priceUsd,
      revSharePct: REV_SHARE,
      status: "listed",
      createdAt: at,
      consentId,
      scopes: input.scopes,
      region: input.region,
      modality: input.modality,
      topics: input.topics,
    };
    const consent: ConsentRecord = {
      id: consentId,
      cid: SESSION_CID,
      product: input.product,
      datasetId: id,
      granted: true,
      scopes: input.scopes,
      purpose: "data_licensing",
      timestamp: at,
      firmamentTx,
    };
    const next: Persisted = {
      ...state,
      datasets: [dataset, ...state.datasets],
      consents: [consent, ...state.consents],
      ledger,
    };
    persist(next);
    set({
      ...next,
      selectedId: id,
      view: "detail",
      notice: "Listed. The grant is on the preview ledger. You keep 85% of a sale.",
    });
  },
  setQueryDataset: (id) => set({ queryDatasetId: id, queryRows: [], receipt: "" }),
  setExpression: (expression) => set({ expression }),
  setRollField: (rollField) => set({ rollField }),
  runQuery: () => {
    const state = get();
    const dataset = state.datasets.find((item) => item.id === state.queryDatasetId);
    if (!dataset) {
      set({ notice: "Pick a dataset.", queryRows: [], receipt: "" });
      return;
    }
    if (!canRead(dataset, state.tokens, SESSION_CID)) {
      set({
        notice: "Query needs an active CDAT, or the set has to be yours.",
        queryRows: [],
        receipt: "",
        view: "detail",
        selectedId: dataset.id,
      });
      return;
    }
    const queryRows = filterRows(dataset.rows, state.expression);
    const receipt = enclaveReceipt(dataset.id, state.expression, queryRows.length);
    set({
      queryRows,
      receipt,
      rollField: dataset.columns[0] ?? "",
      notice: `${queryRows.length} row${queryRows.length === 1 ? "" : "s"}. Receipt ${receipt}.`,
    });
  },
  reset: () => {
    const next = books();
    persist(next);
    set({
      ...next,
      view: "market",
      selectedId: null,
      search: "",
      product: "all",
      modality: "all",
      region: "all",
      cloudMax: 100,
      notice: "Demo reset.",
      queryDatasetId: "ds_storage",
      expression: "",
      queryRows: [],
      receipt: "",
      rollField: "",
    });
  },
  hydrate: () => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Persisted;
      if (!Array.isArray(parsed.datasets) || !Array.isArray(parsed.ledger)) return;
      set(parsed);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  },
}));

export function visibleDatasets(state: ExchangeState): Dataset[] {
  const ranked = state.datasets
    .filter((dataset) => dataset.status === "listed" || dataset.status === "sold")
    .filter((dataset) => state.product === "all" || dataset.product === state.product)
    .filter((dataset) => state.modality === "all" || dataset.modality === state.modality)
    .filter((dataset) => state.region === "all" || dataset.region === state.region)
    .filter((dataset) => dataset.cloudCover === undefined || dataset.cloudCover <= state.cloudMax)
    .map((dataset) => ({ dataset, score: meaningScore(dataset, state.search) }));
  const querying = state.search.trim().length > 0;
  const kept = querying ? ranked.filter((item) => item.score > 0.2) : ranked;
  kept.sort((a, b) => {
    if (querying && b.score !== a.score) return b.score - a.score;
    if (a.dataset.status !== b.dataset.status) return a.dataset.status === "listed" ? -1 : 1;
    return a.dataset.title.localeCompare(b.dataset.title);
  });
  return kept.map((item) => item.dataset);
}

export function scoreOf(dataset: Dataset, search: string): number {
  return meaningScore(dataset, search);
}

export function heldTokens(tokens: CdatToken[]): CdatToken[] {
  return tokens.filter((token) => token.licensee === SESSION_CID);
}

export function readableDatasets(state: Pick<ExchangeState, "datasets" | "tokens">): Dataset[] {
  return state.datasets.filter((dataset) => canRead(dataset, state.tokens, SESSION_CID));
}

export function peerPrice(datasets: Dataset[], product: ProductId, fallback: number): number {
  return suggestPrice(datasets, product, fallback);
}

export function activeLicense(tokens: CdatToken[], datasetId: string): boolean {
  return tokens.some(
    (token) => token.datasetId === datasetId && token.licensee === SESSION_CID && isActiveToken(token),
  );
}

export const session = { cid: SESSION_CID, name: SESSION_NAME, mail: SESSION_MAIL };

export function groupsFor(rows: SampleRow[], field: string) {
  return rollup(rows, field);
}
