/**
 * Force-sent ETH and balance invariant tests.
 *
 * Covers:
 * 1. Force-sending ETH via selfdestruct doesn't corrupt accounting
 * 2. sweepExcess() recovers the surplus without touching user balances
 * 3. reservedBalance tracks the full lifecycle correctly
 * 4. Stateful invariant: random operation sequences never break balance == reserved
 */

import { expect }   from "chai";
import { ethers }   from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployEscrow, makeCommit, assertReservedInvariant, assertLockedOfInvariant,
  expireCommit, mineToRefundable, getCommit, safeInclBlock,
  ONE_GWEI, COLLATERAL,
} from "./helpers/fixtures";
import type { SLAEscrow } from "../typechain-types";

// -- helper: force-send ETH via a self-destructing contract -------------------

async function forceSend(targetAddr: string, amount: bigint, sender: any): Promise<void> {
  // Deploy a contract that selfdestructs and sends ETH to target
  const factory = await ethers.getContractFactory("ForceEther");
  const forcer  = await factory.connect(sender).deploy({ value: amount });
  await (forcer as any).destroy(targetAddr);
}

// -- suite 1: sweepExcess -----------------------------------------------------

describe("sweepExcess -- force-sent ETH", () => {
  it("contract has zero excess under normal operation", async () => {
    const { escrow } = await loadFixture(deployEscrow);
    const addr = await escrow.getAddress();

    const bal      = await ethers.provider.getBalance(addr);
    const reserved = await escrow.reservedBalance();
    expect(bal).to.equal(reserved);
    // sweepExcess() now sends to feeRecipient; no parameter needed
  });

  it("force-sent ETH appears as excess above reservedBalance", async () => {
    const { escrow, attacker } = await loadFixture(deployEscrow);
    const addr    = await escrow.getAddress();
    const excess  = ethers.parseEther("0.5");

    await forceSend(addr, excess, attacker);

    const bal      = await ethers.provider.getBalance(addr);
    const reserved = await escrow.reservedBalance();
    expect(bal - reserved).to.equal(excess);
  });

  it("sweepExcess queues surplus into feeRecipient pendingWithdrawals (pull model)", async () => {
    const { escrow, owner, attacker, feeRecipient } = await loadFixture(deployEscrow);
    const addr   = await escrow.getAddress();
    const excess = ethers.parseEther("0.5");

    await forceSend(addr, excess, attacker);

    const reserved0    = await escrow.reservedBalance();
    const recipBefore  = await ethers.provider.getBalance(feeRecipient.address);
    const pendingBefore = await escrow.pendingWithdrawals(feeRecipient.address);

    await escrow.connect(owner).sweepExcess();

    // reserved increased by excess (excess is now tracked)
    expect(await escrow.reservedBalance()).to.equal(reserved0 + excess);
    // excess queued in pendingWithdrawals
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingBefore + excess);
    // feeRecipient has NOT received ETH yet
    expect(await ethers.provider.getBalance(feeRecipient.address)).to.equal(recipBefore);
    // Balance == reserved (pull model keeps them in sync)
    await assertReservedInvariant(escrow, ethers.provider);

    // feeRecipient claims the queued payout
    const claimTx = await escrow.connect(feeRecipient).claimPayout();
    const claimReceipt = await claimTx.wait();
    const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
    const recipAfter = await ethers.provider.getBalance(feeRecipient.address);
    expect(recipAfter).to.equal(recipBefore + excess - gasCost);
    // After claim: balance == reserved again
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("sweepExcess emits ExcessSwept event with correct args", async () => {
    const { escrow, owner, attacker, feeRecipient } = await loadFixture(deployEscrow);
    const addr   = await escrow.getAddress();
    const excess = ethers.parseEther("0.123");

    await forceSend(addr, excess, attacker);

    await expect(escrow.connect(owner).sweepExcess())
      .to.emit(escrow, "ExcessSwept")
      .withArgs(feeRecipient.address, excess);
  });

  it("sweepExcess with no excess is a no-op (no revert)", async () => {
    const { escrow, owner } = await loadFixture(deployEscrow);
    // Should not revert -- just a no-op
    await expect(escrow.connect(owner).sweepExcess()).to.not.be.reverted;
  });

  it("non-owner cannot sweepExcess", async () => {
    const { escrow, bundler } = await loadFixture(deployEscrow);
    await expect(
      escrow.connect(bundler).sweepExcess()
    ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
     .withArgs(bundler.address);
  });
});

// -- suite 2: reservedBalance lifecycle --------------------------------------

describe("reservedBalance -- lifecycle tracking", () => {
  it("starts at zero before any activity", async () => {
    const { escrow } = await loadFixture(deployEscrow);
    // Note: deployEscrow already deposited 3x collateral so reserved != 0
    // Deploy a fresh escrow to test zero initial state
    const [, , , feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
    const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
    const { upgrades } = await import("hardhat");
    const escrowFresh = await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" },
    ) as any;
    expect(await escrowFresh.reservedBalance()).to.equal(0n);
  });

  it("deposit() increments reservedBalance", async () => {
    const { escrow, bundler } = await loadFixture(deployEscrow);
    const before = await escrow.reservedBalance();
    await escrow.connect(bundler).deposit({ value: ONE_GWEI });
    expect(await escrow.reservedBalance()).to.equal(before + ONE_GWEI);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("withdraw() decrements reservedBalance", async () => {
    const { escrow, bundler } = await loadFixture(deployEscrow);
    const before = await escrow.reservedBalance();
    const idle   = await escrow.idleBalance(bundler.address);
    await escrow.connect(bundler).withdraw(idle / 2n);
    expect(await escrow.reservedBalance()).to.equal(before - idle / 2n);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("commit() adds feePaid to reservedBalance", async () => {
    const { escrow, registry, user, QUOTE_ID } = await loadFixture(deployEscrow);
    const before = await escrow.reservedBalance();
    await makeCommit(escrow, registry, user, QUOTE_ID, "reserved-commit");
    expect(await escrow.reservedBalance()).to.equal(before + ONE_GWEI);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("settle() does not change reservedBalance (internal rearrangement only)", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await loadFixture(deployEscrow);
    await makeCommit(escrow, registry, user, QUOTE_ID, "reserved-settle");
    const before = await escrow.reservedBalance();
    await escrow.connect(bundler).settle(0n);
    expect(await escrow.reservedBalance()).to.equal(before);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("claimRefund() does not change reservedBalance (slash rearranges within contract)", async () => {
    const { escrow, registry, user, QUOTE_ID } = await loadFixture(deployEscrow);
    const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "reserved-refund");
    await expireCommit(escrow, commitId);
    const before = await escrow.reservedBalance();
    await escrow.connect(user).claimRefund(commitId);
    expect(await escrow.reservedBalance()).to.equal(before);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("claimPayout() decrements reservedBalance", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await loadFixture(deployEscrow);
    await makeCommit(escrow, registry, user, QUOTE_ID, "reserved-payout");
    await escrow.connect(bundler).settle(0n);
    const before  = await escrow.reservedBalance();
    const pending = await escrow.pendingWithdrawals(bundler.address);
    await escrow.connect(bundler).claimPayout();
    expect(await escrow.reservedBalance()).to.equal(before - pending);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("invariant holds through full lifecycle: deposit -> commit -> settle -> claimPayout -> withdraw", async () => {
    const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deployEscrow);

    await assertReservedInvariant(escrow, ethers.provider);

    const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "lifecycle");
    await assertReservedInvariant(escrow, ethers.provider);

    await escrow.connect(bundler).settle(commitId);
    await assertReservedInvariant(escrow, ethers.provider);

    await escrow.connect(bundler).claimPayout();
    // feeRecipient has nothing pending (PROTOCOL_FEE_WEI=0 means no fee credited at settle)
    await assertReservedInvariant(escrow, ethers.provider);

    const idle = await escrow.idleBalance(bundler.address);
    await escrow.connect(bundler).withdraw(idle);
    await assertReservedInvariant(escrow, ethers.provider);

    // Final state: only what was initially deposited minus what was withdrawn
    expect(await escrow.reservedBalance()).to.equal(0n);
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
  });

  it("invariant holds through refund lifecycle: deposit -> commit -> expire -> claimRefund -> claimPayout", async () => {
    const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deployEscrow);
    const depositedBefore = await escrow.deposited(bundler.address);

    const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "refund-lifecycle");
    await assertReservedInvariant(escrow, ethers.provider);

    await expireCommit(escrow, commitId);
    await escrow.connect(user).claimRefund(commitId);
    await assertReservedInvariant(escrow, ethers.provider);

    await escrow.connect(user).claimPayout();
    // feeRecipient has nothing pending (PROTOCOL_FEE_WEI=0 means no fee credited at commit/refund)
    await assertReservedInvariant(escrow, ethers.provider);
  });
});

// -- suite 3: flash-loan / single-tx extraction --------------------------------

describe("flash-loan attack: deposit -> commit own offer -> settle -> withdraw in one block", () => {
  it("bundler cannot profit from committing to own offer -- SelfCommitForbidden blocks the attack at source", async () => {
    // A bundler attempts to register an offer, then commit to it acting as a user.
    // SelfCommitForbidden makes this structurally impossible (T8 / role separation).
    const [owner, bundler, , feeRecipient] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
    const { upgrades: up } = await import("hardhat");
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = await up.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" },
    ) as any;

    await registry.connect(bundler).register(ONE_GWEI, 5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });

    // Bundler attempts to commit to its own offer (acting as user) -- reverts SelfCommitForbidden
    await expect(
      escrow.connect(bundler).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("flash-loan-op")), bundler.address, COLLATERAL, 5, { value: ONE_GWEI }),
    ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
     .withArgs(bundler.address);

    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("collateral is not extractable: deposited amount unchanged after settle + claimPayout", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await loadFixture(deployEscrow);
    const depositedBefore = await escrow.deposited(bundler.address);

    const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "collateral-extract");
    await escrow.connect(bundler).settle(commitId);
    await escrow.connect(bundler).claimPayout();

    // Deposited should be unchanged -- settle/claimPayout only moves feePaid, not collateral
    expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
    await assertReservedInvariant(escrow, ethers.provider);
  });
});

// -- suite 4: zero-value commit lifecycle -------------------------------------

describe("minimum-value commit lifecycle (feePerOp=1 wei, collateralWei=2 wei)", () => {
  async function deployMinFee() {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
    const { upgrades: up } = await import("hardhat");
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = await up.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" },
    ) as any;

    // feePerOp=1 wei, slaBlocks=5, collateralWei=2 wei -- minimum-cost offer
    // (T8: collateral must be strictly > fee)
    await registry.connect(bundler).register(1n, 5, 2n, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: 2n });
    return { escrow, registry, owner, bundler, user, feeRecipient };
  }

  it("commit with 1 wei fee succeeds (no minimum fee with PROTOCOL_FEE_WEI=0)", async () => {
    const { escrow, bundler, user } = await deployMinFee();
    // PROTOCOL_FEE_WEI=0 -> msg.value = feePerOp = 1 wei; no minimum check
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("min-fee-op"));
    const acceptGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());
    // Commit executes in the NEXT block; acceptDeadline = (currentBlock + 1) + ACCEPT_GRACE_BLOCKS
    const expectedAcceptDeadline = BigInt(await ethers.provider.getBlockNumber()) + 1n + acceptGrace;
    await expect(escrow.connect(user).commit(1n, userOpHash, bundler.address, 2n, 5, { value: 1n }))
      .to.emit(escrow, "CommitCreated")
      .withArgs(0n, 1n, user.address, bundler.address, userOpHash, expectedAcceptDeadline);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("settle on 1 wei fee commit: succeeds and credits feePerOp to bundler", async () => {
    const { escrow, bundler, user } = await deployMinFee();
    await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("min-fee-settle")), bundler.address, 2n, 5, { value: 1n });
    const commitId = 0n;
    await escrow.connect(bundler).accept(commitId);
    const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
    await escrow.connect(bundler).settle(commitId);
    // Bundler gets the full feePerOp (1 wei); PROTOCOL_FEE_WEI=0 so no protocol cut
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore + 1n);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("refund on 1 wei fee commit: commit succeeds and claimRefund returns feePaid + collateral", async () => {
    const { escrow, bundler, user } = await deployMinFee();
    await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("min-fee-refund")), bundler.address, 2n, 5, { value: 1n });
    const commitId = 0n;
    await escrow.connect(bundler).accept(commitId);
    // Expire the commit
    await mineToRefundable(escrow, commitId);
    await escrow.connect(user).claimRefund(commitId);
    // User gets back feePaid (1 wei) + collateralLocked (2 wei) = 3 wei
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(3n);
    await assertReservedInvariant(escrow, ethers.provider);
  });

  it("register with feePerOp=0 is now rejected", async () => {
    const [, bundler] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
    await expect(
      registry.connect(bundler).register(0n, 5, 0n, 302_400, { value: ethers.parseEther("0.0001") })
    ).to.be.revertedWith("feePerOp must be > 0");
  });
});

// -- suite 5: post-upgrade state invariant ------------------------------------

describe("post-upgrade: V1 state preserved after upgrade to V2Safe", () => {
  it("existing commits survive upgrade and settle correctly post-upgrade", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
    const { upgrades: up } = await import("hardhat");
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const proxy = await up.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" },
    ) as any;

    await registry.connect(bundler).register(ONE_GWEI, 20, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await proxy.connect(bundler).deposit({ value: COLLATERAL * 5n });

    // Create a commit on V1
    const tx   = await proxy.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("pre-upgrade-op")), bundler.address, COLLATERAL, 20, { value: ONE_GWEI });
    const r    = await tx.wait();
    const commitLogs = r!.logs
      .filter(l => l.topics[0] === proxy.interface.getEvent("CommitCreated")!.topicHash)
      .map(l => proxy.interface.parseLog(l)!);
    expect(commitLogs.length, "CommitCreated not emitted").to.equal(1);
    const commitId = BigInt(commitLogs[0].args.commitId);
    await proxy.connect(bundler).accept(commitId);

    const commitBefore = await proxy.getCommit(commitId);
    expect(commitBefore.feePaid).to.equal(ONE_GWEI);

    // Upgrade to V2Safe (unsafeSkipStorageCheck: V2Safe __gap layout is a test variant)
    const V2Safe = await ethers.getContractFactory("SLAEscrowV2Safe");
    const v2 = await up.upgradeProxy(await proxy.getAddress(), V2Safe, {
      kind: "uups", unsafeSkipStorageCheck: true,
    }) as any;

    // Commit data must survive
    const commitAfter = await v2.commits(commitId);
    expect(commitAfter.feePaid).to.equal(ONE_GWEI);
    expect(commitAfter.settled).to.be.false;
    expect(commitAfter.bundler).to.equal(bundler.address);

    // Still settleable post-upgrade
    await v2.connect(bundler).settle(commitId);
    const settled = await v2.commits(commitId);
    expect(settled.settled).to.be.true;

    // Invariants hold
    const bal      = await ethers.provider.getBalance(await v2.getAddress());
    const reserved = await v2.reservedBalance();
    expect(bal).to.equal(reserved);
  });
});

// -- suite 6: stateful invariant -- random operation sequences -----------------

describe("stateful invariant -- random operation sequences", () => {
  /**
   * Run N rounds of randomly chosen operations and assert the invariant holds
   * after each one. This is a lightweight property-based invariant test without
   * needing Foundry/Echidna.
   */
  it("invariant holds across 100 random operations (multi-bundler, multi-user)", async function () {
    this.timeout(120_000);

    const [owner, b1, b2, u1, u2, u3, feeRec] = await ethers.getSigners();

    // Fresh deploy -- two bundlers, three users
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));

    const { upgrades } = await import("hardhat");
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRec.address],
      { kind: "uups" },
    ) as unknown as SLAEscrow;

    const addr = await escrow.getAddress();

    // Register two offers
    await registry.connect(b1).register(ONE_GWEI, 5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });   // quoteId 1
    await registry.connect(b2).register(ONE_GWEI, 5, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });   // quoteId 2

    const bundlers = [b1, b2];
    const users    = [u1, u2, u3];

    // Initial deposits
    for (const b of bundlers) {
      await escrow.connect(b).deposit({ value: COLLATERAL * 20n });
    }

    // Track open commits: {commitId, bundler, user, quoteId}
    type OpenCommit = { commitId: bigint; bundler: any; user: any; deadline: bigint };
    const openCommits: OpenCommit[] = [];
    let opCount = 0;

    const allCommitIds: bigint[] = [];

    const checkInvariant = async (label: string) => {
      const bal      = await ethers.provider.getBalance(addr);
      const reserved = await escrow.reservedBalance();
      expect(bal, `[op ${opCount}] ${label}: balance != reserved`).to.equal(reserved);
      // Also check lockedOf invariant for both bundlers
      await assertLockedOfInvariant(escrow, b1.address, allCommitIds);
      await assertLockedOfInvariant(escrow, b2.address, allCommitIds);
    };

    await checkInvariant("initial");

    // Deterministic pseudo-random (seeded for reproducibility)
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed % n; };

    for (let i = 0; i < 100; i++) {
      opCount = i;
      const op = rand(7); // 0-6

      try {
        if (op === 0) {
          // deposit
          const b   = bundlers[rand(bundlers.length)];
          const amt = COLLATERAL * BigInt(rand(3) + 1);
          await escrow.connect(b).deposit({ value: amt });
          await checkInvariant(`deposit(${amt})`);

        } else if (op === 1) {
          // withdraw idle
          const b    = bundlers[rand(bundlers.length)];
          const idle = await escrow.idleBalance(b.address);
          if (idle > 0n) {
            const amt = idle / BigInt(rand(3) + 1);
            if (amt > 0n) {
              await escrow.connect(b).withdraw(amt);
              await checkInvariant(`withdraw(${amt})`);
            }
          }

        } else if (op === 2) {
          // commit
          const u = users[rand(users.length)];
          const qId = BigInt(rand(2)) + 1n; // quoteId 1 or 2
          const bundler = qId === 1n ? b1 : b2;
          const idle = await escrow.idleBalance(bundler.address);
          if (idle >= COLLATERAL) {
            const tx      = await escrow.connect(u).commit(qId, ethers.randomBytes(32), bundler.address, COLLATERAL, 5, { value: ONE_GWEI });
            const receipt = await tx.wait();
            const commitLogs = receipt!.logs
              .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
              .map(log => escrow.interface.parseLog(log)!);
            expect(commitLogs.length, "CommitCreated not emitted").to.equal(1);
            const cid = BigInt(commitLogs[0].args.commitId);
            await escrow.connect(bundler).accept(cid);
            const commitStruct = await escrow.getCommit(cid);
            const deadline = commitStruct.deadline;
            openCommits.push({ commitId: cid, bundler, user: u, deadline });
            allCommitIds.push(cid);
            await checkInvariant(`commit(quoteId=${qId})`);
          }

        } else if (op === 3) {
          // settle an open commit
          const settleable = openCommits.filter(c => {
            return true; // bundler will check deadline
          });
          if (settleable.length > 0) {
            const c = settleable[rand(settleable.length)];
            const current = BigInt(await ethers.provider.getBlockNumber());
            if (current <= c.deadline) {
              // Any revert (e.g. AlreadyFinalized from prior op) bubbles to the outer
              // try/catch, which filters expected reverts via e.message.includes("revert").
              await escrow.connect(c.bundler).settle(c.commitId);
              const idx = openCommits.indexOf(c);
              if (idx >= 0) openCommits.splice(idx, 1);
              await checkInvariant(`settle(${c.commitId})`);
            }
          }

        } else if (op === 4) {
          // claimRefund on expired commit
          const expired = [];
          const current = BigInt(await ethers.provider.getBlockNumber());
          const settle  = await escrow.SETTLEMENT_GRACE_BLOCKS();
          const grace   = await escrow.REFUND_GRACE_BLOCKS();
          for (const c of openCommits) {
            if (current > c.deadline + BigInt(settle) + BigInt(grace)) {
              const state = await escrow.getCommit(c.commitId);
              if (!state.settled && !state.refunded) expired.push(c);
            }
          }
          if (expired.length > 0) {
            const c   = expired[rand(expired.length)];
            // Any revert bubbles to the outer try/catch, which filters expected reverts
            // via e.message.includes("revert"). The pre-filter above already ensures
            // !settled && !refunded && past refund grace, so a revert here is unexpected.
            await escrow.connect(c.user).claimRefund(c.commitId);
            const idx = openCommits.indexOf(c);
            if (idx >= 0) openCommits.splice(idx, 1);
            await checkInvariant(`claimRefund(${c.commitId})`);
          }

        } else if (op === 5) {
          // claimPayout for a random party
          const parties = [b1, b2, u1, u2, u3, feeRec];
          const p       = parties[rand(parties.length)];
          const pending = await escrow.pendingWithdrawals(p.address);
          if (pending > 0n) {
            await escrow.connect(p).claimPayout();
            await checkInvariant(`claimPayout(${p.address.slice(0, 6)})`);
          }

        } else if (op === 6) {
          // settle -- pick a recent block as inclusionBlock
          const settleable = openCommits.filter(() => true);
          if (settleable.length > 0) {
            const c = settleable[rand(settleable.length)];
            const current = BigInt(await ethers.provider.getBlockNumber());
            if (current <= c.deadline && current > 0n) {
              // Use current block - 1 (has a valid blockhash)
              const inclusionBlock = current - 1n;
              if (inclusionBlock >= 0n) {
                // Any revert bubbles to the outer try/catch, which filters expected
                // reverts via e.message.includes("revert").
                await escrow.connect(c.bundler).settle(c.commitId);
                const idx = openCommits.indexOf(c);
                if (idx >= 0) openCommits.splice(idx, 1);
                await checkInvariant(`settle(${c.commitId})`);
              }
            }
          }
        }
      } catch (e: any) {
        // Ignore expected reverts (InsufficientCollateral, DeadlinePassed, etc.)
        if (!e.message?.includes("revert")) throw e;
      }

      // Mine 1-2 blocks between ops
      await mine(rand(2) + 1);
    }
  });
});
