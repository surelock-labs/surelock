// Unit tests for @surelock-labs/router -- pure logic, no blockchain.
// Tests selectBest() strategies, constraint filtering, and edge cases.

import { expect } from "chai";
import { selectBest } from "@surelock-labs/router";
import type { Offer } from "@surelock-labs/router";

// -- fixtures ------------------------------------------------------------------

function makeOffer(overrides: Partial<Offer> & { quoteId: bigint }): Offer {
  return {
    bundler: `0x${overrides.quoteId.toString(16).padStart(40, "0")}`,
    feePerOp: 100n,
    slaBlocks: 10,
    collateralWei: 1000n,
    active: true,
    ...overrides,
  };
}

// Three distinct offers for most tests:
//   A: cheapest fee, slowest SLA, low collateral
//   B: mid fee, fastest SLA, mid collateral
//   C: expensive fee, mid SLA, highest collateral
const A = makeOffer({ quoteId: 0n, feePerOp: 100n, slaBlocks: 20, collateralWei: 500n });
const B = makeOffer({ quoteId: 1n, feePerOp: 200n, slaBlocks: 5,  collateralWei: 1000n });
const C = makeOffer({ quoteId: 2n, feePerOp: 300n, slaBlocks: 10, collateralWei: 2000n });
const OFFERS = [A, B, C];

// -- selectBest -- strategy: cheapest ------------------------------------------

describe("selectBest -- cheapest strategy", () => {
  it("picks the offer with the lowest feePerOp", () => {
    expect(selectBest(OFFERS, "cheapest")?.quoteId).to.equal(0n); // A
  });

  it("tie-breaks by fastest SLA when fees are equal", () => {
    const X = makeOffer({ quoteId: 10n, feePerOp: 100n, slaBlocks: 15, collateralWei: 500n });
    const Y = makeOffer({ quoteId: 11n, feePerOp: 100n, slaBlocks: 5,  collateralWei: 500n });
    expect(selectBest([X, Y], "cheapest")?.quoteId).to.equal(11n); // Y has fewer slaBlocks
  });

  it("returns the single offer when only one is active", () => {
    expect(selectBest([A], "cheapest")?.quoteId).to.equal(0n);
  });

  it("returns null for an empty list", () => {
    expect(selectBest([], "cheapest")).to.be.null;
  });

  it("ignores inactive offers", () => {
    const inactive = { ...A, active: false };
    expect(selectBest([inactive, B, C], "cheapest")?.quoteId).to.equal(1n); // B is now cheapest
  });
});

// -- selectBest -- strategy: fastest -------------------------------------------

describe("selectBest -- fastest strategy", () => {
  it("picks the offer with the fewest slaBlocks", () => {
    expect(selectBest(OFFERS, "fastest")?.quoteId).to.equal(1n); // B (slaBlocks=5)
  });

  it("tie-breaks by lowest fee when SLA is equal", () => {
    const X = makeOffer({ quoteId: 10n, feePerOp: 300n, slaBlocks: 5, collateralWei: 500n });
    const Y = makeOffer({ quoteId: 11n, feePerOp: 100n, slaBlocks: 5, collateralWei: 500n });
    expect(selectBest([X, Y], "fastest")?.quoteId).to.equal(11n); // Y is cheaper
  });

  it("returns null for empty list", () => {
    expect(selectBest([], "fastest")).to.be.null;
  });

  it("ignores inactive offers", () => {
    const inactiveB = { ...B, active: false };
    // C (slaBlocks=10) is next fastest
    expect(selectBest([A, inactiveB, C], "fastest")?.quoteId).to.equal(2n);
  });
});

// -- selectBest -- strategy: safest ---------------------------------------------

describe("selectBest -- safest strategy", () => {
  it("picks the offer with the highest collateralWei", () => {
    expect(selectBest(OFFERS, "safest")?.quoteId).to.equal(2n); // C (collateral=2000)
  });

  it("tie-breaks by lowest fee when collateral is equal", () => {
    const X = makeOffer({ quoteId: 10n, feePerOp: 300n, slaBlocks: 5, collateralWei: 2000n });
    const Y = makeOffer({ quoteId: 11n, feePerOp: 100n, slaBlocks: 5, collateralWei: 2000n });
    expect(selectBest([X, Y], "safest")?.quoteId).to.equal(11n); // Y is cheaper
  });

  it("returns null for empty list", () => {
    expect(selectBest([], "safest")).to.be.null;
  });

  it("ignores inactive offers", () => {
    const inactiveC = { ...C, active: false };
    expect(selectBest([A, B, inactiveC], "safest")?.quoteId).to.equal(1n); // B (collateral=1000)
  });
});

// -- selectBest -- constraint: maxFee ------------------------------------------

describe("selectBest -- maxFee constraint", () => {
  it("filters out offers above maxFee", () => {
    // Only A (fee=100) qualifies; B and C are too expensive
    expect(selectBest(OFFERS, "cheapest", { maxFee: 100n })?.quoteId).to.equal(0n);
  });

  it("includes offers exactly at maxFee", () => {
    expect(selectBest(OFFERS, "cheapest", { maxFee: 200n })?.quoteId).to.equal(0n); // A cheapest
  });

  it("returns null when all offers exceed maxFee", () => {
    expect(selectBest(OFFERS, "cheapest", { maxFee: 50n })).to.be.null;
  });
});

// -- selectBest -- constraint: maxSlaBlocks ------------------------------------

describe("selectBest -- maxSlaBlocks constraint", () => {
  it("filters out offers with too many slaBlocks", () => {
    // Only B (slaBlocks=5) qualifies with maxSlaBlocks=8
    expect(selectBest(OFFERS, "cheapest", { maxSlaBlocks: 8 })?.quoteId).to.equal(1n);
  });

  it("includes offers exactly at maxSlaBlocks", () => {
    // A (sla=20) is filtered out; B (sla=5) and C (sla=10) qualify -> cheapest is B (fee=200)
    expect(selectBest(OFFERS, "cheapest", { maxSlaBlocks: 10 })?.quoteId).to.equal(1n);
  });

  it("returns null when all offers exceed maxSlaBlocks", () => {
    expect(selectBest(OFFERS, "cheapest", { maxSlaBlocks: 2 })).to.be.null;
  });
});

// -- selectBest -- constraint: minCollateral -----------------------------------

describe("selectBest -- minCollateral constraint", () => {
  it("filters out offers below minCollateral", () => {
    // Only C (collateral=2000) qualifies
    expect(selectBest(OFFERS, "cheapest", { minCollateral: 1500n })?.quoteId).to.equal(2n);
  });

  it("includes offers exactly at minCollateral", () => {
    // B (1000) and C (2000) qualify; cheapest is B (fee=200)
    expect(selectBest(OFFERS, "cheapest", { minCollateral: 1000n })?.quoteId).to.equal(1n);
  });

  it("returns null when no offer meets minCollateral", () => {
    expect(selectBest(OFFERS, "cheapest", { minCollateral: 9999n })).to.be.null;
  });
});

// -- selectBest -- combined constraints ----------------------------------------

describe("selectBest -- combined constraints", () => {
  it("applies all three constraints together", () => {
    // maxFee=250, maxSlaBlocks=15, minCollateral=800
    // A: fee=100 v, sla=20 x -> out
    // B: fee=200 v, sla=5 v, collateral=1000 v -> in
    // C: fee=300 x -> out
    expect(selectBest(OFFERS, "cheapest", {
      maxFee: 250n,
      maxSlaBlocks: 15,
      minCollateral: 800n,
    })?.quoteId).to.equal(1n);
  });

  it("returns null when combined constraints eliminate all offers", () => {
    expect(selectBest(OFFERS, "cheapest", {
      maxFee: 150n,      // only A
      minCollateral: 2000n, // only C
    })).to.be.null;
  });
});

// -- selectBest -- default strategy --------------------------------------------

describe("selectBest -- defaults", () => {
  it("defaults to cheapest strategy when strategy is omitted", () => {
    expect(selectBest(OFFERS)?.quoteId).to.equal(0n); // A (cheapest)
  });

  it("defaults to no constraints when constraints are omitted", () => {
    expect(selectBest([C], "safest")?.quoteId).to.equal(2n);
  });
});

// -- selectBest -- maxFee budget semantics -------------------------------------
// maxFee filters on feePerOp (bundler fee) only.
// The actual client payment is feePerOp + protocolFeeWei, but protocolFeeWei is
// flat and global -- not part of the offer comparison. Callers computing a total
// spend budget must add protocolFeeWei separately before passing maxFee.

describe("selectBest -- maxFee semantics (bundler fee only, not total client cost)", () => {
  it("maxFee=feePerOp selects offer even though total client cost is feePerOp + protocolFee", () => {
    // Offer A has feePerOp=100. If protocolFeeWei=50 applied, total client cost=150.
    // maxFee=100 still selects A because the constraint is on bundler fee, not total.
    expect(selectBest(OFFERS, "cheapest", { maxFee: 100n })?.quoteId).to.equal(0n);
  });

  it("callers enforcing a total spend cap must subtract protocolFee before passing maxFee", () => {
    // Caller budget = 120 total, protocolFeeWei = 50 -> maxFee = 70.
    // Only A (fee=100) would fit the total budget, but maxFee=70 excludes it too.
    // Correct: caller must set maxFee = budget - protocolFeeWei.
    expect(selectBest(OFFERS, "cheapest", { maxFee: 70n })).to.be.null;
  });
});
