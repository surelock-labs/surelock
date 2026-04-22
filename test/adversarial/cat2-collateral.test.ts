// Category 2: Collateral manipulation -- adversarial test suite

import { expect }                  from "chai";
import { ethers, upgrades }         from "hardhat";
import { mine }                     from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture }              from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow } from "../../typechain-types";
import {
    ONE_GWEI,
    COLLATERAL,
    mineToRefundable,
    getCommitId,
} from "../helpers/fixtures";

const SLA_BLOCKS   = 10n;

async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
  return await ethers.provider.getBalance(await escrow.getAddress());
}

async function deploy() {
  // cat2 uses bundler1/bundler2/user1/user2/feeRecipient/stranger naming
  const [owner, bundler1, bundler2, user1, user2, feeRecipient, stranger] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("QuoteRegistry");
  const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;

  const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
  const escrow = (await upgrades.deployProxy(
    Escrow,
    [await registry.getAddress(), feeRecipient.address],
    { kind: "uups" }
  )) as unknown as SLAEscrow;

  // quoteId = 1: bundler1, fee=ONE_GWEI, sla=10, collateral=0.01 ETH
  await registry
    .connect(bundler1)
    .register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
  const QUOTE_ID = 1n;

  const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
  const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());

  return {
    escrow,
    registry,
    owner,
    bundler1,
    bundler2,
    user1,
    user2,
    feeRecipient,
    stranger,
    QUOTE_ID,
    sg,
    rg,
  };
}

async function pastGrace(slaBlocks: bigint, sg: bigint, rg: bigint) {
  await mine(Number(slaBlocks + sg + rg + 2n));
}

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: boundary conditions on commit", () => {
  // -- Test 1 ------------------------------------------------------------------
  it("commit succeeds when bundler has exactly required collateral", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    // deposit exactly COLLATERAL
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-1")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    // accept() is where InsufficientCollateral is checked -- should succeed
    await expect(escrow.connect(bundler1).accept(cid)).to.not.be.reverted;
  });

  // -- Test 2 ------------------------------------------------------------------
  it("accept reverts when bundler has 1 wei less than required collateral", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL - 1n });
    // commit() now always succeeds regardless of deposit
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-2")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await expect(
      escrow.connect(bundler1).accept(cid)
    ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
  });

  // -- Test 3 ------------------------------------------------------------------
  it("accept reverts when bundler has zero collateral deposited", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    // commit() succeeds even with zero deposit
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-3")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await expect(
      escrow.connect(bundler1).accept(cid)
    ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
  });

  // -- Test 4 ------------------------------------------------------------------
  it("commit with wrong fee reverts even if collateral is sufficient", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await expect(
      escrow
        .connect(user1)
        .commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-4")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + 1n })
    ).to.be.revertedWithCustomError(escrow, "WrongFee");
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: multiple simultaneous commits draining collateral", () => {
  // -- Test 5 ------------------------------------------------------------------
  it("two simultaneous commits each lock collateral, total locked = 2xcollateral", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });

    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-a")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid1 = await getCommitId(tx1, escrow);
    await escrow.connect(bundler1).accept(cid1);

    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-b")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid2 = await getCommitId(tx2, escrow);
    await escrow.connect(bundler1).accept(cid2);

    expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL * 2n);
  });

  // -- Test 6 ------------------------------------------------------------------
  it("third accept fails when exactly two commits have drained collateral", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });

    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-c")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid1 = await getCommitId(tx1, escrow);
    await escrow.connect(bundler1).accept(cid1);

    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-d")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid2 = await getCommitId(tx2, escrow);
    await escrow.connect(bundler1).accept(cid2);

    // third commit() is fine; third accept() should fail -- collateral exhausted
    const tx3 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-e")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid3 = await getCommitId(tx3, escrow);
    await expect(
      escrow.connect(bundler1).accept(cid3)
    ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
  });

  // -- Test 7 ------------------------------------------------------------------
  it("idleBalance returns zero after all collateral is locked", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });

    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-f")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx1, escrow));

    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-g")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx2, escrow));

    expect(await escrow.idleBalance(bundler1.address)).to.equal(0n);
  });

  // -- Test 8 ------------------------------------------------------------------
  it("multiple commits to different quotes from same bundler exhaust collateral", async () => {
    const { escrow, registry, user1, user2, bundler1 } = await loadFixture(deploy);
    // register a second quote with same collateral
    await registry
      .connect(bundler1)
      .register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID_1 = 2n;

    // deposit only enough for one commit total
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });

    const tx1 = await escrow.connect(user1).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("op-h")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx1, escrow));

    // second commit to a different quoteId: commit() succeeds, accept() fails
    const tx2 = await escrow.connect(user2).commit(QUOTE_ID_1, ethers.keccak256(ethers.toUtf8Bytes("op-i")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await expect(
      escrow.connect(bundler1).accept(await getCommitId(tx2, escrow))
    ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
  });

  // -- Test 9 ------------------------------------------------------------------
  it("ten sequential commits each subtract COLLATERAL from idle", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    const N = 10n;
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * N });

    for (let i = 0n; i < N; i++) {
      const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes(`op${i}`)), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
      await escrow.connect(bundler1).accept(await getCommitId(tx, escrow));
      expect(await escrow.lockedOf(bundler1.address)).to.equal(
        COLLATERAL * (i + 1n)
      );
    }
    expect(await escrow.idleBalance(bundler1.address)).to.equal(0n);
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: withdraw() boundary conditions", () => {
  // -- Test 10 -----------------------------------------------------------------
  it("withdraw reverts when amount > idle (all funds locked)", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-10")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx, escrow));

    await expect(
      escrow.connect(bundler1).withdraw(1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  // -- Test 11 -----------------------------------------------------------------
  it("withdraw of exactly idle amount succeeds", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    const extra = ethers.parseEther("0.05");
    await escrow.connect(bundler1).deposit({ value: extra });
    await expect(escrow.connect(bundler1).withdraw(extra)).to.not.be.reverted;
  });

  // -- Test 12 -----------------------------------------------------------------
  it("withdraw leaves deposited balance at zero after full withdrawal", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    const amount = ethers.parseEther("0.05");
    await escrow.connect(bundler1).deposit({ value: amount });
    await escrow.connect(bundler1).withdraw(amount);
    expect(await escrow.deposited(bundler1.address)).to.equal(0n);
  });

  // -- Test 13 -----------------------------------------------------------------
  it("withdraw(0) succeeds -- zero amount passes the idle check (0 <= idle) and transfers 0 ETH", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await expect(escrow.connect(bundler1).withdraw(0n)).to.not.be.reverted;
  });

  // -- Test 14 -----------------------------------------------------------------
  it("withdraw reverts when trying to pull locked collateral while commit is open", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    // deposit 2x collateral, commit once (locks 1x after accept)
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-14")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx, escrow));
    // idle is now exactly COLLATERAL; try to withdraw COLLATERAL + 1 should fail
    await expect(
      escrow.connect(bundler1).withdraw(COLLATERAL + 1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  // -- Test 15 -----------------------------------------------------------------
  it("partial withdraw then commit: commit still uses remaining idle correctly", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
    // withdraw half, leaving exactly COLLATERAL idle
    await escrow.connect(bundler1).withdraw(COLLATERAL);
    // commit then accept should succeed
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-15")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await expect(escrow.connect(bundler1).accept(await getCommitId(tx, escrow))).to.not.be.reverted;
  });

  // -- Test 16 -----------------------------------------------------------------
  it("partial withdraw then commit: second accept fails (idle exhausted)", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });
    await escrow.connect(bundler1).withdraw(COLLATERAL);
    // first commit+accept: locks the only COLLATERAL idle
    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-j")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx1, escrow));
    // second commit() itself is fine; accept() fails -- idle exhausted
    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-k")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await expect(
      escrow.connect(bundler1).accept(await getCommitId(tx2, escrow))
    ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
  });

  // -- Test 17 -----------------------------------------------------------------
  it("bundler cannot withdraw more than deposited (over-withdrawal reverts)", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await expect(
      escrow.connect(bundler1).withdraw(COLLATERAL + 1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: deposit() edge cases", () => {
  // -- Test 18 -----------------------------------------------------------------
  it("deposit with zero value reverts with ZeroDeposit", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    await expect(
      escrow.connect(bundler1).deposit({ value: 0n })
    ).to.be.revertedWithCustomError(escrow, "ZeroDeposit");
  });

  // -- Test 19 -----------------------------------------------------------------
  it("multiple deposits accumulate correctly in deposited mapping", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    expect(await escrow.deposited(bundler1.address)).to.equal(COLLATERAL * 3n);
  });

  // -- Test 20 -----------------------------------------------------------------
  it("deposit is credited to msg.sender, not to an arbitrary address", async () => {
    const { escrow, bundler1, stranger } = await loadFixture(deploy);
    // stranger deposits -- it goes to stranger, not bundler1
    await escrow.connect(stranger).deposit({ value: COLLATERAL });
    expect(await escrow.deposited(stranger.address)).to.equal(COLLATERAL);
    expect(await escrow.deposited(bundler1.address)).to.equal(0n);
  });

  // -- Test 21 -----------------------------------------------------------------
  it("over-depositing beyond collateral requirement poses no problem (idleBalance stays correct)", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    const large = COLLATERAL * 100n;
    await escrow.connect(bundler1).deposit({ value: large });
    expect(await escrow.idleBalance(bundler1.address)).to.equal(large);
    expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: lockedOf accounting after settle", () => {
  // -- Test 22 -----------------------------------------------------------------
  it("lockedOf decreases by collateralLocked after successful settle", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-22")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);

    expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
    await escrow.connect(bundler1).settle(cid);
    expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
  });

  // -- Test 23 -----------------------------------------------------------------
  it("idleBalance is restored after settle (collateral is freed)", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-23")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);
    await escrow.connect(bundler1).settle(cid);
    // deposited remains the same, locked is 0 -> idle = deposited
    expect(await escrow.idleBalance(bundler1.address)).to.equal(COLLATERAL);
  });

  // -- Test 24 -----------------------------------------------------------------
  it("settle on one commit does not affect locked amount from another open commit", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });

    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-24a")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid1 = await getCommitId(tx1, escrow);
    await escrow.connect(bundler1).accept(cid1);

    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-24b")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid2 = await getCommitId(tx2, escrow);
    await escrow.connect(bundler1).accept(cid2);

    // settle first commit
    await escrow.connect(bundler1).settle(cid1);
    // locked should still have one collateral unit for the second commit
    expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
  });

  // -- Test 25 -----------------------------------------------------------------
  it("bundler cannot settle same commit twice (AlreadyFinalized)", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-25")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);
    await escrow.connect(bundler1).settle(cid);
    await expect(
      escrow.connect(bundler1).settle(cid)
    ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: lockedOf accounting after claimRefund", () => {
  // -- Test 26 -----------------------------------------------------------------
  it("lockedOf decreases by collateralLocked after claimRefund", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-26")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);

    await mineToRefundable(escrow, cid);
    await escrow.connect(user1).claimRefund(cid);
    expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
  });

  // -- Test 27 -----------------------------------------------------------------
  it("deposited decreases by collateralLocked (slash) after claimRefund", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-27")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);

    await mineToRefundable(escrow, cid);
    await escrow.connect(user1).claimRefund(cid);
    // deposited should be 0 after full slash
    expect(await escrow.deposited(bundler1.address)).to.equal(0n);
  });

  // -- Test 28 -----------------------------------------------------------------
  it("idleBalance is 0 after claimRefund when no extra collateral was deposited", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-28")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);

    await mineToRefundable(escrow, cid);
    await escrow.connect(user1).claimRefund(cid);
    expect(await escrow.idleBalance(bundler1.address)).to.equal(0n);
  });

  // -- Test 29 -----------------------------------------------------------------
  it("user cannot claim refund twice (AlreadyFinalized)", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-29")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);

    await mineToRefundable(escrow, cid);
    await escrow.connect(user1).claimRefund(cid);
    await expect(
      escrow.connect(user1).claimRefund(cid)
    ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
  });

  // -- Test 30 -----------------------------------------------------------------
  it("claimRefund cannot be called after settle (AlreadyFinalized)", async () => {
    const { escrow, user1, bundler1, QUOTE_ID, sg, rg } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-30")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);

    await escrow.connect(bundler1).settle(cid);
    await pastGrace(SLA_BLOCKS, sg, rg);
    await expect(
      escrow.connect(user1).claimRefund(cid)
    ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
  });

  // -- Test 31 -----------------------------------------------------------------
  it("claimRefund too early reverts with NotExpired", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-31")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);
    // advance only to deadline, not past grace
    await mine(SLA_BLOCKS);
    await expect(
      escrow.connect(user1).claimRefund(cid)
    ).to.be.revertedWithCustomError(escrow, "NotExpired");
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: idleBalance state transitions", () => {
  // -- Test 32 -----------------------------------------------------------------
  it("idleBalance = deposited before any commit", async () => {
    const { escrow, bundler1 } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 3n });
    expect(await escrow.idleBalance(bundler1.address)).to.equal(COLLATERAL * 3n);
  });

  // -- Test 33 -----------------------------------------------------------------
  it("idleBalance = deposited - lockedOf after a commit+accept", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 3n });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-33")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);
    const idle = await escrow.idleBalance(bundler1.address);
    const locked = await escrow.lockedOf(bundler1.address);
    const deposited = await escrow.deposited(bundler1.address);
    expect(idle).to.equal(deposited - locked);
  });

  // -- Test 34 -----------------------------------------------------------------
  it("idleBalance is restored to original after settle frees collateral", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    const depositAmount = COLLATERAL * 3n;
    await escrow.connect(bundler1).deposit({ value: depositAmount });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-34")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);
    await escrow.connect(bundler1).settle(cid);
    expect(await escrow.idleBalance(bundler1.address)).to.equal(depositAmount);
  });

  // -- Test 35 -----------------------------------------------------------------
  it("idleBalance for bundler2 is unaffected by bundler1 operations", async () => {
    const { escrow, registry, user1, bundler1, bundler2, QUOTE_ID } =
      await loadFixture(deploy);
    await registry
      .connect(bundler2)
      .register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID_2 = 2n;

    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await escrow.connect(bundler2).deposit({ value: COLLATERAL * 5n });

    // bundler1 gets committed and slashed
    const tx35 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-35")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid35 = await getCommitId(tx35, escrow);
    await escrow.connect(bundler1).accept(cid35);
    await mineToRefundable(escrow, cid35);
    await escrow.connect(user1).claimRefund(cid35);

    // bundler2's idle should be untouched
    expect(await escrow.idleBalance(bundler2.address)).to.equal(COLLATERAL * 5n);
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: re-use after settlement", () => {
  // -- Test 36 -----------------------------------------------------------------
  it("freed collateral after settle can be committed again", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });

    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-36a")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid1 = await getCommitId(tx1, escrow);
    await escrow.connect(bundler1).accept(cid1);
    await escrow.connect(bundler1).settle(cid1);

    // now idle == COLLATERAL again, second commit+accept should succeed
    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-36b")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid2 = await getCommitId(tx2, escrow);
    await expect(escrow.connect(bundler1).accept(cid2)).to.not.be.reverted;
  });

  // -- Test 37 -----------------------------------------------------------------
  it("collateral re-used through many settle cycles works without accumulation drift", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });

    for (let i = 0n; i < 5n; i++) {
      const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes(`cycle${i}`)), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
      const cid = await getCommitId(tx, escrow);
      await escrow.connect(bundler1).accept(cid);
      await escrow.connect(bundler1).settle(cid);
      expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
      expect(await escrow.idleBalance(bundler1.address)).to.equal(COLLATERAL);
    }
  });

  // -- Test 38 -----------------------------------------------------------------
  it("after claimRefund slashes collateral, remaining balance can be used for new commit if refilled", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-38a")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid1 = await getCommitId(tx1, escrow);
    await escrow.connect(bundler1).accept(cid1);

    await mineToRefundable(escrow, cid1);
    await escrow.connect(user1).claimRefund(cid1);
    // deposited is now 0 after full slash

    // re-deposit COLLATERAL
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-38b")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid2 = await getCommitId(tx2, escrow);
    await expect(escrow.connect(bundler1).accept(cid2)).to.not.be.reverted;
  });

  // -- Test 39 -----------------------------------------------------------------
  it("accept fails after partial slash reduces balance below collateral requirement", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    // deposit enough for one commit
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx1 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-39a")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid1 = await getCommitId(tx1, escrow);
    await escrow.connect(bundler1).accept(cid1);

    await mineToRefundable(escrow, cid1);
    await escrow.connect(user1).claimRefund(cid1);
    // after slash, deposited == 0, idle == 0

    // second commit() succeeds; accept() fails -- no collateral
    const tx2 = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-39b")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await expect(
      escrow.connect(bundler1).accept(await getCommitId(tx2, escrow))
    ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: withdraw freed collateral after settle", () => {
  // -- Test 40 -----------------------------------------------------------------
  it("bundler can withdraw collateral freed by settle", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-40")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid = await getCommitId(tx, escrow);
    await escrow.connect(bundler1).accept(cid);
    await escrow.connect(bundler1).settle(cid);

    // fee payout is via pendingWithdrawals, but the deposit collateral is freed
    await expect(
      escrow.connect(bundler1).withdraw(COLLATERAL)
    ).to.not.be.reverted;
    expect(await escrow.deposited(bundler1.address)).to.equal(0n);
  });

  // -- Test 41 -----------------------------------------------------------------
  it("bundler cannot withdraw locked collateral before settle", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-41")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler1).accept(await getCommitId(tx, escrow));

    await expect(
      escrow.connect(bundler1).withdraw(COLLATERAL)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  // -- Test 42 -----------------------------------------------------------------
  it("deposit, commit, settle, withdraw cycle leaves contract balance consistent", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } =
      await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx42 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-42")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid42 = await getCommitId(tx42, escrow);
    await escrow.connect(bundler1).accept(cid42);

    const balBefore = await contractBalance(escrow);
    await escrow.connect(bundler1).settle(cid42);
    await escrow.connect(bundler1).withdraw(COLLATERAL);
    await escrow.connect(bundler1).claimPayout();
    // feeRecipient gets nothing (PROTOCOL_FEE_WEI=0) -- no claimPayout needed

    const balAfter = await contractBalance(escrow);
    // all ETH should have left the contract
    expect(balAfter).to.equal(0n);
    // sanity: started with COLLATERAL + ONE_GWEI
    expect(balBefore).to.equal(COLLATERAL + ONE_GWEI);
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: multiple bundlers are isolated", () => {
  async function twoBundle() {
    const base = await loadFixture(deploy);
    const { registry, escrow, bundler2 } = base;
    await registry
      .connect(bundler2)
      .register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID_2 = 2n;
    return { ...base, QUOTE_ID_2 };
  }

  // -- Test 43 -----------------------------------------------------------------
  it("bundler2 commit does not affect bundler1 lockedOf", async () => {
    const { escrow, user1, user2, bundler1, bundler2, QUOTE_ID, QUOTE_ID_2 } =
      await twoBundle();
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await escrow.connect(bundler2).deposit({ value: COLLATERAL });

    const tx43 = await escrow.connect(user2).commit(QUOTE_ID_2, ethers.keccak256(ethers.toUtf8Bytes("op-43")), bundler2.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    await escrow.connect(bundler2).accept(await getCommitId(tx43, escrow));

    expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
  });

  // -- Test 44 -----------------------------------------------------------------
  it("bundler1 slash does not reduce bundler2 deposited", async () => {
    const { escrow, user1, user2, bundler1, bundler2, QUOTE_ID, QUOTE_ID_2 } =
      await twoBundle();
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await escrow.connect(bundler2).deposit({ value: COLLATERAL });

    const tx44 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-44")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid44 = await getCommitId(tx44, escrow);
    await escrow.connect(bundler1).accept(cid44);
    await mineToRefundable(escrow, cid44);
    await escrow.connect(user1).claimRefund(cid44);

    expect(await escrow.deposited(bundler2.address)).to.equal(COLLATERAL);
  });

  // -- Test 45 -----------------------------------------------------------------
  it("bundler1 settle does not affect bundler2 lockedOf or deposited", async () => {
    const { escrow, user1, user2, bundler1, bundler2, QUOTE_ID, QUOTE_ID_2 } =
      await twoBundle();
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await escrow.connect(bundler2).deposit({ value: COLLATERAL });

    const tx45a = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-l")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid45a = await getCommitId(tx45a, escrow);
    await escrow.connect(bundler1).accept(cid45a);

    const tx45b = await escrow.connect(user2).commit(QUOTE_ID_2, ethers.keccak256(ethers.toUtf8Bytes("op-m")), bundler2.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid45b = await getCommitId(tx45b, escrow);
    await escrow.connect(bundler2).accept(cid45b);

    await escrow.connect(bundler1).settle(cid45a);

    expect(await escrow.lockedOf(bundler2.address)).to.equal(COLLATERAL);
    expect(await escrow.deposited(bundler2.address)).to.equal(COLLATERAL);
  });

  // -- Test 46 -----------------------------------------------------------------
  it("two bundlers can operate entirely independently without cross-contamination", async () => {
    const { escrow, user1, user2, bundler1, bundler2, QUOTE_ID, QUOTE_ID_2 } =
      await twoBundle();
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 3n });
    await escrow.connect(bundler2).deposit({ value: COLLATERAL * 2n });

    // bundler1: two commits, settle both
    const tx46a = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("h1")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid46a = await getCommitId(tx46a, escrow);
    await escrow.connect(bundler1).accept(cid46a);

    const tx46b = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("h2")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid46b = await getCommitId(tx46b, escrow);
    await escrow.connect(bundler1).accept(cid46b);

    await escrow.connect(bundler1).settle(cid46a);
    await escrow.connect(bundler1).settle(cid46b);

    // bundler2: one commit, slash
    const tx46c = await escrow.connect(user2).commit(QUOTE_ID_2, ethers.keccak256(ethers.toUtf8Bytes("h3")), bundler2.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid46c = await getCommitId(tx46c, escrow);
    await escrow.connect(bundler2).accept(cid46c);
    await mineToRefundable(escrow, cid46c);
    await escrow.connect(user2).claimRefund(cid46c);

    // bundler1 state
    expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);
    expect(await escrow.deposited(bundler1.address)).to.equal(COLLATERAL * 3n);

    // bundler2 state: full slash
    expect(await escrow.lockedOf(bundler2.address)).to.equal(0n);
    expect(await escrow.deposited(bundler2.address)).to.equal(COLLATERAL); // had 2x, lost 1x
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: payout accounting integrity", () => {
  // -- Test 47 -----------------------------------------------------------------
  it("pendingWithdrawals[bundler] is set correctly after settle", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx47 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-47")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid47 = await getCommitId(tx47, escrow);
    await escrow.connect(bundler1).accept(cid47);
    await escrow.connect(bundler1).settle(cid47);

    // bundler gets full feePerOp (PROTOCOL_FEE_WEI=0)
    expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
  });

  // -- Test 48 -----------------------------------------------------------------
  it("pendingWithdrawals[feeRecipient] accumulates across multiple settles", async () => {
    const { escrow, user1, user2, bundler1, feeRecipient, QUOTE_ID } =
      await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });

    const tx48a = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("h1-48")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid48a = await getCommitId(tx48a, escrow);
    await escrow.connect(bundler1).accept(cid48a);

    const tx48b = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("h2-48")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid48b = await getCommitId(tx48b, escrow);
    await escrow.connect(bundler1).accept(cid48b);

    await escrow.connect(bundler1).settle(cid48a);
    await escrow.connect(bundler1).settle(cid48b);

    // PROTOCOL_FEE_WEI=0 -> feeRecipient accrues nothing at settle
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  // -- Test 49 -----------------------------------------------------------------
  it("claimRefund credits user with feePaid + full collateral", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx49 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-49")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid49 = await getCommitId(tx49, escrow);
    await escrow.connect(bundler1).accept(cid49);

    await mineToRefundable(escrow, cid49);
    await escrow.connect(user1).claimRefund(cid49);

    // 100% of collateral goes to user (no protocol split)
    const expectedUserPending = ONE_GWEI + COLLATERAL;
    expect(await escrow.pendingWithdrawals(user1.address)).to.equal(
      expectedUserPending
    );
  });

  // -- Test 50 -----------------------------------------------------------------
  it("claimRefund credits feeRecipient with 0 (100% slash goes to user)", async () => {
    const { escrow, user1, bundler1, feeRecipient, QUOTE_ID } =
      await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx50 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-50")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid50 = await getCommitId(tx50, escrow);
    await escrow.connect(bundler1).accept(cid50);

    await mineToRefundable(escrow, cid50);
    await escrow.connect(user1).claimRefund(cid50);

    // feeRecipient receives nothing; full collateral goes to user
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });

  // -- Test 51 -----------------------------------------------------------------
  it("claimPayout resets pendingWithdrawals to zero", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx51 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-51")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid51 = await getCommitId(tx51, escrow);
    await escrow.connect(bundler1).accept(cid51);
    await mineToRefundable(escrow, cid51);
    await escrow.connect(user1).claimRefund(cid51);

    await escrow.connect(user1).claimPayout();
    expect(await escrow.pendingWithdrawals(user1.address)).to.equal(0n);
  });

  // -- Test 52 -----------------------------------------------------------------
  it("claimPayout with nothing pending reverts NothingToClaim", async () => {
    const { escrow, stranger } = await loadFixture(deploy);
    await expect(
      escrow.connect(stranger).claimPayout()
    ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
  });
});

// -----------------------------------------------------------------------------
describe("Cat2 -- Collateral: invariant checks across complex scenarios", () => {
  // -- Test 53 -----------------------------------------------------------------
  it("ETH invariant: sum of all pending + deposits = contract balance at any point", async () => {
    const { escrow, user1, user2, bundler1, feeRecipient, QUOTE_ID } =
      await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 2n });

    const tx53a = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("h1-53")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid53a = await getCommitId(tx53a, escrow);
    await escrow.connect(bundler1).accept(cid53a);

    const tx53b = await escrow.connect(user2).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("h2-53")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid53b = await getCommitId(tx53b, escrow);
    await escrow.connect(bundler1).accept(cid53b);

    // settle first, slash second
    await escrow.connect(bundler1).settle(cid53a);
    await mineToRefundable(escrow, cid53b);
    await escrow.connect(user2).claimRefund(cid53b);

    const contractBal = await contractBalance(escrow);
    const b1Deposited = await escrow.deposited(bundler1.address);
    const b1Pending = await escrow.pendingWithdrawals(bundler1.address);
    const user1Pending = await escrow.pendingWithdrawals(user1.address);
    const user2Pending = await escrow.pendingWithdrawals(user2.address);
    const feePending = await escrow.pendingWithdrawals(feeRecipient.address);

    const accounted = b1Deposited + b1Pending + user1Pending + user2Pending + feePending;
    expect(contractBal).to.equal(accounted);
  });

  // -- Test 54 -----------------------------------------------------------------
  it("stranger cannot withdraw another bundler's idle balance", async () => {
    const { escrow, bundler1, stranger } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    // stranger has 0 deposited, withdraw should fail
    await expect(
      escrow.connect(stranger).withdraw(1n)
    ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
  });

  // -- Test 55 -----------------------------------------------------------------
  it("lockedOf never exceeds deposited at any point in time", async () => {
    const { escrow, user1, user2, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 3n });

    for (let i = 0n; i < 3n; i++) {
      const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes(`lock${i}`)), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
      await escrow.connect(bundler1).accept(await getCommitId(tx, escrow));
      const locked = await escrow.lockedOf(bundler1.address);
      const deposited = await escrow.deposited(bundler1.address);
      expect(locked).to.be.lte(deposited);
    }
  });

  // -- Test 56 -----------------------------------------------------------------
  it("settle after deadline reverts DeadlinePassed", async () => {
    const { escrow, user1, bundler1, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx56 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-56")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid56 = await getCommitId(tx56, escrow);
    await escrow.connect(bundler1).accept(cid56);

    // mine past deadline + SETTLEMENT_GRACE_BLOCKS
    await mine(SLA_BLOCKS + BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS()) + 2n);
    await expect(
      escrow.connect(bundler1).settle(cid56)
    ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
  });

  // -- Test 57 -----------------------------------------------------------------
  it("non-bundler cannot accept a commit (NotBundler)", async () => {
    const { escrow, user1, bundler1, stranger, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx57 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-57")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid57 = await getCommitId(tx57, escrow);
    await expect(
      escrow.connect(stranger).accept(cid57)
    ).to.be.revertedWithCustomError(escrow, "NotBundler");
  });

  // -- Test 58 -----------------------------------------------------------------
  it("stranger cannot claimRefund for a commit -- reverts Unauthorized (T12)", async () => {
    const { escrow, user1, bundler1, stranger, QUOTE_ID } = await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    const tx58 = await escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-58")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid58 = await getCommitId(tx58, escrow);
    await escrow.connect(bundler1).accept(cid58);
    await mineToRefundable(escrow, cid58);
    await expect(
      escrow.connect(stranger).claimRefund(cid58)
    ).to.be.revertedWithCustomError(escrow, "Unauthorized");
  });

  // -- Test 59 -----------------------------------------------------------------
  it("committing to an inactive quote reverts OfferInactive", async () => {
    const { escrow, registry, user1, bundler1, QUOTE_ID } =
      await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });
    await registry.connect(bundler1).deregister(QUOTE_ID);
    await expect(
      escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-59")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI })
    ).to.be.revertedWithCustomError(escrow, "OfferInactive");
  });

  // -- Test 60 -----------------------------------------------------------------
  it("full lifecycle: deposit -> commit -> settle -> withdraw produces correct final balances", async () => {
    const { escrow, user1, bundler1, feeRecipient, QUOTE_ID } =
      await loadFixture(deploy);
    await escrow.connect(bundler1).deposit({ value: COLLATERAL });

    const bundlerEthBefore = await ethers.provider.getBalance(bundler1.address);

    const commitTx = await escrow
      .connect(user1)
      .commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op-60")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const cid60 = await getCommitId(commitTx, escrow);
    await escrow.connect(bundler1).accept(cid60);
    await escrow.connect(bundler1).settle(cid60);

    // withdraw deposit
    const withdrawTx = await escrow.connect(bundler1).withdraw(COLLATERAL);
    // claim bundler fee share (full feePerOp; PROTOCOL_FEE_WEI=0)
    await escrow.connect(bundler1).claimPayout();
    // feeRecipient has nothing to claim -- no claimPayout needed

    expect(await contractBalance(escrow)).to.equal(0n);
    expect(await escrow.deposited(bundler1.address)).to.equal(0n);
    expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
    expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
  });
});
