/**
 * End-to-end usage simulation -- exercises the full market lifecycle with
 * realistic multi-party scenarios designed to surface grey areas and bugs.
 *
 * Each scenario simulates a real pattern of router + bundler SDK calls
 * working together: users pick quotes, bundlers settle or miss, collateral
 * gets slashed, fees flow to the right places.
 */

import { expect }   from "chai";
import { ethers } from "hardhat";
import { mine, loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { fetchQuotes, selectBest } from "@surelock-labs/router";
import {
  register, deregister, deposit, withdraw,
  claimPayout, getCommit, getIdleBalance, getDeposited,
  accept, settle as sdkSettle,
} from "@surelock-labs/bundler";

import { buildBlockHeaderRlp, buildReceiptProof } from "./helpers/buildSettleProof";

import {
  ONE_GWEI,
  COLLATERAL,
  MIN_BOND,
  mineToRefundable,
  deployRealEscrow,
} from "./helpers/fixtures";

/** Test helper: settle via the 1-arg SLAEscrowTestable overload (no proof required). */
async function settle(signer: any, escrowAddress: string, commitId: bigint): Promise<void> {
  const esc = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
  const tx = await esc.connect(signer)["settle(uint256)"](commitId);
  await tx.wait();
}

// -- shared deploy fixture -----------------------------------------------------

async function deploy() {
  const [owner, bundlerA, bundlerB, bundlerC, user1, user2, user3, feeRecipient] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("QuoteRegistry");
  const registry = await Registry.deploy(owner.address, ethers.parseEther("0.0001"));

  const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
  const escrow = await upgrades.deployProxy(
    Escrow,
    [await registry.getAddress(), feeRecipient.address],
    { kind: "uups" },
  ) as any;

  const registryAddress = await registry.getAddress();
  const escrowAddress   = await escrow.getAddress();

  return {
    registry, escrow,
    registryAddress, escrowAddress,
    owner, bundlerA, bundlerB, bundlerC,
    user1, user2, user3, feeRecipient,
  };
}

// -- helpers -------------------------------------------------------------------

async function doCommit(
  escrow: any,
  user: any,
  quoteId: bigint,
  tag: string,
  fee?: bigint,
): Promise<bigint> {
  const userOp = ethers.keccak256(ethers.toUtf8Bytes(tag));
  const reg = await ethers.getContractAt("QuoteRegistry", await escrow.registry());
  const offer = await reg.getOffer(quoteId);
  const protocolFee = BigInt(await escrow.protocolFeeWei());
  const tx = await escrow.connect(user).commit(quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: fee ?? (offer.feePerOp + protocolFee) });
  const receipt = await tx.wait();
  const commitLogs = receipt!.logs
    .filter(l => l.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
    .map(l => escrow.interface.parseLog(l)!);
  if (commitLogs.length === 0) throw new Error("CommitCreated not emitted");
  const commitId = BigInt(commitLogs[0].args.commitId);

  // Two-phase commit: bundler must accept() to transition PROPOSED -> ACTIVE
  const allSigners = await ethers.getSigners();
  const bundlerSigner = allSigners.find(s => s.address.toLowerCase() === offer.bundler.toLowerCase());
  if (bundlerSigner) {
    const esc2 = await ethers.getContractAt("SLAEscrowTestable", await escrow.getAddress());
    await esc2.connect(bundlerSigner).accept(commitId);
  }

  return commitId;
}

function bundlerNet(amount: bigint)   { return amount; }

// -- Scenario 1: Market routing -- router picks cheapest, bundler settles -------

describe("Scenario 1: market routing -- router picks cheapest, bundler settles", () => {
  it("user is routed to the cheapest offer and bundler gets paid correctly", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, bundlerB, bundlerC, user1, feeRecipient } =
      await loadFixture(deploy);

    // Three bundlers register competing offers
    const idA = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI,       slaBlocks: 10, collateralWei: COLLATERAL });
    const idB = await register(bundlerB, registryAddress, { feePerOp: ONE_GWEI * 2n,  slaBlocks: 5,  collateralWei: COLLATERAL });
    const idC = await register(bundlerC, registryAddress, { feePerOp: ONE_GWEI * 3n,  slaBlocks: 3,  collateralWei: COLLATERAL });

    await deposit(bundlerA, escrowAddress, COLLATERAL);
    await deposit(bundlerB, escrowAddress, COLLATERAL);
    await deposit(bundlerC, escrowAddress, COLLATERAL);

    // Router fetches and selects cheapest
    const offers = await fetchQuotes(ethers.provider, registryAddress);
    const best = selectBest(offers, "cheapest");
    expect(best!.bundler.toLowerCase()).to.equal(bundlerA.address.toLowerCase());
    expect(best!.quoteId).to.equal(idA);

    // User commits to the chosen offer
    const commitId = await doCommit(escrow, user1, idA, "scenario1-op");

    // BundlerA settles it
    await settle(bundlerA, escrowAddress, commitId);

    // Check payouts queued correctly
    const expectedNet = bundlerNet(ONE_GWEI);
    expect(BigInt(await escrow.pendingWithdrawals(bundlerA.address))).to.equal(expectedNet);
    expect(BigInt(await escrow.pendingWithdrawals(feeRecipient.address))).to.equal(0n);

    // Claim payouts
    await claimPayout(bundlerA, escrowAddress);

    expect(BigInt(await escrow.pendingWithdrawals(bundlerA.address))).to.equal(0n);
    expect(BigInt(await escrow.pendingWithdrawals(feeRecipient.address))).to.equal(0n);
  });
});

// -- Scenario 2: SLA miss -- bundler misses deadline, user gets refund ----------

describe("Scenario 2: SLA miss -- bundler misses deadline, user gets refund + slash", () => {
  it("user recovers fee + full collateral; bundler loses full collateral", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, feeRecipient } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 2, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "scenario2-miss");
    const info = await getCommit(ethers.provider, escrowAddress, commitId);

    // Mine past deadline + settlement grace + refund grace
    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    await mine(Number(info.deadline - currentBlock + sg + rg + 1n));

    // bundlerA cannot settle past deadline
    await expect(settle(bundlerA, escrowAddress, commitId))
      .to.be.rejectedWith("DeadlinePassed");

    const bundlerDepBefore = await getDeposited(ethers.provider, escrowAddress, bundlerA.address);

    // User claims refund
    await escrow.connect(user1).claimRefund(commitId);

    const bundlerDepAfter = await getDeposited(ethers.provider, escrowAddress, bundlerA.address);

    // Bundler loses the FULL collateral (both slash halves come from bundler's deposit)
    expect(bundlerDepBefore - bundlerDepAfter).to.equal(COLLATERAL);

    // User's pending = fee paid back + full collateral (100%)
    const userPending = BigInt(await escrow.pendingWithdrawals(user1.address));
    expect(userPending).to.equal(ONE_GWEI + COLLATERAL);

    // Protocol gets 0 (100% goes to user)
    const feePending = BigInt(await escrow.pendingWithdrawals(feeRecipient.address));
    expect(feePending).to.equal(0n);
  });
});

// -- Scenario 3: Collateral exhaustion -----------------------------------------

describe("Scenario 3: collateral exhaustion -- bundler can't take more commits than collateral allows", () => {
  it("second commit fails when bundler has no idle balance", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, user2 } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL); // only enough for 1 commit

    // First commit consumes all idle collateral
    await doCommit(escrow, user1, quoteId, "exhaust-1");
    expect(await getIdleBalance(ethers.provider, escrowAddress, bundlerA.address)).to.equal(0n);

    // Second commit should revert -- no idle collateral left
    await expect(doCommit(escrow, user2, quoteId, "exhaust-2")).to.be.rejectedWith("InsufficientCollateral");
  });

  it("bundler can accept more commits after settling the first", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, user2 } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId1 = await doCommit(escrow, user1, quoteId, "reuse-1");
    await settle(bundlerA, escrowAddress, commitId1); // unlocks collateral

    // Now bundler can accept a second commit
    const commitId2 = await doCommit(escrow, user2, quoteId, "reuse-2");
    const info = await getCommit(ethers.provider, escrowAddress, commitId2);
    expect(info.settled).to.be.false;
  });
});

// -- Scenario 4: Competing bundlers, safest routing ---------------------------

describe("Scenario 4: competing bundlers -- user routes by safest collateral", () => {
  it("safest strategy picks highest-collateral bundler even if not cheapest", async () => {
    const { registryAddress, escrowAddress, bundlerA, bundlerB, user1, escrow } =
      await loadFixture(deploy);

    // bundlerA: cheaper but low collateral
    await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    // bundlerB: more expensive but higher collateral
    await register(bundlerB, registryAddress, { feePerOp: ONE_GWEI * 2n, slaBlocks: 5, collateralWei: COLLATERAL * 5n });
    await deposit(bundlerB, escrowAddress, COLLATERAL * 5n);

    const offers = await fetchQuotes(ethers.provider, registryAddress);
    const safest = selectBest(offers, "safest");
    expect(safest!.bundler.toLowerCase()).to.equal(bundlerB.address.toLowerCase());
  });
});

// -- Scenario 5: Bundler deregisters mid-flight --------------------------------

describe("Scenario 5: bundler deregisters while commits are live", () => {
  it("deregistered bundler can still settle existing in-flight commits", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    // Commit first, then deregister
    const commitId = await doCommit(escrow, user1, quoteId, "deregister-inflight");
    await deregister(bundlerA, registryAddress, quoteId);

    // Offer is gone from registry
    const offers = await fetchQuotes(ethers.provider, registryAddress);
    expect(offers).to.have.length(0);

    // But bundlerA can still settle the existing commit
    await settle(bundlerA, escrowAddress, commitId);
    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(info.settled).to.be.true;
  });

  it("no new commits can be made against a deregistered offer", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);
    await deregister(bundlerA, registryAddress, quoteId);

    await expect(doCommit(escrow, user1, quoteId, "no-new-commit")).to.be.rejectedWith("OfferInactive");
  });
});

// -- Scenario 6: Multiple users, single bundler --------------------------------

describe("Scenario 6: multiple users committing to the same bundler", () => {
  it("each commit is independent and all settle correctly", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, user2, user3, feeRecipient } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL * 3n); // enough for 3 commits

    const c1 = await doCommit(escrow, user1, quoteId, "multi-1");
    const c2 = await doCommit(escrow, user2, quoteId, "multi-2");
    const c3 = await doCommit(escrow, user3, quoteId, "multi-3");

    // All 3 locked simultaneously
    expect(await getIdleBalance(ethers.provider, escrowAddress, bundlerA.address)).to.equal(0n);

    await settle(bundlerA, escrowAddress, c1);
    await settle(bundlerA, escrowAddress, c2);
    await settle(bundlerA, escrowAddress, c3);

    const expectedNet   = bundlerNet(ONE_GWEI) * 3n;

    expect(BigInt(await escrow.pendingWithdrawals(bundlerA.address))).to.equal(expectedNet);
    expect(BigInt(await escrow.pendingWithdrawals(feeRecipient.address))).to.equal(0n);

    await claimPayout(bundlerA, escrowAddress);

    // Contract balance = deposited collateral only (all fees paid out)
    const contractBal = await ethers.provider.getBalance(escrowAddress);
    expect(contractBal).to.equal(COLLATERAL * 3n);
  });
});

// -- Scenario 7: Double-settle / double-refund guards -------------------------

describe("Scenario 7: idempotency guards", () => {
  it("bundler cannot settle the same commit twice", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "double-settle");
    await settle(bundlerA, escrowAddress, commitId);

    await expect(settle(bundlerA, escrowAddress, commitId))
      .to.be.rejectedWith("AlreadyFinalized");
  });

  it("user cannot claim refund on a settled commit", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 2, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "settled-no-refund");
    await settle(bundlerA, escrowAddress, commitId);

    // Mine past grace (deadline + sg + rg + 1)
    await mineToRefundable(escrow, commitId);
    await expect(escrow.connect(user1).claimRefund(commitId)).to.be.rejectedWith("AlreadyFinalized");
  });

  it("user cannot claim refund twice", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 2, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "double-refund");
    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    await mine(Number(info.deadline - currentBlock + sg + rg + 1n));

    await escrow.connect(user1).claimRefund(commitId);
    await expect(escrow.connect(user1).claimRefund(commitId)).to.be.rejectedWith("AlreadyFinalized");
  });
});

// -- Scenario 8: Refund timing edge cases -------------------------------------

describe("Scenario 8: refund timing boundaries", () => {
  it("user cannot refund before deadline + grace expires", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "too-early-refund");
    // No mining -- still within SLA window
    await expect(escrow.connect(user1).claimRefund(commitId)).to.be.rejectedWith("NotExpired");
  });

  it("bundler cannot settle after deadline", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 2, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "late-settle");
    // Mine past deadline + settlement grace so settle() reverts DeadlinePassed.
    const c = await getCommit(ethers.provider, escrowAddress, commitId);
    const currentBlock = BigInt(await ethers.provider.getBlockNumber());
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    await mine(Number(BigInt(c.deadline) - currentBlock + sg + 1n));

    const lateInfo = await getCommit(ethers.provider, escrowAddress, commitId);
    await expect(settle(bundlerA, escrowAddress, commitId))
      .to.be.rejectedWith("DeadlinePassed");
  });

  it("bundler can settle at exactly the deadline block", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "exact-deadline");
    const info = await getCommit(ethers.provider, escrowAddress, commitId);

    // Mine to deadline-1 so the settle() tx itself lands at the deadline block
    const current = BigInt(await ethers.provider.getBlockNumber());
    if (info.deadline > current + 1n) await mine(Number(info.deadline - current - 1n));

    await settle(bundlerA, escrowAddress, commitId);
    const settled = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(settled.settled).to.be.true;
  });
});

// -- Scenario 9: Protocol fee accounting --------------------------------------

describe("Scenario 9: protocol fee accounting -- feeRecipient and bundler splits", () => {
  it("feeRecipient receives protocolFeeWei and bundler receives feePerOp when fee is active", async () => {
    const { registryAddress, escrowAddress, escrow, owner, bundlerA, user1, feeRecipient } =
      await loadFixture(deploy);

    const PROTOCOL_FEE = 500n;
    await escrow.connect(owner).setProtocolFeeWei(PROTOCOL_FEE);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    // doCommit picks up protocolFeeWei automatically -- user pays feePerOp + PROTOCOL_FEE
    const commitId = await doCommit(escrow, user1, quoteId, "fee-active");
    await settle(bundlerA, escrowAddress, commitId);

    expect(BigInt(await escrow.pendingWithdrawals(bundlerA.address))).to.equal(ONE_GWEI);
    expect(BigInt(await escrow.pendingWithdrawals(feeRecipient.address))).to.equal(PROTOCOL_FEE);
  });

  it("bundler receives exact feePerOp with no ETH loss when protocolFeeWei is zero", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, feeRecipient } =
      await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "zero-protocol-fee");
    await settle(bundlerA, escrowAddress, commitId);

    expect(BigInt(await escrow.pendingWithdrawals(bundlerA.address))).to.equal(ONE_GWEI);
    expect(BigInt(await escrow.pendingWithdrawals(feeRecipient.address))).to.equal(0n);
  });
});

// -- Scenario 10: Withdraw while committed -------------------------------------

describe("Scenario 10: withdraw while collateral is locked", () => {
  it("bundler cannot withdraw locked collateral mid-commit", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    await doCommit(escrow, user1, quoteId, "withdraw-locked");

    // Idle balance is 0 -- all locked
    expect(await getIdleBalance(ethers.provider, escrowAddress, bundlerA.address)).to.equal(0n);
    await expect(withdraw(bundlerA, escrowAddress, COLLATERAL)).to.be.rejectedWith("InsufficientIdle");
  });

  it("bundler can withdraw idle portion when only partially locked", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL * 3n); // 3x collateral, only 1x locked per commit

    await doCommit(escrow, user1, quoteId, "partial-lock");

    const idle = await getIdleBalance(ethers.provider, escrowAddress, bundlerA.address);
    expect(idle).to.equal(COLLATERAL * 2n); // 2x still idle

    // Can withdraw the 2 idle units
    await withdraw(bundlerA, escrowAddress, COLLATERAL * 2n);
    expect(await getIdleBalance(ethers.provider, escrowAddress, bundlerA.address)).to.equal(0n);
  });
});

// -- Scenario 11: Same userOpHash, different commits --------------------------

describe("Scenario 11: duplicate userOpHash -- uniqueness enforced", () => {
  it("same userOpHash cannot be committed twice (UserOpAlreadyCommitted)", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL * 2n);

    await doCommit(escrow, user1, quoteId, "same-hash");
    // Second commit with the same userOp bytes reverts (same derived hash)
    const reg = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await reg.getOffer(quoteId);
    await expect(
      escrow.connect(user1).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("same-hash")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp }),
    ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");
  });
});

// -- Scenario 12: Bundler is also the user -- now structurally blocked ----------

describe("Scenario 12: bundler commits to their own offer", () => {
  it("bundler cannot commit to their own quote -- SelfCommitForbidden blocks role confusion", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA } = await loadFixture(deploy);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    // bundlerA attempts to commit to their own offer -- must revert SelfCommitForbidden
    // (structural guard: msg.sender == bundler is rejected at commit() entry).
    const reg = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await reg.getOffer(quoteId);
    await expect(
      escrow.connect(bundlerA).commit(
        quoteId,
        ethers.keccak256(ethers.toUtf8Bytes("bundler-is-user")),
        offer.bundler,
        offer.collateralWei,
        offer.slaBlocks,
        { value: offer.feePerOp },
      ),
    ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
     .withArgs(bundlerA.address);
  });
});

// -- Scenario 13: ETH accounting invariant ------------------------------------

describe("Scenario 13: ETH accounting invariant holds throughout full lifecycle", () => {
  async function contractBalance(escrow: any): Promise<bigint> {
    return ethers.provider.getBalance(await escrow.getAddress());
  }

  async function checkInvariant(escrow: any, parties: string[], bundlers: string[]) {
    let sumDeposited = 0n;
    for (const b of bundlers) sumDeposited += BigInt(await escrow.deposited(b));
    let sumPending = 0n;
    for (const a of parties) sumPending += BigInt(await escrow.pendingWithdrawals(a));
    // Pending feePaid in open (unsettled, unrefunded) commits
    const nextId = BigInt(await escrow.nextCommitId());
    let sumOpenFees = 0n;
    for (let i = 0n; i < nextId; i++) {
      const commit = await escrow.getCommit(i);
      if (!commit.settled && !commit.refunded && !commit.cancelled) sumOpenFees += BigInt(commit.feePaid);
    }
    const bal = await contractBalance(escrow);
    expect(bal, "ETH invariant").to.equal(sumDeposited + sumPending + sumOpenFees);
  }

  it("invariant holds across deposit, commit, settle, and claim", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, user2, feeRecipient } =
      await loadFixture(deploy);

    const parties  = [bundlerA.address, user1.address, user2.address, feeRecipient.address];
    const bundlers = [bundlerA.address];

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL * 2n);
    await checkInvariant(escrow, parties, bundlers);

    const c1 = await doCommit(escrow, user1, quoteId, "inv-1");
    await checkInvariant(escrow, parties, bundlers);

    const c2 = await doCommit(escrow, user2, quoteId, "inv-2");
    await checkInvariant(escrow, parties, bundlers);

    await settle(bundlerA, escrowAddress, c1);
    await checkInvariant(escrow, parties, bundlers);

    // Miss c2 -- let it expire
    const info = await getCommit(ethers.provider, escrowAddress, c2);
    const cur = BigInt(await ethers.provider.getBlockNumber());
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    await mine(Number(info.deadline - cur + sg + rg + 1n));
    await escrow.connect(user2).claimRefund(c2);
    await checkInvariant(escrow, parties, bundlers);

    await claimPayout(bundlerA, escrowAddress);
    await claimPayout(feeRecipient, escrowAddress);
    await escrow.connect(user2).claimPayout();
    await checkInvariant(escrow, parties, bundlers);
  });

  it("invariant still holds when a commit is cancelled (verifies cancelled field read correctly)", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1, feeRecipient } =
      await loadFixture(deploy);

    const parties  = [bundlerA.address, user1.address, feeRecipient.address];
    const bundlers = [bundlerA.address];

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);
    await checkInvariant(escrow, parties, bundlers);

    // Commit but do NOT accept -- leaves commit in PROPOSED state
    const reg = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await reg.getOffer(quoteId);
    const userOp = ethers.keccak256(ethers.toUtf8Bytes("cancel-invariant"));
    const commitTx = await escrow.connect(user1).commit(
      quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: ONE_GWEI },
    );
    const commitReceipt = await commitTx.wait();
    const log = commitReceipt!.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);
    await checkInvariant(escrow, parties, bundlers);

    // User cancels during accept window
    await escrow.connect(user1).cancel(commitId);
    // Cancelled commit must NOT count as open fees -- invariant still holds
    await checkInvariant(escrow, parties, bundlers);
  });
});

// -- Scenario 14: Real A10 inclusion proof settlement (end-to-end) -------------

describe("Scenario 14: real A10 inclusion proof settlement (end-to-end)", () => {
  it("settles through the real A10 proof path in a full end-to-end flow", async () => {
    const { registry, escrow, mockEP, registryAddress, escrowAddress, bundler, user } =
      await deployRealEscrow();

    await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND });
    await escrow.connect(bundler).deposit({ value: COLLATERAL });

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("e2e-a10-settle"));
    const commitTx = await escrow.connect(user).commit(
      1n, userOpHash, bundler.address, COLLATERAL, 10, { value: ONE_GWEI },
    );
    await commitTx.wait();
    const commitId = 0n;
    await accept(bundler, escrowAddress, commitId);

    const inclusionTx = await mockEP.connect(bundler).handleOp(userOpHash);
    const inclusionReceipt = await inclusionTx.wait();

    const rpc = { send: (m: string, p: unknown[]) => ethers.provider.send(m, p) };
    const blockHeaderRlp = await buildBlockHeaderRlp(rpc, inclusionReceipt.blockNumber);
    const { proofNodes, txIndex } = await buildReceiptProof(rpc, inclusionReceipt.blockNumber, inclusionReceipt.hash);

    await sdkSettle(
      bundler, escrowAddress, commitId,
      BigInt(inclusionReceipt.blockNumber), blockHeaderRlp, proofNodes, txIndex,
    );

    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(info.settled).to.be.true;
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
  });

  it("rejects a success=false receipt proof (A1 -- reverted UserOp cannot earn fee)", async () => {
    const { registry, escrow, mockEP, escrowAddress, bundler, user } =
      await deployRealEscrow();

    await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND });
    await escrow.connect(bundler).deposit({ value: COLLATERAL });

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("e2e-a1-failed-op"));
    await escrow.connect(user).commit(1n, userOpHash, bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
    await accept(bundler, escrowAddress, 0n);

    const tx = await mockEP.connect(bundler).handleFailedOp(userOpHash);
    const receipt = await tx.wait();

    const rpc = { send: (m: string, p: unknown[]) => ethers.provider.send(m, p) };
    const blockHeaderRlp = await buildBlockHeaderRlp(rpc, receipt.blockNumber);
    const { proofNodes, txIndex } = await buildReceiptProof(rpc, receipt.blockNumber, receipt.hash);

    await expect(
      sdkSettle(bundler, escrowAddress, 0n, BigInt(receipt.blockNumber), blockHeaderRlp, proofNodes, txIndex),
    ).to.be.rejectedWith("InvalidInclusionProof");
  });
});

// -- Scenario 15: Protocol fee accounting on cancel and refund paths -----------

describe("Scenario 15: protocol fee accounting on cancel and refund paths", () => {
  const PROTOCOL_FEE = 500n;

  it("cancel returns only feePerOp and retains protocolFeeWei with feeRecipient (T4)", async () => {
    const { registryAddress, escrowAddress, escrow, owner, bundlerA, user1, feeRecipient } =
      await loadFixture(deploy);

    await escrow.connect(owner).setProtocolFeeWei(PROTOCOL_FEE);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    // Commit only -- do NOT accept (stays PROPOSED)
    const reg = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await reg.getOffer(quoteId);
    const userOp = ethers.keccak256(ethers.toUtf8Bytes("s15-cancel"));
    const commitTx = await escrow.connect(user1).commit(
      quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: ONE_GWEI + PROTOCOL_FEE },
    );
    const commitReceipt = await commitTx.wait();
    const log = commitReceipt!.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    // feeRecipient already has PROTOCOL_FEE from commit
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(PROTOCOL_FEE);

    await escrow.connect(user1).cancel(commitId);

    // User gets feePerOp back -- NOT the protocol fee (T4)
    expect(await escrow.pendingWithdrawals(user1.address)).to.equal(ONE_GWEI);
    // feeRecipient still holds the protocol fee (non-refundable)
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(PROTOCOL_FEE);
  });

  it("refund returns feePerOp + collateral while feeRecipient keeps protocolFeeWei (T11)", async () => {
    const { registryAddress, escrowAddress, escrow, owner, bundlerA, user1, feeRecipient } =
      await loadFixture(deploy);

    await escrow.connect(owner).setProtocolFeeWei(PROTOCOL_FEE);
    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 2, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await doCommit(escrow, user1, quoteId, "s15-refund");

    // Mine past deadline + settlement grace + refund grace
    const info = await escrow.getCommit(commitId);
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    const cur = BigInt(await ethers.provider.getBlockNumber());
    await mine(Number(BigInt(info.deadline) - cur + sg + rg + 1n));

    await escrow.connect(user1).claimRefund(commitId);

    // User gets feePerOp + collateral (T11)
    expect(await escrow.pendingWithdrawals(user1.address)).to.equal(ONE_GWEI + COLLATERAL);
    // feeRecipient keeps protocol fee (credited at commit, non-refundable)
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(PROTOCOL_FEE);
  });
});

// -- Scenario 16: PROPOSED-state lifecycle (commit without auto-accept) --------

describe("Scenario 16: PROPOSED-state lifecycle -- cancel before and after accept window", () => {
  async function commitWithoutAccept(
    escrow: any,
    user: any,
    quoteId: bigint,
    tag: string,
  ): Promise<bigint> {
    const userOp = ethers.keccak256(ethers.toUtf8Bytes(tag));
    const reg = await ethers.getContractAt("QuoteRegistry", await escrow.registry());
    const offer = await reg.getOffer(quoteId);
    const tx = await escrow.connect(user).commit(
      quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: offer.feePerOp },
    );
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    return BigInt(log!.args.commitId);
  }

  it("client can cancel a PROPOSED commit during the accept window (not yet accepted)", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await commitWithoutAccept(escrow, user1, quoteId, "s16-client-cancel");

    // Cancel immediately -- still within accept window, no collateral ever locked
    await escrow.connect(user1).cancel(commitId);

    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(info.cancelled).to.be.true;
    expect(info.accepted).to.be.false;

    // Client gets feePerOp back; bundler collateral never touched
    expect(await escrow.pendingWithdrawals(user1.address)).to.equal(ONE_GWEI);
    expect(await getIdleBalance(ethers.provider, escrowAddress, bundlerA.address)).to.equal(COLLATERAL);
  });

  it("bundler can cancel a PROPOSED commit after the accept window expires", async () => {
    const { registryAddress, escrowAddress, escrow, bundlerA, user1 } = await loadFixture(deploy);

    const quoteId = await register(bundlerA, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundlerA, escrowAddress, COLLATERAL);

    const commitId = await commitWithoutAccept(escrow, user1, quoteId, "s16-bundler-cancel");

    await mine(Number(await escrow.ACCEPT_GRACE_BLOCKS()) + 1);
    await escrow.connect(bundlerA).cancel(commitId);

    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(info.cancelled).to.be.true;
    expect(await escrow.pendingWithdrawals(user1.address)).to.equal(ONE_GWEI);
  });
});
