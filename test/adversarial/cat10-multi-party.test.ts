// Category 10: Multi-party / role confusion -- adversarial test suite

import { expect }                   from "chai";
import { ethers, upgrades }           from "hardhat";
import { mine }                      from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    makeCommit as fixturesMakeCommit,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const ONE_ETH      = ethers.parseEther("1");
const SLA_BLOCKS   = 2n;

async function deploy() {
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

    // bundler1 registers offer
    await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID = 1n;

    // bundler1 deposits collateral so commits can be made
    await escrow.connect(bundler1).deposit({ value: ONE_ETH });

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
    };
}

async function passDeadline(escrow: SLAEscrow, slaBlocks = SLA_BLOCKS) {
    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    await mine(Number(slaBlocks + sg + rg + 2n));
}

// Helper: create a commit and return commitId
async function makeCommit(
    escrow: SLAEscrow,
    user: Awaited<ReturnType<typeof ethers.getSigner>>,
    quoteId = 1n,
    tag?: string,
) {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, tag ?? `op-${Date.now()}-${Math.random()}`);
    return commitId;
}

// -----------------------------------------------------------------------------
describe("Cat-10: Multi-party / role confusion", () => {

    // -------------------------------------------------------------------------
    describe("settle() -- wrong caller", () => {

        it("bundler can call claimRefund after expiry -- ETH goes to user (T12)", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            const pendingBefore = await escrow.pendingWithdrawals(user1.address);
            await escrow.connect(bundler1).claimRefund(cid);
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
        });

        it("user calls settle -- succeeds (permissionless), fee goes to bundler1", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await expect(escrow.connect(user1).settle(cid)).to.not.be.reverted;
            // fee routes to the commit's bundler, not the caller
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(0n);
        });

        it("stranger calls settle -- succeeds (permissionless), fee goes to bundler1", async () => {
            const { escrow, bundler1, user1, stranger, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await expect(escrow.connect(stranger).settle(cid)).to.not.be.reverted;
            // fee routes to the commit's bundler, not the caller
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        });

        it("stranger calls claimRefund -- reverts Unauthorized (T12)", async () => {
            const { escrow, user1, stranger, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            await expect(escrow.connect(stranger).claimRefund(cid))
                .to.be.revertedWithCustomError(escrow, "Unauthorized")
                .withArgs(cid, stranger.address);
        });

        it("feeRecipient calls settle -- succeeds (permissionless), fee goes to bundler1", async () => {
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await expect(escrow.connect(feeRecipient).settle(cid)).to.not.be.reverted;
            // fee routes to the commit's bundler, not the caller
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("feeRecipient (PROTOCOL) calls claimRefund -- succeeds (T12/A9 cleanup role)", async () => {
            const { escrow, user1, feeRecipient, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            // feeRecipient == PROTOCOL is explicitly allowed as a cleanup caller
            await expect(escrow.connect(feeRecipient).claimRefund(cid)).to.not.be.reverted;
        });

        it("OWNER calls settle for someone else's commit -- succeeds (permissionless)", async () => {
            const { escrow, bundler1, user1, owner, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
            // fee routes to the commit's bundler, not the owner
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
        });

        it("bundler2 calls settle on bundler1's commit -- succeeds, fee goes to bundler1 not bundler2", async () => {
            const { escrow, bundler1, bundler2, user1, QUOTE_ID } = await deploy();
            // bundler2 deposits but commits belong to bundler1's offer
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await expect(escrow.connect(bundler2).settle(cid)).to.not.be.reverted;
            // fee routes to the commit's bundler (bundler1), not the caller (bundler2)
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(0n);
        });

        it("user2 calls claimRefund on user1's commit -- reverts Unauthorized (T12)", async () => {
            const { escrow, user1, user2, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            await expect(escrow.connect(user2).claimRefund(cid))
                .to.be.revertedWithCustomError(escrow, "Unauthorized")
                .withArgs(cid, user2.address);
        });

        it("user commits to bundler1's offer, bundler2 settles -- succeeds, fee goes to bundler1", async () => {
            const { escrow, bundler1, bundler2, user1, QUOTE_ID } = await deploy();
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await expect(escrow.connect(bundler2).settle(cid)).to.not.be.reverted;
            // fee routes to the commit's bundler (bundler1), not the caller (bundler2)
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(0n);
        });

        it("cross-commit contamination: settle routes fee to commit's bundler regardless of caller", async () => {
            const { escrow, registry, bundler1, bundler2, user1, user2, QUOTE_ID } = await deploy();
            // bundler2 registers offer #2
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const QUOTE_ID_2 = 2n;

            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);   // bundler1's commit
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID_2); // bundler2's commit

            // bundler1 settles cid1 (bundler2's commit) -- succeeds, fee goes to bundler2
            await expect(escrow.connect(bundler1).settle(cid1)).to.not.be.reverted;
            expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);

            // bundler2 settles cid0 (bundler1's commit) -- succeeds, fee goes to bundler1
            await expect(escrow.connect(bundler2).settle(cid0)).to.not.be.reverted;
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            // bundler2's balance is still only ONE_GWEI (from cid1), not doubled
            expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(ONE_GWEI);
        });

    });

    // -------------------------------------------------------------------------
    describe("setFeeRecipient() -- access control", () => {

        it("non-owner calls setFeeRecipient (OwnableUnauthorizedAccount)", async () => {
            const { escrow, stranger } = await deploy();
            await expect(escrow.connect(stranger).setFeeRecipient(stranger.address))
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
                .withArgs(stranger.address);
        });

        it("bundler calls setFeeRecipient (OwnableUnauthorizedAccount)", async () => {
            const { escrow, bundler1, stranger } = await deploy();
            await expect(escrow.connect(bundler1).setFeeRecipient(stranger.address))
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("user calls setFeeRecipient (OwnableUnauthorizedAccount)", async () => {
            const { escrow, user1, stranger } = await deploy();
            await expect(escrow.connect(user1).setFeeRecipient(stranger.address))
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("feeRecipient calls setFeeRecipient (OwnableUnauthorizedAccount)", async () => {
            const { escrow, feeRecipient, stranger } = await deploy();
            await expect(escrow.connect(feeRecipient).setFeeRecipient(stranger.address))
                .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("OWNER calls setFeeRecipient (succeeds)", async () => {
            const { escrow, owner, stranger } = await deploy();
            await expect(escrow.connect(owner).setFeeRecipient(stranger.address))
                .to.emit(escrow, "FeeRecipientUpdated")
                .withArgs(await escrow.feeRecipient(), stranger.address);
            expect(await escrow.feeRecipient()).to.equal(stranger.address);
        });

        it("setFeeRecipient to zero address reverts ZeroAddress", async () => {
            const { escrow, owner } = await deploy();
            await expect(escrow.connect(owner).setFeeRecipient(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(escrow, "ZeroAddress");
        });

        it("owner is set to deployer", async () => {
            const { escrow, owner, bundler1 } = await deploy();
            expect(await escrow.owner()).to.equal(owner.address);
            expect(await escrow.owner()).to.not.equal(bundler1.address);
        });

        it("multiple owner candidates: only deployer qualifies", async () => {
            const { escrow, owner, bundler1, bundler2, user1, user2 } = await deploy();
            for (const nonOwner of [bundler1, bundler2, user1, user2]) {
                await expect(escrow.connect(nonOwner).setFeeRecipient(nonOwner.address))
                    .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
            }
            // owner succeeds
            await expect(escrow.connect(owner).setFeeRecipient(owner.address)).to.not.be.reverted;
        });

    });

    // -------------------------------------------------------------------------
    describe("feeRecipient update -- settlement routing", () => {

        it("OWNER updates feeRecipient: future settles use new recipient", async () => {
            const { escrow, owner, bundler1, user1, stranger, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            // Change feeRecipient to stranger before settle
            await escrow.connect(owner).setFeeRecipient(stranger.address);
            await escrow.connect(bundler1).settle(cid);
            // PROTOCOL_FEE_WEI=0: no platform fee is routed to feeRecipient
            expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        });

        it("OWNER updates feeRecipient: old recipient's pendingWithdrawals unaffected", async () => {
            const { escrow, owner, bundler1, user1, user2, stranger, feeRecipient, QUOTE_ID } =
                await deploy();
            // Settle once before changing recipient
            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid0);
            const feeAfterFirst = await escrow.pendingWithdrawals(feeRecipient.address);

            // Change recipient
            await escrow.connect(owner).setFeeRecipient(stranger.address);

            // Settle again -- new fees go to stranger
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid1);

            // Old feeRecipient balance unchanged
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(feeAfterFirst);
            // New feeRecipient gets 0 -- PROTOCOL_FEE_WEI=0, no platform fee
            expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        });

        it("feeRecipient changed mid-session: commit from before change settles to new recipient", async () => {
            // The commit records no feeRecipient at commit time; settle reads current feeRecipient
            const { escrow, owner, bundler1, user1, stranger, feeRecipient, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            // Change feeRecipient AFTER commit but BEFORE settle
            await escrow.connect(owner).setFeeRecipient(stranger.address);
            await escrow.connect(bundler1).settle(cid);
            // Old feeRecipient gets nothing
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
            // New feeRecipient gets 0 -- PROTOCOL_FEE_WEI=0, no platform fee
            expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        });

        it("setFeeRecipient to bundler address: bundler accumulates full service fee (no platform split)", async () => {
            const { escrow, owner, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(owner).setFeeRecipient(bundler1.address);
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            // PROTOCOL_FEE_WEI=0: bundler gets full ONE_GWEI (no platform fee split)
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
        });

        it("setFeeRecipient to user address: user accumulates 0 platform fee (PROTOCOL_FEE_WEI=0)", async () => {
            const { escrow, owner, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(owner).setFeeRecipient(user1.address);
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            // PROTOCOL_FEE_WEI=0: no platform fee; user1 gets 0 as feeRecipient
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(0n);
        });

    });

    // -------------------------------------------------------------------------
    describe("Correct payout routing after settle", () => {

        it("user commits to bundler1's offer, bundler1 settles: payout to bundler1 not bundler2", async () => {
            const { escrow, registry, bundler1, bundler2, user1, QUOTE_ID } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });

            const cid = await makeCommit(escrow, user1, QUOTE_ID); // bundler1's offer
            await escrow.connect(bundler1).settle(cid);

            // PROTOCOL_FEE_WEI=0: bundler gets full ONE_GWEI
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(0n);
        });

        it("pendingWithdrawals isolation: bundler1 claiming doesn't affect bundler2's pending", async () => {
            const { escrow, registry, bundler1, bundler2, user1, user2, QUOTE_ID } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const QUOTE_ID_2 = 2n;

            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID_2);

            await escrow.connect(bundler1).settle(cid0);
            await escrow.connect(bundler2).settle(cid1);

            // PROTOCOL_FEE_WEI=0: each bundler gets full ONE_GWEI
            const b2Before = await escrow.pendingWithdrawals(bundler2.address);
            await escrow.connect(bundler1).claimPayout();
            const b2After = await escrow.pendingWithdrawals(bundler2.address);

            expect(b2After).to.equal(b2Before);
            expect(b2After).to.equal(ONE_GWEI);
        });

    });

    // -------------------------------------------------------------------------
    describe("Bundler self-commit (bundler == user) -- FORBIDDEN", () => {

        it("bundler self-commits: commit reverts SelfCommitForbidden (T8)", async () => {
            const { escrow, bundler1, QUOTE_ID } = await deploy();
            // bundler1 is both bundler and user -> commit must revert
            await expect(
                escrow.connect(bundler1).commit(
                    QUOTE_ID, ethers.hexlify(ethers.randomBytes(32)),
                    bundler1.address, COLLATERAL, Number(SLA_BLOCKS),
                    { value: ONE_GWEI },
                ),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
             .withArgs(bundler1.address);
        });

        it("bundler self-commits: refund path blocked (commit reverts first)", async () => {
            const { escrow, bundler1, QUOTE_ID } = await deploy();
            // commit must revert -- cannot even reach refund path
            await expect(
                escrow.connect(bundler1).commit(
                    QUOTE_ID, ethers.hexlify(ethers.randomBytes(32)),
                    bundler1.address, COLLATERAL, Number(SLA_BLOCKS),
                    { value: ONE_GWEI },
                ),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
        });

        it("bundler self-commits: no pendingWithdrawals accumulate (commit never succeeds)", async () => {
            const { escrow, bundler1, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(bundler1).commit(
                    QUOTE_ID, ethers.hexlify(ethers.randomBytes(32)),
                    bundler1.address, COLLATERAL, Number(SLA_BLOCKS),
                    { value: ONE_GWEI },
                ),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
            // No pending withdrawals should have accumulated
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
        });

    });

    // -------------------------------------------------------------------------
    describe("bundler == feeRecipient", () => {

        it("bundler = feeRecipient: settle queues fee to self, claimPayout works", async () => {
            const { escrow, owner, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(owner).setFeeRecipient(bundler1.address);
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            const total = await escrow.pendingWithdrawals(bundler1.address);
            expect(total).to.equal(ONE_GWEI); // full fee -- PROTOCOL_FEE_WEI=0, no split
            await expect(escrow.connect(bundler1).claimPayout()).to.not.be.reverted;
        });

    });

    // -------------------------------------------------------------------------
    describe("user == feeRecipient", () => {

        it("user = feeRecipient: claimRefund accumulates correctly (100% slash to client)", async () => {
            const { escrow, owner, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(owner).setFeeRecipient(user1.address);
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            await escrow.connect(user1).claimRefund(cid);

            // 100% slash goes to client; PROTOCOL_FEE_WEI=0 so slashToProtocol=0
            // user1 gets feePaid + full collateral
            const userTotal = ONE_GWEI + COLLATERAL;
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(userTotal);
        });

    });

    // -------------------------------------------------------------------------
    describe("bundler == owner", () => {

        it("bundler = owner: setFeeRecipient still works", async () => {
            const signers = await ethers.getSigners();
            const [owner] = signers;
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const feeRecipient = signers[5];
            const stranger     = signers[6];
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" }
            )) as unknown as SLAEscrow;
            // owner is also bundler
            await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await expect(escrow.connect(owner).setFeeRecipient(stranger.address)).to.not.be.reverted;
            expect(await escrow.feeRecipient()).to.equal(stranger.address);
        });

    });

    // -------------------------------------------------------------------------
    describe("Multi-bundler state isolation", () => {

        it("multiple bundlers, multiple users: state isolation verified", async () => {
            const { escrow, registry, bundler1, bundler2, user1, user2, QUOTE_ID } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const QUOTE_ID_2 = 2n;

            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID_2);

            // Verify each commit references the correct bundler
            const c0 = await escrow.getCommit(cid0);
            const c1 = await escrow.getCommit(cid1);
            expect(c0.bundler).to.equal(bundler1.address);
            expect(c1.bundler).to.equal(bundler2.address);

            // Settle only commit 0
            await escrow.connect(bundler1).settle(cid0);

            // commit 1 is still open
            const c1After = await escrow.getCommit(cid1);
            expect(c1After.settled).to.be.false;
        });

        it("bundler1 deregisters offer, bundler2's offer unaffected", async () => {
            const { escrow, registry, bundler1, bundler2, user2, QUOTE_ID } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const QUOTE_ID_2 = 2n;

            await registry.connect(bundler1).deregister(QUOTE_ID);
            expect(await registry.isActive(QUOTE_ID_2)).to.be.true;

            // Can still commit to bundler2's offer
            await expect(
                escrow.connect(user2).commit(QUOTE_ID_2, ethers.hexlify(ethers.randomBytes(32)), bundler2.address, COLLATERAL, Number(SLA_BLOCKS), {
                    value: ONE_GWEI,
                }),
            ).to.not.be.reverted;
        });

        it("bundler registers offer with same params as another: separate quoteIds", async () => {
            const { registry, bundler1, bundler2 } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const offer1 = await registry.getOffer(1n);
            const offer2 = await registry.getOffer(2n);
            expect(offer1.quoteId).to.not.equal(offer2.quoteId);
            expect(offer1.bundler).to.equal(bundler1.address);
            expect(offer2.bundler).to.equal(bundler2.address);
        });

    });

    // -------------------------------------------------------------------------
    describe("deposit() by non-bundler / role bootstrap", () => {

        it("deposit() by non-bundler: they become a bundler for that deposit amount", async () => {
            const { escrow, stranger } = await deploy();
            await escrow.connect(stranger).deposit({ value: ONE_ETH });
            expect(await escrow.deposited(stranger.address)).to.equal(ONE_ETH);
        });

        it("non-bundler can register an offer and then receive commits", async () => {
            const { escrow, registry, user1, stranger } = await deploy();
            await registry.connect(stranger).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(stranger).deposit({ value: ONE_ETH });
            const QUOTE_ID_S = 2n;
            const cid = await makeCommit(escrow, user1, QUOTE_ID_S);
            const c = await escrow.getCommit(cid);
            expect(c.bundler).to.equal(stranger.address);
        });

    });

    // -------------------------------------------------------------------------
    describe("Commit to offer where bundler == user -- FORBIDDEN", () => {

        it("commit to own offer (bundler == user) reverts SelfCommitForbidden", async () => {
            const { escrow, bundler1, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(bundler1).commit(QUOTE_ID, ethers.hexlify(ethers.randomBytes(32)), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), {
                    value: ONE_GWEI,
                }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
             .withArgs(bundler1.address);
        });

    });

    // -------------------------------------------------------------------------
    describe("AlreadyFinalized guard -- role confusion re-entry", () => {

        it("bundler cannot settle twice: AlreadyFinalized", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await expect(escrow.connect(bundler1).settle(cid))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("user cannot claimRefund after bundler settled: AlreadyFinalized", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await passDeadline(escrow);
            await expect(escrow.connect(user1).claimRefund(cid))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("bundler cannot settle after user claimed refund: AlreadyFinalized", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            await escrow.connect(user1).claimRefund(cid);
            await expect(escrow.connect(bundler1).settle(cid))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("user cannot claimRefund twice: AlreadyFinalized", async () => {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await passDeadline(escrow);
            await escrow.connect(user1).claimRefund(cid);
            await expect(escrow.connect(user1).claimRefund(cid))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

    });

    // -------------------------------------------------------------------------
    describe("pendingWithdrawals -- NothingToClaim guard", () => {

        it("stranger with no pending balance cannot claimPayout (NothingToClaim)", async () => {
            const { escrow, stranger } = await deploy();
            await expect(escrow.connect(stranger).claimPayout())
                .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("bundler with no settled commits cannot claimPayout (NothingToClaim)", async () => {
            const { escrow, bundler1 } = await deploy();
            await expect(escrow.connect(bundler1).claimPayout())
                .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("user with no refunded commits cannot claimPayout (NothingToClaim)", async () => {
            const { escrow, user1 } = await deploy();
            await expect(escrow.connect(user1).claimPayout())
                .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("claimPayout zeroes balance: second call reverts NothingToClaim", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await escrow.connect(bundler1).claimPayout();
            await expect(escrow.connect(bundler1).claimPayout())
                .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

    });

    // -------------------------------------------------------------------------
    describe("DeadlinePassed guard -- settle after deadline", () => {

        it("bundler cannot settle after deadline passes: DeadlinePassed", async () => {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            // push past deadline + SETTLEMENT_GRACE_BLOCKS
            await mine(Number(SLA_BLOCKS) + Number(await escrow.SETTLEMENT_GRACE_BLOCKS()) + 1);
            await expect(escrow.connect(bundler1).settle(cid))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

    });

    // -------------------------------------------------------------------------
    describe("NotExpired guard -- claimRefund before deadline", () => {

        it("user cannot claimRefund before deadline + grace: NotExpired", async () => {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            // deadline not passed yet
            await expect(escrow.connect(user1).claimRefund(cid))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("user cannot claimRefund exactly at deadline: NotExpired", async () => {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await makeCommit(escrow, user1, QUOTE_ID);
            await mine(Number(SLA_BLOCKS)); // at deadline, not past grace
            await expect(escrow.connect(user1).claimRefund(cid))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

    });

    // -------------------------------------------------------------------------
    describe("Multi-commit sequential settle -- role confusion across commits", () => {

        it("bundler settles their own two commits independently", async () => {
            const { escrow, bundler1, user1, user2, QUOTE_ID } = await deploy();
            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid0);
            await escrow.connect(bundler1).settle(cid1);
            // PROTOCOL_FEE_WEI=0: bundler gets full ONE_GWEI per settle
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI * 2n);
        });

        it("user1 cannot claimRefund for user2's commit even after deadline -- reverts Unauthorized", async () => {
            const { escrow, user1, user2, QUOTE_ID } = await deploy();
            await makeCommit(escrow, user1, QUOTE_ID);
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID);
            await passDeadline(escrow);
            await expect(escrow.connect(user1).claimRefund(cid1))
                .to.be.revertedWithCustomError(escrow, "Unauthorized");
        });

        it("settle commitId=0 does not mark commitId=1 as settled", async () => {
            const { escrow, bundler1, user1, user2, QUOTE_ID } = await deploy();
            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid0);
            const c1 = await escrow.getCommit(cid1);
            expect(c1.settled).to.be.false;
        });

        it("claimRefund for cid0 does not refund cid1", async () => {
            const { escrow, user1, user2, QUOTE_ID } = await deploy();
            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            const cid1 = await makeCommit(escrow, user2, QUOTE_ID);
            await passDeadline(escrow);
            await escrow.connect(user1).claimRefund(cid0);
            const c1 = await escrow.getCommit(cid1);
            expect(c1.refunded).to.be.false;
        });

    });

    // -------------------------------------------------------------------------
    describe("Locked collateral isolation across bundlers", () => {

        it("bundler2 collateral unaffected by bundler1 settle", async () => {
            const { escrow, registry, bundler1, bundler2, user1, user2, QUOTE_ID } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const QUOTE_ID_2 = 2n;

            const cid0 = await makeCommit(escrow, user1, QUOTE_ID);
            await makeCommit(escrow, user2, QUOTE_ID_2);

            const locked2Before = await escrow.lockedOf(bundler2.address);
            await escrow.connect(bundler1).settle(cid0);
            const locked2After = await escrow.lockedOf(bundler2.address);

            expect(locked2After).to.equal(locked2Before);
        });

        it("bundler1's deposited balance unaffected by bundler2 claimRefund slash", async () => {
            const { escrow, registry, bundler1, bundler2, user2, QUOTE_ID } = await deploy();
            await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const QUOTE_ID_2 = 2n;

            const dep1Before = await escrow.deposited(bundler1.address);
            const cid = await makeCommit(escrow, user2, QUOTE_ID_2);
            await passDeadline(escrow);
            await escrow.connect(user2).claimRefund(cid);
            const dep1After = await escrow.deposited(bundler1.address);

            expect(dep1After).to.equal(dep1Before);
        });

    });

});
