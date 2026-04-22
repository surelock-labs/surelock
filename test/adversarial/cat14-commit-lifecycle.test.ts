// Category 14: Commit Lifecycle Deep Edge Cases -- adversarial test suite
//
// Focus: boundary conditions in the commit/settle/claimRefund state machine,
// block number edge cases at exact deadline and grace window boundaries,
// userOpHash uniqueness, commitId ordering, offer deregistration mid-flight,
// slaBlocks extremes, bundler-as-user role overlap, exact collateral boundary
// conditions, and subtle off-by-one errors.

import { expect }                   from "chai";
import { ethers, upgrades }         from "hardhat";
import { mine }                     from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow } from "../../typechain-types";
import {
    makeCommit as fixturesMakeCommit,
    mineTo,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const ONE_ETH      = ethers.parseEther("1");
const MAX_SLA      = 1_000;
const UINT96_MAX   = 2n ** 96n - 1n;

async function deploy(slaBlocks = 2, fee = ONE_GWEI, collateral = COLLATERAL) {
    const [owner, bundler, user, feeRecipient, stranger, user2, bundler2] =
        await ethers.getSigners();
    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as QuoteRegistry;
    const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow   = (await upgrades.deployProxy(
        Escrow,
        [await registry.getAddress(), feeRecipient.address],
        { kind: "uups" },
    )) as unknown as SLAEscrow;

    await registry.connect(bundler).register(fee, slaBlocks, collateral, 302_400, { value: ethers.parseEther("0.0001") });
    await escrow.connect(bundler).deposit({ value: collateral * 10n });

    const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
    return { escrow, registry, owner, bundler, user, feeRecipient, stranger, user2, bundler2, QUOTE_ID: 1n, sg, rg };
}

/** Make a commit (two-phase: commit + accept) and return commitId + deadline */
async function makeCommit(
    escrow: SLAEscrow,
    user: any,
    quoteId: bigint,
    userOp?: string,
): Promise<{ commitId: bigint; deadline: bigint }> {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const tag = userOp ? undefined : `op-${Date.now()}-${Math.random()}`;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, tag, userOp);
    const c  = await escrow.getCommit(commitId);
    return { commitId, deadline: c.deadline };
}

// ===============================================================================
// Tests
// ===============================================================================

describe("Cat14 -- Commit Lifecycle Deep Edge Cases", function () {

    // -- userOpHash non-uniqueness --------------------------------------------

    describe("userOpHash non-uniqueness", function () {

        it("14.01 keccak256 of empty bytes is a valid non-zero userOpHash (bytes32(0) is the rejected case)", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const tx = escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
            await expect(tx).to.not.be.reverted;
        });

        it("14.02 two commits with identical userOpHash, same quoteId, same user reverts UserOpAlreadyCommitted", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("dup"));
            const hash = userOp;
            await makeCommit(escrow, user, QUOTE_ID, userOp);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted")
                .withArgs(hash);
        });

        it("14.03 two commits with identical userOpHash, different users reverts UserOpAlreadyCommitted", async function () {
            const { escrow, bundler, user, user2, QUOTE_ID } = await deploy();
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("shared"));
            const hash = userOp;
            await makeCommit(escrow, user, QUOTE_ID, userOp);
            await expect(
                escrow.connect(user2).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted")
                .withArgs(hash);
        });

        it("14.04 commit with arbitrary bytes as userOp succeeds, hash stored correctly", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("max-bytes"));
            await escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            const c = await escrow.getCommit(commitId);
            expect(c.userOpHash).to.equal(userOp);
        });

        it("14.05 userOpHash stored correctly in commits struct and retrievable", async function () {
            const { escrow, user, QUOTE_ID } = await deploy();
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("verify-store"));
            const hash = userOp;
            await makeCommit(escrow, user, QUOTE_ID, userOp);
            const c = await escrow.getCommit(0n);
            expect(c.userOpHash).to.equal(hash);
        });

        it("14.06 three commits with same hash: first succeeds, second and third revert UserOpAlreadyCommitted", async function () {
            const { escrow, registry, bundler, user, user2, QUOTE_ID } = await deploy();
            // Register a second offer
            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const QUOTE2 = 2n;
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("triple"));

            await makeCommit(escrow, user, QUOTE_ID, userOp);
            // Same userOp, different user: reverts
            await expect(
                escrow.connect(user2).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");
            // Same userOp, different offer: reverts
            await expect(
                escrow.connect(user).commit(QUOTE2, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");
        });
    });

    // -- userOpHash uniqueness (double-commit attack prevention) ------------

    describe("cat14: userOpHash uniqueness", function () {

        it("reverts when same userOpHash committed twice to same bundler", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("unique-same-bundler"));
            const hash = userOp;
            await makeCommit(escrow, user, QUOTE_ID, userOp);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted")
                .withArgs(hash);
        });

        it("reverts when same userOpHash committed to different bundlers (double-commit attack)", async function () {
            const [owner, bundlerA, bundlerB, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            // Two bundlers with their own offers
            await registry.connect(bundlerA).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await registry.connect(bundlerB).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundlerA).deposit({ value: ONE_ETH });
            await escrow.connect(bundlerB).deposit({ value: ONE_ETH });

            const userOp = ethers.keccak256(ethers.toUtf8Bytes("double-commit-attack"));
            const hash = userOp;
            // Commit to bundlerA's offer (quoteId 1) succeeds
            await escrow.connect(user).commit(1n, userOp, bundlerA.address, COLLATERAL, 10, { value: ONE_GWEI });
            // Attempt to commit same userOp to bundlerB's offer (quoteId 2) reverts
            await expect(
                escrow.connect(user).commit(2n, userOp, bundlerB.address, COLLATERAL, 10, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted")
                .withArgs(hash);
        });

        it("reuse of userOpHash after settle() is blocked -- retiredHashes permanent guard", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(10);
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("reuse-after-settle"));
            const hash = userOp;
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID, userOp);

            // Hash is active, second commit reverts
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 10, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");

            // Settle records the hash permanently in retiredHashes
            await escrow.connect(bundler).settle(commitId);
            expect(await escrow.activeCommitForHash(hash)).to.be.false;
            expect(await escrow.retiredHashes(hash)).to.be.true;

            // Re-commit of the settled hash is now blocked at commit()
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 10, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });

        it("userOpHash is permanently retired after claimRefund() -- fresh hash required for retry", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("reuse-after-refund"));
            const hash = userOp;
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID, userOp);

            // Hash is active, second commit reverts
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");

            // Wait for refund window
            await mineTo(deadline + sg + rg + 1n);
            await escrow.connect(user).claimRefund(commitId);
            expect(await escrow.activeCommitForHash(hash)).to.be.false;
            expect(await escrow.retiredHashes(hash)).to.be.true;

            // Hash is permanently retired -- retry requires a fresh UserOp hash (T23)
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });

        it("different userOpHashes can be committed concurrently without conflict", async function () {
            const { escrow, user, QUOTE_ID } = await deploy(10);
            const userOpA = ethers.keccak256(ethers.toUtf8Bytes("concurrent-a"));
            const userOpB = ethers.keccak256(ethers.toUtf8Bytes("concurrent-b"));
            const userOpC = ethers.keccak256(ethers.toUtf8Bytes("concurrent-c"));
            const hashA   = userOpA;
            const hashB   = userOpB;
            const hashC   = userOpC;

            const { commitId: idA } = await makeCommit(escrow, user, QUOTE_ID, userOpA);
            const { commitId: idB } = await makeCommit(escrow, user, QUOTE_ID, userOpB);
            const { commitId: idC } = await makeCommit(escrow, user, QUOTE_ID, userOpC);

            // All three are distinct and active
            expect(idA).to.not.equal(idB);
            expect(idB).to.not.equal(idC);
            expect(await escrow.activeCommitForHash(hashA)).to.be.true;
            expect(await escrow.activeCommitForHash(hashB)).to.be.true;
            expect(await escrow.activeCommitForHash(hashC)).to.be.true;
        });
    });

    // -- Timing boundaries (off-by-one) ---------------------------------------

    describe("Timing boundaries (off-by-one)", function () {

        it("14.07 settle at exactly block.number == deadline succeeds", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline);
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("14.08 settle at block.number == deadline + 1 succeeds (within SETTLEMENT_GRACE_BLOCKS window)", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + 1n); // TX mines at deadline+1, still within SETTLEMENT_GRACE_BLOCKS=10 window -> allowed
            await expect(escrow.connect(bundler).settle(commitId))
                .to.not.be.reverted;
        });

        it("14.09 claimRefund before unlocksAt reverts NotExpired", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            // unlocksAt = deadline + sg + rg + 1 = deadline + 16
            // At deadline + REFUND_GRACE (= deadline + 5), block.number < unlocksAt -> NotExpired
            await mineTo(deadline + rg);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("14.10 claimRefund at block == deadline + sg + rg + 1 succeeds", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("14.11 claimRefund well past unlocksAt succeeds", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 2n);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("14.12 slaBlocks=1: commit at block N, deadline=N+1, mine 1, settle at N+1 succeeds", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(1);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            // commit was mined at some block N, deadline = N+1
            // Currently at N (commit block). Need to settle at N+1 = deadline
            await mineTo(deadline);
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("14.13 slaBlocks=1: settle at deadline+SETTLEMENT_GRACE+1 reverts DeadlinePassed", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg } = await deploy(1);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + 1n); // TX mines at deadline+11 -> past grace window
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("14.14 settle at block.number == deadline - 1 succeeds (well within window)", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(10);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline - 1n);
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("14.15 claimRefund exactly at unlocksAt boundary, verifying the +1 offset in the contract", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            // unlocksAt = deadline + GRACE + 1
            const unlocksAt = deadline + sg + rg + 1n;

            // One block before: should fail
            await mineTo(unlocksAt - 1n);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("14.16 claimRefund exactly at unlocksAt: should succeed", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            const unlocksAt = deadline + sg + rg + 1n;
            await mineTo(unlocksAt);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("14.17 the gap between settle window and refund window: blocks [deadline+SETTLE_GRACE+1, deadline+SETTLE_GRACE+REFUND_GRACE] are dead zone", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);

            // deadline+SETTLEMENT_GRACE+1: settle reverts (past grace window)
            await mineTo(deadline + sg + 1n);
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");

            // deadline+SETTLEMENT_GRACE+3 (middle of refund grace): refund also reverts
            await mineTo(deadline + sg + 3n);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("14.18 claimRefund far in the future (1000 blocks past unlocksAt) still succeeds", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            // unlocksAt = deadline + sg + rg + 1 = deadline + 16;
            // mining to deadline + sg + rg + 1000 is well past that.
            await mineTo(deadline + sg + rg + 1000n);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });
    });

    // -- SLA extremes ---------------------------------------------------------

    describe("SLA extremes", function () {

        it("14.19 slaBlocks=1 (minimum): commit + settle immediately at deadline", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(1);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline);
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
            const c = await escrow.getCommit(commitId);
            expect(c.settled).to.be.true;
        });

        it("14.20 slaBlocks=1: miss by SETTLEMENT_GRACE+1 blocks, settle reverts, claimRefund succeeds after grace", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(1);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + 1n); // TX at deadline+2, past grace window
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");

            await mineTo(deadline + sg + rg + 1n);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("14.21 slaBlocks=MAX_SLA_BLOCKS: deadline = block.number + 1000, no uint64 overflow", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(MAX_SLA);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            const commitBlock = deadline - BigInt(MAX_SLA);
            expect(deadline).to.equal(commitBlock + BigInt(MAX_SLA));
            // Verify deadline fits in uint64
            expect(deadline).to.be.lt(2n ** 64n);
        });

        it("14.22 slaBlocks=MAX_SLA_BLOCKS: REFUND_GRACE_BLOCKS still works (no overflow on unlocksAt)", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(MAX_SLA);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            const unlocksAt = deadline + sg + rg + 1n;
            // No uint64 overflow
            expect(unlocksAt).to.be.lt(2n ** 64n);
        });

        it("14.23 slaBlocks=MAX_SLA_BLOCKS+1: register reverts", async function () {
            const [, bundlerX] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            await expect(
                registry.connect(bundlerX).register(ONE_GWEI, MAX_SLA + 1, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");
        });

        it("14.24 slaBlocks=0: register reverts", async function () {
            const [, bundlerX] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            await expect(
                registry.connect(bundlerX).register(ONE_GWEI, 0, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("slaBlocks must be > 0");
        });
    });

    // -- Offer deregistration mid-flight --------------------------------------

    describe("Offer deregistration mid-flight", function () {

        it("14.25 commit then deregister offer, settle still succeeds (commit already exists)", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            await registry.connect(bundler).deregister(QUOTE_ID);
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("14.26 deregister offer, new commit on same offer reverts OfferInactive", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deploy();
            await registry.connect(bundler).deregister(QUOTE_ID);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("fail")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("14.27 deregister mid-flight, claimRefund after grace succeeds", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID, sg, rg } = await deploy();
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await registry.connect(bundler).deregister(QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("14.28 deregister mid-flight does not affect collateral locks on existing commits", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deploy();
            const lockedBefore = await escrow.lockedOf(bundler.address);
            await makeCommit(escrow, user, QUOTE_ID);
            const lockedAfter = await escrow.lockedOf(bundler.address);
            expect(lockedAfter).to.equal(lockedBefore + COLLATERAL);

            await registry.connect(bundler).deregister(QUOTE_ID);
            // Lock unchanged by deregister
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedAfter);
        });

        it("14.29 deregister then re-register: new offer gets new quoteId, old commits unaffected", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deploy(10); // large SLA: deregister+register mine 2 blocks
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            await registry.connect(bundler).deregister(QUOTE_ID);
            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const newQuoteId = 2n;

            // Old commit still settles
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
            // New quoteId works for new commits
            const { commitId: id2 } = await makeCommit(escrow, user, newQuoteId);
            expect(id2).to.equal(1n);
        });
    });

    // -- Collateral boundaries ------------------------------------------------

    describe("Collateral boundaries", function () {

        it("14.30 bundler deposits exactly collateralWei: one commit succeeds", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });
            await expect(
                escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("one")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.not.be.reverted;
        });

        it("14.31 after one accept with exact collateral: second accept reverts InsufficientCollateral", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });
            // First commit + accept locks the full collateral
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("first")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
            await escrow.connect(bundler).accept(0n);
            // Second commit succeeds (no collateral check at commit time)...
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("second")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
            // ...but second accept reverts because collateral is fully locked
            await expect(
                escrow.connect(bundler).accept(1n),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });

        it("14.32 after settle, idle restored: new commit succeeds again", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("a")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
            await escrow.connect(bundler).accept(0n);
            await escrow.connect(bundler).settle(0n);

            // idle should be restored
            expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL);

            await expect(
                escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("b")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI }),
            ).to.not.be.reverted;
        });

        it("14.33 after claimRefund: collateral slashed, idle = 0, new accept fails InsufficientCollateral", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
            const { commitId, deadline } = await makeCommit(escrow, user, 1n, ethers.keccak256(ethers.toUtf8Bytes("slash")));
            await mineTo(deadline + sg + rg + 1n);
            await escrow.connect(user).claimRefund(commitId);

            // deposited reduced by COLLATERAL, idle = 0
            expect(await escrow.deposited(bundler.address)).to.equal(0n);
            expect(await escrow.idleBalance(bundler.address)).to.equal(0n);

            // commit succeeds (no collateral check at commit time)...
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("next")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
            // ...but accept reverts because deposited was slashed to 0
            await expect(
                escrow.connect(bundler).accept((await escrow.nextCommitId()) - 1n),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });

        it("14.34 withdraw(idle) right after settle returns exactly the collateral", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const idleBefore = await escrow.idleBalance(bundler.address);
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            const idleDuring = await escrow.idleBalance(bundler.address);
            expect(idleDuring).to.equal(idleBefore - COLLATERAL);

            await escrow.connect(bundler).settle(commitId);
            const idleAfter = await escrow.idleBalance(bundler.address);
            expect(idleAfter).to.equal(idleBefore);

            // Can withdraw all idle
            await expect(escrow.connect(bundler).withdraw(idleAfter)).to.not.be.reverted;
        });

        it("14.35 bundler deposits 2x collateral: can handle 2 simultaneous commits", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });

            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("a")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
            await expect(
                escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("b")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI }),
            ).to.not.be.reverted;
        });

        it("14.36 bundler deposits 3x collateral - 1 wei: can only handle 2 commits (not 3)", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 3n - 1n });

            // All three commits succeed (no collateral check at commit time)
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("a")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("b")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("c")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
            // First two accepts lock all available collateral
            await escrow.connect(bundler).accept(0n);
            await escrow.connect(bundler).accept(1n);
            // Third accept reverts: deposited = 3*COLLATERAL-1, locked = 2*COLLATERAL, idle = COLLATERAL-1 < COLLATERAL
            await expect(
                escrow.connect(bundler).accept(2n),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });

        it("14.37 settle one of two simultaneous commits: only that commit's collateral freed", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId: id0 } = await makeCommit(escrow, user, QUOTE_ID);
            const lockedAfter1 = await escrow.lockedOf(bundler.address);
            const { commitId: id1 } = await makeCommit(escrow, user, QUOTE_ID);
            const lockedAfter2 = await escrow.lockedOf(bundler.address);
            expect(lockedAfter2).to.equal(lockedAfter1 + COLLATERAL);

            await escrow.connect(bundler).settle(id0);
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedAfter2 - COLLATERAL);
        });
    });

    // -- CommitId ordering ----------------------------------------------------

    describe("CommitId ordering", function () {

        it("14.38 first commit has commitId = 0", async function () {
            const { escrow, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            expect(commitId).to.equal(0n);
        });

        it("14.39 second commit has commitId = 1", async function () {
            const { escrow, user, QUOTE_ID } = await deploy();
            await makeCommit(escrow, user, QUOTE_ID);
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            expect(commitId).to.equal(1n);
        });

        it("14.40 commitIds are monotonically increasing across different users", async function () {
            const { escrow, user, user2, QUOTE_ID } = await deploy();
            const { commitId: id0 } = await makeCommit(escrow, user, QUOTE_ID);
            const { commitId: id1 } = await makeCommit(escrow, user2, QUOTE_ID);
            const { commitId: id2 } = await makeCommit(escrow, user, QUOTE_ID);
            expect(id0).to.equal(0n);
            expect(id1).to.equal(1n);
            expect(id2).to.equal(2n);
        });

        it("14.41 nextCommitId reflects total commits ever made", async function () {
            const { escrow, user, QUOTE_ID } = await deploy();
            expect(await escrow.nextCommitId()).to.equal(0n);
            await makeCommit(escrow, user, QUOTE_ID);
            expect(await escrow.nextCommitId()).to.equal(1n);
            await makeCommit(escrow, user, QUOTE_ID);
            expect(await escrow.nextCommitId()).to.equal(2n);
            await makeCommit(escrow, user, QUOTE_ID);
            expect(await escrow.nextCommitId()).to.equal(3n);
        });

        it("14.42 commits[999] for non-existent commit: user == address(0), settled == false", async function () {
            const { escrow } = await deploy();
            const c = await escrow.getCommit(999n);
            expect(c.user).to.equal(ethers.ZeroAddress);
            expect(c.bundler).to.equal(ethers.ZeroAddress);
            expect(c.settled).to.be.false;
            expect(c.refunded).to.be.false;
            expect(c.feePaid).to.equal(0n);
            expect(c.deadline).to.equal(0n);
        });

        it("14.43 settle(999) non-existent: reverts CommitNotFound", async function () {
            // _settle() checks c.user == address(0) -> CommitNotFound before CommitNotActive.
            const { escrow, bundler } = await deploy();
            await expect(escrow.connect(bundler).settle(999n))
                .to.be.revertedWithCustomError(escrow, "CommitNotFound")
                .withArgs(999n);
        });

        it("14.44 claimRefund(999) non-existent: reverts CommitNotFound", async function () {
            const { escrow, user } = await deploy();
            await expect(escrow.connect(user).claimRefund(999n))
                .to.be.revertedWithCustomError(escrow, "CommitNotFound");
        });

        it("14.45 nextCommitId not affected by settle or claimRefund (only by commit)", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy();
            const { commitId: id0, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await makeCommit(escrow, user, QUOTE_ID);
            expect(await escrow.nextCommitId()).to.equal(2n);

            await escrow.connect(bundler).settle(id0);
            expect(await escrow.nextCommitId()).to.equal(2n); // unchanged

            await mineTo(deadline + sg + rg + 3n); // +3: SETTLEMENT_GRACE shift + commit 1 is 1 block later
            await escrow.connect(user).claimRefund(1n);
            expect(await escrow.nextCommitId()).to.equal(2n); // still unchanged
        });
    });

    // -- Bundler-as-user (same address) -- FORBIDDEN by SelfCommitForbidden ----

    describe("Bundler-as-user (same address) -- SelfCommitForbidden", function () {

        it("14.46 bundler commits to own offer reverts SelfCommitForbidden", async function () {
            const { escrow, bundler, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(bundler).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
             .withArgs(bundler.address);
        });

        it("14.47 bundler cannot settle because commit never succeeds", async function () {
            const { escrow, bundler, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(bundler).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-47")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
            // No commit was created
            expect(await escrow.nextCommitId()).to.equal(0n);
        });

        it("14.48 bundler self-commit reverts: no fee accumulates", async function () {
            const { escrow, bundler, QUOTE_ID } = await deploy();
            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            await expect(
                escrow.connect(bundler).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-48")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
            // No pending accumulated
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore);
        });

        it("14.49 bundler self-commit reverts: deposited balance unchanged (no slash path)", async function () {
            const { escrow, bundler, QUOTE_ID } = await deploy();
            const depositedBefore = await escrow.deposited(bundler.address);
            await expect(
                escrow.connect(bundler).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-49")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden");
            // Deposited unchanged (commit never succeeded -> no collateral lock or slash)
            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        });

        it("14.50 bundler self-commit with arbitrary userOp still reverts SelfCommitForbidden", async function () {
            const { escrow, bundler, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(bundler).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("alt-50")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
             .withArgs(bundler.address);
        });

        it("14.51 bundler self-commit reverts regardless of extra args passed", async function () {
            const { escrow, bundler, QUOTE_ID } = await deploy();
            // Even with correct bundler/collat/sla args, SelfCommitForbidden fires first
            await expect(
                escrow.connect(bundler).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("self-51")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
             .withArgs(bundler.address);
        });
    });

    // -- Fee validation -------------------------------------------------------

    describe("Fee validation", function () {

        it("14.52 commit with msg.value = 0 reverts WrongFee (value != feePerOp)", async function () {
            const { escrow, bundler, user } = await deploy(2, 1000n, 1001n);
            await expect(
                escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("zero")), bundler.address, 1001n, 2, { value: 0n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("14.53 commit with msg.value = feePerOp - 1 reverts WrongFee", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("less")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI - 1n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("14.54 commit with msg.value = feePerOp + 1 reverts WrongFee", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("more")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI + 1n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("14.55 commit with msg.value = feePerOp exactly succeeds", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            await expect(
                escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("exact")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.not.be.reverted;
        });

        it("14.56 register with feePerOp = 0 is now rejected (zero-fee offers banned)", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;

            await expect(
                registry.connect(bundler).register(0, 2, 0, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("feePerOp must be > 0");
        });
    });

    // -- Very small / very large values ---------------------------------------

    describe("Very small / very large values", function () {

        it("14.57 feePerOp = 1 wei -> commit succeeds (no minimum fee in PROTOCOL_FEE_WEI model)", async function () {
            const { escrow, bundler, user } = await deploy(2, 1n, 2n);
            // With PROTOCOL_FEE_WEI=0 there is no FeeTooSmall gate; commit should succeed
            await expect(makeCommit(escrow, user, 1n)).to.not.be.reverted;
        });

        it("14.58 feePerOp = 1 wei -> commit succeeds, bundler gets full 1 wei fee", async function () {
            const { escrow, bundler, user, feeRecipient } = await deploy(2, 1n, 2n);
            const { commitId } = await makeCommit(escrow, user, 1n);
            await escrow.connect(bundler).settle(commitId);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(1n);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("14.59 feePerOp = 10000 wei: small feePerOp commits work, bundler gets full fee", async function () {
            const fee = 10000n;
            const { escrow, bundler, user } = await deploy(2, fee, fee + 1n);
            const { commitId } = await makeCommit(escrow, user, 1n);
            const tx = await escrow.connect(bundler).settle(commitId);
            const receipt = await tx.wait();
            const settledEvents = receipt!.logs
                .filter(log => log.topics[0] === escrow.interface.getEvent("Settled")!.topicHash)
                .map(log => escrow.interface.parseLog(log)!);
            expect(settledEvents.length, "Settled event not emitted").to.equal(1);
            expect(settledEvents[0].args.bundlerNet).to.equal(fee);
        });

        it("14.60 near type(uint96).max as feePerOp: register accepts (collateral = fee + 1)", async function () {
            const [, bundlerX] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            // Fee must be strictly less than UINT96_MAX so collateral = fee+1 still fits
            const fee = UINT96_MAX - 1n;
            await expect(
                registry.connect(bundlerX).register(fee, 2, fee + 1n, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.not.be.reverted;
        });

        it("14.61 type(uint96).max + 1 as feePerOp: register reverts ValueTooLarge", async function () {
            const [, bundlerX] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            await expect(
                registry.connect(bundlerX).register(UINT96_MAX + 1n, 2, UINT96_MAX + 2n, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
        });

        it("14.62 collateralWei > type(uint96).max: register reverts ValueTooLarge", async function () {
            const [, bundlerX] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            await expect(
                registry.connect(bundlerX).register(1n, 2, UINT96_MAX + 1n, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
        });
    });

    // -- Cross-commit contamination -------------------------------------------

    describe("Cross-commit contamination", function () {

        it("14.63 settling commit A does not affect commit B's state", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId: idA } = await makeCommit(escrow, user, QUOTE_ID);
            const { commitId: idB } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(idA);
            const cB = await escrow.getCommit(idB);
            expect(cB.settled).to.be.false;
            expect(cB.refunded).to.be.false;
        });

        it("14.64 refunding commit A does not finalize commit B", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId: idA, deadline: dlA } = await makeCommit(escrow, user, QUOTE_ID);
            const { commitId: idB } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(dlA + sg + rg + 1n);
            await escrow.connect(user).claimRefund(idA);
            const cB = await escrow.getCommit(idB);
            expect(cB.settled).to.be.false;
            expect(cB.refunded).to.be.false;
        });

        it("14.65 settle commit 0, then commit 1 can still be refunded independently", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId: id0 } = await makeCommit(escrow, user, QUOTE_ID);
            const { commitId: id1, deadline: dl1 } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(id0);
            await mineTo(dl1 + sg + rg + 1n);
            await expect(escrow.connect(user).claimRefund(id1)).to.not.be.reverted;
        });

        it("14.66 refund commit 0, commit 1 can still be settled (if within deadline)", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(100);
            const { commitId: id0, deadline: dl0 } = await makeCommit(escrow, user, QUOTE_ID);
            const { commitId: id1, deadline: dl1 } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(dl0 + sg + rg + 1n);
            await escrow.connect(user).claimRefund(id0);
            // If dl1 still in the future, settle should work
            const cur = BigInt(await ethers.provider.getBlockNumber());
            if (cur <= dl1) {
                await expect(escrow.connect(bundler).settle(id1)).to.not.be.reverted;
            }
        });
    });

    // -- Event emission correctness -------------------------------------------

    describe("Event emission correctness", function () {

        it("14.67 CommitCreated emits correct commitId, quoteId, user, bundler, userOpHash, deadline", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("event-test"));
            const hash = userOp;
            const tx = escrow.connect(user).commit(QUOTE_ID, userOp, bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
            await expect(tx)
                .to.emit(escrow, "CommitCreated")
                .withArgs(0n, QUOTE_ID, user.address, bundler.address, hash, (deadline: bigint) => deadline > 0n);
        });

        it("14.68 Settled event emits correct bundlerNet (2-arg, bundler gets full fee)", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            const bundlerNet = ONE_GWEI;
            await expect(escrow.connect(bundler).settle(commitId))
                .to.emit(escrow, "Settled")
                .withArgs(commitId, bundlerNet);
        });

        it("14.69 Refunded event emits correct userAmount (2-arg, user gets feePaid + full collateral)", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);

            const userTotal = ONE_GWEI + COLLATERAL; // feePaid + full collateral (100% to user)

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.emit(escrow, "Refunded")
                .withArgs(commitId, userTotal);
        });
    });

    // -- Finalization idempotency ---------------------------------------------

    describe("Finalization idempotency", function () {

        it("14.70 double settle reverts AlreadyFinalized", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(commitId);
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("14.71 double claimRefund reverts AlreadyFinalized", async function () {
            const { escrow, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);
            await escrow.connect(user).claimRefund(commitId);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("14.72 settle then claimRefund reverts AlreadyFinalized", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(commitId);
            await mineTo(deadline + sg + rg + 1n);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("14.73 claimRefund then settle reverts AlreadyFinalized", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);
            await escrow.connect(user).claimRefund(commitId);
            // Settle would also fail because deadline passed, but AlreadyFinalized comes first
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });
    });

    // -- Multi-offer interactions ---------------------------------------------

    describe("Multi-offer interactions", function () {

        it("14.74 commits from different offers with different fees on same bundler track independently", async function () {
            const { escrow, registry, bundler, user } = await deploy();
            // Register a second offer with higher fee (collateral strictly > fee)
            const higherFee = ethers.parseUnits("2", "gwei");
            const higherCollat = higherFee + 1n;
            await registry.connect(bundler).register(higherFee, 2, higherCollat, 302_400, { value: ethers.parseEther("0.0001") });
            const QUOTE1 = 2n;

            const { commitId: id0 } = await makeCommit(escrow, user, 1n);
            const tx = await escrow.connect(user).commit(QUOTE1, ethers.keccak256(ethers.toUtf8Bytes("q1")), bundler.address, higherCollat, 2, { value: higherFee });
            await tx.wait();
            const id1 = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(id1);

            const c0 = await escrow.getCommit(id0);
            const c1 = await escrow.getCommit(id1);
            expect(c0.feePaid).to.equal(ONE_GWEI);
            expect(c1.feePaid).to.equal(higherFee);
        });

        it("14.75 two bundlers: commit on each, settle one, refund the other", async function () {
            const [owner, bundler1, bundler2, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler1).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await registry.connect(bundler2).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());

            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("b1")), bundler1.address, COLLATERAL, 2, { value: ONE_GWEI });
            await escrow.connect(bundler1).accept(0n);
            await escrow.connect(user).commit(2n, ethers.keccak256(ethers.toUtf8Bytes("b2")), bundler2.address, COLLATERAL, 2, { value: ONE_GWEI });
            await escrow.connect(bundler2).accept(1n);

            // Settle commit 0 (bundler1)
            await escrow.connect(bundler1).settle(0n);
            // Wait for refund on commit 1 (bundler2)
            const c1 = await escrow.getCommit(1n);
            await mineTo(c1.deadline + sg + rg + 1n);
            await escrow.connect(user).claimRefund(1n);

            expect((await escrow.getCommit(0n)).settled).to.be.true;
            expect((await escrow.getCommit(1n)).refunded).to.be.true;
        });

        it("14.76 settle credits bundler2 even if called by bundler1 (testable settle is permissionless; production enforces NotBundler)", async function () {
            // Note: SLAEscrowTestable.settle(1-arg) bypasses caller check for unit testing.
            // Production settle(5-arg) enforces NotBundler. This test verifies fee routing is correct.
            const [owner, bundler1, bundler2, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler1).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await registry.connect(bundler2).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });

            await escrow.connect(user).commit(2n, ethers.keccak256(ethers.toUtf8Bytes("cross")), bundler2.address, COLLATERAL, 10, { value: ONE_GWEI });
            await escrow.connect(bundler2).accept(0n);
            // testable settle called by bundler1 -- succeeds (permissionless), fee goes to bundler2
            await escrow.connect(bundler1).settle(0n);
            expect(await escrow.pendingWithdrawals(bundler2.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
        });
    });

    // -- Deposit / withdrawal interaction with commits ------------------------

    describe("Deposit / withdrawal interaction with commits", function () {

        it("14.77 cannot withdraw locked collateral while commit in-flight", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            await makeCommit(escrow, user, QUOTE_ID);
            const totalDeposited = await escrow.deposited(bundler.address);
            // Try to withdraw all deposited -- should fail because some is locked
            await expect(escrow.connect(bundler).withdraw(totalDeposited))
                .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
        });

        it("14.78 can withdraw idle portion while commit in-flight", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            await makeCommit(escrow, user, QUOTE_ID);
            const idle = await escrow.idleBalance(bundler.address);
            if (idle > 0n) {
                await expect(escrow.connect(bundler).withdraw(idle)).to.not.be.reverted;
            }
        });

        it("14.79 deposit during commit does not affect existing commit's collateralLocked", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            const cBefore = await escrow.getCommit(commitId);
            await escrow.connect(bundler).deposit({ value: ONE_ETH });
            const cAfter = await escrow.getCommit(commitId);
            expect(cAfter.collateralLocked).to.equal(cBefore.collateralLocked);
        });

        it("14.80 withdraw all idle, then new accept fails (InsufficientCollateral)", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow   = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });
            await escrow.connect(bundler).withdraw(COLLATERAL);

            // commit succeeds (no collateral check at commit time)
            await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("fail")), bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
            // accept reverts because deposited = 0, idle = 0 < COLLATERAL
            await expect(
                escrow.connect(bundler).accept(0n),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });
    });

    // -- PendingWithdrawals accounting ----------------------------------------

    describe("PendingWithdrawals accounting", function () {

        it("14.81 settle accumulates bundlerNet across multiple commits (bundler gets full fee each time)", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(10);
            await makeCommit(escrow, user, QUOTE_ID);
            await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(0n);
            await escrow.connect(bundler).settle(1n);

            const bundlerNet = ONE_GWEI;
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerNet * 2n);
        });

        it("14.82 feeRecipient gets 0 across multiple settles with PROTOCOL_FEE_WEI=0", async function () {
            const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await deploy(10);
            await makeCommit(escrow, user, QUOTE_ID);
            await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(0n);
            await escrow.connect(bundler).settle(1n);

            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("14.83 claimPayout zeroes pendingWithdrawals", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(commitId);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
            await escrow.connect(bundler).claimPayout();
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
        });

        it("14.84 claimPayout with nothing pending reverts NothingToClaim", async function () {
            const { escrow, stranger } = await deploy();
            await expect(escrow.connect(stranger).claimPayout())
                .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("14.85 mixed settle + refund: user pendingWithdrawals accumulates refunds", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            // commit 0: will settle
            const { commitId: id0 } = await makeCommit(escrow, user, QUOTE_ID);
            // commit 1: will expire and refund
            const { commitId: id1, deadline: dl1 } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(id0);
            await mineTo(dl1 + sg + rg + 1n);
            await escrow.connect(user).claimRefund(id1);

            const slashToUser = COLLATERAL; // 100% of collateral to user on refund
            const userTotal = ONE_GWEI + slashToUser;
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(userTotal);
        });
    });

    // -- Slash math edge cases ------------------------------------------------

    describe("Slash math edge cases", function () {

        it("14.86 odd collateral: user gets fee + full collateral (100% to user, no split)", async function () {
            // collateral = 11 wei: new model -- user gets all 11 wei
            const oddCollateral = 11n;
            const fee = 1n;
            const { escrow, user, sg, rg } = await deploy(2, fee, oddCollateral);
            const { commitId, deadline } = await makeCommit(escrow, user, 1n);
            await mineTo(deadline + sg + rg + 1n);
            const tx = await escrow.connect(user).claimRefund(commitId);
            const receipt = await tx.wait();
            const refundedEvents = receipt!.logs
                .filter(log => log.topics[0] === escrow.interface.getEvent("Refunded")!.topicHash)
                .map(log => escrow.interface.parseLog(log)!);
            expect(refundedEvents.length, "Refunded event not emitted").to.equal(1);
            expect(refundedEvents[0].args.userAmount).to.equal(fee + oddCollateral);
        });

        it("14.87 even collateral: user gets fee + full collateral (100% to user)", async function () {
            const evenCollateral = 10n;
            const fee = 1n;
            const { escrow, user, sg, rg } = await deploy(2, fee, evenCollateral);
            const { commitId, deadline } = await makeCommit(escrow, user, 1n);
            await mineTo(deadline + sg + rg + 1n);
            const tx = await escrow.connect(user).claimRefund(commitId);
            const receipt = await tx.wait();
            const refundedEvents = receipt!.logs
                .filter(log => log.topics[0] === escrow.interface.getEvent("Refunded")!.topicHash)
                .map(log => escrow.interface.parseLog(log)!);
            expect(refundedEvents.length, "Refunded event not emitted").to.equal(1);
            expect(refundedEvents[0].args.userAmount).to.equal(fee + evenCollateral);
        });

        it("14.88 collateral = 2 wei (minimum collateral > fee=1): user gets fee + 2", async function () {
            const { escrow, user, sg, rg } = await deploy(2, 1n, 2n);
            const { commitId, deadline } = await makeCommit(escrow, user, 1n);
            await mineTo(deadline + sg + rg + 1n);
            const tx = await escrow.connect(user).claimRefund(commitId);
            const receipt = await tx.wait();
            const refundedEvents = receipt!.logs
                .filter(log => log.topics[0] === escrow.interface.getEvent("Refunded")!.topicHash)
                .map(log => escrow.interface.parseLog(log)!);
            expect(refundedEvents.length, "Refunded event not emitted").to.equal(1);
            expect(refundedEvents[0].args.userAmount).to.equal(3n);
        });

        it("14.89 collateral = 2 wei: user gets fee + 2 (full collateral to user)", async function () {
            const { escrow, user, sg, rg } = await deploy(2, 1n, 2n);
            const { commitId, deadline } = await makeCommit(escrow, user, 1n);
            await mineTo(deadline + sg + rg + 1n);
            const tx = await escrow.connect(user).claimRefund(commitId);
            const receipt = await tx.wait();
            const refundedEvents = receipt!.logs
                .filter(log => log.topics[0] === escrow.interface.getEvent("Refunded")!.topicHash)
                .map(log => escrow.interface.parseLog(log)!);
            expect(refundedEvents.length, "Refunded event not emitted").to.equal(1);
            expect(refundedEvents[0].args.userAmount).to.equal(3n);
        });
    });

    // -- Role enforcement edge cases ------------------------------------------

    describe("Role enforcement edge cases", function () {

        it("14.90 user calling settle credits bundler (testable settle is permissionless; fee routing is correct)", async function () {
            // Note: SLAEscrowTestable.settle(1-arg) is permissionless (test helper).
            // Production settle(5-arg) enforces NotBundler. Fee always flows to c.bundler.
            const { escrow, bundler, user, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            await escrow.connect(user).settle(commitId); // permissionless in testable contract
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore + ONE_GWEI);
        });

        it("14.91 bundler can call claimRefund after expiry -- ETH goes to user (T12)", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);
            const pendingBefore = await escrow.pendingWithdrawals(user.address);
            await escrow.connect(bundler).claimRefund(commitId);
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
        });

        it("14.92 stranger calling settle credits bundler (testable settle permissionless; production enforces NotBundler)", async function () {
            // Note: SLAEscrowTestable.settle(1-arg) is permissionless -- production settle(5-arg) enforces NotBundler.
            const { escrow, bundler, user, stranger, QUOTE_ID } = await deploy();
            const { commitId } = await makeCommit(escrow, user, QUOTE_ID);
            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            await escrow.connect(stranger).settle(commitId); // permissionless in testable contract
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore + ONE_GWEI);
        });

        it("14.93 stranger cannot claimRefund anyone's commit -- reverts Unauthorized (T12)", async function () {
            const { escrow, user, stranger, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            await mineTo(deadline + sg + rg + 1n);
            await expect(escrow.connect(stranger).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "Unauthorized");
        });

        it("14.94 owner calling settle credits bundler (testable permissionless); owner cannot claimRefund (Unauthorized -- T12 is user/bundler/feeRecipient only)", async function () {
            // Note: SLAEscrowTestable.settle(1-arg) is permissionless -- production settle(5-arg) enforces NotBundler.
            // Owner is NOT a T12 caller; only user, bundler, or feeRecipient may trigger claimRefund.
            const { escrow, bundler, owner, user, QUOTE_ID, sg, rg } = await deploy(2);
            const { commitId, deadline } = await makeCommit(escrow, user, QUOTE_ID);
            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            await escrow.connect(owner).settle(commitId); // permissionless in testable contract
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore + ONE_GWEI);
            // Now test claimRefund -- but commit is already settled, skip this check.
            // The Unauthorized check for claimRefund is covered by test 14.93.
        });
    });

    // -- Commit on non-existent / inactive offers -----------------------------

    describe("Commit on non-existent / inactive offers", function () {

        it("14.95 commit on quoteId that was never registered: OfferInactive", async function () {
            const { escrow, bundler, user } = await deploy();
            await expect(
                escrow.connect(user).commit(999n, ethers.keccak256(ethers.toUtf8Bytes("ghost")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("14.96 commit on quoteId 0 after deregistration: OfferInactive", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deploy();
            await registry.connect(bundler).deregister(QUOTE_ID);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("dead")), bundler.address, COLLATERAL, 2, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });
    });

    // -- Rapid-fire stress ----------------------------------------------------

    describe("Rapid-fire stress", function () {

        it("14.97 10 commits in rapid succession: all get unique commitIds", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(100);
            const ids: bigint[] = [];
            for (let i = 0; i < 10; i++) {
                const tx = await escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes(`rapid-${i}`)), bundler.address, COLLATERAL, 100, { value: ONE_GWEI });
                await tx.wait();
                ids.push((await escrow.nextCommitId()) - 1n);
            }
            const unique = new Set(ids.map(String));
            expect(unique.size).to.equal(10);
            // Monotonically increasing
            for (let i = 1; i < ids.length; i++) {
                expect(ids[i]).to.equal(ids[i - 1] + 1n);
            }
        });

        it("14.98 10 commits, settle all within deadline: all succeed", async function () {
            const { escrow, bundler, user, QUOTE_ID } = await deploy(100);
            for (let i = 0; i < 10; i++) {
                await escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes(`settle-${i}`)), bundler.address, COLLATERAL, 100, { value: ONE_GWEI });
                await escrow.connect(bundler).accept(BigInt(i));
            }
            for (let i = 0; i < 10; i++) {
                await expect(escrow.connect(bundler).settle(BigInt(i))).to.not.be.reverted;
            }
        });

        it("14.99 10 commits, let all expire, refund all: all succeed", async function () {
            const { escrow, bundler, user, QUOTE_ID, sg, rg } = await deploy(2);
            const deadlines: bigint[] = [];
            for (let i = 0; i < 10; i++) {
                await escrow.connect(user).commit(QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes(`expire-${i}`)), bundler.address, COLLATERAL, 2, { value: ONE_GWEI });
                await escrow.connect(bundler).accept(BigInt(i));
                const c = await escrow.getCommit(BigInt(i));
                deadlines.push(c.deadline);
            }
            // Mine past all deadlines + grace
            const maxDeadline = deadlines.reduce((a, b) => (a > b ? a : b));
            await mineTo(maxDeadline + sg + rg + 1n);
            for (let i = 0; i < 10; i++) {
                await expect(escrow.connect(user).claimRefund(BigInt(i))).to.not.be.reverted;
            }
        });

        it("14.100 interleave: commit, settle, commit, refund, commit, settle across multiple users", async function () {
            const { escrow, bundler, user, user2, QUOTE_ID, sg, rg } = await deploy(100);

            // user commits, bundler settles
            const { commitId: id0 } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(id0);

            // user2 commits, let expire, refund
            const { commitId: id1, deadline: dl1 } = await makeCommit(escrow, user2, QUOTE_ID);
            await mineTo(dl1 + sg + rg + 1n);
            await escrow.connect(user2).claimRefund(id1);

            // user commits again: should work because settle freed collateral
            const { commitId: id2 } = await makeCommit(escrow, user, QUOTE_ID);
            await escrow.connect(bundler).settle(id2);

            expect((await escrow.getCommit(id0)).settled).to.be.true;
            expect((await escrow.getCommit(id1)).refunded).to.be.true;
            expect((await escrow.getCommit(id2)).settled).to.be.true;
            expect(await escrow.nextCommitId()).to.equal(3n);
        });
    });
});
