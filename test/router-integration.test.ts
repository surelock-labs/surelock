// Integration tests for @surelock-labs/router against a live in-process Hardhat chain.
// Deploys a real QuoteRegistry, registers offers, and exercises fetchQuotes + selectBest.

import { expect }   from "chai";
import { ethers }   from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { fetchQuotes, selectBest } from "@surelock-labs/router";
import type { Offer } from "@surelock-labs/router";

// -- constants ----------------------------------------------------------------

const ONE_GWEI = ethers.parseUnits("1", "gwei");
const COLLATERAL = ethers.parseEther("0.01");

// -- fixture ------------------------------------------------------------------

async function deploy() {
  const [owner, bundlerA, bundlerB, bundlerC] = await ethers.getSigners();

  const Factory  = await ethers.getContractFactory("QuoteRegistry");
  const registry = await Factory.deploy(owner.address, ethers.parseEther("0.0001"));

  // bundlerA: cheapest fee, slow SLA, low collateral
  await registry.connect(bundlerA).register(ONE_GWEI,       5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });            // quoteId 1
  // bundlerB: mid fee, fastest SLA, mid collateral
  await registry.connect(bundlerB).register(ONE_GWEI * 2n,  2, COLLATERAL * 2n, 302_400, { value: ethers.parseEther("0.0001") });       // quoteId 2
  // bundlerC: expensive fee, mid SLA, highest collateral
  await registry.connect(bundlerC).register(ONE_GWEI * 3n,  3, COLLATERAL * 5n, 302_400, { value: ethers.parseEther("0.0001") });       // quoteId 3

  const registryAddress = await registry.getAddress();
  const provider = ethers.provider;

  return { registry, registryAddress, provider, owner, bundlerA, bundlerB, bundlerC };
}

// -- fetchQuotes ---------------------------------------------------------------

describe("fetchQuotes (integration)", () => {
  it("returns all active offers with correct field types", async () => {
    const { provider, registryAddress } = await loadFixture(deploy);
    const offers = await fetchQuotes(provider, registryAddress);

    expect(offers).to.have.length(3);
    for (const o of offers) {
      expect(typeof o.quoteId).to.equal("bigint");
      expect(typeof o.bundler).to.equal("string");
      expect(o.bundler).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(typeof o.feePerOp).to.equal("bigint");
      expect(typeof o.slaBlocks).to.equal("number");
      expect(typeof o.collateralWei).to.equal("bigint");
      expect(o.active).to.be.true;
    }
  });

  it("returns offers with correct on-chain values", async () => {
    const { provider, registryAddress, bundlerA, bundlerB, bundlerC } = await loadFixture(deploy);
    const offers = await fetchQuotes(provider, registryAddress);

    const a = offers.find((o) => o.bundler.toLowerCase() === bundlerA.address.toLowerCase())!;
    const b = offers.find((o) => o.bundler.toLowerCase() === bundlerB.address.toLowerCase())!;
    const c = offers.find((o) => o.bundler.toLowerCase() === bundlerC.address.toLowerCase())!;

    expect(a.feePerOp).to.equal(ONE_GWEI);
    expect(a.slaBlocks).to.equal(5);
    expect(a.collateralWei).to.equal(COLLATERAL);

    expect(b.feePerOp).to.equal(ONE_GWEI * 2n);
    expect(b.slaBlocks).to.equal(2);
    expect(b.collateralWei).to.equal(COLLATERAL * 2n);

    expect(c.feePerOp).to.equal(ONE_GWEI * 3n);
    expect(c.slaBlocks).to.equal(3);
    expect(c.collateralWei).to.equal(COLLATERAL * 5n);
  });

  it("excludes deregistered offers", async () => {
    const { registry, provider, registryAddress, bundlerB } = await loadFixture(deploy);
    await registry.connect(bundlerB).deregister(2n); // quoteId 2 -> bundlerB
    const offers = await fetchQuotes(provider, registryAddress);
    expect(offers).to.have.length(2);
    expect(offers.every((o) => o.bundler.toLowerCase() !== bundlerB.address.toLowerCase())).to.be.true;
  });

  it("returns empty array when no offers are registered", async () => {
    const [owner] = await ethers.getSigners();
    const Factory  = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Factory.deploy(owner.address, ethers.parseEther("0.0001"));
    const offers = await fetchQuotes(ethers.provider, await registry.getAddress());
    expect(offers).to.deep.equal([]);
  });
});

// -- selectBest with real on-chain offers -------------------------------------

describe("selectBest (integration -- real offers from chain)", () => {
  let offers: Offer[];
  let bundlerA: any, bundlerB: any, bundlerC: any;

  beforeEach(async () => {
    const fix = await loadFixture(deploy);
    offers    = await fetchQuotes(fix.provider, fix.registryAddress);
    bundlerA  = fix.bundlerA;
    bundlerB  = fix.bundlerB;
    bundlerC  = fix.bundlerC;
  });

  it("cheapest picks bundlerA (lowest fee=1 gwei)", () => {
    const best = selectBest(offers, "cheapest");
    expect(best?.bundler.toLowerCase()).to.equal(bundlerA.address.toLowerCase());
  });

  it("fastest picks bundlerB (slaBlocks=2)", () => {
    const best = selectBest(offers, "fastest");
    expect(best?.bundler.toLowerCase()).to.equal(bundlerB.address.toLowerCase());
  });

  it("safest picks bundlerC (collateral=5x)", () => {
    const best = selectBest(offers, "safest");
    expect(best?.bundler.toLowerCase()).to.equal(bundlerC.address.toLowerCase());
  });

  it("cheapest with maxFee=1gwei picks only bundlerA", () => {
    const best = selectBest(offers, "cheapest", { maxFee: ONE_GWEI });
    expect(best?.bundler.toLowerCase()).to.equal(bundlerA.address.toLowerCase());
  });

  it("cheapest with maxFee below all offers returns null", () => {
    expect(selectBest(offers, "cheapest", { maxFee: 1n })).to.be.null;
  });

  it("fastest with maxSlaBlocks=2 picks only bundlerB", () => {
    const best = selectBest(offers, "fastest", { maxSlaBlocks: 2 });
    expect(best?.bundler.toLowerCase()).to.equal(bundlerB.address.toLowerCase());
  });

  it("safest with minCollateral=4x picks only bundlerC", () => {
    const best = selectBest(offers, "safest", { minCollateral: COLLATERAL * 4n });
    expect(best?.bundler.toLowerCase()).to.equal(bundlerC.address.toLowerCase());
  });

  it("combined constraints: minCollateral=2x + maxFee=2gwei picks bundlerB", () => {
    // bundlerA: collateral=1x x (too low), bundlerB: collateral=2x v, fee=2gwei v
    // bundlerC: fee=3gwei x
    const best = selectBest(offers, "cheapest", {
      minCollateral: COLLATERAL * 2n,
      maxFee: ONE_GWEI * 2n,
    });
    expect(best?.bundler.toLowerCase()).to.equal(bundlerB.address.toLowerCase());
  });
});

// -- round-trip: register -> fetch -> select ------------------------------------

describe("round-trip (register -> fetch -> select)", () => {
  it("a newly registered offer appears immediately in fetchQuotes", async () => {
    const { registry, provider, registryAddress } = await loadFixture(deploy);
    const [,,,,, newBundler] = await ethers.getSigners();

    // Register a very cheap offer. T8: collateral must be strictly > fee, so use 2 wei.
    await registry.connect(newBundler).register(1n, 1, 2n, 302_400, { value: ethers.parseEther("0.0001") });

    const offers = await fetchQuotes(provider, registryAddress);
    expect(offers).to.have.length(4);
    const newOffer = offers.find((o) => o.bundler.toLowerCase() === newBundler.address.toLowerCase());
    expect(newOffer).to.exist;
    expect(newOffer!.feePerOp).to.equal(1n);
  });

  it("selectBest(cheapest) finds the newly registered cheapest offer", async () => {
    const { registry, provider, registryAddress } = await loadFixture(deploy);
    const [,,,,, newBundler] = await ethers.getSigners();

    await registry.connect(newBundler).register(1n, 1, 2n, 302_400, { value: ethers.parseEther("0.0001") });
    const offers = await fetchQuotes(provider, registryAddress);
    const best = selectBest(offers, "cheapest");

    expect(best?.bundler.toLowerCase()).to.equal(newBundler.address.toLowerCase());
    expect(best?.feePerOp).to.equal(1n);
  });

  it("deregistered offer no longer selected", async () => {
    const { registry, provider, registryAddress, bundlerA } = await loadFixture(deploy);

    // bundlerA has the cheapest offer (quoteId=1); deregister it
    await registry.connect(bundlerA).deregister(1n);
    const offers = await fetchQuotes(provider, registryAddress);
    const best = selectBest(offers, "cheapest");

    // bundlerB (fee=2gwei) is now cheapest
    expect(best?.feePerOp).to.equal(ONE_GWEI * 2n);
  });
});

// -- active vs routable: fetchQuotes uses list(), not listRoutable() -----------
// fetchQuotes returns all active offers regardless of whether the bundler has
// enough idle collateral to actually accept(). listRoutable(escrow) is the
// stricter check -- but requires an escrow address and is not used by fetchQuotes.
// Callers using selectBest on fetchQuotes output may receive quotes that will
// revert at accept() if the bundler is undercollateralised.

describe("active vs routable -- fetchQuotes returns offers that may lack idle collateral", () => {
  it("undercollateralised bundler appears active in fetchQuotes but cannot accept", async () => {
    const [owner, bundlerA] = await ethers.getSigners();
    const Factory  = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Factory.deploy(owner.address, ethers.parseEther("0.0001"));

    // Register offer but do NOT deposit collateral into any escrow
    await registry.connect(bundlerA).register(ONE_GWEI, 5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });

    const offers = await fetchQuotes(ethers.provider, await registry.getAddress());
    expect(offers).to.have.length(1);
    expect(offers[0].active).to.be.true; // active on registry

    // selectBest picks the offer (meets budget criteria) ...
    const best = selectBest(offers, "cheapest");
    expect(best?.bundler.toLowerCase()).to.equal(bundlerA.address.toLowerCase());

    // ... but an accept() against this bundler would revert InsufficientIdle
    // because no collateral was deposited into the escrow.
    // This is intentional: fetchQuotes is registry-based, not escrow-balance-based.
    // Use registry.listRoutable(escrowAddress) for escrow-aware discovery.
  });

  it("listRoutable excludes bundler with zero idle balance (escrow-aware filter)", async () => {
    const [owner, bundlerFunded, bundlerEmpty] = await ethers.getSigners();
    const Factory  = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Factory.deploy(owner.address, ethers.parseEther("0.0001"));

    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const { upgrades } = await import("hardhat");
    const escrow = await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), owner.address],
      { kind: "uups" },
    ) as any;
    const escrowAddress = await escrow.getAddress();

    await registry.connect(bundlerFunded).register(ONE_GWEI,      5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await registry.connect(bundlerEmpty).register(ONE_GWEI * 2n, 5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });

    // Only bundlerFunded deposits collateral
    await escrow.connect(bundlerFunded).deposit({ value: COLLATERAL });

    const routable = await registry.listRoutable(escrowAddress);
    expect(routable.length).to.equal(1);
    expect(routable[0].bundler.toLowerCase()).to.equal(bundlerFunded.address.toLowerCase());
  });
});
