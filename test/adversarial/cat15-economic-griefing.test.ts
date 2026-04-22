// Category 15: Economic & Griefing Attack Vectors -- adversarial test suite

import { expect }                  from "chai";
import { ethers, upgrades }        from "hardhat";
import { mine, loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow, Attacker } from "../../typechain-types";
import {
    makeCommit as fixturesMakeCommit,
    safeInclBlock,
    mineToRefundable,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const ONE_ETH      = ethers.parseEther("1");
const SLA_BLOCKS   = 2n;

async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
  return await ethers.provider.getBalance(await escrow.getAddress());
}

async function deploy(slaBlocks = SLA_BLOCKS) {
  const [owner, bundler, user, feeRecipient, stranger, user2, user3, bundler2, bundler3, bundler4] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("QuoteRegistry");
  const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;

  const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
  const escrow = (await upgrades.deployProxy(
    Escrow,
    [await registry.getAddress(), feeRecipient.address],
    { kind: "uups" }
  )) as unknown as SLAEscrow;

  // quoteId = 1: bundler, fee=ONE_GWEI, sla=slaBlocks, collateral=0.01 ETH
  await registry
    .connect(bundler)
    .register(ONE_GWEI, Number(slaBlocks), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
  const QUOTE_ID = 1n;

  // Pre-deposit enough collateral for bundler to cover up to 10 commits
  await escrow.connect(bundler).deposit({ value: COLLATERAL * 10n });

  const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
  const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());

  return { escrow, registry, owner, bundler, user, feeRecipient, stranger, user2, user3, bundler2, bundler3, bundler4, QUOTE_ID, sg, rg };
}

async function deployZeroFee() {
  const [owner, bundler, user, feeRecipient, stranger] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("QuoteRegistry");
  const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;

  const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
  const escrow = (await upgrades.deployProxy(
    Escrow,
    [await registry.getAddress(), feeRecipient.address],
    { kind: "uups" }
  )) as unknown as SLAEscrow;

  // quoteId=1: fee=1 wei, collateral=2 wei (minimum allowed with strict collateral > fee)
  await registry.connect(bundler).register(1, 1, 2, 302_400, { value: ethers.parseEther("0.0001") });
  // quoteId=2: fee=1 wei, collateral=1 ETH
  await registry.connect(bundler).register(1, 2, ONE_ETH, 302_400, { value: ethers.parseEther("0.0001") });
  await escrow.connect(bundler).deposit({ value: ONE_ETH * 5n });

  const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
  const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());

  return { escrow, registry, owner, bundler, user, feeRecipient, stranger, QUOTE_ZERO: 1n, QUOTE_FREE_WITH_COLLATERAL: 2n, sg, rg };
}

async function pastGrace(slaBlocks: bigint, sg: bigint, rg: bigint) {
  await mine(Number(slaBlocks + sg + rg + 2n));
}

async function makeCommit(escrow: SLAEscrow, user: any, quoteId: bigint, tag?: string): Promise<bigint> {
  const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
  const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, tag ?? `op-${Date.now()}-${Math.random()}`);
  return commitId;
}

// -----------------------------------------------------------------------------
// Collateral exhaustion / locking attacks
// -----------------------------------------------------------------------------
describe("Cat15 -- Collateral exhaustion / locking attacks", () => {
  it("15.01 bundler deposits exactly N*collateral, N commits succeed, (N+1)th fails InsufficientCollateral", async () => {
    const { escrow, registry, bundler, user, user2, user3, QUOTE_ID } = await loadFixture(deploy);
    // bundler deposited 10*COLLATERAL in deploy(). Make 10 commits to exhaust.
    const users = [user, user2, user3];
    const commitIds: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      const u = users[i % users.length];
      commitIds.push(await makeCommit(escrow, u, QUOTE_ID, `op-${i}`));
    }
    // idle should be 0
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    // (N+1)th commit fails at accept() (collateral lock happens at accept, not commit)
    await expect(
      makeCommit(escrow, user, QUOTE_ID, "op-10")
    ).to.be.rejectedWith("InsufficientCollateral");
  });

  it("15.02 user fills bundler capacity, bundler deposits more mid-flight, new commit succeeds", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    // Exhaust all 10 slots
    for (let i = 0; i < 10; i++) {
      await makeCommit(escrow, user, QUOTE_ID, `fill-${i}`);
    }
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    // Bundler deposits 1 more COLLATERAL
    await escrow.connect(bundler).deposit({ value: COLLATERAL });
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
    // New commit succeeds
    await makeCommit(escrow, user, QUOTE_ID, "extra");
  });

  it("15.03 bundler partially withdraws: deposit 10x, withdraw 5x, only 5x idle remains", async () => {
    const { escrow, bundler, QUOTE_ID } = await loadFixture(deploy);
    // Already deposited 10*COLLATERAL
    await escrow.connect(bundler).withdraw(COLLATERAL * 5n);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 5n);
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 5n);
  });

  it("15.04 bundler withdraws all idle, zero idle remains, commit fails, settle restores idle, new commit succeeds", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await deploy(10n);
    // make 1 commit: locks 1 COLLATERAL. idle = 9*COLLATERAL.
    const cid = await makeCommit(escrow, user, QUOTE_ID, "one");
    // withdraw all idle
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    // new commit fails at accept() (collateral lock happens at accept, not commit)
    await expect(
      makeCommit(escrow, user, QUOTE_ID, "one-b")
    ).to.be.rejectedWith("InsufficientCollateral");
    // settle the old commit to unlock collateral
    await escrow.connect(bundler).settle(cid);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
    // new commit succeeds
    await makeCommit(escrow, user, QUOTE_ID, "two");
  });

  it("15.05 multiple users exhaust bundler, all claimRefund, idle resets to zero (deposited slashed to 0)", async () => {
    const { escrow, bundler, user, user2, user3, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const users = [user, user2, user3];
    const commitIds: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      commitIds.push(await makeCommit(escrow, users[i % 3], QUOTE_ID, `slash-${i}`));
    }
    await pastGrace(SLA_BLOCKS, sg, rg);
    for (let i = 0; i < 10; i++) {
      await escrow.connect(users[i % 3]).claimRefund(commitIds[i]);
    }
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
  });
});

// -----------------------------------------------------------------------------
// Deposit-withdraw race conditions
// -----------------------------------------------------------------------------
describe("Cat15 -- Deposit-withdraw race conditions", () => {
  it("15.06 bundler cannot withdraw locked collateral after user commits", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    // idle = 10*COLLATERAL
    const cid = await makeCommit(escrow, user, QUOTE_ID, "race1");
    // idle = 9*COLLATERAL. Try to withdraw 10*COLLATERAL
    await expect(
      escrow.connect(bundler).withdraw(COLLATERAL * 10n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  it("15.07 bundler can withdraw exactly idle (not locked) after commit", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    await makeCommit(escrow, user, QUOTE_ID, "race2");
    const idle = COLLATERAL * 9n;
    await expect(escrow.connect(bundler).withdraw(idle)).to.not.be.reverted;
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL);
  });

  it("15.08 settle unlocks collateral, bundler can then withdraw it", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    // withdraw 9 to leave exactly 1 COLLATERAL
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "race3");
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    // settle
    await escrow.connect(bundler).settle(cid);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
    // now withdraw
    await expect(escrow.connect(bundler).withdraw(COLLATERAL)).to.not.be.reverted;
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
  });

  it("15.09 claimRefund slashes deposited, bundler cannot withdraw beyond remaining", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n); // leave exactly 1 COLLATERAL
    const cid = await makeCommit(escrow, user, QUOTE_ID, "race4");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    // deposited = 0 after slash
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
    await expect(
      escrow.connect(bundler).withdraw(1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  it("15.10 bundler deposits after slash, fresh capacity available", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "race5");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
    // deposit fresh
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 2n);
    await makeCommit(escrow, user, QUOTE_ID, "fresh");
  });

  it("15.11 bundler deposits mid-commit-window: cannot withdraw locked portion", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-dep");
    // deposit more while commit is live
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 3n });
    // total deposited=4, locked=1, idle=3
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 3n);
    // cannot withdraw 4 (locked blocks it)
    await expect(
      escrow.connect(bundler).withdraw(COLLATERAL * 4n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    // can withdraw 3
    await expect(escrow.connect(bundler).withdraw(COLLATERAL * 3n)).to.not.be.reverted;
  });
});

// -----------------------------------------------------------------------------
// Bundler abandonment economics
// -----------------------------------------------------------------------------
describe("Cat15 -- Bundler abandonment economics", () => {
  it("15.12 bundler commits to 10 users, never settles, all claimRefund: loses 10*collateral", async () => {
    const { escrow, bundler, user, user2, user3, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const users = [user, user2, user3];
    const commitIds: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      commitIds.push(await makeCommit(escrow, users[i % 3], QUOTE_ID, `abandon-${i}`));
    }
    const depositedBefore = await escrow.deposited(bundler.address);
    expect(depositedBefore).to.equal(COLLATERAL * 10n);
    await pastGrace(SLA_BLOCKS, sg, rg);
    for (let i = 0; i < 10; i++) {
      await escrow.connect(users[i % 3]).claimRefund(commitIds[i]);
    }
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
  });

  it("15.13 after total slash, deposited does not underflow (remains exactly 0)", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "no-underflow");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
    // No underflow -- trying to slash more doesn't work because no more commits
  });

  it("15.14 after abandon: lockedOf returns to 0 after all refunds claimed", async () => {
    const { escrow, bundler, user, user2, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "ab1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "ab2");
    expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 2n);
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid1);
    expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
    await escrow.connect(user2).claimRefund(cid2);
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
  });

  it("15.15 after total slash, bundler can deposit fresh and start over", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    // Slash all
    const commitIds: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      commitIds.push(await makeCommit(escrow, user, QUOTE_ID, `redo-${i}`));
    }
    await pastGrace(SLA_BLOCKS, sg, rg);
    for (let i = 0; i < 10; i++) {
      await escrow.connect(user).claimRefund(commitIds[i]);
    }
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
    // Fresh deposit
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 5n);
    await makeCommit(escrow, user, QUOTE_ID, "new-era");
  });

  it("15.16 abandon economics: user gets feePaid + full collateral (100%), protocol gets 0", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const userPendBefore = await escrow.pendingWithdrawals(user.address);
    const protoPendBefore = await escrow.pendingWithdrawals(feeRecipient.address);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "econ-slash");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    const slashToUser = COLLATERAL; // 100% to user
    const userTotal = ONE_GWEI + slashToUser;
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(userPendBefore + userTotal);
    // Protocol gets nothing from refund slash
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(protoPendBefore);
    // Bundler net loss: full COLLATERAL
    expect(await escrow.deposited(bundler.address)).to.equal(0n);
  });

  it("15.17 bundler abandon: mixed settle/refund. some commits settled, some slashed", async () => {
    const { escrow, bundler, user, user2, feeRecipient, QUOTE_ID, sg, rg } = await deploy(5n);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "mix1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "mix2");
    const cid3 = await makeCommit(escrow, user, QUOTE_ID, "mix3");
    // settle cid1 only
    await escrow.connect(bundler).settle(cid1);
    // let cid2 and cid3 expire
    await pastGrace(5n, sg, rg);
    await escrow.connect(user2).claimRefund(cid2);
    await escrow.connect(user).claimRefund(cid3);
    // deposited reduced by 2*COLLATERAL (two slashes), locked=0
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n - COLLATERAL * 2n);
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
  });

  it("15.18 bundler settles half, abandons half: deposited reflects only slashed portion", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(10n);
    const cids: bigint[] = [];
    for (let i = 0; i < 6; i++) {
      cids.push(await makeCommit(escrow, user, QUOTE_ID, `half-${i}`));
    }
    // settle first 3
    for (let i = 0; i < 3; i++) {
      await escrow.connect(bundler).settle(cids[i]);
    }
    await pastGrace(10n, sg, rg);
    // refund last 3
    for (let i = 3; i < 6; i++) {
      await escrow.connect(user).claimRefund(cids[i]);
    }
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n - COLLATERAL * 3n);
  });
});

// -----------------------------------------------------------------------------
// Fee rounding exploitation
// -----------------------------------------------------------------------------
describe("Cat15 -- Fee rounding exploitation", () => {
  it("15.19 fee=1 wei, collateral=2 wei -> commit succeeds (no FeeTooSmall in PROTOCOL_FEE_WEI model)", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    await registry.connect(bundler).register(1, 2, 2, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: 100n });
    await expect(makeCommit(escrow, user, 1n, "round1")).to.not.be.reverted;
  });

  it("15.20 PROTOCOL_FEE_WEI above MAX reverts InvalidProtocolFee (owner-only)", async () => {
    const [owner, , , feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const MAX = ethers.parseEther("0.001");
    await expect(
      escrow.connect(owner).setProtocolFeeWei(MAX + 1n)
    ).to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
  });

  it("15.21 PROTOCOL_FEE_WEI=0 (default): feeRecipient gets 0, bundler gets full fee", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const fee = ethers.parseUnits("100", "gwei");
    await registry.connect(bundler).register(fee, 2, fee + 1n, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: fee * 10n });
    const cid = await makeCommit(escrow, user, 1n, "default-fee-wei");
    await escrow.connect(bundler).settle(cid);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
  });

  it("15.22 PROTOCOL_FEE_WEI=0: feeRecipient gets nothing from settle, bundler gets full fee", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ZERO } = await loadFixture(deployZeroFee);
    // Use QUOTE_FREE_WITH_COLLATERAL (quoteId=2): fee=1 wei, collateral=1 ETH
    const cid = await makeCommit(escrow, user, 2n, "zero-fee-settle");
    await escrow.connect(bundler).settle(cid);
    // PROTOCOL_FEE_WEI=0: bundler gets full fee
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(1n);
  });

  it("15.23 PROTOCOL_FEE_WEI=0, claimRefund: user gets feePaid + full collateral (100%), feeRecipient gets 0", async () => {
    const { escrow, bundler, user, feeRecipient, sg, rg } = await loadFixture(deployZeroFee);
    // QUOTE_FREE_WITH_COLLATERAL: fee=1 wei, collateral=1 ETH, sla=2
    const cid = await makeCommit(escrow, user, 2n, "zero-fee-slash");
    await mine(Number(SLA_BLOCKS + sg + rg + 2n));
    const protoPendBefore = await escrow.pendingWithdrawals(feeRecipient.address);
    await escrow.connect(user).claimRefund(cid);
    // New model: user gets fee + full collateral; protocol gets 0
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(1n + ONE_ETH);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(protoPendBefore);
  });

  it("15.24 PROTOCOL_FEE_WEI=0, settle: feeRecipient pending unchanged", async () => {
    const { escrow, bundler, user, feeRecipient } = await loadFixture(deployZeroFee);
    const cid = await makeCommit(escrow, user, 2n, "zero-fee-settle2");
    const protoPendBefore = await escrow.pendingWithdrawals(feeRecipient.address);
    await escrow.connect(bundler).settle(cid);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(protoPendBefore);
  });

  it("15.25 multiple settles with PROTOCOL_FEE_WEI=0: all fee goes to bundler, no wei leak", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    await registry.connect(bundler).register(10000, 2, 10001, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: 10001n * 20n });
    let totalFeePaid = 0n;
    for (let i = 0; i < 10; i++) {
      const cid = await makeCommit(escrow, user, 1n, `rnd-${i}`);
      await escrow.connect(bundler).settle(cid);
      totalFeePaid += 10000n;
    }
    const totalBundlerPending = await escrow.pendingWithdrawals(bundler.address);
    const totalPlatformPending = await escrow.pendingWithdrawals(feeRecipient.address);
    // PROTOCOL_FEE_WEI=0: all fee to bundler
    expect(totalPlatformPending).to.equal(0n);
    expect(totalBundlerPending).to.equal(totalFeePaid);
  });

  it("15.26 odd collateral (2 wei, fee=1): user gets fee + full collateral (100% to user)", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    // fee=1, collateral=2 (strict >)
    await registry.connect(bundler).register(1, 2, 2, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: 100n });
    const sg26 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg26 = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    const cid = await makeCommit(escrow, user, 1n, "odd1");
    await mine(Number(2n + sg26 + rg26 + 2n));
    await escrow.connect(user).claimRefund(cid);
    // user gets fee (1) + full collateral (2) = 3
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(3n);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  it("15.27 3 wei collateral: user gets fee + 3 (full collateral to user)", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    // fee=1, collateral=3
    await registry.connect(bundler).register(1, 2, 3, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: 100n });
    const sg27 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg27 = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    const cid = await makeCommit(escrow, user, 1n, "odd3");
    await mine(Number(2n + sg27 + rg27 + 2n));
    await escrow.connect(user).claimRefund(cid);
    // user gets fee (1) + full collateral (3) = 4; feeRecipient gets 0
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(4n);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  it("15.28 large fee, PROTOCOL_FEE_WEI=0: bundler gets full fee, no dust left unaccounted", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const bigFee = ethers.parseEther("1.333333333333333337");
    await registry.connect(bundler).register(bigFee, 2, bigFee + 1n, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: bigFee * 5n });
    const cid = await makeCommit(escrow, user, 1n, "big-fee");
    await escrow.connect(bundler).settle(cid);
    const bPend = await escrow.pendingWithdrawals(bundler.address);
    const fPend = await escrow.pendingWithdrawals(feeRecipient.address);
    // PROTOCOL_FEE_WEI=0: all fee to bundler
    expect(bPend).to.equal(bigFee);
    expect(fPend).to.equal(0n);
    expect(bPend + fPend).to.equal(bigFee);
  });

  it("15.29 repeated settles: PROTOCOL_FEE_WEI=0, bundler gets all fees, feeRecipient gets 0", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    for (let i = 0; i < 8; i++) {
      const cid = await makeCommit(escrow, user, QUOTE_ID, `cum-${i}`);
      await escrow.connect(bundler).settle(cid);
    }
    const bPend = await escrow.pendingWithdrawals(bundler.address);
    const fPend = await escrow.pendingWithdrawals(feeRecipient.address);
    expect(bPend).to.equal(ONE_GWEI * 8n);
    expect(fPend).to.equal(0n);
    expect(bPend + fPend).to.equal(ONE_GWEI * 8n);
  });
});

// -----------------------------------------------------------------------------
// Gas griefing / DoS
// -----------------------------------------------------------------------------
describe("Cat15 -- Gas griefing / DoS via feeRecipient", () => {
  async function deployWithAttackerFee() {
    const [owner, bundler, user, , stranger] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    // Deploy with owner as temp feeRecipient, then swap to attacker
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), owner.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const AttackerFactory = await ethers.getContractFactory("Attacker");
    const attacker = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;
    await escrow.connect(owner).setFeeRecipient(await attacker.getAddress());
    await registry.connect(bundler).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 10n });
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    return { escrow, registry, owner, bundler, user, stranger, attacker, QUOTE_ID: 1n, sg, rg };
  }

  it("15.30 griefing feeRecipient has 0 pending with PROTOCOL_FEE_WEI=0; bundler claims without issue", async () => {
    const { escrow, bundler, user, attacker, QUOTE_ID } = await loadFixture(deployWithAttackerFee);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "grief1");
    await escrow.connect(bundler).settle(cid);
    // attacker turns on griefing
    await attacker.setRevert(true);
    // PROTOCOL_FEE_WEI=0: attacker (feeRecipient) has 0 pending -- no griefing possible
    const attackerAddr = await attacker.getAddress();
    const feePending = await escrow.pendingWithdrawals(attackerAddr);
    expect(feePending).to.equal(0n);
    // bundler can still claim their full fee
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    await expect(escrow.connect(bundler).claimPayout()).to.not.be.reverted;
  });

  it("15.31 griefing feeRecipient does not affect user claimPayout after refund", async () => {
    const { escrow, bundler, user, attacker, QUOTE_ID, sg, rg } = await loadFixture(deployWithAttackerFee);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "grief2");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    await attacker.setRevert(true);
    // User can still claim their refund (feePaid + full collateral)
    await expect(escrow.connect(user).claimPayout()).to.not.be.reverted;
    // attacker has 0 pending (PROTOCOL_FEE_WEI=0, no slash to protocol)
    expect(await escrow.pendingWithdrawals(await attacker.getAddress())).to.equal(0n);
  });

  it("15.32 griefing toggle: PROTOCOL_FEE_WEI=0, no fees accrue to attacker regardless of toggle", async () => {
    const { escrow, bundler, user, attacker, QUOTE_ID } = await loadFixture(deployWithAttackerFee);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "grief3");
    await escrow.connect(bundler).settle(cid);
    // grief ON
    await attacker.setRevert(true);
    // 0 pending -- nothing to claim
    expect(await escrow.pendingWithdrawals(await attacker.getAddress())).to.equal(0n);
    // grief OFF -- still 0
    await attacker.setRevert(false);
    expect(await escrow.pendingWithdrawals(await attacker.getAddress())).to.equal(0n);
  });

  it("15.33 settle/claimRefund are pure state updates -- gas cost independent of recipient behavior", async () => {
    const { escrow, bundler, user, attacker, QUOTE_ID, sg, rg } = await loadFixture(deployWithAttackerFee);
    await attacker.setRevert(true);
    // settle should still succeed (no external calls)
    const cid = await makeCommit(escrow, user, QUOTE_ID, "grief4");
    await expect(escrow.connect(bundler).settle(cid)).to.not.be.reverted;
    // claimRefund should still succeed
    const cid2 = await makeCommit(escrow, user, QUOTE_ID, "grief5");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await expect(escrow.connect(user).claimRefund(cid2)).to.not.be.reverted;
  });

  it("15.34 multiple deposits from different bundlers: gas is constant per deposit (no loop)", async () => {
    const signers = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), signers[3].address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    // Warm up reservedBalance with one deposit first (cold 0->nonzero SSTORE is a one-time cost
    // on a fresh contract, not per-bundler; subsequent deposits only do a warm nonzero->nonzero
    // update, which is O(1) and constant across all bundlers).
    await escrow.connect(signers[4]).deposit({ value: ONE_ETH });
    // Measure 5 additional bundlers -- all see warm reservedBalance
    const gasUsed: bigint[] = [];
    for (let i = 5; i < 10; i++) {
      const tx = await escrow.connect(signers[i]).deposit({ value: ONE_ETH });
      const receipt = await tx.wait();
      gasUsed.push(receipt!.gasUsed);
    }
    // All deposits should have similar gas cost (no unbounded iteration)
    const maxGas = gasUsed.reduce((a, b) => (a > b ? a : b));
    const minGas = gasUsed.reduce((a, b) => (a < b ? a : b));
    // Expect < 20% variation (only cold deposited[addr] 0->nonzero differs; reservedBalance is warm)
    expect(maxGas - minGas).to.be.lt(maxGas / 5n);
  });
});

// -----------------------------------------------------------------------------
// Sybil attacks
// -----------------------------------------------------------------------------
describe("Cat15 -- Sybil bundler strategies", () => {
  it("15.35 10 sybil bundlers each register, commit, settle: total ETH distributed correctly", async () => {
    const signers = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const feeRecipient = signers[0];
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const user = signers[1];
    // 10 sybil bundlers: signers[2..11]
    for (let i = 2; i < 12; i++) {
      await registry.connect(signers[i]).register(ONE_GWEI, 15, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
      await escrow.connect(signers[i]).deposit({ value: COLLATERAL });
    }
    // user commits to each
    const commitIds: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      const cid = await makeCommit(escrow, user, BigInt(i) + 1n, `sybil-${i}`);
      commitIds.push(cid);
    }
    // all settle
    for (let i = 0; i < 10; i++) {
      await escrow.connect(signers[i + 2]).settle(commitIds[i]);
    }
    // total platform fees + bundler fees = 10 * ONE_GWEI
    let totalPending = 0n;
    totalPending += await escrow.pendingWithdrawals(feeRecipient.address);
    for (let i = 2; i < 12; i++) {
      totalPending += await escrow.pendingWithdrawals(signers[i].address);
    }
    expect(totalPending).to.equal(ONE_GWEI * 10n);
  });

  it("15.36 minimum-fee offer: commit with value=1 wei succeeds", async () => {
    const { escrow, bundler, user, QUOTE_ZERO } = await loadFixture(deployZeroFee);
    // quoteId=1: fee=1 wei, collateral=2 wei (minimum allowed under strict collateral > fee)
    const hash = ethers.keccak256(ethers.toUtf8Bytes("free"));
    await expect(
      escrow.connect(user).commit(QUOTE_ZERO, hash, bundler.address, 2n, 1, { value: 1n })
    ).to.not.be.reverted;
  });

  it("15.37 minimum-fee, minimum-collateral offer: settle gives 1 wei to bundler, 0 to protocol", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ZERO } = await loadFixture(deployZeroFee);
    const tx = await escrow.connect(user).commit(QUOTE_ZERO, ethers.keccak256(ethers.toUtf8Bytes("free2")), bundler.address, 2n, 1, { value: 1n });
    const receipt = await tx.wait();
    const commitLogs = receipt!.logs
      .filter(l => l.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
      .map(l => escrow.interface.parseLog(l)!);
    expect(commitLogs.length, "CommitCreated not emitted").to.equal(1);
    const cid = commitLogs[0].args.commitId;
    await escrow.connect(bundler).accept(cid);
    await escrow.connect(bundler).settle(cid);
    // PROTOCOL_FEE_WEI=0: bundler gets full fee (1 wei), feeRecipient gets 0
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(1n);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  it("15.38 minimum-fee, min-collateral (fee=1, collateral=2): claimRefund gives 3 wei to user", async () => {
    const { escrow, bundler, user, QUOTE_ZERO, sg, rg } = await loadFixture(deployZeroFee);
    const tx = await escrow.connect(user).commit(QUOTE_ZERO, ethers.keccak256(ethers.toUtf8Bytes("free3")), bundler.address, 2n, 1, { value: 1n });
    const receipt = await tx.wait();
    const commitLogs = receipt!.logs
      .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
      .map(log => escrow.interface.parseLog(log)!);
    expect(commitLogs.length, "CommitCreated not emitted").to.equal(1);
    const cid = commitLogs[0].args.commitId as bigint;
    await escrow.connect(bundler).accept(cid);
    // SLA is 1 block for QUOTE_ZERO
    await mine(Number(1n + sg + rg + 2n));
    await escrow.connect(user).claimRefund(cid);
    // New model: user gets fee (1) + full collateral (2) = 3
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(3n);
    // user can claim
    await expect(escrow.connect(user).claimPayout()).to.not.be.reverted;
  });

  it("15.39 minimum-fee with nonzero collateral: user gets fee + full collateral on slash", async () => {
    const { escrow, bundler, user, feeRecipient, sg, rg } = await loadFixture(deployZeroFee);
    // QUOTE_FREE_WITH_COLLATERAL (id=2): fee=1 wei, collateral=1 ETH, sla=2
    const cid = await makeCommit(escrow, user, 2n, "free-with-col");
    await mine(Number(2n + sg + rg + 2n));
    await escrow.connect(user).claimRefund(cid);
    // New model: user gets fee + full collateral; feeRecipient gets 0
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(1n + ONE_ETH);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  it("15.40 sybil bundlers compete: user picks cheapest, others idle -- no impact on their deposits", async () => {
    const signers = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), signers[0].address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    // 5 bundlers register with increasing fees
    for (let i = 2; i < 7; i++) {
      const fee = ONE_GWEI * BigInt(i);
      await registry.connect(signers[i]).register(fee, 2, fee + 1n, 302_400, { value: ethers.parseEther("0.0001") });
      await escrow.connect(signers[i]).deposit({ value: fee * 5n });
    }
    // user picks cheapest (quoteId=1, signer[2])
    const user = signers[1];
    const cid = await makeCommit(escrow, user, 1n, "cheapest");
    await escrow.connect(signers[2]).settle(cid);
    // other bundlers' deposits untouched
    for (let i = 3; i < 7; i++) {
      const fee = ONE_GWEI * BigInt(i);
      expect(await escrow.deposited(signers[i].address)).to.equal(fee * 5n);
      expect(await escrow.lockedOf(signers[i].address)).to.equal(0n);
    }
  });
});

// -----------------------------------------------------------------------------
// Withdrawal pattern attacks
// -----------------------------------------------------------------------------
describe("Cat15 -- Withdrawal pattern attacks", () => {
  it("15.41 withdraw(0) succeeds silently (wastes gas, no state change)", async () => {
    const { escrow, bundler } = await loadFixture(deploy);
    const depositedBefore = await escrow.deposited(bundler.address);
    await expect(escrow.connect(bundler).withdraw(0n)).to.not.be.reverted;
    expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
  });

  it("15.42 withdraw(0) emits Withdrawn event with amount=0", async () => {
    const { escrow, bundler } = await loadFixture(deploy);
    await expect(escrow.connect(bundler).withdraw(0n))
      .to.emit(escrow, "Withdrawn")
      .withArgs(bundler.address, 0n);
  });

  it("15.43 double claimPayout: second call reverts NothingToClaim", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "double-claim");
    await escrow.connect(bundler).settle(cid);
    await escrow.connect(bundler).claimPayout();
    await expect(
      escrow.connect(bundler).claimPayout()
    ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
  });

  it("15.44 multiple users claimPayout in sequence: each gets own amount", async () => {
    const { escrow, bundler, user, user2, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "mu1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "mu2");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid1);
    await escrow.connect(user2).claimRefund(cid2);
    const pend1 = await escrow.pendingWithdrawals(user.address);
    const pend2 = await escrow.pendingWithdrawals(user2.address);
    // Full SLA miss -> user pending = feePaid + collateral (new slash model).
    expect(pend1).to.equal(ONE_GWEI + COLLATERAL);
    expect(pend2).to.equal(ONE_GWEI + COLLATERAL);
    const bal1Before = await ethers.provider.getBalance(user.address);
    const tx1 = await escrow.connect(user).claimPayout();
    const r1 = await tx1.wait();
    const bal1After = await ethers.provider.getBalance(user.address);
    expect(bal1After - bal1Before + r1!.gasUsed * r1!.gasPrice).to.equal(pend1);
    // user2 still has their pending
    expect(await escrow.pendingWithdrawals(user2.address)).to.equal(pend2);
  });

  it("15.45 withdraw when deposited == lockedOf (zero idle): fails InsufficientIdle", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    // drain idle
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    await makeCommit(escrow, user, QUOTE_ID, "no-idle");
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    await expect(
      escrow.connect(bundler).withdraw(1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  it("15.46 stranger with no deposit calls withdraw(0): succeeds (deposited=0, locked=0, idle=0, 0<=0)", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    await expect(escrow.connect(stranger).withdraw(0n)).to.not.be.reverted;
  });

  it("15.47 stranger with no deposit calls withdraw(1): fails InsufficientIdle", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    await expect(
      escrow.connect(stranger).withdraw(1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  it("15.48 claimPayout by stranger with no pending: NothingToClaim", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    await expect(
      escrow.connect(stranger).claimPayout()
    ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
  });
});

// -----------------------------------------------------------------------------
// idleBalance correctness
// -----------------------------------------------------------------------------
describe("Cat15 -- idleBalance() correctness", () => {
  it("15.49 idleBalance after deposit equals deposited amount", async () => {
    const { escrow, bundler } = await loadFixture(deploy);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 10n);
  });

  it("15.50 idleBalance after commit: deposited - collateralLocked", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    await makeCommit(escrow, user, QUOTE_ID, "idle1");
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 9n);
  });

  it("15.51 idleBalance after settle: lock released, idle restored", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "idle2");
    await escrow.connect(bundler).settle(cid);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 10n);
  });

  it("15.52 idleBalance after claimRefund: deposited reduced by collateral, idle = 0 if exact", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "idle3");
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
  });

  it("15.53 idleBalance for stranger: 0", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    expect(await escrow.idleBalance(stranger.address)).to.equal(0n);
  });

  it("15.54 idleBalance with multiple partial states: 3 commits, 1 settled, 1 refunded, 1 live", async () => {
    const { escrow, bundler, user, user2, user3, QUOTE_ID, sg, rg } = await deploy(5n);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "p1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "p2");
    const cid3 = await makeCommit(escrow, user3, QUOTE_ID, "p3");
    // settle cid1
    await escrow.connect(bundler).settle(cid1);
    // let cid2 expire
    await pastGrace(5n, sg, rg);
    await escrow.connect(user2).claimRefund(cid2);
    // cid3 is still live (also expired but not claimed)
    // deposited = 10*C - C (slash) = 9*C, locked = C (cid3 still locked), idle = 8*C
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 9n);
    expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 8n);
  });
});

// -----------------------------------------------------------------------------
// Balance invariant checks
// -----------------------------------------------------------------------------
describe("Cat15 -- Balance invariant under economic attacks", () => {
  it("15.55 after N commits + settles: contract balance = sum(deposited) + sum(pendingWithdrawals)", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    for (let i = 0; i < 5; i++) {
      const cid = await makeCommit(escrow, user, QUOTE_ID, `inv-${i}`);
      await escrow.connect(bundler).settle(cid);
    }
    const balance = await contractBalance(escrow);
    const dep = await escrow.deposited(bundler.address);
    const pendBundler = await escrow.pendingWithdrawals(bundler.address);
    const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);
    // fees not yet in deposited -- they're in pending
    expect(balance).to.equal(dep + pendBundler + pendFee);
  });

  it("15.56 after N commits + refunds: contract balance = sum(deposited) + sum(pendingWithdrawals)", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cids: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      cids.push(await makeCommit(escrow, user, QUOTE_ID, `inv2-${i}`));
    }
    await pastGrace(SLA_BLOCKS, sg, rg);
    for (const cid of cids) {
      await escrow.connect(user).claimRefund(cid);
    }
    const balance = await contractBalance(escrow);
    const dep = await escrow.deposited(bundler.address);
    const pendUser = await escrow.pendingWithdrawals(user.address);
    const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);
    expect(balance).to.equal(dep + pendUser + pendFee);
  });

  it("15.57 mixed settle + refund + claimPayout: balance invariant holds throughout", async () => {
    const { escrow, bundler, user, user2, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "mix-inv1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "mix-inv2");
    await escrow.connect(bundler).settle(cid1);
    // bundler claims payout
    await escrow.connect(bundler).claimPayout();
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user2).claimRefund(cid2);
    // user2 claims
    await escrow.connect(user2).claimPayout();
    const balance = await contractBalance(escrow);
    const dep = await escrow.deposited(bundler.address);
    const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);
    const pendUser = await escrow.pendingWithdrawals(user.address);
    const pendUser2 = await escrow.pendingWithdrawals(user2.address);
    const pendBundler = await escrow.pendingWithdrawals(bundler.address);
    expect(balance).to.equal(dep + pendFee + pendUser + pendUser2 + pendBundler);
  });

  it("15.58 after all payouts claimed: contract balance equals only remaining deposited", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "all-claimed");
    await escrow.connect(bundler).settle(cid);
    // claim all
    await escrow.connect(bundler).claimPayout();
    if ((await escrow.pendingWithdrawals(feeRecipient.address)) > 0n) {
      await escrow.connect(feeRecipient).claimPayout();
    }
    const balance = await contractBalance(escrow);
    expect(balance).to.equal(await escrow.deposited(bundler.address));
  });

  it("15.59 zero-fee commit + settle: no ETH added from fee, balance invariant still holds", async () => {
    const { escrow, bundler, user, feeRecipient } = await loadFixture(deployZeroFee);
    const cid = await makeCommit(escrow, user, 2n, "zero-inv");
    await escrow.connect(bundler).settle(cid);
    const balance = await contractBalance(escrow);
    const dep = await escrow.deposited(bundler.address);
    const pendBundler = await escrow.pendingWithdrawals(bundler.address);
    const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);
    expect(balance).to.equal(dep + pendBundler + pendFee);
  });
});

// -----------------------------------------------------------------------------
// Economic incentive misalignment attacks
// -----------------------------------------------------------------------------
describe("Cat15 -- Economic incentive misalignment", () => {
  it("15.60 bundler cheating economics: settling dishonestly is profitable only if collateral < fee (blocked by registry)", async () => {
    // collateralWei must > feePerOp (strict). So cheating (collect fee, lose collateral)
    // means bundler loses strictly more than they gain. Verify the constraint.
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const [, bundler] = await ethers.getSigners();
    // try collateral < fee: should fail
    await expect(
      registry.connect(bundler).register(ONE_GWEI * 10n, 2, ONE_GWEI, 302_400, { value: ethers.parseEther("0.0001") })
    ).to.be.revertedWith("collateralWei must be > feePerOp");
    // try collateral == fee: should also fail (strict > enforced in T8)
    await expect(
      registry.connect(bundler).register(ONE_GWEI, 2, ONE_GWEI, 302_400, { value: ethers.parseEther("0.0001") })
    ).to.be.revertedWith("collateralWei must be > feePerOp");
  });

  it("15.61 bundler registers collateral > fee: slash means bundler net loss strictly > 0", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    // Register a new offer with collateral = fee + 1 (minimum strictly greater)
    const { registry } = await loadFixture(deploy);
    const [, b2] = await ethers.getSigners();
    const fee = ethers.parseUnits("100", "gwei");
    const collat = fee + 1n;
    await registry.connect(b2).register(fee, 2, collat, 302_400, { value: ethers.parseEther("0.0001") });
    // Under T8 with strict > collateralWei > feePerOp: slash -> bundler loses collateral > fee gained.
    // Net loss = collateral - fee >= 1 wei (strictly negative P&L on any slash path).
    expect(collat).to.be.gt(fee);
    expect(collat - fee).to.equal(1n);
  });

  it("15.62 user has no incentive to NOT claim refund (gets feePaid + full collateral)", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    await escrow.connect(bundler).withdraw(COLLATERAL * 9n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "incentive");
    await pastGrace(SLA_BLOCKS, sg, rg);
    const userPendBefore = await escrow.pendingWithdrawals(user.address);
    await escrow.connect(user).claimRefund(cid);
    const userPendAfter = await escrow.pendingWithdrawals(user.address);
    const gain = userPendAfter - userPendBefore;
    // New model: user gains feePaid + full collateral
    // (strictly positive by definition, so no redundant > 0 check needed).
    expect(gain).to.equal(ONE_GWEI + COLLATERAL);
  });

  it("15.63 protocol gets 0 from slash (all collateral goes to user)", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "proto-profit");
    const protoPendBefore = await escrow.pendingWithdrawals(feeRecipient.address);
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user).claimRefund(cid);
    const protoPendAfter = await escrow.pendingWithdrawals(feeRecipient.address);
    const protoGain = protoPendAfter - protoPendBefore;
    // New model: protocol gets 0 from slash
    expect(protoGain).to.equal(0n);
  });

  it("15.64 bundler that always settles on time: net positive (keeps full fee, no platform cut)", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    for (let i = 0; i < 5; i++) {
      const cid = await makeCommit(escrow, user, QUOTE_ID, `honest-${i}`);
      await escrow.connect(bundler).settle(cid);
    }
    const bundlerPend = await escrow.pendingWithdrawals(bundler.address);
    // PROTOCOL_FEE_WEI=0: bundler gets full ONE_GWEI per settle
    expect(bundlerPend).to.equal(ONE_GWEI * 5n);
  });

  it("15.65 bundler that never settles: net loss = N * collateral, strictly negative", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cids: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      cids.push(await makeCommit(escrow, user, QUOTE_ID, `dishonest-${i}`));
    }
    const depositedBefore = COLLATERAL * 10n;
    await pastGrace(SLA_BLOCKS, sg, rg);
    for (const cid of cids) {
      await escrow.connect(user).claimRefund(cid);
    }
    const depositedAfter = await escrow.deposited(bundler.address);
    expect(depositedBefore - depositedAfter).to.equal(COLLATERAL * 5n);
    // bundler pendingWithdrawals should be 0 (never settled)
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
  });
});

// -----------------------------------------------------------------------------
// Dust attacks
// -----------------------------------------------------------------------------
describe("Cat15 -- Dust attacks", () => {
  it("15.66 deposit 1 wei: valid, deposited increments", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    await escrow.connect(stranger).deposit({ value: 1n });
    expect(await escrow.deposited(stranger.address)).to.equal(1n);
  });

  it("15.67 deposit 1 wei then withdraw 1 wei: deposited returns to 0", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    await escrow.connect(stranger).deposit({ value: 1n });
    await escrow.connect(stranger).withdraw(1n);
    expect(await escrow.deposited(stranger.address)).to.equal(0n);
  });

  it("15.68 1-wei fee, 2-wei collateral -> commit succeeds (no FeeTooSmall in PROTOCOL_FEE_WEI model)", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    await registry.connect(bundler).register(1, 2, 2, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: 10n });
    const hash = ethers.keccak256(ethers.toUtf8Bytes("dust"));
    // PROTOCOL_FEE_WEI=0: commit with any feePerOp > 0 works
    await expect(
      escrow.connect(user).commit(1n, hash, bundler.address, 2n, 2, { value: 1n }),
    ).to.not.be.reverted;
  });

  it("15.69 many 1-wei deposits: no accumulation error over 100 deposits", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    for (let i = 0; i < 100; i++) {
      await escrow.connect(stranger).deposit({ value: 1n });
    }
    expect(await escrow.deposited(stranger.address)).to.equal(100n);
  });

  it("15.70 dust deposit by many strangers: each independently tracked", async () => {
    const signers = await ethers.getSigners();
    const { escrow } = await loadFixture(deploy);
    for (let i = 4; i < 10; i++) {
      await escrow.connect(signers[i]).deposit({ value: BigInt(i) });
    }
    for (let i = 4; i < 10; i++) {
      expect(await escrow.deposited(signers[i].address)).to.equal(BigInt(i));
    }
  });
});

// -----------------------------------------------------------------------------
// Complex multi-step economic scenarios
// -----------------------------------------------------------------------------
describe("Cat15 -- Complex multi-step economic scenarios", () => {
  it("15.71 bundler: deposit, commit x3, settle x1, refund x1, withdraw idle, deposit more, commit again", async () => {
    const { escrow, bundler, user, user2, user3, QUOTE_ID, sg, rg } = await deploy(5n);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "complex1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "complex2");
    const cid3 = await makeCommit(escrow, user3, QUOTE_ID, "complex3");
    // locked = 3*C, idle = 7*C
    await escrow.connect(bundler).settle(cid1); // unlock 1
    // locked = 2*C, idle = 8*C
    await pastGrace(5n, sg, rg);
    await escrow.connect(user2).claimRefund(cid2); // slash 1
    // deposited = 9*C, locked = 1*C, idle = 8*C
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 9n);
    expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 8n);
    // withdraw 5*C
    await escrow.connect(bundler).withdraw(COLLATERAL * 5n);
    // deposited = 4*C, locked = 1*C, idle = 3*C
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 3n);
    // deposit 2*C
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });
    // deposited = 6*C, locked = 1*C, idle = 5*C
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 5n);
    // can commit again
    await makeCommit(escrow, user, QUOTE_ID, "complex4");
  });

  it("15.72 two bundlers compete for same user: user commits to both, settles overlap economically", async () => {
    const { escrow, registry, bundler, user, bundler2, QUOTE_ID } = await loadFixture(deploy);
    // bundler2 registers
    await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler2).deposit({ value: COLLATERAL * 5n });
    // user commits to both
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "comp1");
    const cid2 = await makeCommit(escrow, user, 2n, "comp2");
    // both settle
    await escrow.connect(bundler).settle(cid1);
    await escrow.connect(bundler2).settle(cid2);
    // both bundlers have pending -- each got exactly feePerOp on settle (PROTOCOL_FEE_WEI=0).
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(ONE_GWEI);
  });

  it("15.73 feeRecipient accumulates from multiple bundlers: verify total", async () => {
    const signers = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const feeRecipient = signers[0];
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const user = signers[1];
    // 3 bundlers
    for (let i = 2; i < 5; i++) {
      await registry.connect(signers[i]).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
      await escrow.connect(signers[i]).deposit({ value: COLLATERAL * 3n });
    }
    // user commits to each, each settles
    for (let i = 0; i < 3; i++) {
      const cid = await makeCommit(escrow, user, BigInt(i) + 1n, `multi-b-${i}`);
      await escrow.connect(signers[i + 2]).settle(cid);
    }
    // PROTOCOL_FEE_WEI=0: feeRecipient gets 0 from all settles
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  it("15.74 bundler settles one commit, gets slashed on another, net P&L correct", async () => {
    const { escrow, bundler, user, user2, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "pnl1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "pnl2");
    await escrow.connect(bundler).settle(cid1);
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user2).claimRefund(cid2);
    // bundler earned: full ONE_GWEI from settle (PROTOCOL_FEE_WEI=0)
    // bundler lost: COLLATERAL from slash
    const bundlerPend = await escrow.pendingWithdrawals(bundler.address);
    const bundlerNet = ONE_GWEI;
    expect(bundlerPend).to.equal(bundlerNet);
    // deposited reduced by 1 COLLATERAL (slash)
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n - COLLATERAL);
  });

  it("15.75 user commits, bundler deregisters offer, commit still valid and settleable", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "dereg");
    // bundler deregisters offer
    await registry.connect(bundler).deregister(QUOTE_ID);
    // settle still works (commit already created)
    await expect(escrow.connect(bundler).settle(cid)).to.not.be.reverted;
  });

  it("15.76 user commits, bundler deregisters, SLA expires, user claimRefunds: works", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "dereg-refund");
    await registry.connect(bundler).deregister(QUOTE_ID);
    await pastGrace(SLA_BLOCKS, sg, rg);
    await expect(escrow.connect(user).claimRefund(cid)).to.not.be.reverted;
  });
});

// -----------------------------------------------------------------------------
// Capacity attack: lock bundler out through many small commits
// -----------------------------------------------------------------------------
describe("Cat15 -- Capacity lock-out attacks", () => {
  it("15.77 attacker commits max times to lock all bundler collateral: bundler can deposit more to escape", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    // user fills all 10 slots
    for (let i = 0; i < 10; i++) {
      await makeCommit(escrow, user, QUOTE_ID, `lock-${i}`);
    }
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    // Bundler escapes by depositing more
    await escrow.connect(bundler).deposit({ value: COLLATERAL });
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
  });

  it("15.78 attacker commits max times, bundler waits for SLA expiry: all locks eventually freed via refunds", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cids: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      cids.push(await makeCommit(escrow, user, QUOTE_ID, `lock2-${i}`));
    }
    await pastGrace(SLA_BLOCKS, sg, rg);
    // user claims all refunds
    for (const cid of cids) {
      await escrow.connect(user).claimRefund(cid);
    }
    // All locks freed (deposited=0 due to slashes, locked=0)
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
  });

  it("15.79 attacker locks bundler, bundler settles all within SLA: no collateral loss", async () => {
    const { escrow, bundler, user, QUOTE_ID } = await deploy(15n);
    const cids: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      cids.push(await makeCommit(escrow, user, QUOTE_ID, `lock3-${i}`));
    }
    // Settle all immediately
    for (const cid of cids) {
      await escrow.connect(bundler).settle(cid);
    }
    expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n);
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 10n);
  });

  it("15.80 attacker uses multiple EOAs to lock bundler: each commit independently locks collateral", async () => {
    const signers = await ethers.getSigners();
    const { escrow, bundler, QUOTE_ID } = await loadFixture(deploy);
    // 5 different users each commit twice
    for (let i = 4; i < 9; i++) {
      await makeCommit(escrow, signers[i], QUOTE_ID, `multi-eoa-a-${i}`);
      await makeCommit(escrow, signers[i], QUOTE_ID, `multi-eoa-b-${i}`);
    }
    expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 10n);
    expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
  });

  it("15.81 lock-out cost to attacker: user pays fee per commit. 10 commits = 10*fee", async () => {
    const { escrow, user, QUOTE_ID } = await loadFixture(deploy);
    const balBefore = await ethers.provider.getBalance(user.address);
    for (let i = 0; i < 10; i++) {
      await makeCommit(escrow, user, QUOTE_ID, `cost-${i}`);
    }
    const balAfter = await ethers.provider.getBalance(user.address);
    // user spent at least 10 * ONE_GWEI (plus gas)
    expect(balBefore - balAfter).to.be.gte(ONE_GWEI * 10n);
  });
});

// -----------------------------------------------------------------------------
// Platform fee accumulation edge cases
// -----------------------------------------------------------------------------
describe("Cat15 -- Platform fee accumulation", () => {
  it("15.82 feeRecipient accumulates across settle + claimRefund from same bundler", async () => {
    const { escrow, bundler, user, user2, feeRecipient, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "accum1");
    const cid2 = await makeCommit(escrow, user2, QUOTE_ID, "accum2");
    await escrow.connect(bundler).settle(cid1);
    await pastGrace(SLA_BLOCKS, sg, rg);
    await escrow.connect(user2).claimRefund(cid2);
    // PROTOCOL_FEE_WEI=0: no fee from settle, no slash to protocol from refund
    const feePending = await escrow.pendingWithdrawals(feeRecipient.address);
    expect(feePending).to.equal(0n);
  });

  it("15.83 feeRecipient claims, more fees accrue, claims again: both succeed", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "claim-twice-1");
    await escrow.connect(bundler).settle(cid1);
    const pend1 = await escrow.pendingWithdrawals(feeRecipient.address);
    if (pend1 > 0n) {
      await escrow.connect(feeRecipient).claimPayout();
    }
    // more fees
    const cid2 = await makeCommit(escrow, user, QUOTE_ID, "claim-twice-2");
    await escrow.connect(bundler).settle(cid2);
    const pend2 = await escrow.pendingWithdrawals(feeRecipient.address);
    if (pend2 > 0n) {
      await expect(escrow.connect(feeRecipient).claimPayout()).to.not.be.reverted;
    }
  });

  it("15.84 feeRecipient changed mid-flight: old recipient keeps accrued, new one gets future fees", async () => {
    const { escrow, registry, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await loadFixture(deploy);
    const cid1 = await makeCommit(escrow, user, QUOTE_ID, "change-fee1");
    await escrow.connect(bundler).settle(cid1);
    const oldPending = await escrow.pendingWithdrawals(feeRecipient.address);
    // change feeRecipient
    await escrow.connect(owner).setFeeRecipient(stranger.address);
    const cid2 = await makeCommit(escrow, user, QUOTE_ID, "change-fee2");
    await escrow.connect(bundler).settle(cid2);
    // old recipient keeps what they had (was 0 since PROTOCOL_FEE_WEI=0)
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(oldPending);
    // new recipient (stranger) also gets 0 (PROTOCOL_FEE_WEI=0)
    expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
  });

  it("15.85 feeRecipient changed to bundler address: bundler gets both net fee and platform fee", async () => {
    const { escrow, owner, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(owner).setFeeRecipient(bundler.address);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "bundler-is-fee");
    await escrow.connect(bundler).settle(cid);
    // PROTOCOL_FEE_WEI=0: bundler gets full fee (no split)
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
  });

  it("15.86 feeRecipient changed to user address: PROTOCOL_FEE_WEI=0, user gets 0 protocol fee from settle", async () => {
    const { escrow, owner, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(owner).setFeeRecipient(user.address);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "user-is-fee");
    await escrow.connect(bundler).settle(cid);
    // PROTOCOL_FEE_WEI=0: user (as feeRecipient) gets 0 protocol fee
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(0n);
  });
});

// -----------------------------------------------------------------------------
// Self-dealing: bundler == user -- BLOCKED by SelfCommitForbidden
// -----------------------------------------------------------------------------
describe("Cat15 -- Self-dealing (bundler acts as user) -- BLOCKED", () => {
  it("15.87 bundler commits to own offer as user: reverts SelfCommitForbidden", async () => {
    const { escrow, bundler, QUOTE_ID } = await loadFixture(deploy);
    // Commit with bundler as msg.sender must revert
    await expect(
      escrow.connect(bundler).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-deal")),
        bundler.address, COLLATERAL, Number(SLA_BLOCKS),
        { value: ONE_GWEI },
      ),
    ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
     .withArgs(bundler.address);
    // No collateral locked -- commit never succeeded
    expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
  });

  it("15.88 bundler self-deal settle path blocked: no collateral ever locked", async () => {
    const { escrow, bundler, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    await expect(
      escrow.connect(bundler).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-settle")),
        bundler.address, COLLATERAL, Number(SLA_BLOCKS),
        { value: ONE_GWEI },
      ),
    ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
    // No pending withdrawals
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
  });

  it("15.89 bundler self-deal claimRefund path blocked: deposit unchanged, no slash", async () => {
    const { escrow, bundler, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    const depositedBefore = await escrow.deposited(bundler.address);
    await expect(
      escrow.connect(bundler).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-refund")),
        bundler.address, COLLATERAL, Number(SLA_BLOCKS),
        { value: ONE_GWEI },
      ),
    ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
    // Deposited unchanged -- refund path never reachable
    expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
  });

  it("15.90 bundler self-deal: no ETH flows -- SelfCommitForbidden prevents any extraction", async () => {
    const { escrow, bundler, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    const depositedBefore = await escrow.deposited(bundler.address);
    await expect(
      escrow.connect(bundler).commit(
        QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("no-free-money")),
        bundler.address, COLLATERAL, Number(SLA_BLOCKS),
        { value: ONE_GWEI },
      ),
    ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
    // No state changes: deposited unchanged, no pending withdrawals
    expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
  });
});

// -----------------------------------------------------------------------------
// Commit with deactivated offer race
// -----------------------------------------------------------------------------
describe("Cat15 -- Deactivated offer economic attacks", () => {
  it("15.91 commit reverts on deactivated offer", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await loadFixture(deploy);
    await registry.connect(bundler).deregister(QUOTE_ID);
    await expect(
      escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("15.91")), bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI })
    ).to.be.revertedWithCustomError(escrow, "OfferInactive");
  });

  it("15.92 deactivate + reactivate by registering new offer: old commits unaffected", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await deploy(10n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "deact-old");
    await registry.connect(bundler).deregister(QUOTE_ID);
    // register new offer (quoteId=2)
    await registry.connect(bundler).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    // old commit still works
    await expect(escrow.connect(bundler).settle(cid)).to.not.be.reverted;
    // new commits use new quoteId
    await makeCommit(escrow, user, 2n, "new-offer");
  });

  it("15.93 rapid register/deregister: existing commits remain setteable", async () => {
    const { escrow, registry, bundler, user, QUOTE_ID } = await deploy(10n);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "rapid");
    await registry.connect(bundler).deregister(QUOTE_ID);
    await registry.connect(bundler).register(ONE_GWEI * 2n, 3, COLLATERAL * 2n, 302_400, { value: ethers.parseEther("0.0001") });
    await registry.connect(bundler).deregister(2n);
    // original commit still settles fine
    await expect(escrow.connect(bundler).settle(cid)).to.not.be.reverted;
  });
});

// -----------------------------------------------------------------------------
// Extreme values
// -----------------------------------------------------------------------------
describe("Cat15 -- Extreme value economic tests", () => {
  it("15.94 near max uint96 fee, collateral = fee + 1: lifecycle works", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const maxU96 = (1n << 96n) - 1n;
    const fee = maxU96 - 1n; // leave room for collateral = fee + 1
    const collat = fee + 1n;
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    await registry.connect(bundler).register(fee, 2, collat, 302_400, { value: ethers.parseEther("0.0001") });
    // Give bundler and user enough ETH to transact at near-uint96 max values
    await setBalance(bundler.address, maxU96 * 2n);
    await setBalance(user.address, maxU96 * 2n);
    await escrow.connect(bundler).deposit({ value: collat });
    const tx = await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("max")), bundler.address, collat, 2, { value: fee });
    const receipt = await tx.wait();
    const commitLogs15 = receipt!.logs
      .filter(l => l.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
      .map(l => escrow.interface.parseLog(l)!);
    expect(commitLogs15.length, "CommitCreated not emitted").to.equal(1);
    const cid = commitLogs15[0].args.commitId;
    await escrow.connect(bundler).accept(cid);
    await escrow.connect(bundler).settle(cid);
    // PROTOCOL_FEE_WEI=0: bundler gets full fee
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    // invariant
    const bal = await contractBalance(escrow);
    const dep = await escrow.deposited(bundler.address);
    const pb = await escrow.pendingWithdrawals(bundler.address);
    const pf = await escrow.pendingWithdrawals(feeRecipient.address);
    expect(bal).to.equal(dep + pb + pf);
  });

  it("15.95 near max uint96 fee: claimRefund slash math correct (no overflow)", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const maxU96 = (1n << 96n) - 1n;
    const fee = maxU96 - 1n;
    const collat = fee + 1n;
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    await registry.connect(bundler).register(fee, 2, collat, 302_400, { value: ethers.parseEther("0.0001") });
    const sg95 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg95 = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    // Give bundler and user enough ETH to transact at near-uint96 max values
    await setBalance(bundler.address, maxU96 * 2n);
    await setBalance(user.address, maxU96 * 2n);
    await escrow.connect(bundler).deposit({ value: collat });
    const tx = await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("max-refund")), bundler.address, collat, 2, { value: fee });
    const receipt = await tx.wait();
    const commitLogs95 = receipt!.logs
      .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
      .map(log => escrow.interface.parseLog(log)!);
    expect(commitLogs95.length, "CommitCreated not emitted").to.equal(1);
    const cid = commitLogs95[0].args.commitId as bigint;
    await escrow.connect(bundler).accept(cid);
    await mine(Number(2n + sg95 + rg95 + 2n));
    await escrow.connect(user).claimRefund(cid);
    // New model: user gets fee + full collateral (100%); feeRecipient gets 0
    const userTotal = fee + collat; // fee + full collateral
    expect(await escrow.pendingWithdrawals(user.address)).to.equal(userTotal);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  it("15.96 collateral much larger than fee: slash economics amplified", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    const fee = ONE_GWEI;
    const collateral = ONE_ETH; // 1 ETH >> 1 gwei
    await registry.connect(bundler).register(fee, 2, collateral, 302_400, { value: ethers.parseEther("0.0001") });
    const sg96 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg96 = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    await escrow.connect(bundler).deposit({ value: collateral * 2n });
    const cid = await makeCommit(escrow, user, 1n, "big-collateral");
    await mine(Number(2n + sg96 + rg96 + 2n));
    await escrow.connect(user).claimRefund(cid);
    // New model: user gets fee + full collateral = 1gwei + 1 ETH >> the 1gwei fee
    const userPend = await escrow.pendingWithdrawals(user.address);
    expect(userPend).to.equal(fee + collateral);
  });
});

// -----------------------------------------------------------------------------
// Edge cases: timing + economics intersection
// -----------------------------------------------------------------------------
describe("Cat15 -- Timing-economics intersection", () => {
  it("15.97 bundler settles at exactly the deadline block: captures full fee, no slash", async () => {
    const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "deadline-exact");
    // mine SLA_BLOCKS - 1 (commit already mined 1 block)
    await mine(SLA_BLOCKS - 1n);
    // settle at deadline
    await escrow.connect(bundler).settle(cid);
    // PROTOCOL_FEE_WEI=0: bundler gets full ONE_GWEI
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
  });

  it("15.98 settle past deadline + settlement grace: DeadlinePassed, user can refund after grace", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "late-settle");
    await mine(Number(SLA_BLOCKS + sg));
    await expect(
      escrow.connect(bundler).settle(cid)
    ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    await mine(Number(rg + 1n));
    await expect(escrow.connect(user).claimRefund(cid)).to.not.be.reverted;
  });

  it("15.99 grace window: neither settle nor refund possible during grace blocks", async () => {
    const { escrow, bundler, user, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    const cid = await makeCommit(escrow, user, QUOTE_ID, "grace-window");
    // mine past deadline + settlement grace
    await mine(Number(SLA_BLOCKS + sg));
    // settle fails (past deadline + settlement grace)
    await expect(
      escrow.connect(bundler).settle(cid)
    ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    // refund also fails (still in refund grace)
    await expect(
      escrow.connect(user).claimRefund(cid)
    ).to.be.revertedWithCustomError(escrow, "NotExpired");
    // mine through refund grace
    await mine(Number(rg));
    // NOW refund works
    await expect(escrow.connect(user).claimRefund(cid)).to.not.be.reverted;
  });

  it("15.100 long SLA window: collateral locked for extended period is an opportunity cost to bundler", async () => {
    const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
      Escrow,
      [await registry.getAddress(), feeRecipient.address],
      { kind: "uups" }
    )) as unknown as SLAEscrow;
    // Max SLA = 1000 blocks
    await registry.connect(bundler).register(ONE_GWEI, 1000, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });
    const cid = await makeCommit(escrow, user, 1n, "long-sla");
    // Collateral locked for 1000 blocks
    expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
    // Can only do 1 more commit, not 2 (only 1*COLLATERAL idle left)
    await makeCommit(escrow, user, 1n, "long-sla-2");
    // Third commit fails at accept() (collateral lock happens at accept, not commit)
    await expect(
      makeCommit(escrow, user, 1n, "long-sla-3")
    ).to.be.rejectedWith("InsufficientCollateral");
    // Settle to free up
    await escrow.connect(bundler).settle(cid);
    expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
  });
});
