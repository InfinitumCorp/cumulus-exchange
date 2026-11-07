export type ProductId =
  | "cumulus"
  | "scalus"
  | "spectre"
  | "architect"
  | "veil"
  | "fabric"
  | "aether"
  | "metatron"
  | "hrvst"
  | "eidetic"
  | "firm"
  | "firmament"
  | "tokens"
  | "eon"
  | "observation";

export type PrivacyLevel = "anonymized" | "pseudonymized" | "aggregated";
export type DatasetStatus = "draft" | "listed" | "sold" | "revoked";
export type RegionId = "iad" | "lhr" | "fra" | "nrt" | "syd";
export type Modality = "aggregate" | "optical" | "sar" | "ais" | "weather" | "rf";

export type SampleRow = Record<string, string | number>;

export interface Dataset {
  id: string;
  ownerCid: string;
  ownerName: string;
  product: ProductId;
  title: string;
  description: string;
  schema: string;
  columns: string[];
  rows: SampleRow[];
  sizeEstimate: number;
  privacyLevel: PrivacyLevel;
  licenseTerms: string;
  priceUsd: number;
  revSharePct: number;
  status: DatasetStatus;
  createdAt: string;
  consentId?: string;
  scopes: string[];
  region: RegionId;
  modality: Modality;
  bbox?: [number, number, number, number];
  topics: Record<string, number>;
  cloudCover?: number;
}

export interface ConsentRecord {
  id: string;
  cid: string;
  product: ProductId;
  datasetId: string;
  granted: boolean;
  scopes: string[];
  purpose: string;
  timestamp: string;
  firmamentTx?: string;
}

export interface LicenseSale {
  id: string;
  datasetId: string;
  buyerId: string;
  buyerName: string;
  amountUsd: number;
  userShareUsd: number;
  platformShareUsd: number;
  cdatTokenId?: string;
  soldAt: string;
  status: "completed" | "refunded";
}

export interface CdatToken {
  tokenId: string;
  onchainId: number;
  datasetId: string;
  saleId: string;
  licensee: string;
  ownerCid: string;
  terms: string;
  amountUsd: number;
  issuedAt: string;
  expiresAt: string;
  burned: boolean;
  firmamentTx?: string;
}

export interface Payout {
  saleId: string;
  cid: string;
  amountUsd: number;
  paid: boolean;
  paidAt?: string;
}

export interface LedgerEntry {
  index: number;
  hash: string;
  prev: string;
  type: "grant" | "license" | "payment" | "revoke" | "list";
  at: string;
  summary: string;
}

export interface Recipe {
  drop: string[];
  redact: string[];
  bucket: string[];
}

export const SESSION_CID = "cid_alex";
export const SESSION_NAME = "Alex Rivera";
export const SESSION_MAIL = "alex@cumulusmail.cloud";
export const GENESIS = "firmament_genesis";
export const REV_SHARE = 85;

export const PRODUCT_LABEL: Record<ProductId, string> = {
  cumulus: "Cumulus://Cloud",
  scalus: "SCALVS.ai",
  spectre: "+SPCTR",
  architect: "ARCHITECT",
  veil: "VEIL",
  fabric: "FabriC++",
  aether: "ÆTHER",
  metatron: "METATRON",
  hrvst: "HRVST",
  eidetic: "ei·det·ic",
  firm: "FIRM",
  firmament: "Firmament",
  tokens: "Tokens",
  eon: "E(O)N",
  observation: "Observation",
};

export const REGION_LABEL: Record<RegionId, string> = {
  iad: "IAD · Virginia",
  lhr: "LHR · London",
  fra: "FRA · Frankfurt",
  nrt: "NRT · Tokyo",
  syd: "SYD · Sydney",
};

export const MODALITY_LABEL: Record<Modality, string> = {
  aggregate: "Aggregate",
  optical: "Optical mosaic",
  sar: "SAR change",
  ais: "AIS density",
  weather: "GNSS-RO weather",
  rf: "RF density",
};

const LEXICON: Record<string, string> = {
  cloud: "storage",
  storage: "storage",
  compute: "storage",
  file: "storage",
  deal: "crm",
  pipeline: "crm",
  win: "crm",
  sales: "crm",
  agent: "agent",
  workflow: "agent",
  intent: "agent",
  forecast: "forecast",
  prediction: "forecast",
  confidence: "forecast",
  mesh: "mesh",
  hop: "mesh",
  radio: "rf",
  message: "mesh",
  satellite: "observation",
  imagery: "observation",
  scene: "observation",
  tile: "observation",
  optical: "observation",
  mosaic: "observation",
  ship: "maritime",
  vessel: "maritime",
  ais: "maritime",
  port: "maritime",
  maritime: "maritime",
  weather: "weather",
  temperature: "weather",
  occultation: "weather",
  sar: "sar",
  radar: "sar",
  change: "sar",
  identity: "identity",
  wallet: "wallet",
  token: "wallet",
  swap: "wallet",
  browser: "browser",
  veil: "browser",
  capture: "capture",
  photo: "capture",
  packet: "capture",
  battery: "capture",
  wearable: "capture",
};

export function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function splitAmount(amountUsd: number, revSharePct: number) {
  const amountCents = Math.round(amountUsd * 100);
  const userCents = Math.round((amountCents * revSharePct) / 100);
  return {
    amountUsd: amountCents / 100,
    userShareUsd: userCents / 100,
    platformShareUsd: (amountCents - userCents) / 100,
  };
}

export function splitHolds(sale: LicenseSale, revSharePct: number): boolean {
  const again = splitAmount(sale.amountUsd, revSharePct);
  return (
    again.userShareUsd === sale.userShareUsd && again.platformShareUsd === sale.platformShareUsd
  );
}

export function previewHash(prev: string, body: string): string {
  const data = `${prev}|${body}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `fm_${hex(h1)}${hex(h2)}`;
}

export function appendEntry(
  ledger: LedgerEntry[],
  type: LedgerEntry["type"],
  at: string,
  summary: string,
): LedgerEntry[] {
  const prev = ledger.length > 0 ? ledger[ledger.length - 1].hash : GENESIS;
  const index = ledger.length + 1;
  const hash = previewHash(prev, `${index}|${type}|${at}|${summary}`);
  return [...ledger, { index, hash, prev, type, at, summary }];
}

export function termExpiry(terms: string, fromIso: string): string {
  const match = terms.match(/(\d+)\s*(y|d)\b/i);
  const start = Date.parse(fromIso);
  const day = 24 * 60 * 60 * 1000;
  const span = !match
    ? 365 * day
    : match[2].toLowerCase() === "d"
      ? Number(match[1]) * day
      : Number(match[1]) * 365 * day;
  return new Date(start + span).toISOString();
}

export function isActiveToken(token: CdatToken, now = Date.now()): boolean {
  return !token.burned && Date.parse(token.expiresAt) > now;
}

function cosine(query: Record<string, number>, topics: Record<string, number>): number {
  const keys = new Set([...Object.keys(query), ...Object.keys(topics)]);
  let dot = 0;
  let a = 0;
  let b = 0;
  for (const key of keys) {
    const q = query[key] ?? 0;
    const t = topics[key] ?? 0;
    dot += q * t;
    a += q * q;
    b += t * t;
  }
  if (a === 0 || b === 0) return 0;
  return dot / Math.sqrt(a * b);
}

export function meaningScore(dataset: Dataset, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return 0;
  const blob =
    `${dataset.title} ${dataset.description} ${dataset.schema} ${dataset.modality} ${dataset.product}`.toLowerCase();
  let hits = 0;
  const qVec: Record<string, number> = {};
  for (const token of tokens) {
    const stem = token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
    if (blob.includes(token) || blob.includes(stem)) hits += 1;
    const topic = LEXICON[token] ?? LEXICON[stem];
    if (topic) qVec[topic] = (qVec[topic] ?? 0) + 1;
  }
  return hits / tokens.length + cosine(qVec, dataset.topics);
}

export function suggestPrice(datasets: Dataset[], product: ProductId, fallback: number): number {
  const peers = datasets
    .filter((dataset) => dataset.product === product && dataset.status !== "revoked")
    .map((dataset) => dataset.priceUsd)
    .sort((a, b) => a - b);
  if (peers.length === 0) return fallback;
  return peers[Math.floor(peers.length / 2)] ?? fallback;
}

export function filterRows(rows: SampleRow[], expression: string): SampleRow[] {
  const text = expression.trim();
  if (!text) return rows;
  const clauses = text.split(/\s+and\s+/i);
  return rows.filter((row) => clauses.every((clause) => matchClause(row, clause.trim())));
}

function matchClause(row: SampleRow, clause: string): boolean {
  const match = clause.match(/^([a-zA-Z0-9_]+)\s*(<=|>=|!=|=|<|>|contains)\s*(.+)$/);
  if (!match) {
    const needle = clause.toLowerCase();
    return Object.values(row).some((value) => String(value).toLowerCase().includes(needle));
  }
  const field = match[1];
  const op = match[2];
  const raw = match[3].replace(/^["']|["']$/g, "");
  const value = row[field];
  if (value === undefined || op === undefined) return false;
  if (op === "contains") return String(value).toLowerCase().includes(raw.toLowerCase());
  const num = Number(raw);
  const bothNum = typeof value === "number" && Number.isFinite(num);
  if (op === "=") return bothNum ? value === num : String(value) === raw;
  if (op === "!=") return bothNum ? value !== num : String(value) !== raw;
  if (!bothNum) return false;
  if (op === "<") return value < num;
  if (op === ">") return value > num;
  if (op === "<=") return value <= num;
  return value >= num;
}

export function rollup(rows: SampleRow[], field: string) {
  const groups = new Map<string, { count: number; sum: number; numeric: boolean }>();
  for (const row of rows) {
    const key = String(row[field] ?? "—");
    const current = groups.get(key) ?? { count: 0, sum: 0, numeric: true };
    current.count += 1;
    const asNumber = typeof row[field] === "number" ? row[field] : Number(row[field]);
    if (typeof asNumber === "number" && Number.isFinite(asNumber)) current.sum += asNumber;
    else current.numeric = false;
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    count: group.count,
    sum: group.numeric ? group.sum : null,
  }));
}

export function applyRecipe(rows: SampleRow[], recipe: Recipe): SampleRow[] {
  return rows.map((row) => {
    const next: SampleRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (recipe.drop.includes(key)) continue;
      if (recipe.redact.includes(key)) next[key] = "••••";
      else if (recipe.bucket.includes(key) && typeof value === "number") {
        next[key] = Math.round(value / 10) * 10;
      } else next[key] = value;
    }
    return next;
  });
}

export function columnsOf(rows: SampleRow[]): string[] {
  return rows[0] ? Object.keys(rows[0]) : [];
}

export function enclaveReceipt(datasetId: string, expression: string, count: number): string {
  return previewHash("enclave", `${datasetId}|${expression}|${count}`);
}

export function canRead(dataset: Dataset, tokens: CdatToken[], cid: string): boolean {
  if (dataset.ownerCid === cid && dataset.status !== "revoked") return true;
  return tokens.some(
    (token) => token.datasetId === dataset.id && token.licensee === cid && isActiveToken(token),
  );
}
