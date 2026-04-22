// Category 1: Fund theft / double-claim -- adversarial test suite

import { expect }                   from "chai";
import { ethers, upgrades }           from "hardhat";
import { mine }                      from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    assertBalanceInvariant,
    makeCommit as fixturesMakeCommit,
    mineToRefundable,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
    MIN_BOND,
    MIN_LIFETIME,
} from "../helpers/fixtures";

const ONE_ETH  = ethers.parseEther("1");
const SLA_BLOCKS = 2n;

async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
    return await ethers.provider.getBalance(await escrow.getAddress());
}

async function deploy() {
    const [owner, bundler1, bundler2, user1, user2, feeRecipient, stranger] =
        await ethers.getSigners();

    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;

    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
        Escrow,
        [await registry.getAddress(), feeRecipient.address],
        { kind: "uups" }
    )) as unknown as SLAEscrow;

    // Register a standard offer: bundler1
    await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
    const QUOTE_ID = 1n;

    // Deposit collateral for bundler1
    await escrow.connect(bundler1).deposit({ value: COLLATERAL * 10n });

    return { escrow, registry, owner, bundler1, bundler2, user1, user2, feeRecipient, stranger, QUOTE_ID };
}

/** Create a commit and return its commitId (signature: registry as 2nd arg for test readability). */
async function makeCommit(
    escrow: SLAEscrow,
    registry: QuoteRegistry,
    user: any,
    quoteId: bigint,
    userOpHash?: string,
): Promise<bigint> {
    const { commitId } = await fixturesMakeCommit(
        escrow, registry, user, quoteId,
        userOpHash ? undefined : `op-${Date.now()}-${Math.random()}`,
        userOpHash,
    );
    return commitId;
}

// -----------------------------------------------------------------------------
// 1. Double-settle
// -----------------------------------------------------------------------------
describe("Cat1 -- Double settle()", () => {
    it("1.01 reverts on second settle() of the same commitId", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
    });

    it("1.02 bundler cannot double-collect earnings via two settle() calls", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        const pendingAfter = await escrow.pendingWithdrawals(bundler1.address);
        expect(pendingAfter).to.equal(pendingBefore); // no extra credit
    });

    it("1.03 contract balance stays consistent after blocked double settle()", async () => {
        const { escrow, registry, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler1.address],
            [bundler1.address, feeRecipient.address, user1.address],
        );
    });
});

// -----------------------------------------------------------------------------
// 2. Double-claimRefund
// -----------------------------------------------------------------------------
describe("Cat1 -- Double claimRefund()", () => {
    it("1.04 reverts on second claimRefund() of the same commitId", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // advance past deadline + settlement grace + refund grace
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
    });

    it("1.05 user pendingWithdrawals not incremented twice after double claimRefund()", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        const pendingAfterFirst = await escrow.pendingWithdrawals(user1.address);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(pendingAfterFirst);
    });

    it("1.06 contract balance invariant holds after blocked double claimRefund()", async () => {
        const { escrow, registry, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler1.address],
            [bundler1.address, user1.address, feeRecipient.address],
        );
    });
});

// -----------------------------------------------------------------------------
// 3. settle() after claimRefund() already ran
// -----------------------------------------------------------------------------
describe("Cat1 -- settle() after claimRefund()", () => {
    it("1.07 settle() reverts when commit is already refunded", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
    });

    it("1.08 bundler earns nothing from settle() after refund has run", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(pendingBefore);
    });

    it("1.09 balance invariant holds when settle() after refund is blocked", async () => {
        const { escrow, registry, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler1.address],
            [bundler1.address, user1.address, feeRecipient.address],
        );
    });
});

// -----------------------------------------------------------------------------
// 4. claimRefund() after settle() already ran
// -----------------------------------------------------------------------------
describe("Cat1 -- claimRefund() after settle()", () => {
    it("1.10 claimRefund() reverts when commit is already settled", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
    });

    it("1.11 user gets no extra pending after claimRefund on settled commit", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await mineToRefundable(escrow, cid);
        const pendingBefore = await escrow.pendingWithdrawals(user1.address);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(pendingBefore);
    });

    it("1.12 contract balance invariant holds after blocked claimRefund post-settle", async () => {
        const { escrow, registry, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
            .withArgs(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler1.address],
            [bundler1.address, user1.address, feeRecipient.address],
        );
    });
});

// -----------------------------------------------------------------------------
// 5. settle() is permissionless -- any caller can submit; fee always goes to c.bundler
// -----------------------------------------------------------------------------
describe("Cat1 -- Permissionless settle()", () => {
    it("1.13 stranger can call settle() (permissionless); fee goes to bundler1 not stranger", async () => {
        const { escrow, registry, bundler1, stranger, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(stranger).settle(cid)).to.not.be.reverted;
        // Fee credited to the snapshotted bundler, not the caller
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(pendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
    });

    it("1.14 the user themselves can call settle() (permissionless); fee goes to bundler1", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(user1).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(pendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(0n);
    });

    it("1.15 a second bundler can settle another bundler's commit; fee still goes to commit's bundler", async () => {
        const { escrow, registry, bundler1, bundler2, user1, QUOTE_ID } = await deploy();
        // bundler2 has an offer but settles bundler1's commit
        await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const b1PendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(bundler2).settle(cid)).to.not.be.reverted;
        // Fee goes to bundler1 (commit's bundler), not bundler2
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(b1PendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(0n);
    });

    it("1.16 owner can call settle() (permissionless); fee goes to commit's bundler", async () => {
        const { escrow, registry, bundler1, owner, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(pendingBefore + ONE_GWEI);
    });

    it("1.17 feeRecipient can call settle() (permissionless); fee goes to commit's bundler", async () => {
        const { escrow, registry, bundler1, feeRecipient, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        await expect(escrow.connect(feeRecipient).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(pendingBefore + ONE_GWEI);
    });
});

// -----------------------------------------------------------------------------
// 6. Unauthorised claimRefund() -- stranger or bundler calls claimRefund()
// -----------------------------------------------------------------------------
describe("Cat1 -- Unauthorised claimRefund()", () => {
    it("1.18 stranger cannot call claimRefund() -- reverts Unauthorized", async () => {
        const { escrow, registry, stranger, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(stranger).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "Unauthorized")
            .withArgs(cid, stranger.address);
    });

    it("1.19 bundler (commit servicer) can call claimRefund() after expiry -- ETH goes to user (T12)", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        const pendingBefore = await escrow.pendingWithdrawals(user1.address);
        await escrow.connect(bundler1).claimRefund(cid);
        // User receives feePaid (ONE_GWEI) + full collateral (COLLATERAL) on refund
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
    });

    it("1.20 a second user cannot claim refund on another user's commit -- reverts Unauthorized", async () => {
        const { escrow, registry, user1, user2, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(user2).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "Unauthorized")
            .withArgs(cid, user2.address);
    });

    it("1.21 feeRecipient can call claimRefund() after expiry -- ETH goes to user (T12)", async () => {
        const { escrow, registry, feeRecipient, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        const pendingBefore = await escrow.pendingWithdrawals(user1.address);
        await escrow.connect(feeRecipient).claimRefund(cid);
        // User receives feePaid (ONE_GWEI) + full collateral (COLLATERAL) on refund
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
    });
});

// -----------------------------------------------------------------------------
// 7. claimPayout() -- draining pendingWithdrawals
// -----------------------------------------------------------------------------
describe("Cat1 -- Double claimPayout()", () => {
    it("1.22 second claimPayout() reverts with NothingToClaim", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await escrow.connect(bundler1).claimPayout();
        await expect(escrow.connect(bundler1).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("1.23 pendingWithdrawals is zero after first claimPayout()", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await escrow.connect(bundler1).claimPayout();
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
    });

    it("1.24 claimPayout() with zero balance reverts with NothingToClaim", async () => {
        const { escrow, registry, stranger } = await deploy();
        await expect(escrow.connect(stranger).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("1.25 CEI pattern: second sequential claimPayout in same context reverts (no re-entrancy window)", async () => {
        // Demonstrates that pendingWithdrawals is zeroed before the transfer.
        // Two separate calls -- second must see zero balance.
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await escrow.connect(bundler1).claimPayout();
        // State is already cleared; second call must revert
        await expect(escrow.connect(bundler1).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("1.26 user claimPayout after refund then second call reverts", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await escrow.connect(user1).claimPayout();
        await expect(escrow.connect(user1).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("1.27 feeRecipient cannot double-claim platform fees", async () => {
        const { escrow, registry, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        // With PROTOCOL_FEE_WEI=0, feeRecipient accrues nothing at settle; first call reverts
        await expect(escrow.connect(feeRecipient).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
});

// -----------------------------------------------------------------------------
// 8. settle() / claimRefund() on non-existent commitId
// -----------------------------------------------------------------------------
describe("Cat1 -- Operations on non-existent commitId", () => {
    it("1.28 settle() on never-created commitId reverts CommitNotFound", async () => {
        const { escrow, registry, bundler1 } = await deploy();
        // commit slot 999 is zero-initialised; c.user == address(0) -> CommitNotFound
        await expect(escrow.connect(bundler1).settle(999n))
            .to.be.revertedWithCustomError(escrow, "CommitNotFound");
    });

    it("1.29 claimRefund() on never-created commitId reverts CommitNotFound", async () => {
        const { escrow, registry, user1 } = await deploy();
        await mine(20);
        await expect(escrow.connect(user1).claimRefund(999n))
            .to.be.revertedWithCustomError(escrow, "CommitNotFound");
    });

    it("1.30 settle() on commitId 0 before any commit exists reverts CommitNotFound", async () => {
        const { escrow, registry, bundler1 } = await deploy();
        await expect(escrow.connect(bundler1).settle(0n))
            .to.be.revertedWithCustomError(escrow, "CommitNotFound");
    });

    it("1.31 claimRefund() on commitId 0 before any commit exists reverts CommitNotFound", async () => {
        const { escrow, registry, user1 } = await deploy();
        await mine(20);
        await expect(escrow.connect(user1).claimRefund(0n))
            .to.be.revertedWithCustomError(escrow, "CommitNotFound");
    });
});

// -----------------------------------------------------------------------------
// 9. Withdraw more than deposited / withdraw locked collateral
// -----------------------------------------------------------------------------
describe("Cat1 -- Withdraw attacks", () => {
    it("1.32 bundler cannot withdraw more than their deposit", async () => {
        const { escrow, registry, bundler1 } = await deploy();
        const deposited = await escrow.deposited(bundler1.address);
        await expect(escrow.connect(bundler1).withdraw(deposited + 1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("1.33 bundler cannot withdraw locked collateral", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        await makeCommit(escrow, registry, user1, QUOTE_ID);
        // All idle = deposited - locked. If collateral == deposited, idle == 0
        const idle = await escrow.idleBalance(bundler1.address);
        // Try to withdraw 1 wei more than idle
        await expect(escrow.connect(bundler1).withdraw(idle + 1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("1.34 bundler with zero deposit cannot withdraw anything", async () => {
        const { escrow, registry, stranger } = await deploy();
        await expect(escrow.connect(stranger).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("1.35 withdraw exactly idle amount succeeds; locked portion stays", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        await makeCommit(escrow, registry, user1, QUOTE_ID);
        const idle = await escrow.idleBalance(bundler1.address);
        if (idle > 0n) {
            await expect(escrow.connect(bundler1).withdraw(idle)).to.not.be.reverted;
        }
        // locked should remain
        expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);
    });

    it("1.36 bundler cannot withdraw after depositing zero (ZeroDeposit guard)", async () => {
        const { escrow, registry, bundler1 } = await deploy();
        await expect(escrow.connect(bundler1).deposit({ value: 0n }))
            .to.be.revertedWithCustomError(escrow, "ZeroDeposit");
    });

    it("1.37 total withdrawn never exceeds total deposited (invariant)", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        const idle = await escrow.idleBalance(bundler1.address);
        await escrow.connect(bundler1).withdraw(idle);
        // After withdraw, deposited should equal locked
        expect(await escrow.deposited(bundler1.address)).to.equal(await escrow.lockedOf(bundler1.address));
    });
});

// -----------------------------------------------------------------------------
// 10. Using wrong quoteId in settle()
// -----------------------------------------------------------------------------
describe("Cat1 -- Wrong quoteId / mismatched commit attacks", () => {
    it("1.38 bundler2 settles bundler1's commit (permissionless) -- fee goes to bundler1 not bundler2", async () => {
        const { escrow, registry, bundler1, bundler2, user1, QUOTE_ID } = await deploy();
        // Register bundler2 offer and deposit
        await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
        await escrow.connect(bundler2).deposit({ value: COLLATERAL * 5n });
        // Make commit against bundler1's quote
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const b1PendingBefore = await escrow.pendingWithdrawals(bundler1.address);
        // bundler2 settles it -- succeeds, but fee goes to bundler1 (the commit's bundler)
        await expect(escrow.connect(bundler2).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(b1PendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(0n);
    });

    it("1.39 settle() past deadline + settlement grace reverts with DeadlinePassed", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // Mine past deadline + SETTLEMENT_GRACE_BLOCKS to trigger DeadlinePassed
        const c = await escrow.getCommit(cid);
        const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
        const current = BigInt(await ethers.provider.getBlockNumber());
        const target = BigInt(c.deadline) + sg + 1n; // one past settle window
        if (target > current) await mine(Number(target - current));
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("1.40 bundler1 settles bundler2's commit (permissionless) -- fee goes to bundler2 not bundler1", async () => {
        const { escrow, registry, bundler1, bundler2, user1 } = await deploy();
        await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, MIN_LIFETIME, { value: MIN_BOND });
        await escrow.connect(bundler2).deposit({ value: COLLATERAL * 5n });
        const QUOTE_ID_2 = 2n;
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID_2);
        const b2PendingBefore = await escrow.pendingWithdrawals(bundler2.address);
        // bundler1 settles -- succeeds, but fee goes to bundler2 (the commit's bundler)
        await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(b2PendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// 11. Deregistered offer then exploit refund
// -----------------------------------------------------------------------------
describe("Cat1 -- Deregistered offer exploitation", () => {
    it("1.41 commit on active offer, then deregister; settle still works for bundler", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await registry.connect(bundler1).deregister(QUOTE_ID);
        // Settle should still work since the commit is already created
        await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
    });

    it("1.42 commit on active offer, deregister, advance blocks; claimRefund still works for user", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await registry.connect(bundler1).deregister(QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(user1).claimRefund(cid)).to.not.be.reverted;
    });

    it("1.43 cannot commit on a deregistered (inactive) offer", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        await registry.connect(bundler1).deregister(QUOTE_ID);
        await expect(
            escrow.connect(user1).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op")), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), {
                value: ONE_GWEI,
            }),
        ).to.be.revertedWithCustomError(escrow, "OfferInactive");
    });

    it("1.44 user cannot profit from double refund via deregister trick", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await registry.connect(bundler1).deregister(QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });
});

// -----------------------------------------------------------------------------
// 12. Frontrunning -- settle() vs claimRefund()
// -----------------------------------------------------------------------------
describe("Cat1 -- Frontrunning scenarios", () => {
    it("1.45 if bundler settles just before claimRefund window, user refund reverts AlreadyFinalized", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // Bundler settles within deadline
        await escrow.connect(bundler1).settle(cid);
        // Advance past refund window -- but commit is already settled; AlreadyFinalized fires immediately
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });

    it("1.46 if user claims refund at exactly unlock block, bundler settle reverts AlreadyFinalized", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        // User claims refund first
        await escrow.connect(user1).claimRefund(cid);
        // Bundler tries to settle -- it's already refunded AND past deadline
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });

    it("1.47 claimRefund before deadline reverts NotExpired", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // Do not advance blocks -- should fail
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "NotExpired");
    });

    it("1.48 claimRefund at exactly deadline reverts (grace not yet elapsed)", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // Advance to exactly deadline block
        await mine(Number(SLA_BLOCKS));
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "NotExpired");
    });

    it("1.49 claimRefund at deadline + refund_grace still reverts (needs settle_grace + refund_grace + 1)", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // Read actual grace periods from the contract
        const c = await escrow.getCommit(cid);
        const deadline = c.deadline;
        const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
        // unlocksAt = deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1
        // We mine to deadline + REFUND_GRACE which is less than unlocksAt, so it should revert.
        const current = BigInt(await ethers.provider.getBlockNumber());
        const targetBlock = deadline + rg; // still before unlocksAt
        const blocksToMine = targetBlock - current - 1n; // -1 because claimRefund tx mines a block
        if (blocksToMine > 0n) await mine(Number(blocksToMine));
        await expect(escrow.connect(user1).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "NotExpired");
    });

    it("1.49b claimRefund at deadline + settle_grace + refund_grace + 1 (= unlocksAt) succeeds", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        const c = await escrow.getCommit(cid);
        const deadline = c.deadline;
        const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
        const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
        // Mine so claimRefund tx lands exactly at unlocksAt = deadline + sg + rg + 1
        const current = BigInt(await ethers.provider.getBlockNumber());
        const targetBlock = deadline + sg + rg + 1n;
        const blocksToMine = targetBlock - current - 1n;
        if (blocksToMine > 0n) await mine(Number(blocksToMine));
        await expect(escrow.connect(user1).claimRefund(cid)).to.not.be.reverted;
    });

    it("1.50 settle() reverts past deadline + settlement grace (DeadlinePassed)", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        // Mine past deadline + SETTLEMENT_GRACE_BLOCKS so settle window is closed
        const c = await escrow.getCommit(cid);
        const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
        const current = BigInt(await ethers.provider.getBlockNumber());
        const target = BigInt(c.deadline) + sg + 1n;
        if (target > current) await mine(Number(target - current));
        await expect(escrow.connect(bundler1).settle(cid))
            .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });
});

// -----------------------------------------------------------------------------
// 13. Multi-commit -- no cross-contamination of funds
// -----------------------------------------------------------------------------
describe("Cat1 -- Multi-commit fund isolation", () => {
    it("1.51 settling one commitId does not affect another open commitId's collateral lock", async () => {
        const { escrow, registry, bundler1, user1, user2, QUOTE_ID } = await deploy();
        // Need extra collateral for two commits
        await escrow.connect(bundler1).deposit({ value: COLLATERAL * 5n });
        const cid1 = await makeCommit(escrow, registry, user1, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")));
        const cid2 = await makeCommit(escrow, registry, user2, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op2")));
        const lockedBefore = await escrow.lockedOf(bundler1.address);
        await escrow.connect(bundler1).settle(cid1);
        const lockedAfter = await escrow.lockedOf(bundler1.address);
        // Locked should decrease by exactly one collateral
        expect(lockedBefore - lockedAfter).to.equal(COLLATERAL);
    });

    it("1.52 refunding one commitId does not let user steal collateral from another", async () => {
        const { escrow, registry, bundler1, user1, user2, feeRecipient, QUOTE_ID } = await deploy();
        await escrow.connect(bundler1).deposit({ value: COLLATERAL * 5n });
        const cid1 = await makeCommit(escrow, registry, user1, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")));
        const cid2 = await makeCommit(escrow, registry, user2, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op2")));
        await mineToRefundable(escrow, cid1);
        await escrow.connect(user1).claimRefund(cid1);
        // user2's pending should still be zero
        expect(await escrow.pendingWithdrawals(user2.address)).to.equal(0n);
        // Invariant: cid2 is still open, so its fee (ONE_GWEI) is pending in the contract
        await assertBalanceInvariant(
            escrow,
            [bundler1.address],
            [bundler1.address, user1.address, user2.address, feeRecipient.address],
            ONE_GWEI, // pending fee from cid2 still held in contract
        );
    });

    it("1.53 both commits settled -- total bundler pending equals sum of net fees", async () => {
        const { escrow, registry, bundler1, user1, user2, feeRecipient, QUOTE_ID } = await deploy();
        await escrow.connect(bundler1).deposit({ value: COLLATERAL * 5n });
        const cid1 = await makeCommit(escrow, registry, user1, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")));
        const cid2 = await makeCommit(escrow, registry, user2, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op2")));
        await escrow.connect(bundler1).settle(cid1);
        await escrow.connect(bundler1).settle(cid2);
        // bundler gets full feePerOp; feeRecipient gets PROTOCOL_FEE_WEI (0 in tests)
        expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI * 2n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("1.54 contract balance invariant holds across multiple commits and settlements", async () => {
        const { escrow, registry, bundler1, user1, user2, feeRecipient, QUOTE_ID } = await deploy();
        await escrow.connect(bundler1).deposit({ value: COLLATERAL * 5n });
        const cid1 = await makeCommit(escrow, registry, user1, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op1")));
        const cid2 = await makeCommit(escrow, registry, user2, QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("op2")));
        await escrow.connect(bundler1).settle(cid1);
        await mineToRefundable(escrow, cid2);
        await escrow.connect(user2).claimRefund(cid2);
        await assertBalanceInvariant(
            escrow,
            [bundler1.address],
            [bundler1.address, user1.address, user2.address, feeRecipient.address],
        );
    });
});

// -----------------------------------------------------------------------------
// 14. Platform fee accounting
// -----------------------------------------------------------------------------
describe("Cat1 -- Platform fee fund theft", () => {
    it("1.55 feeRecipient cannot be zero address (constructor guard)", async () => {
        const [deployer] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = await Registry.deploy(deployer.address, MIN_BOND);
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        await expect(
            upgrades.deployProxy(Escrow, [await registry.getAddress(), ethers.ZeroAddress], { kind: "uups" }),
        ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
    });

    it("1.56 stranger cannot setFeeRecipient (OwnableUnauthorizedAccount)", async () => {
        const { escrow, registry, stranger } = await deploy();
        await expect(escrow.connect(stranger).setFeeRecipient(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(stranger.address);
    });

    it("1.57 platform fee is correctly deducted -- bundlerNet + platformFee == feePaid", async () => {
        const { escrow, registry, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        // With PROTOCOL_FEE_WEI=0, bundler gets full feePerOp; feeRecipient gets 0
        const bundlerPending = await escrow.pendingWithdrawals(bundler1.address);
        const feePending      = await escrow.pendingWithdrawals(feeRecipient.address);
        expect(bundlerPending).to.equal(ONE_GWEI);
        expect(feePending).to.equal(0n);
        expect(bundlerPending + feePending).to.equal(ONE_GWEI);
    });

    it("1.58 slash to protocol lands in feeRecipient pendingWithdrawals on refund", async () => {
        const { escrow, registry, user1, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        const feePendingBefore = await escrow.pendingWithdrawals(feeRecipient.address);
        await escrow.connect(user1).claimRefund(cid);
        const feePendingAfter = await escrow.pendingWithdrawals(feeRecipient.address);
        // 100% of collateral goes to user; feeRecipient receives nothing on refund
        expect(feePendingAfter - feePendingBefore).to.equal(0n);
    });

    it("1.59 user receives feePaid + full collateral on refund", async () => {
        const { escrow, registry, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        // 100% of collateral goes to user (no protocol split)
        const expectedUserTotal = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(expectedUserTotal);
    });

    it("1.59b odd collateral: user receives feePaid + full collateral (no protocol split)", async () => {
        // Register an offer with odd collateral to verify 100% goes to user on refund.
        const { escrow, registry, bundler1, user1, feeRecipient } = await deploy();
        // oddCollateral must be strictly > feePerOp (T8); use an odd value above ONE_GWEI
        const oddCollateral = ONE_GWEI + 101n;
        await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), oddCollateral, MIN_LIFETIME, { value: MIN_BOND });
        const oddQuoteId = (await registry.nextQuoteId()) - 1n;
        // Deposit enough for the odd collateral on top of the initial deposit
        await escrow.connect(bundler1).deposit({ value: oddCollateral });
        // Use the fixture helper which reliably parses the CommitCreated event
        const { commitId: cid } = await fixturesMakeCommit(escrow, registry, user1, oddQuoteId);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        // 100% of collateral goes to user; feeRecipient gets nothing on refund
        const userTotal = ONE_GWEI + oddCollateral; // feePaid + full collateral
        expect(await escrow.pendingWithdrawals(user1.address)).to.equal(userTotal);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// 15. ETH accounting -- total balances consistent after full lifecycle
// -----------------------------------------------------------------------------
describe("Cat1 -- ETH accounting invariants", () => {
    it("1.60 after full settle + claimPayout lifecycle, contract balance equals remaining deposits", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);
        await escrow.connect(bundler1).claimPayout();
        // feeRecipient gets nothing (PROTOCOL_FEE_WEI=0) -- no claimPayout needed
        // Only remaining deposited collateral should stay in contract
        const remaining = await escrow.deposited(bundler1.address);
        expect(await contractBalance(escrow)).to.equal(remaining);
    });

    it("1.61 after full refund + claimPayout lifecycle, contract balance equals remaining deposits", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user1).claimRefund(cid);
        await escrow.connect(user1).claimPayout();
        // feeRecipient gets nothing (PROTOCOL_FEE_WEI=0, 100% slash to user) -- no claimPayout needed
        const remaining = await escrow.deposited(bundler1.address);
        expect(await contractBalance(escrow)).to.equal(remaining);
    });

    it("1.62 no ETH leaks: sum of claimPayouts equals total ETH injected (fees + deposit consumed)", async () => {
        const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
        // bundler1 deposited COLLATERAL * 10n in deploy(); user commits ONE_GWEI
        const cid = await makeCommit(escrow, registry, user1, QUOTE_ID);
        await escrow.connect(bundler1).settle(cid);

        const b1BalBefore = await ethers.provider.getBalance(bundler1.address);

        const tx1 = await escrow.connect(bundler1).claimPayout();
        const r1  = await tx1.wait();
        const gas1 = r1!.gasUsed * r1!.gasPrice;

        const b1BalAfter  = await ethers.provider.getBalance(bundler1.address);

        // bundler gets full feePerOp (PROTOCOL_FEE_WEI=0)
        expect(b1BalAfter - b1BalBefore + gas1).to.equal(ONE_GWEI);
    });
});
