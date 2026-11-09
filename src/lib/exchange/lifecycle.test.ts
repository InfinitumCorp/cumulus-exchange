import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptLicense,
  auditVisibleTo,
  emptyBooks,
  offerLicense,
  readRows,
  recordExistingListing,
  recordRejectedTransfer,
  revokeLicense,
  setScope,
  settlePayout,
  SoulboundError,
  TenantIsolationError,
  transferCdat,
} from "./lifecycle.ts";
import {
  divTrunc,
  dollarsToCents,
  FIRMAMENT_CHANNEL,
  REV_SHARE,
  SESSION_CID,
  splitHolds,
  splitRevenueCents,
  type Dataset,
} from "./model.ts";
import { seedBooks } from "./seed.ts";
import { decodeSse, drift, encodeSse, positionOf } from "./stream.ts";
import { driveHeaders, driveObjectUrl, previewShareHref } from "./drive-client.ts";

function sample(owner = "cid_alex"): Dataset {
  return {
    id: "ds_unit",
    ownerCid: owner,
    ownerName: "Alex Rivera",
    product: "cumulus",
    title: "Unit aggregates",
    description: "Synthetic rows for the lifecycle tests.",
    schema: "category,count",
    columns: ["category", "count"],
    rows: [
      { category: "photos", count: 2 },
      { category: "archive", count: 5 },
    ],
    sizeEstimate: 10,
    privacyLevel: "aggregated",
    licenseTerms: "CDAT-research-1y",
    priceUsd: 1,
    revSharePct: REV_SHARE,
    status: "listed",
    createdAt: "2026-11-01T00:00:00.000Z",
    scopes: ["usage_metrics", "workflow_stats"],
    region: "iad",
    modality: "aggregate",
    topics: { storage: 1 },
  };
}

describe("revenue split", () => {
  it("uses integer truncating division and keeps an 85/15 remainder", () => {
    assert.equal(divTrunc(8585, 100), 85);
    const exact = splitRevenueCents(10_000);
    assert.deepEqual(exact, { amountCents: 10_000, ownerCents: 8_500, platformCents: 1_500 });
    const dust = splitRevenueCents(101);
    assert.equal(dust.ownerCents, 85);
    assert.equal(dust.platformCents, 16);
    assert.equal(dust.ownerCents + dust.platformCents, 101);
    const penny = splitRevenueCents(1);
    assert.equal(penny.ownerCents + penny.platformCents, 1);
    assert.equal(dollarsToCents(80.5), 8050);
    assert.throws(() => splitRevenueCents(1.5), /safe integer/);
    assert.throws(() => splitRevenueCents(-1), /safe integer/);
  });

  it("matches the seeded sale", () => {
    const books = seedBooks();
    const sale = books.sales[0];
    assert.ok(sale);
    assert.equal(sale.amountCents, 40_000);
    assert.equal(sale.ownerCents, 34_000);
    assert.equal(sale.platformCents, 6_000);
    assert.equal(splitHolds(sale, REV_SHARE), true);
    assert.equal(books.platformCents, 6_000);
    assert.equal(FIRMAMENT_CHANNEL, "preview");
  });
});

describe("consent", () => {
  it("opts in per scope and revokes one scope without dropping the other", () => {
    let books = recordExistingListing(emptyBooks(), sample());
    const before = books.audit.filter((event) => event.action === "scope_grant");
    assert.equal(before.length, 2);
    books = setScope(books, {
      actorCid: "cid_alex",
      datasetId: "ds_unit",
      scope: "workflow_stats",
      grant: false,
      at: "2026-11-02T00:00:00.000Z",
    });
    const consent = books.consents[0];
    assert.ok(consent);
    assert.equal(consent.granted, true);
    assert.deepEqual(consent.scopes, ["usage_metrics"]);
    assert.equal(
      books.audit.some((event) => event.action === "scope_revoke" && event.scope === "workflow_stats"),
      true,
    );
    const again = setScope(books, {
      actorCid: "cid_alex",
      datasetId: "ds_unit",
      scope: "workflow_stats",
      grant: false,
      at: "2026-11-02T00:00:01.000Z",
    });
    assert.equal(again.audit.length, books.audit.length);
  });

  it("revoking the last scope burns an accepted CDAT and records the trail", () => {
    let books = recordExistingListing(emptyBooks(), sample());
    books = offerLicense(books, {
      actorCid: "cid_harbor",
      datasetId: "ds_unit",
      at: "2026-11-03T00:00:00.000Z",
    });
    const offer = books.licenses[0];
    assert.ok(offer);
    books = acceptLicense(books, {
      actorCid: "cid_alex",
      licenseId: offer.id,
      at: "2026-11-03T01:00:00.000Z",
    });
    books = setScope(books, {
      actorCid: "cid_alex",
      datasetId: "ds_unit",
      scope: "usage_metrics",
      grant: false,
      at: "2026-11-03T02:00:00.000Z",
    });
    books = setScope(books, {
      actorCid: "cid_alex",
      datasetId: "ds_unit",
      scope: "workflow_stats",
      grant: false,
      at: "2026-11-03T03:00:00.000Z",
    });
    assert.equal(books.datasets[0]?.status, "revoked");
    assert.equal(books.tokens[0]?.burned, true);
    assert.equal(books.licenses.every((license) => license.phase === "revoked"), true);
    assert.equal(books.sales[0]?.status, "refunded");
    assert.equal(books.wallets.cid_harbor, 500_000);
  });
});

describe("tenant isolation", () => {
  it("hides rows, consent changes, payouts, and audit from other tenants", () => {
    let books = recordExistingListing(emptyBooks(), sample());
    assert.throws(() => readRows(books, "cid_harbor", "ds_unit"), TenantIsolationError);
    assert.deepEqual(readRows(books, "cid_alex", "ds_unit"), books.datasets[0]?.rows);
    assert.throws(
      () =>
        setScope(books, {
          actorCid: "cid_harbor",
          datasetId: "ds_unit",
          scope: "usage_metrics",
          grant: false,
          at: "2026-11-04T00:00:00.000Z",
        }),
      TenantIsolationError,
    );
    books = offerLicense(books, {
      actorCid: "cid_harbor",
      datasetId: "ds_unit",
      at: "2026-11-04T01:00:00.000Z",
    });
    const offer = books.licenses[0];
    assert.ok(offer);
    books = acceptLicense(books, {
      actorCid: "cid_alex",
      licenseId: offer.id,
      at: "2026-11-04T02:00:00.000Z",
    });
    assert.equal(readRows(books, "cid_harbor", "ds_unit").length, 2);
    assert.throws(() => readRows(books, "cid_kepler", "ds_unit"), TenantIsolationError);
    const saleId = books.sales[0]?.id ?? "";
    assert.throws(
      () => settlePayout(books, { actorCid: "cid_harbor", saleId, at: "2026-11-04T03:00:00.000Z" }),
      TenantIsolationError,
    );
    books = settlePayout(books, {
      actorCid: "cid_alex",
      saleId,
      at: "2026-11-04T03:00:00.000Z",
    });
    assert.equal(books.wallets.cid_alex, 240_000 + 85);
    const harbor = auditVisibleTo(books.audit, "cid_harbor").map((event) => event.action);
    assert.equal(harbor.includes("scope_grant"), false);
    assert.equal(harbor.includes("offer"), true);
    const kepler = auditVisibleTo(books.audit, "cid_kepler");
    assert.equal(kepler.length, 0);
  });
});

describe("license lifecycle", () => {
  it("offers, accepts, and revokes with a soulbound CDAT", () => {
    let books = recordExistingListing(emptyBooks(), sample("cid_kepler"));
    books = offerLicense(books, {
      actorCid: "cid_alex",
      datasetId: "ds_unit",
      at: "2026-11-05T00:00:00.000Z",
    });
    const offer = books.licenses[0];
    assert.ok(offer);
    assert.equal(offer.phase, "offered");
    assert.equal(offer.ownerCents, 85);
    assert.equal(offer.platformCents, 15);
    assert.equal(books.wallets.cid_alex, 240_000);
    assert.throws(
      () =>
        acceptLicense(books, {
          actorCid: "cid_alex",
          licenseId: offer.id,
          at: "2026-11-05T01:00:00.000Z",
        }),
      TenantIsolationError,
    );
    books = acceptLicense(books, {
      actorCid: "cid_kepler",
      licenseId: offer.id,
      at: "2026-11-05T01:00:00.000Z",
    });
    const token = books.tokens[0];
    assert.ok(token);
    assert.equal(token.soulbound, true);
    assert.equal(token.transferable, false);
    assert.equal(books.datasets[0]?.status, "sold");
    assert.equal(books.wallets.cid_alex, 240_000 - 100);
    assert.equal(books.platformCents, 15);
    assert.throws(() => transferCdat(token, "cid_north"), SoulboundError);
    const rejected = recordRejectedTransfer(books, {
      actorCid: "cid_alex",
      tokenId: token.tokenId,
      toCid: "cid_north",
      at: "2026-11-05T02:00:00.000Z",
    });
    assert.equal(rejected.tokens[0]?.licensee, "cid_alex");
    assert.equal(rejected.audit.at(-1)?.action, "transfer_rejected");
    books = revokeLicense(books, {
      actorCid: "cid_kepler",
      licenseId: offer.id,
      at: "2026-11-05T03:00:00.000Z",
    });
    assert.equal(books.licenses[0]?.phase, "revoked");
    assert.equal(books.tokens[0]?.burned, true);
    assert.equal(books.datasets[0]?.status, "listed");
    assert.equal(books.wallets.cid_alex, 240_000);
    assert.equal(books.platformCents, 0);
    assert.throws(
      () =>
        revokeLicense(books, {
          actorCid: "cid_north",
          licenseId: offer.id,
          at: "2026-11-05T04:00:00.000Z",
        }),
      TenantIsolationError,
    );
  });

  it("keeps a settled preview payout when the license is later revoked", () => {
    let books = recordExistingListing(emptyBooks(), sample());
    books = offerLicense(books, {
      actorCid: "cid_north",
      datasetId: "ds_unit",
      at: "2026-11-06T00:00:00.000Z",
    });
    const offer = books.licenses[0];
    assert.ok(offer);
    books = acceptLicense(books, {
      actorCid: SESSION_CID,
      licenseId: offer.id,
      at: "2026-11-06T01:00:00.000Z",
    });
    const saleId = books.sales[0]?.id ?? "";
    books = settlePayout(books, {
      actorCid: SESSION_CID,
      saleId,
      at: "2026-11-06T02:00:00.000Z",
    });
    const settled = books.wallets.cid_alex;
    books = revokeLicense(books, {
      actorCid: SESSION_CID,
      licenseId: offer.id,
      at: "2026-11-06T03:00:00.000Z",
    });
    assert.equal(books.tokens[0]?.burned, true);
    assert.equal(books.wallets.cid_alex, settled);
    assert.equal(books.payouts[0]?.paid, true);
    assert.equal(books.sales[0]?.status, "completed");
  });
});

describe("seed chain and catalog stream", () => {
  it("links the preview ledger and places an open offer on Alex's listing", () => {
    const books = seedBooks();
    let prev = "firmament_genesis";
    for (const entry of books.ledger) {
      assert.equal(entry.prev, prev);
      prev = entry.hash;
    }
    const open = books.licenses.find((license) => license.phase === "offered");
    assert.equal(open?.datasetId, "ds_firm");
    assert.equal(open?.licenseeCid, "cid_north");
    assert.equal(open?.ownerCid, SESSION_CID);
    const held = books.tokens.find((token) => token.datasetId === "ds_spectre");
    assert.equal(held?.licensee, "cid_harbor");
    assert.equal(held?.soulbound, true);
  });

  it("round-trips a mock SSE asset tick", () => {
    const dataset = seedBooks().datasets.find((item) => item.id === "ds_optical");
    assert.ok(dataset);
    const fix = {
      id: "asset_ds_optical",
      datasetId: dataset.id,
      title: dataset.title,
      kind: "asset" as const,
      ...positionOf(dataset),
    };
    const moved = drift(fix, 1);
    assert.notEqual(moved.lat, fix.lat);
    const tick = {
      id: moved.id,
      datasetId: moved.datasetId,
      lat: moved.lat,
      lon: moved.lon,
      at: "2026-11-07T00:00:00.000Z",
      seq: 1,
    };
    assert.deepEqual(decodeSse(encodeSse(tick)), tick);
    assert.equal(decodeSse("event: asset\n\n"), null);
  });
});

describe("drive client", () => {
  it("calls the /api/drive routes with a purpose header", () => {
    assert.equal(driveObjectUrl("drive"), "/api/drive/v1/objects/drive");
    assert.equal(driveObjectUrl("drive", "notes.txt"), "/api/drive/v1/objects/drive/notes.txt");
    assert.deepEqual(driveHeaders("token-demo", "drive.write"), {
      authorization: "Bearer token-demo",
      "x-cumulus-purpose": "drive.write",
    });
    assert.equal(
      previewShareHref("https://cloud.cumuluscloud.app/v1/shared?shareId=shr_1&exp=1&sig=abc"),
      "/api/drive/v1/shared?shareId=shr_1&exp=1&sig=abc",
    );
  });
});
