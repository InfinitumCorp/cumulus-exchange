import {
  applyRecipe,
  assertPreviewTenant,
  columnsOf,
  dollarsToCents,
  firmamentPreviewAppend,
  isActiveToken,
  REV_SHARE,
  splitRevenueCents,
  tenantName,
  termExpiry,
  type AuditEvent,
  type CdatToken,
  type ConsentRecord,
  type Dataset,
  type LedgerEntry,
  type LicenseRecord,
  type LicenseSale,
  type Payout,
  type ProductId,
  type Recipe,
  type RegionId,
  type SampleRow,
  type Modality,
} from "./model.ts";

export interface Books {
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
  nextOnchainId: number;
}

export class TenantIsolationError extends Error {
  readonly actorCid: string;
  readonly tenantCid: string;

  constructor(actorCid: string, tenantCid: string) {
    super(`Tenant ${actorCid} cannot access tenant ${tenantCid}`);
    this.name = "TenantIsolationError";
    this.actorCid = actorCid;
    this.tenantCid = tenantCid;
  }
}

export class SoulboundError extends Error {
  constructor() {
    super("CDAT licenses are soulbound and cannot be transferred");
    this.name = "SoulboundError";
  }
}

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export function emptyBooks(): Books {
  return {
    datasets: [],
    consents: [],
    licenses: [],
    sales: [],
    tokens: [],
    payouts: [],
    ledger: [],
    audit: [],
    wallets: {
      cid_alex: 240_000,
      cid_harbor: 500_000,
      cid_kepler: 500_000,
      cid_north: 500_000,
    },
    platformCents: 0,
    nextOnchainId: 1,
  };
}

export function grantedScopes(consent: ConsentRecord | undefined): string[] {
  if (!consent) return [];
  return consent.decisions.filter((decision) => decision.granted).map((decision) => decision.scope);
}

function requireDataset(books: Books, datasetId: string): Dataset {
  const dataset = books.datasets.find((item) => item.id === datasetId);
  if (!dataset) throw new LifecycleError("Unknown dataset");
  return dataset;
}

function requireLicense(books: Books, licenseId: string): LicenseRecord {
  const license = books.licenses.find((item) => item.id === licenseId);
  if (!license) throw new LifecycleError("Unknown license");
  return license;
}

function consentFor(books: Books, datasetId: string): ConsentRecord | undefined {
  return books.consents.find((item) => item.datasetId === datasetId);
}

function appendAudit(audit: AuditEvent[], event: Omit<AuditEvent, "id">): AuditEvent[] {
  return [...audit, { ...event, id: `audit_${audit.length + 1}` }];
}

export function auditVisibleTo(audit: AuditEvent[], actorCid: string): AuditEvent[] {
  return audit.filter((event) => event.tenantCid === actorCid || event.actorCid === actorCid);
}

/** CDAT licenses cannot move to another CID. This always fails. */
export function transferCdat(_token: CdatToken, _toCid: string): never {
  throw new SoulboundError();
}

export function recordRejectedTransfer(
  books: Books,
  input: { actorCid: string; tokenId: string; toCid: string; at: string },
): Books {
  const token = books.tokens.find((item) => item.tokenId === input.tokenId);
  if (!token) throw new LifecycleError("Unknown CDAT");
  if (input.actorCid !== token.licensee && input.actorCid !== token.ownerCid) {
    throw new TenantIsolationError(input.actorCid, token.ownerCid);
  }
  try {
    transferCdat(token, input.toCid);
  } catch (error) {
    if (!(error instanceof SoulboundError)) throw error;
  }
  return {
    ...books,
    audit: appendAudit(books.audit, {
      at: input.at,
      actorCid: input.actorCid,
      tenantCid: token.ownerCid,
      action: "transfer_rejected",
      subjectId: token.tokenId,
      detail: `Transfer of ${token.tokenId} to ${input.toCid} rejected. CDAT is soulbound.`,
    }),
  };
}

export function readRows(books: Books, actorCid: string, datasetId: string): SampleRow[] {
  const dataset = requireDataset(books, datasetId);
  if (dataset.ownerCid === actorCid) return dataset.rows.map((row) => ({ ...row }));
  const licensed = books.tokens.some(
    (token) =>
      token.datasetId === datasetId &&
      token.licensee === actorCid &&
      token.soulbound === true &&
      token.transferable === false &&
      isActiveToken(token),
  );
  if (!licensed) throw new TenantIsolationError(actorCid, dataset.ownerCid);
  return dataset.rows.map((row) => ({ ...row }));
}

export function recordExistingListing(books: Books, dataset: Dataset, at = dataset.createdAt): Books {
  const decisions = dataset.scopes.map((scope) => ({
    scope,
    granted: true,
    updatedAt: at,
  }));
  const consent: ConsentRecord = {
    id: `consent_${dataset.id}`,
    cid: dataset.ownerCid,
    product: dataset.product,
    datasetId: dataset.id,
    granted: decisions.length > 0,
    scopes: dataset.scopes.slice(),
    decisions,
    purpose: "data_licensing",
    timestamp: at,
  };
  let ledger = books.ledger;
  let audit = books.audit;
  for (const scope of dataset.scopes) {
    ledger = firmamentPreviewAppend(
      ledger,
      "grant",
      at,
      `${dataset.ownerCid} granted ${scope} on ${dataset.id}`,
    );
    audit = appendAudit(audit, {
      at,
      actorCid: dataset.ownerCid,
      tenantCid: dataset.ownerCid,
      action: "scope_grant",
      subjectId: dataset.id,
      scope,
      detail: `${dataset.ownerCid} opted in to ${scope} on ${dataset.id}`,
    });
  }
  consent.firmamentTx = ledger[ledger.length - 1]?.hash;
  ledger = firmamentPreviewAppend(ledger, "list", at, `${dataset.id} listed at ${dataset.priceUsd} USD`);
  const stored: Dataset = {
    ...dataset,
    consentId: consent.id,
    rows: dataset.rows.map((row) => ({ ...row })),
    status: dataset.status === "revoked" ? "revoked" : "listed",
  };
  return {
    ...books,
    datasets: [...books.datasets, stored],
    consents: [...books.consents, consent],
    ledger,
    audit,
  };
}

export function publishDataset(
  books: Books,
  input: {
    actorCid: string;
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
    at: string;
  },
): Books {
  assertPreviewTenant(input.actorCid);
  if (input.scopes.length === 0) throw new LifecycleError("Opt in to at least one scope");
  const rows = applyRecipe(input.rows, input.recipe);
  const columns = columnsOf(rows);
  if (columns.length === 0) {
    throw new LifecycleError("A listing needs at least one column after the prep recipe");
  }
  const cents = dollarsToCents(input.priceUsd);
  if (cents <= 0) throw new LifecycleError("Price must be a positive number of cents");
  const id = `ds_${books.datasets.length + 1}_${input.product}`;
  const dataset: Dataset = {
    id,
    ownerCid: input.actorCid,
    ownerName: tenantName(input.actorCid),
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
    createdAt: input.at,
    scopes: input.scopes.slice(),
    region: input.region,
    modality: input.modality,
    topics: input.topics,
  };
  return recordExistingListing(books, dataset, input.at);
}

export function offerLicense(
  books: Books,
  input: { actorCid: string; datasetId: string; at: string; amountCents?: number },
): Books {
  const dataset = requireDataset(books, input.datasetId);
  if (dataset.status !== "listed") throw new LifecycleError("Only a listed dataset can be offered");
  if (input.actorCid === dataset.ownerCid) {
    throw new LifecycleError("The owner does not offer to license their own dataset");
  }
  const consent = consentFor(books, dataset.id);
  const scopes = grantedScopes(consent);
  if (!consent?.granted || scopes.length === 0) throw new LifecycleError("The owner has not opted in");
  const amountCents = input.amountCents ?? dollarsToCents(dataset.priceUsd);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new LifecycleError("Offer amount must be a positive integer number of cents");
  }
  const open = books.licenses.find(
    (license) =>
      license.datasetId === dataset.id &&
      license.licenseeCid === input.actorCid &&
      license.phase === "offered",
  );
  if (open) throw new LifecycleError("An open offer already exists");
  const parts = splitRevenueCents(amountCents, dataset.revSharePct);
  const license: LicenseRecord = {
    id: `lic_${books.licenses.length + 1}_${dataset.id}`,
    datasetId: dataset.id,
    ownerCid: dataset.ownerCid,
    licenseeCid: input.actorCid,
    licenseeName: tenantName(input.actorCid),
    amountCents: parts.amountCents,
    ownerCents: parts.ownerCents,
    platformCents: parts.platformCents,
    scopes,
    phase: "offered",
    offeredAt: input.at,
    soulbound: true,
  };
  const ledger = firmamentPreviewAppend(
    books.ledger,
    "license",
    input.at,
    `offer ${license.id} for ${dataset.id} from ${input.actorCid} at ${parts.amountCents} cents`,
  );
  const audit = appendAudit(books.audit, {
    at: input.at,
    actorCid: input.actorCid,
    tenantCid: dataset.ownerCid,
    action: "offer",
    subjectId: license.id,
    detail: `${input.actorCid} offered ${parts.amountCents} cents for ${dataset.id}`,
  });
  return { ...books, licenses: [license, ...books.licenses], ledger, audit };
}

export function acceptLicense(
  books: Books,
  input: { actorCid: string; licenseId: string; at: string },
): Books {
  const license = requireLicense(books, input.licenseId);
  const dataset = requireDataset(books, license.datasetId);
  if (input.actorCid !== dataset.ownerCid) {
    throw new TenantIsolationError(input.actorCid, dataset.ownerCid);
  }
  if (license.phase !== "offered") throw new LifecycleError("Only an open offer can be accepted");
  if (dataset.status !== "listed") throw new LifecycleError("Dataset is not listed");
  const consent = consentFor(books, dataset.id);
  if (!consent?.granted) throw new LifecycleError("Consent is not granted");
  for (const scope of license.scopes) {
    if (!grantedScopes(consent).includes(scope)) {
      throw new LifecycleError(`Scope ${scope} is not granted`);
    }
  }
  const balance = books.wallets[license.licenseeCid] ?? 0;
  if (balance < license.amountCents) throw new LifecycleError("Licensee preview balance is short");
  const parts = splitRevenueCents(license.amountCents, dataset.revSharePct);
  if (parts.ownerCents !== license.ownerCents || parts.platformCents !== license.platformCents) {
    throw new LifecycleError("Stored split does not match integer 85/15");
  }
  const tokenId = `cdat_${books.nextOnchainId}`;
  const saleId = `sale_${license.id}`;
  let ledger = firmamentPreviewAppend(
    books.ledger,
    "license",
    input.at,
    `${tokenId} licenses ${dataset.id} to ${license.licenseeCid} until ${termExpiry(dataset.licenseTerms, input.at)}`,
  );
  const firmamentTx = ledger[ledger.length - 1]?.hash;
  ledger = firmamentPreviewAppend(
    ledger,
    "payment",
    input.at,
    `${saleId} ${parts.amountCents} owner ${parts.ownerCents} platform ${parts.platformCents}`,
  );
  const token: CdatToken = {
    tokenId,
    onchainId: books.nextOnchainId,
    datasetId: dataset.id,
    saleId,
    licensee: license.licenseeCid,
    ownerCid: dataset.ownerCid,
    terms: dataset.licenseTerms,
    amountUsd: parts.amountCents / 100,
    issuedAt: input.at,
    expiresAt: termExpiry(dataset.licenseTerms, input.at),
    burned: false,
    soulbound: true,
    transferable: false,
    firmamentTx,
  };
  const sale: LicenseSale = {
    id: saleId,
    datasetId: dataset.id,
    buyerId: license.licenseeCid,
    buyerName: license.licenseeName,
    amountCents: parts.amountCents,
    ownerCents: parts.ownerCents,
    platformCents: parts.platformCents,
    amountUsd: parts.amountCents / 100,
    userShareUsd: parts.ownerCents / 100,
    platformShareUsd: parts.platformCents / 100,
    soldAt: input.at,
    status: "completed",
    cdatTokenId: tokenId,
  };
  const payout: Payout = {
    saleId,
    cid: dataset.ownerCid,
    amountCents: parts.ownerCents,
    amountUsd: parts.ownerCents / 100,
    paid: false,
  };
  const licenses = books.licenses.map((item) => {
    if (item.id === license.id) {
      return { ...item, phase: "accepted" as const, acceptedAt: input.at, cdatTokenId: tokenId, saleId };
    }
    if (item.datasetId === dataset.id && item.phase === "offered") {
      return { ...item, phase: "revoked" as const, revokedAt: input.at, revokedBy: input.actorCid };
    }
    return item;
  });
  const audit = appendAudit(books.audit, {
    at: input.at,
    actorCid: input.actorCid,
    tenantCid: dataset.ownerCid,
    action: "accept",
    subjectId: license.id,
    detail: `${input.actorCid} accepted ${license.id}. ${tokenId} is soulbound to ${license.licenseeCid}.`,
  });
  return {
    ...books,
    datasets: books.datasets.map((item) =>
      item.id === dataset.id ? { ...item, status: "sold" } : item,
    ),
    licenses,
    sales: [sale, ...books.sales],
    tokens: [token, ...books.tokens],
    payouts: [payout, ...books.payouts],
    ledger,
    audit,
    wallets: { ...books.wallets, [license.licenseeCid]: balance - license.amountCents },
    platformCents: books.platformCents + parts.platformCents,
    nextOnchainId: books.nextOnchainId + 1,
  };
}

export function revokeLicense(
  books: Books,
  input: { actorCid: string; licenseId: string; at: string },
): Books {
  const license = requireLicense(books, input.licenseId);
  if (input.actorCid !== license.ownerCid && input.actorCid !== license.licenseeCid) {
    throw new TenantIsolationError(input.actorCid, license.ownerCid);
  }
  if (license.phase === "revoked") throw new LifecycleError("License is already revoked");
  let wallets = books.wallets;
  let platformCents = books.platformCents;
  let payouts = books.payouts;
  let sales = books.sales;
  let tokens = books.tokens;
  let datasets = books.datasets;
  if (license.phase === "accepted") {
    tokens = tokens.map((token) =>
      token.tokenId === license.cdatTokenId ? { ...token, burned: true } : token,
    );
    const payout = license.saleId ? payouts.find((item) => item.saleId === license.saleId) : undefined;
    if (payout && !payout.paid && license.saleId) {
      wallets = {
        ...wallets,
        [license.licenseeCid]: (wallets[license.licenseeCid] ?? 0) + license.amountCents,
      };
      platformCents -= license.platformCents;
      if (platformCents < 0) throw new LifecycleError("Platform preview balance cannot go negative");
      payouts = payouts.filter((item) => item.saleId !== license.saleId);
      sales = sales.map((sale) =>
        sale.id === license.saleId ? { ...sale, status: "refunded" } : sale,
      );
    }
    const consent = consentFor(books, license.datasetId);
    const stillListed = grantedScopes(consent).length > 0;
    datasets = datasets.map((dataset) =>
      dataset.id === license.datasetId
        ? { ...dataset, status: stillListed ? "listed" : "revoked" }
        : dataset,
    );
  }
  const licenses = books.licenses.map((item) =>
    item.id === license.id
      ? { ...item, phase: "revoked" as const, revokedAt: input.at, revokedBy: input.actorCid }
      : item,
  );
  const ledger = firmamentPreviewAppend(
    books.ledger,
    "revoke",
    input.at,
    `${input.actorCid} revoked ${license.id}`,
  );
  const audit = appendAudit(books.audit, {
    at: input.at,
    actorCid: input.actorCid,
    tenantCid: license.ownerCid,
    action: "license_revoke",
    subjectId: license.id,
    detail: `${input.actorCid} revoked ${license.phase} license ${license.id}`,
  });
  return {
    ...books,
    wallets,
    platformCents,
    payouts,
    sales,
    tokens,
    datasets,
    licenses,
    ledger,
    audit,
  };
}

export function setScope(
  books: Books,
  input: { actorCid: string; datasetId: string; scope: string; grant: boolean; at: string },
): Books {
  const dataset = requireDataset(books, input.datasetId);
  if (input.actorCid !== dataset.ownerCid) {
    throw new TenantIsolationError(input.actorCid, dataset.ownerCid);
  }
  const consent = consentFor(books, dataset.id);
  if (!consent) throw new LifecycleError("No consent record");
  const current = consent.decisions.find((decision) => decision.scope === input.scope);
  if (!current) throw new LifecycleError("Unknown scope");
  if (current.granted === input.grant) return books;
  const decisions = consent.decisions.map((decision) =>
    decision.scope === input.scope
      ? { ...decision, granted: input.grant, updatedAt: input.at }
      : decision,
  );
  const scopes = decisions.filter((decision) => decision.granted).map((decision) => decision.scope);
  const granted = scopes.length > 0;
  let next: Books = {
    ...books,
    consents: books.consents.map((item) =>
      item.id === consent.id
        ? { ...item, decisions, scopes, granted, timestamp: input.at }
        : item,
    ),
    datasets: books.datasets.map((item) =>
      item.id === dataset.id
        ? {
            ...item,
            scopes,
            status: granted ? (item.status === "revoked" ? "listed" : item.status) : "revoked",
          }
        : item,
    ),
    ledger: firmamentPreviewAppend(
      books.ledger,
      input.grant ? "grant" : "revoke",
      input.at,
      `${input.actorCid} ${input.grant ? "granted" : "revoked"} ${input.scope} on ${dataset.id}`,
    ),
    audit: appendAudit(books.audit, {
      at: input.at,
      actorCid: input.actorCid,
      tenantCid: dataset.ownerCid,
      action: input.grant ? "scope_grant" : "scope_revoke",
      subjectId: dataset.id,
      scope: input.scope,
      detail: `${input.actorCid} ${input.grant ? "opted in to" : "revoked"} ${input.scope} on ${dataset.id}`,
    }),
  };
  if (!granted) {
    const live = next.licenses.filter(
      (license) => license.datasetId === dataset.id && license.phase !== "revoked",
    );
    for (const license of live) {
      next = revokeLicense(next, { actorCid: input.actorCid, licenseId: license.id, at: input.at });
    }
    return next;
  }
  const accepted = next.licenses.filter(
    (license) => license.datasetId === dataset.id && license.phase === "accepted",
  );
  for (const license of accepted) {
    const kept = license.scopes.filter((scope) => scopes.includes(scope));
    if (kept.length === 0) {
      next = revokeLicense(next, { actorCid: input.actorCid, licenseId: license.id, at: input.at });
    } else {
      next = {
        ...next,
        licenses: next.licenses.map((item) =>
          item.id === license.id ? { ...item, scopes: kept } : item,
        ),
      };
    }
  }
  return next;
}

export function settlePayout(
  books: Books,
  input: { actorCid: string; saleId: string; at: string },
): Books {
  const payout = books.payouts.find((item) => item.saleId === input.saleId);
  if (!payout || payout.paid) throw new LifecycleError("Nothing to settle");
  if (input.actorCid !== payout.cid) throw new TenantIsolationError(input.actorCid, payout.cid);
  return {
    ...books,
    wallets: {
      ...books.wallets,
      [payout.cid]: (books.wallets[payout.cid] ?? 0) + payout.amountCents,
    },
    payouts: books.payouts.map((item) =>
      item.saleId === input.saleId ? { ...item, paid: true, paidAt: input.at } : item,
    ),
    ledger: firmamentPreviewAppend(
      books.ledger,
      "payment",
      input.at,
      `payout ${input.saleId} ${payout.amountCents} cents to ${payout.cid}`,
    ),
    audit: appendAudit(books.audit, {
      at: input.at,
      actorCid: input.actorCid,
      tenantCid: payout.cid,
      action: "settle",
      subjectId: input.saleId,
      detail: `Settled ${payout.amountCents} cents to ${payout.cid}`,
    }),
  };
}
