// Integration tests for @surelock-labs/router against a live in-process Hardhat chain.
// Deploys a real QuoteRegistry, registers offers, and exercises fetchQuotes + selectBest.

import { expect }   from "chai";
import { ethers }   from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  fetchQuotes,
  selectBest,
  commitOp,
  cancel,
  claimRefund,
  claimPayout,
  totalCommitValue,
  scoreBundlers,
  fetchAndScoreQuotes,
} from "@surelock-labs/router";
import type { Offer } from "@surelock-labs/router";
import { register, deposit, accept } from "@surelock-labs/bundler";

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

  it("rejects invalid page sizes before querying", async () => {
    const { provider, registryAddress } = await loadFixture(deploy);
    await expect(fetchQuotes(provider, registryAddress, 0)).to.be.rejectedWith("pageSize must be a positive safe integer");
    await expect(fetchQuotes(provider, registryAddress, -1)).to.be.rejectedWith("pageSize must be a positive safe integer");
    await expect(fetchQuotes(provider, registryAddress, 1.5)).to.be.rejectedWith("pageSize must be a positive safe integer");
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

// -- reliability scoring -------------------------------------------------------

describe("reliability scoring", () => {
  async function deployScoringEscrow() {
    const [owner, bundlerA, bundlerB] = await ethers.getSigners();
    const BOND = ethers.parseEther("0.0001");
    const RegF = await ethers.getContractFactory("QuoteRegistry");
    const reg  = await RegF.deploy(owner.address, BOND);
    const EscF = await ethers.getContractFactory("SLAEscrowTestable");
    const { upgrades } = await import("hardhat");
    const esc = await upgrades.deployProxy(EscF, [await reg.getAddress(), owner.address], { kind: "uups" }) as any;
    const registryAddress = await reg.getAddress();
    const escrowAddress = await esc.getAddress();

    const offerA = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI,       slaBlocks: 5, collateralWei: COLLATERAL });
    const offerB = await register(bundlerB, registryAddress, { feePerOp: ONE_GWEI * 2n,  slaBlocks: 6, collateralWei: COLLATERAL * 2n });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    return { registryAddress, escrowAddress, bundlerA, bundlerB, offers: [offerA, offerB] };
  }

  it("scoreBundlers falls back to direct reads when Multicall3 is unavailable", async () => {
    const { escrowAddress, bundlerA, bundlerB, offers } = await loadFixture(deployScoringEscrow);
    const direct = await scoreBundlers(ethers.provider, escrowAddress, offers, 100, { multicall: false });
    const auto   = await scoreBundlers(ethers.provider, escrowAddress, offers, 100);
    expect(auto.get(bundlerA.address.toLowerCase())!.idleBalance)
      .to.equal(direct.get(bundlerA.address.toLowerCase())!.idleBalance)
      .and.to.equal(COLLATERAL);
    expect(auto.get(bundlerB.address.toLowerCase())!.idleBalance)
      .to.equal(direct.get(bundlerB.address.toLowerCase())!.idleBalance)
      .and.to.equal(0n);
  });

  it("fetchAndScoreQuotes exposes the same multicall opt-out path", async () => {
    const { registryAddress, escrowAddress, bundlerA } = await loadFixture(deployScoringEscrow);
    const scored = await fetchAndScoreQuotes(ethers.provider, registryAddress, escrowAddress, 100, { multicall: false });
    expect(scored).to.have.length(2);
    expect(scored.find(({ offer }) => offer.bundler.toLowerCase() === bundlerA.address.toLowerCase())!.score.idleBalance)
      .to.equal(COLLATERAL);
  });

  describe("Multicall3 fallback warn-once semantics", () => {
    let warns: any[][];
    let origWarn: typeof console.warn;
    let scoreBundlersSrc: typeof import("../packages/router/src/scoring").scoreBundlers;

    beforeEach(async () => {
      const scoring = await import("../packages/router/src/scoring");
      scoring._resetMulticallAbsentWarned();
      scoreBundlersSrc = scoring.scoreBundlers;
      warns = [];
      origWarn = console.warn;
      console.warn = (...args: any[]) => { warns.push(args); };
    });

    afterEach(() => { console.warn = origWarn; });

    it("auto fallback emits exactly one console.warn the first time", async () => {
      const { escrowAddress, offers } = await loadFixture(deployScoringEscrow);
      await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100);
      expect(warns).to.have.length(1);
      expect(String(warns[0][0])).to.match(/Multicall3 not deployed/);
    });

    it("second auto-fallback call in the same process stays silent (warn-once)", async () => {
      const { escrowAddress, offers } = await loadFixture(deployScoringEscrow);
      await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100);
      await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100);
      await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100);
      expect(warns).to.have.length(1);
    });

    it("explicit { multicall: false } never warns", async () => {
      const { escrowAddress, offers } = await loadFixture(deployScoringEscrow);
      await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100, { multicall: false });
      await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100, { multicall: false });
      expect(warns).to.have.length(0);
    });

    it("queryFilter is chunked to 9000-block ranges covering the full window", async () => {
      const { escrowAddress, offers } = await loadFixture(deployScoringEscrow);
      const { mine } = await import("@nomicfoundation/hardhat-network-helpers");
      const { scoreBundler } = await import("../packages/router/src/scoring");
      const LOOKBACK = 20_000;
      await mine(LOOKBACK + 100);
      const tip = await ethers.provider.getBlockNumber();
      const from = tip - LOOKBACK;
      const expectedRanges: Array<[number, number]> = [
        [from,            from + 8_999 ],
        [from + 9_000,    from + 17_999],
        [from + 18_000,   tip          ],
      ];

      const calls: Array<[number, number]> = [];
      const proto = (ethers as any).BaseContract?.prototype ?? (ethers as any).Contract.prototype;
      const origQF = proto.queryFilter;
      proto.queryFilter = async function(filter: any, f: any, t: any) {
        if (typeof f === "number" && typeof t === "number") calls.push([f, t]);
        return origQF.call(this, filter, f, t);
      };
      try {
        await scoreBundler(ethers.provider, escrowAddress, offers[0].bundler, COLLATERAL, LOOKBACK);
        expect(calls, "3 filters x 3 chunks = 9 calls").to.have.length(9);
        for (const exp of expectedRanges) {
          const matches = calls.filter(c => c[0] === exp[0] && c[1] === exp[1]);
          expect(matches, `range ${exp[0]}-${exp[1]} must appear once per filter`).to.have.length(3);
        }
      } finally {
        proto.queryFilter = origQF;
      }
    });

    it("transient getCode failure rejects scoreBundlers and emits no fallback warn", async () => {
      const { escrowAddress, offers } = await loadFixture(deployScoringEscrow);
      const { MULTICALL3 } = await import("@surelock-labs/protocol");
      const origGetCode = ethers.provider.getCode.bind(ethers.provider);
      (ethers.provider as any).getCode = async (addr: string) => {
        if (addr.toLowerCase() === MULTICALL3.toLowerCase()) {
          throw new Error("simulated RPC outage");
        }
        return origGetCode(addr);
      };
      try {
        let thrown: unknown = null;
        try { await scoreBundlersSrc(ethers.provider, escrowAddress, offers, 100); }
        catch (e) { thrown = e; }
        expect(thrown, "scoreBundlers must reject on getCode failure").to.not.be.null;
        expect(String((thrown as Error).message)).to.match(/simulated RPC outage/);
        expect(warns, "no fallback warn should fire for a transient error").to.have.length(0);
      } finally {
        (ethers.provider as any).getCode = origGetCode;
      }
    });
  });
});

// -- cancel / claimRefund / claimPayout (router SDK) ---------------------------

describe("cancel / claimRefund / claimPayout (router SDK)", () => {
  async function deployEscrow() {
    const [owner, bundlerSigner, user] = await ethers.getSigners();
    const BOND = ethers.parseEther("0.0001");
    const RegF = await ethers.getContractFactory("QuoteRegistry");
    const reg  = await RegF.deploy(owner.address, BOND);
    const EscF = await ethers.getContractFactory("SLAEscrowTestable");
    const { upgrades } = await import("hardhat");
    const esc  = await upgrades.deployProxy(EscF, [await reg.getAddress(), owner.address], { kind: "uups" }) as any;
    const registryAddress = await reg.getAddress();
    const escrowAddress   = await esc.getAddress();
    const offer = await register(bundlerSigner, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundlerSigner, escrowAddress, COLLATERAL);
    return { registryAddress, escrowAddress, escrow: esc, bundlerSigner, user, offer };
  }

  it("cancel returns feePaid to user and marks commit cancelled", async () => {
    const { escrowAddress, user, offer } = await deployEscrow();
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("cancel-test"));
    const { commitId } = await commitOp(user, escrowAddress, offer, userOpHash);

    await cancel(user, escrowAddress, commitId);

    const pending = BigInt(await (await ethers.getContractAt("SLAEscrow", escrowAddress)).pendingWithdrawals(user.address));
    expect(pending).to.equal(ONE_GWEI);
  });

  it("claimRefund returns fee + collateral to user after SLA miss", async () => {
    const { escrowAddress, escrow, bundlerSigner, user, offer } = await deployEscrow();
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("refund-test"));
    const { commitId } = await commitOp(user, escrowAddress, offer, userOpHash);
    await accept(bundlerSigner, escrowAddress, commitId);

    const SETTLE_GRACE = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const REFUND_GRACE = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    const info0 = await escrow.getCommit(commitId);
    const mineCount = Number(BigInt(info0.deadline) - BigInt(await ethers.provider.getBlockNumber()) + SETTLE_GRACE + REFUND_GRACE + 1n);
    await (await import("@nomicfoundation/hardhat-network-helpers")).mine(mineCount);

    await claimRefund(user, escrowAddress, commitId);

    const pending = BigInt(await escrow.pendingWithdrawals(user.address));
    expect(pending).to.equal(ONE_GWEI + COLLATERAL);
  });

  it("claimPayout drains pendingWithdrawals and returns amount", async () => {
    const { escrowAddress, escrow, user, offer } = await deployEscrow();
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("payout-test"));
    const { commitId } = await commitOp(user, escrowAddress, offer, userOpHash);
    await cancel(user, escrowAddress, commitId);

    const claimed = await claimPayout(user, escrowAddress);
    expect(claimed).to.equal(ONE_GWEI);
    expect(BigInt(await escrow.pendingWithdrawals(user.address))).to.equal(0n);
  });

  it("claimPayout returns 0 when nothing is pending", async () => {
    const { escrowAddress, user } = await deployEscrow();
    const claimed = await claimPayout(user, escrowAddress);
    expect(claimed).to.equal(0n);
  });

  it("claimPayout fromBlock pins the pendingWithdrawals read to a specific block", async () => {
    const { escrowAddress, escrow, user, offer } = await deployEscrow();
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("payout-pinned"));
    const { commitId, blockNumber } = await commitOp(user, escrowAddress, offer, userOpHash);
    const cancelRcpt = await cancel(user, escrowAddress, commitId);
    const claimed = await claimPayout(user, escrowAddress, cancelRcpt.blockNumber);
    expect(claimed).to.equal(ONE_GWEI);
    expect(BigInt(await escrow.pendingWithdrawals(user.address))).to.equal(0n);
    expect(cancelRcpt.blockNumber).to.be.greaterThanOrEqual(blockNumber);
  });

  it("totalCommitValue equals feePerOp + protocolFeeWei (zero fee)", async () => {
    const { escrowAddress, offer, escrow } = await deployEscrow();
    const got = await totalCommitValue(ethers.provider, escrowAddress, offer);
    const protocolFee = BigInt(await escrow.protocolFeeWei());
    expect(got).to.equal(offer.feePerOp + protocolFee);
    expect(got).to.equal(offer.feePerOp);
  });

  it("totalCommitValue tracks setProtocolFeeWei changes (no caching)", async () => {
    const [owner] = await ethers.getSigners();
    const { escrowAddress, escrow, offer } = await deployEscrow();
    const newFee = ethers.parseUnits("123", "gwei");
    await escrow.connect(owner).setProtocolFeeWei(newFee);
    const got = await totalCommitValue(ethers.provider, escrowAddress, offer);
    expect(got).to.equal(offer.feePerOp + newFee);
  });

  it("createRouter().claimPayout threads fromBlock through to the pinned read", async () => {
    const { createRouter } = await import("@surelock-labs/router");
    const { registryAddress, escrowAddress, escrow, user, offer } = await deployEscrow();
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("factory-pinned"));
    const { commitId } = await commitOp(user, escrowAddress, offer, userOpHash);
    const blockBeforeCancel = await ethers.provider.getBlockNumber();
    await cancel(user, escrowAddress, commitId);
    expect(BigInt(await escrow.pendingWithdrawals(user.address))).to.equal(ONE_GWEI);

    const router = createRouter({ rpcUrl: "http://unused", registryAddress, escrowAddress });

    const pinned = await router.claimPayout(user, blockBeforeCancel);
    expect(pinned).to.equal(0n);
    expect(BigInt(await escrow.pendingWithdrawals(user.address))).to.equal(ONE_GWEI);

    const noPin = await router.claimPayout(user);
    expect(noPin).to.equal(ONE_GWEI);
    expect(BigInt(await escrow.pendingWithdrawals(user.address))).to.equal(0n);
  });
});
