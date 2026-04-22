// Category 19: Exact Invariant Tests
//
// Addresses weaknesses found in the suite review:
//   - Weak >0n assertions replaced with exact expected values
//   - Grace constants read from contract (not hardcoded)
//   - Log-parsing tests assert the event was actually found (no silent-skip)
//   - collateralWei == feePerOp boundary actually tested (cat3 helper silently bumped it)
//   - Double-accept and accept-after-finalization attack paths
//   - Exact lockedOf accounting across concurrent commits
//   - reservedBalance checked after every mutating operation

import { expect }            from "chai";
import { ethers, upgrades }  from "hardhat";
import { mine }              from "@nomicfoundation/hardhat-network-helpers";
import type { QuoteRegistry, SLAEscrow } from "../../typechain-types";
import {
    deployEscrow,
    makeCommit,
    mineTo,
    mineToRefundable,
    assertReservedInvariant,
    assertBalanceInvariant,
    assertLockedOfInvariant,
    assertSettled,
    assertRefunded,
    bundlerNet,
    userRefundAmount,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read SETTLEMENT_GRACE_BLOCKS from the live contract (never hardcode). */
async function settlGrace(escrow: SLAEscrow): Promise<bigint> {
    return BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
}

/** Read REFUND_GRACE_BLOCKS from the live contract (never hardcode). */
async function refundGrace(escrow: SLAEscrow): Promise<bigint> {
    return BigInt(await escrow.REFUND_GRACE_BLOCKS());
}

// =============================================================================
// 1. Exact fee math -- bundler gets exactly feePerOp on settle (PROTOCOL_FEE=0)
// =============================================================================

describe("Cat19 -- Exact fee routing after settle", function () {

    it("19.01 bundler pendingWithdrawals == ONE_GWEI after one settle (not just > 0)", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const { commitId } = await makeCommit(escrow, await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry, user, QUOTE_ID, "19.01");

        await (escrow as any).connect(bundler)["settle(uint256)"](commitId);

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("19.02 after N settles bundler pendingWithdrawals == N * ONE_GWEI (not just > 0)", async function () {
        const N = 5;
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ preDeposit: COLLATERAL * BigInt(N + 1) });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;

        for (let i = 0; i < N; i++) {
            const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, `19.02-${i}`);
            await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
        }

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * BigInt(N));
    });

    it("19.03 feeRecipient pendingWithdrawals == 0 after settle (PROTOCOL_FEE_WEI=0)", async function () {
        const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.03");

        await (escrow as any).connect(bundler)["settle(uint256)"](commitId);

        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("19.04 Settled event carries exact bundlerNet == ONE_GWEI", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.04");

        const tx = (escrow as any).connect(bundler)["settle(uint256)"](commitId);
        await assertSettled(tx, escrow, commitId, bundlerNet(ONE_GWEI));
    });
});

// =============================================================================
// 2. Exact slash math -- user gets exactly feePaid + collateral on claimRefund
// =============================================================================

describe("Cat19 -- Exact slash math after claimRefund", function () {

    it("19.05 user pendingWithdrawals == feePaid + collateral after claimRefund", async function () {
        const { escrow, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.05");

        await mineToRefundable(escrow, commitId);
        await escrow.connect(user).claimRefund(commitId);

        const expected = userRefundAmount(ONE_GWEI, COLLATERAL);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expected);
    });

    it("19.06 Refunded event carries exact userAmount == feePaid + collateral", async function () {
        const { escrow, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.06");

        await mineToRefundable(escrow, commitId);
        const tx = escrow.connect(user).claimRefund(commitId);
        await assertRefunded(tx, escrow, commitId, userRefundAmount(ONE_GWEI, COLLATERAL));
    });

    it("19.07 bundler deposited reduced by exactly collateral after claimRefund", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const depositedBefore = await escrow.deposited(bundler.address);
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.07");

        await mineToRefundable(escrow, commitId);
        await escrow.connect(user).claimRefund(commitId);

        // Slash: deposited -= collateralLocked.  No more, no less.
        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore - COLLATERAL);
    });

    it("19.08 odd-wei collateral: user gets fee + exact collateral (no rounding, no truncation)", async function () {
        const oddCollateral = 11n;
        const fee = 1n;
        // Deploy custom escrow: fee=1, collateral=11 (strictly greater)
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), feeRecipient.address],
            { kind: "uups" },
        )) as unknown as SLAEscrow;

        await registry.connect(bundler).register(fee, 2, oddCollateral, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: oddCollateral });

        // commit
        await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("odd")), bundler.address, oddCollateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);

        const sg = await settlGrace(escrow);
        const rg = await refundGrace(escrow);
        const c = await escrow.getCommit(0n);
        await mineTo(c.deadline + sg + rg + 1n);

        const tx = escrow.connect(user).claimRefund(0n);
        // Must find the Refunded event and verify exact amount
        const receipt = await (await tx).wait();
        const refundedLogs1 = receipt!.logs
            .filter(log => log.topics[0] === escrow.interface.getEvent("Refunded")!.topicHash)
            .map(log => escrow.interface.parseLog(log)!);
        expect(refundedLogs1.length, "Refunded event not emitted").to.equal(1);
        expect(refundedLogs1[0].args.userAmount).to.equal(fee + oddCollateral, "Refunded.userAmount wrong");
    });
});

// =============================================================================
// 3. Grace boundary exact blocks (read from contract, never hardcoded)
// =============================================================================

describe("Cat19 -- Exact grace block boundaries", function () {

    it("19.09 settle at exactly deadline + SETTLEMENT_GRACE_BLOCKS succeeds", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ slaBlocks: 2n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.09");

        const sg = await settlGrace(escrow);
        const c = await escrow.getCommit(commitId);
        await mineTo(c.deadline + sg); // tx lands at deadline + SETTLEMENT_GRACE

        await expect(
            (escrow as any).connect(bundler)["settle(uint256)"](commitId),
        ).to.not.be.reverted;
    });

    it("19.10 settle at deadline + SETTLEMENT_GRACE_BLOCKS + 1 reverts DeadlinePassed", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ slaBlocks: 2n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.10");

        const sg = await settlGrace(escrow);
        const c = await escrow.getCommit(commitId);
        await mineTo(c.deadline + sg + 1n); // one block past the window

        await expect(
            (escrow as any).connect(bundler)["settle(uint256)"](commitId),
        ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("19.11 claimRefund at exactly deadline + SETTLEMENT_GRACE + REFUND_GRACE reverts NotExpired", async function () {
        const { escrow, user, QUOTE_ID } = await deployEscrow({ slaBlocks: 2n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.11");

        const sg = await settlGrace(escrow);
        const rg = await refundGrace(escrow);
        const c = await escrow.getCommit(commitId);
        // unlocksAt = deadline + sg + rg + 1; at deadline+sg+rg, we are still one short
        await mineTo(c.deadline + sg + rg);

        await expect(escrow.connect(user).claimRefund(commitId))
            .to.be.revertedWithCustomError(escrow, "NotExpired");
    });

    it("19.12 claimRefund at exactly unlocksAt (deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1) succeeds", async function () {
        const { escrow, user, QUOTE_ID } = await deployEscrow({ slaBlocks: 2n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.12");

        const sg = await settlGrace(escrow);
        const rg = await refundGrace(escrow);
        const c = await escrow.getCommit(commitId);
        await mineTo(c.deadline + sg + rg + 1n);

        await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
    });

    it("19.13 dead zone: past settlement window and before refund window, BOTH actions revert", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ slaBlocks: 2n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.13");

        const sg = await settlGrace(escrow);
        const rg = await refundGrace(escrow);
        const c = await escrow.getCommit(commitId);

        // mid dead zone
        await mineTo(c.deadline + sg + 1n);
        await expect(
            (escrow as any).connect(bundler)["settle(uint256)"](commitId),
        ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");

        if (rg > 1n) {
            await mineTo(c.deadline + sg + (rg / 2n));
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        }
    });
});

// =============================================================================
// 4. collateralWei == feePerOp boundary (cat3's setupOffer silently skips this)
// =============================================================================

describe("Cat19 -- collateralWei boundary (T8: strict >)", function () {

    it("19.14 register with collateralWei == feePerOp reverts", async function () {
        const [owner, bundler] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;

        await expect(
            registry.connect(bundler).register(ONE_GWEI, 2, ONE_GWEI, 302_400, { value: ethers.parseEther("0.0001") }),
        ).to.be.revertedWith("collateralWei must be > feePerOp");
    });

    it("19.15 register with collateralWei == feePerOp - 1 reverts", async function () {
        const [owner, bundler] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;

        await expect(
            registry.connect(bundler).register(ONE_GWEI, 2, ONE_GWEI - 1n, 302_400, { value: ethers.parseEther("0.0001") }),
        ).to.be.revertedWith("collateralWei must be > feePerOp");
    });

    it("19.16 register with collateralWei == feePerOp + 1 succeeds", async function () {
        const [owner, bundler] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;

        await expect(
            registry.connect(bundler).register(ONE_GWEI, 2, ONE_GWEI + 1n, 302_400, { value: ethers.parseEther("0.0001") }),
        ).to.not.be.reverted;
    });
});

// =============================================================================
// 5. Double-accept and accept-after-finalization attacks
// =============================================================================

describe("Cat19 -- accept() double-call and post-finalization attacks", function () {

    it("19.17 bundler cannot accept() twice on same commit", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.17");
        // makeCommit already called accept() once; try again
        await expect(
            escrow.connect(bundler).accept(commitId),
        ).to.be.revertedWithCustomError(escrow, "CommitNotProposed");
    });

    it("19.18 bundler cannot accept() after commit is settled", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.18");
        await (escrow as any).connect(bundler)["settle(uint256)"](commitId);

        await expect(
            escrow.connect(bundler).accept(commitId),
        ).to.be.revertedWithCustomError(escrow, "CommitNotProposed");
    });

    it("19.19 bundler cannot accept() after commit is refunded", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.19");
        await mineToRefundable(escrow, commitId);
        await escrow.connect(user).claimRefund(commitId);

        await expect(
            escrow.connect(bundler).accept(commitId),
        ).to.be.revertedWithCustomError(escrow, "CommitNotProposed");
    });

    it("19.20 double-accept does not double-lock collateral", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.20");

        const lockedAfterFirstAccept = await escrow.lockedOf(bundler.address);
        // second accept reverts CommitNotProposed (already ACTIVE) -- locked must be unchanged
        await expect(escrow.connect(bundler).accept(commitId))
            .to.be.revertedWithCustomError(escrow, "CommitNotProposed");
        expect(await escrow.lockedOf(bundler.address)).to.equal(lockedAfterFirstAccept);
    });
});

// =============================================================================
// 6. Exact lockedOf accounting across concurrent commits
// =============================================================================

describe("Cat19 -- Exact lockedOf across concurrent commits", function () {

    it("19.21 lockedOf increases by exactly collateral per accept()", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ preDeposit: COLLATERAL * 5n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;

        const locked0 = await escrow.lockedOf(bundler.address);
        expect(locked0).to.equal(0n); // nothing locked before first accept

        const { commitId: id0 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.21a");
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);

        const { commitId: id1 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.21b");
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 2n);

        const { commitId: id2 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.21c");
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 3n);

        await assertLockedOfInvariant(escrow, bundler.address, [id0, id1, id2]);
    });

    it("19.22 lockedOf decreases by exactly collateral after each settle()", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ preDeposit: COLLATERAL * 5n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;

        const { commitId: id0 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.22a");
        const { commitId: id1 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.22b");
        const { commitId: id2 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.22c");
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 3n);

        await (escrow as any).connect(bundler)["settle(uint256)"](id0);
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 2n);

        await (escrow as any).connect(bundler)["settle(uint256)"](id1);
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 1n);

        await (escrow as any).connect(bundler)["settle(uint256)"](id2);
        expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
    });

    it("19.23 lockedOf decreases by exactly collateral after claimRefund() (slash)", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ preDeposit: COLLATERAL * 3n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;

        const { commitId: id0 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.23a");
        const { commitId: id1 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.23b");
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL * 2n);

        await mineToRefundable(escrow, id0);
        await escrow.connect(user).claimRefund(id0);

        // id0 refunded: lockedOf -= COLLATERAL.  id1 still locked.
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
        await assertLockedOfInvariant(escrow, bundler.address, [id0, id1]);
    });
});

// =============================================================================
// 7. reservedBalance invariant after every mutating operation
// =============================================================================

describe("Cat19 -- reservedBalance == balance after every operation", function () {

    it("19.24 invariant holds after deposit()", async function () {
        const { escrow, bundler } = await deployEscrow({ preDeposit: false });
        await escrow.connect(bundler).deposit({ value: COLLATERAL });
        await assertReservedInvariant(escrow, ethers.provider);
    });

    it("19.25 invariant holds after commit() + accept()", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        await makeCommit(escrow, registry, user, QUOTE_ID, "19.25");
        await assertReservedInvariant(escrow, ethers.provider);
    });

    it("19.26 invariant holds after settle()", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.26");
        await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
        await assertReservedInvariant(escrow, ethers.provider);
    });

    it("19.27 invariant holds after claimRefund()", async function () {
        const { escrow, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.27");
        await mineToRefundable(escrow, commitId);
        await escrow.connect(user).claimRefund(commitId);
        await assertReservedInvariant(escrow, ethers.provider);
    });

    it("19.28 invariant holds after claimPayout()", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.28");
        await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
        await escrow.connect(bundler).claimPayout();
        await assertReservedInvariant(escrow, ethers.provider);
    });

    it("19.29 invariant holds after withdraw()", async function () {
        const { escrow, bundler } = await deployEscrow();
        await escrow.connect(bundler).withdraw(COLLATERAL);
        await assertReservedInvariant(escrow, ethers.provider);
    });

    it("19.30 invariant holds through full settle+refund+claim cycle with 2 bundlers", async function () {
        const [owner, b1, b2, user, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), feeRecipient.address],
            { kind: "uups" },
        )) as unknown as SLAEscrow;

        await registry.connect(b1).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        await registry.connect(b2).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(b1).deposit({ value: COLLATERAL });
        await escrow.connect(b2).deposit({ value: COLLATERAL });
        await assertReservedInvariant(escrow, ethers.provider);

        // b1 commit -> settle
        await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("b1")), b1.address, COLLATERAL, 2, { value: ONE_GWEI });
        await escrow.connect(b1).accept(0n);
        await assertReservedInvariant(escrow, ethers.provider);

        await (escrow as any).connect(b1)["settle(uint256)"](0n);
        await assertReservedInvariant(escrow, ethers.provider);

        // b2 commit -> expire -> refund
        await escrow.connect(user).commit(2n, ethers.keccak256(ethers.toUtf8Bytes("b2")), b2.address, COLLATERAL, 2, { value: ONE_GWEI });
        await escrow.connect(b2).accept(1n);
        await assertReservedInvariant(escrow, ethers.provider);

        const sg = await settlGrace(escrow);
        const rg = await refundGrace(escrow);
        const c = await escrow.getCommit(1n);
        await mineTo(c.deadline + sg + rg + 1n);
        await escrow.connect(user).claimRefund(1n);
        await assertReservedInvariant(escrow, ethers.provider);

        // claim all pending
        await escrow.connect(b1).claimPayout();
        await escrow.connect(user).claimPayout();
        await assertReservedInvariant(escrow, ethers.provider);
    });
});

// =============================================================================
// 8. Exact pendingWithdrawals after permissionless settle (testable contract)
//    Tests that silently used > before instead of exact equality
// =============================================================================

describe("Cat19 -- Exact pendingWithdrawals after permissionless settle", function () {

    it("19.31 stranger calling settle() credits bundler with exactly ONE_GWEI, not just > before", async function () {
        const { escrow, bundler, user, stranger, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.31");

        const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
        await (escrow as any).connect(stranger)["settle(uint256)"](commitId);

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore + ONE_GWEI);
        // stranger gets nothing
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
    });

    it("19.32 bundler calling claimRefund credits user with exactly feePaid + collateral, not just > before", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow();
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
        const { commitId } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.32");

        const pendingBefore = await escrow.pendingWithdrawals(user.address);
        await mineToRefundable(escrow, commitId);
        await escrow.connect(bundler).claimRefund(commitId);

        expect(await escrow.pendingWithdrawals(user.address)).to.equal(pendingBefore + userRefundAmount(ONE_GWEI, COLLATERAL));
    });
});

// =============================================================================
// 9. Log-parsing tests that can silently skip (cat14 86-89 pattern fixed)
//    Each test ASSERTS the target event was actually found in the receipt.
// =============================================================================

describe("Cat19 -- Log-parsing: assert event is present (no silent skip)", function () {

    async function deployTiny(fee: bigint, collateral: bigint, slaBlocks = 2) {
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), feeRecipient.address],
            { kind: "uups" },
        )) as unknown as SLAEscrow;
        await registry.connect(bundler).register(fee, slaBlocks, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: collateral });
        return { escrow, registry, bundler, user, feeRecipient };
    }

    it("19.33 Refunded event present and userAmount exact (tiny fee=1, collateral=2)", async function () {
        const fee = 1n, collat = 2n;
        const { escrow, bundler, user } = await deployTiny(fee, collat);

        await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("t1")), bundler.address, collat, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);

        const sg = await settlGrace(escrow);
        const rg = await refundGrace(escrow);
        const c = await escrow.getCommit(0n);
        await mineTo(c.deadline + sg + rg + 1n);

        const tx = await escrow.connect(user).claimRefund(0n);
        const receipt = await tx.wait();

        const refundedLogs33 = receipt!.logs
            .filter(log => log.topics[0] === escrow.interface.getEvent("Refunded")!.topicHash)
            .map(log => escrow.interface.parseLog(log)!);
        expect(refundedLogs33.length, "Refunded event not emitted").to.equal(1);
        expect(refundedLogs33[0].args.userAmount, "Refunded.userAmount").to.equal(fee + collat);
    });

    it("19.34 Settled event present and bundlerNet exact (tiny fee=1, collateral=2)", async function () {
        const fee = 1n, collat = 2n;
        const { escrow, bundler, user } = await deployTiny(fee, collat);

        await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("t2")), bundler.address, collat, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);

        const tx = await (escrow as any).connect(bundler)["settle(uint256)"](0n);
        const receipt = await tx.wait();

        const settledLogs34 = receipt!.logs
            .filter(log => log.topics[0] === escrow.interface.getEvent("Settled")!.topicHash)
            .map(log => escrow.interface.parseLog(log)!);
        expect(settledLogs34.length, "Settled event not emitted").to.equal(1);
        expect(settledLogs34[0].args.bundlerNet, "Settled.bundlerNet").to.equal(fee);
    });
});

// =============================================================================
// 10. idleBalance exact accounting (complements lockedOf tests)
// =============================================================================

describe("Cat19 -- Exact idleBalance accounting", function () {

    it("19.35 idleBalance == deposited - lockedOf at all times", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ preDeposit: COLLATERAL * 4n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;

        async function checkIdle(label: string) {
            const dep    = await escrow.deposited(bundler.address);
            const locked = await escrow.lockedOf(bundler.address);
            const idle   = await escrow.idleBalance(bundler.address);
            expect(idle, `idle mismatch @ ${label}`).to.equal(dep - locked);
        }

        await checkIdle("start");
        const { commitId: id0 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.35a");
        await checkIdle("after commit 0");
        const { commitId: id1 } = await makeCommit(escrow, registry, user, QUOTE_ID, "19.35b");
        await checkIdle("after commit 1");
        await (escrow as any).connect(bundler)["settle(uint256)"](id0);
        await checkIdle("after settle 0");
        await mineToRefundable(escrow, id1);
        await escrow.connect(user).claimRefund(id1);
        await checkIdle("after refund 1");
    });

    it("19.36 withdraw exactly reduces idleBalance (not deposited-without-lock)", async function () {
        const { escrow, bundler, user, QUOTE_ID } = await deployEscrow({ preDeposit: COLLATERAL * 3n });
        const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;

        // Lock one collateral
        await makeCommit(escrow, registry, user, QUOTE_ID, "19.36");
        const idleBefore = await escrow.idleBalance(bundler.address);
        expect(idleBefore).to.equal(COLLATERAL * 2n); // 3 deposited, 1 locked

        await escrow.connect(bundler).withdraw(COLLATERAL);
        expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 2n);
    });
});
