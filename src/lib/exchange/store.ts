import { create } from "zustand";
import {
  acceptLicense,
  auditVisibleTo,
  offerLicense,
  publishDataset,
  readRows,
  recordRejectedTransfer,
  revokeLicense,
  setScope,
  settlePayout,
  type Books,
} from "@/lib/exchange/lifecycle";
import {
  assertPreviewTenant,
  canRead,
  enclaveReceipt,
  filterRows,
  isActiveToken,
  meaningScore,
  rollup,
  SESSION_CID,
  SESSION_MAIL,
  SESSION_NAME,
  suggestPrice,
  tenantName,
  type AuditEvent,
  type CdatToken,
  type ConsentRecord,
  type Dataset,
  type LedgerEntry,
  type LicenseRecord,
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

const STORAGE_KEY = "cumulus-exchange-v2";

interface Persisted {
  datasets: Dataset[];
  consents: ConsentRecord[];
  licenses: LicenseRecord[];
  sales: LicenseSale[];
  tokens: CdatToken[];
  payouts: Payout[];
  ledger: LedgerEntry[];
  audit: AuditEvent[];
  wallets: Record<string, number>;
  platformCents: number;
  walletUsd: number;
  platformUsd: number;
  nextOnchainId: number;
}

export interface ExchangeState extends Persisted {
  view: View;
  actorCid: string;
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
  setActor: (cid: string) => void;
  license: (datasetId: string) => void;
  accept: (licenseId: string) => void;
  revokeLicense: (licenseId: string) => void;
  setScopeGrant: (datasetId: string, scope: string, grant: boolean) => void;
  rejectTransfer: (tokenId: string, toCid: string) => void;
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

function withMoney(books: Books, actorCid: string): Persisted {
  return {
    ...books,
    walletUsd: (books.wallets[actorCid] ?? 0) / 100,
    platformUsd: books.platformCents / 100,
  };
}

function toBooks(state: Persisted): Books {
  return {
    datasets: state.datasets,
    consents: state.consents,
    licenses: state.licenses,
    sales: state.sales,
    tokens: state.tokens,
    payouts: state.payouts,
    ledger: state.ledger,
    audit: state.audit,
    wallets: state.wallets,
    platformCents: state.platformCents,
    nextOnchainId: state.nextOnchainId,
  };
}

function books(): Persisted {
  return withMoney(seedBooks(), SESSION_CID);
}

function persist(state: Persisted) {
  if (typeof window === "undefined") return;
  const snapshot: Persisted = {
    datasets: state.datasets,
    consents: state.consents,
    licenses: state.licenses,
    sales: state.sales,
    tokens: state.tokens,
    payouts: state.payouts,
    ledger: state.ledger,
    audit: state.audit,
    wallets: state.wallets,
    platformCents: state.platformCents,
    walletUsd: state.walletUsd,
    platformUsd: state.platformUsd,
    nextOnchainId: state.nextOnchainId,
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function noticeOf(error: unknown): string {
  return error instanceof Error ? error.message : "That action was refused.";
}

function stamp(iso?: string) {
  return iso ?? new Date().toISOString();
}

export const useExchange = create<ExchangeState>((set, get) => ({
  ...books(),
  view: "home",
  actorCid: SESSION_CID,
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
  setActor: (cid) => {
    try {
      assertPreviewTenant(cid);
      const state = get();
      set({
        actorCid: cid,
        walletUsd: (state.wallets[cid] ?? 0) / 100,
        notice: `Preview tenant is ${tenantName(cid)}.`,
      });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  license: (datasetId) => {
    const state = get();
    try {
      const next = offerLicense(toBooks(state), {
        actorCid: state.actorCid,
        datasetId,
        at: stamp(),
      });
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({ ...saved, notice: "Offer recorded on the preview ledger. The owner accepts it.", view: "licenses" });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  accept: (licenseId) => {
    const state = get();
    try {
      const next = acceptLicense(toBooks(state), { actorCid: state.actorCid, licenseId, at: stamp() });
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({ ...saved, notice: "Offer accepted. The CDAT is soulbound to the licensee.", view: "licenses" });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  revokeLicense: (licenseId) => {
    const state = get();
    try {
      const next = revokeLicense(toBooks(state), { actorCid: state.actorCid, licenseId, at: stamp() });
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({ ...saved, notice: "License revoked on the preview ledger." });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  setScopeGrant: (datasetId, scope, grant) => {
    const state = get();
    const decision = state.consents
      .find((item) => item.datasetId === datasetId)
      ?.decisions.find((item) => item.scope === scope);
    if (decision && decision.granted === grant) return;
    try {
      const next = setScope(toBooks(state), {
        actorCid: state.actorCid,
        datasetId,
        scope,
        grant,
        at: stamp(),
      });
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({
        ...saved,
        notice: grant ? `Opted in to ${scope}.` : `Revoked ${scope}. The audit trail kept the grant.`,
      });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  rejectTransfer: (tokenId, toCid) => {
    const state = get();
    try {
      const next = recordRejectedTransfer(toBooks(state), {
        actorCid: state.actorCid,
        tokenId,
        toCid,
        at: stamp(),
      });
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({ ...saved, notice: "CDAT licenses are soulbound and cannot be transferred." });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  settle: (saleId) => {
    const state = get();
    try {
      const next = settlePayout(toBooks(state), { actorCid: state.actorCid, saleId, at: stamp() });
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({ ...saved, notice: "Owner share settled into the preview wallet. No payment was sent." });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  revoke: (datasetId) => {
    const state = get();
    try {
      const consent = state.consents.find((item) => item.datasetId === datasetId);
      const scopes = consent?.decisions.filter((decision) => decision.granted).map((decision) => decision.scope) ?? [];
      if (scopes.length === 0) {
        set({ notice: "No live scope to revoke." });
        return;
      }
      let next = toBooks(state);
      const at = stamp();
      for (const scope of scopes) {
        next = setScope(next, { actorCid: state.actorCid, datasetId, scope, grant: false, at });
      }
      const saved = withMoney(next, state.actorCid);
      persist(saved);
      set({ ...saved, notice: "Consent revoked. Listings and CDAT licenses for this set are closed." });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
  },
  publish: (input) => {
    const state = get();
    try {
      const next = publishDataset(toBooks(state), { ...input, actorCid: state.actorCid, at: stamp() });
      const saved = withMoney(next, state.actorCid);
      const created = next.datasets[next.datasets.length - 1];
      persist(saved);
      set({
        ...saved,
        selectedId: created?.id ?? null,
        view: "detail",
        notice: "Listed. Each opted-in scope is on the preview ledger. You keep 85% of a sale.",
      });
    } catch (error) {
      set({ notice: noticeOf(error) });
    }
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
    try {
      const rows = readRows(toBooks(state), state.actorCid, dataset.id);
      const queryRows = filterRows(rows, state.expression);
      const receipt = enclaveReceipt(dataset.id, state.expression, queryRows.length);
      set({
        queryRows,
        receipt,
        rollField: dataset.columns[0] ?? "",
        notice: `${queryRows.length} row${queryRows.length === 1 ? "" : "s"}. Receipt ${receipt}.`,
      });
    } catch (error) {
      set({
        notice: noticeOf(error),
        queryRows: [],
        receipt: "",
        view: "detail",
        selectedId: dataset.id,
      });
    }
  },
  reset: () => {
    const next = books();
    persist(next);
    set({
      ...next,
      view: "market",
      actorCid: SESSION_CID,
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
      if (!Array.isArray(parsed.datasets) || !Array.isArray(parsed.ledger) || !Array.isArray(parsed.licenses)) {
        return;
      }
      const actorCid = get().actorCid;
      set({
        ...parsed,
        walletUsd: (parsed.wallets?.[actorCid] ?? 0) / 100,
        platformUsd: parsed.platformCents / 100,
      });
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

export function heldTokens(tokens: CdatToken[], actor = SESSION_CID): CdatToken[] {
  return tokens.filter((token) => token.licensee === actor);
}

export function readableDatasets(
  state: Pick<ExchangeState, "datasets" | "tokens"> & { actorCid?: string },
): Dataset[] {
  const actor = state.actorCid || SESSION_CID;
  return state.datasets.filter((dataset) => canRead(dataset, state.tokens, actor));
}

export function peerPrice(datasets: Dataset[], product: ProductId, fallback: number): number {
  return suggestPrice(datasets, product, fallback);
}

export function activeLicense(tokens: CdatToken[], datasetId: string, actor = SESSION_CID): boolean {
  return tokens.some(
    (token) => token.datasetId === datasetId && token.licensee === actor && isActiveToken(token),
  );
}

export function visibleAudit(state: Pick<ExchangeState, "audit" | "actorCid">) {
  return auditVisibleTo(state.audit, state.actorCid);
}

export const session = { cid: SESSION_CID, name: SESSION_NAME, mail: SESSION_MAIL };

export function groupsFor(rows: SampleRow[], field: string) {
  return rollup(rows, field);
}
