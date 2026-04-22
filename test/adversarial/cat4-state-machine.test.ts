// Category 4: State machine violations -- adversarial test suite

import { expect }                   from "chai";
import { ethers, upgrades }           from "hardhat";
import { mine }                      from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
    mineToRefundable,
} from "../helpers/fixtures";

const SLA_BLOCKS = 2n;
const ONE_ETH    = ethers.parseEther("1");

const BYTES32_A = ethers.keccak256(ethers.toUtf8Bytes("userOpA"));
const BYTES32_B = ethers.keccak256(ethers.toUtf8Bytes("userOpB"));
const BYTES32_C = ethers.keccak256(ethers.toUtf8Bytes("userOpC"));

async function deploy() {
    const [owner, bundler1, bundler2, user1, user2, feeRecipient, stranger] =
        await ethers.getSigners();

    const Registry = await ethers.getContractFactory("QuoteRegistry");
    const registry = (await Registry.deploy(owner.address, ethers.parseEther("0.0001"))) as unknown as QuoteRegistry;

    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const escrow = (await upgrades.deployProxy(
        Escrow,
        [await registry.getAddress(), feeRecipient.address],
        { kind: "uups" }
    )) as unknown as SLAEscrow;

    // Register quoteId=1 with bundler1
    await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID = 1n;

    // Give bundler1 enough collateral in escrow
    await escrow.connect(bundler1).deposit({ value: ONE_ETH });

    return {
        escrow, registry,
        owner, bundler1, bundler2,
        user1, user2, feeRecipient, stranger,
        QUOTE_ID,
    };
}

/** Helper: propose a commit (PROPOSED state only -- no accept). */
async function doPropose(
    escrow: SLAEscrow,
    user: Awaited<ReturnType<typeof ethers.getSigner>>,
    quoteId: bigint,
    userOpHash: string = BYTES32_A,
    opts?: { bundler?: string; collateral?: bigint; slaBlocks?: number },
): Promise<bigint> {
    const bundlerAddr = opts?.bundler ?? (await ethers.getSigners())[1].address;
    const collateral  = opts?.collateral ?? COLLATERAL;
    const slaBlocks   = opts?.slaBlocks ?? Number(SLA_BLOCKS);
    const tx = await escrow.connect(user).commit(quoteId, userOpHash, bundlerAddr, collateral, slaBlocks, { value: ONE_GWEI });
    const receipt = await tx.wait();
    const event = receipt!.logs
        .map((l) => {
            try { return (escrow.interface as any).parseLog(l); } catch { return null; }
        })
        .find((e) => e?.name === "CommitCreated");
    return event!.args.commitId as bigint;
}

/**
 * Helper: commit then accept (ACTIVE state).
 * bundler1 (signers[1]) accepts unless opts.bundler overrides.
 */
async function doCommit(
    escrow: SLAEscrow,
    user: Awaited<ReturnType<typeof ethers.getSigner>>,
    quoteId: bigint,
    userOpHash: string = BYTES32_A,
    opts?: { bundler?: string; collateral?: bigint; slaBlocks?: number },
): Promise<bigint> {
    const bundlerAddr = opts?.bundler ?? (await ethers.getSigners())[1].address;
    const cid = await doPropose(escrow, user, quoteId, userOpHash, opts);
    const bundler = await ethers.getSigner(bundlerAddr);
    await (escrow as any).connect(bundler).accept(cid);
    return cid;
}

// -----------------------------------------------------------------------------

describe("Category 4: State Machine Violations", function () {

    // --- 4.1  Double-finalize: settle -> settle --------------------------------
    describe("4.1  settle() on already-settled commit", function () {
        it("reverts AlreadyFinalized on second settle()", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("settled flag is true after first settle()", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.true;
        });

        it("third settle() attempt also reverts AlreadyFinalized", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await expect(escrow.connect(bundler1).settle(cid)).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
            await expect(escrow.connect(bundler1).settle(cid)).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });
    });

    // --- 4.2  Double-finalize: claimRefund -> claimRefund ---------------------
    describe("4.2  claimRefund() on already-refunded commit", function () {
        it("reverts AlreadyFinalized on second claimRefund()", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            await expect(
                escrow.connect(user1).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("refunded flag is true after first claimRefund()", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            const c = await escrow.getCommit(cid);
            expect(c.refunded).to.be.true;
        });

        it("settled flag remains false after claimRefund()", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.false;
        });
    });

    // --- 4.3  Cross-finalize: refund -> settle --------------------------------
    describe("4.3  settle() on already-refunded commit", function () {
        it("reverts AlreadyFinalized (AlreadyFinalized checked before DeadlinePassed in settle())", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            // settle() checks: CommitNotActive -> AlreadyFinalized -> DeadlinePassed.
            // c.refunded=true so AlreadyFinalized fires.
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
             .withArgs(cid);
        });

        it("reverts with AlreadyFinalized (not DeadlinePassed) when refunded flag set -- AlreadyFinalized checked before DeadlinePassed", async function () {
            // settle() checks: CommitNotActive -> AlreadyFinalized -> DeadlinePassed.
            // Since c.refunded=true, AlreadyFinalized fires before DeadlinePassed.
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
             .withArgs(cid);
        });
    });

    // --- 4.4  Cross-finalize: settle -> claimRefund ---------------------------
    describe("4.4  claimRefund() on already-settled commit", function () {
        it("reverts AlreadyFinalized", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await mineToRefundable(escrow, cid);
            await expect(
                escrow.connect(user1).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("cannot drain bundler collateral by refunding a settled commit", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const lockedBefore = await escrow.lockedOf(bundler1.address);
            await escrow.connect(bundler1).settle(cid);
            const lockedAfter = await escrow.lockedOf(bundler1.address);
            expect(lockedAfter).to.be.lt(lockedBefore); // unlocked on settle
            await mineToRefundable(escrow, cid);
            await expect(
                escrow.connect(user1).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });
    });

    // --- 4.5  Settle / claimRefund on non-existent commit --------------------
    describe("4.5  Operations on non-existent commits", function () {
        it("settle() on never-created commitId reverts CommitNotFound", async function () {
            const { escrow, bundler1 } = await deploy();
            await expect(
                escrow.connect(bundler1).settle(9999n),
            ).to.be.revertedWithCustomError(escrow, "CommitNotFound");
        });

        it("claimRefund() on never-created commitId reverts CommitNotFound (user=0)", async function () {
            const { escrow, user1 } = await deploy();
            await expect(
                escrow.connect(user1).claimRefund(9999n),
            ).to.be.revertedWithCustomError(escrow, "CommitNotFound");
        });

        it("settle() on commitId=0 before any commits reverts CommitNotFound", async function () {
            const { escrow, bundler1 } = await deploy();
            // Redeploy a fresh escrow with no commits
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const r2 = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const e2 = (await upgrades.deployProxy(Escrow, [await r2.getAddress(), bundler1.address], { kind: "uups" })) as unknown as SLAEscrow;
            await expect(
                e2.connect(bundler1).settle(0n),
            ).to.be.revertedWithCustomError(e2, "CommitNotFound");
        });

        it("stranger cannot settle a non-existent commit -- reverts CommitNotFound", async function () {
            const { escrow, stranger } = await deploy();
            await expect(
                escrow.connect(stranger).settle(42n),
            ).to.be.revertedWithCustomError(escrow, "CommitNotFound");
        });

        it("stranger cannot claimRefund on a non-existent commit -- reverts CommitNotFound", async function () {
            const { escrow, stranger } = await deploy();
            await expect(
                escrow.connect(stranger).claimRefund(42n),
            ).to.be.revertedWithCustomError(escrow, "CommitNotFound");
        });
    });

    // --- 4.6  Commit with inactive / never-registered offer ------------------
    describe("4.6  commit() with inactive or never-registered offer", function () {
        it("reverts OfferInactive for deregistered quoteId", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await expect(
                escrow.connect(user1).commit(QUOTE_ID, BYTES32_A, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("reverts OfferInactive for a quoteId that was never registered", async function () {
            const { escrow, user1, bundler1 } = await deploy();
            await expect(
                escrow.connect(user1).commit(999n, BYTES32_A, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("reverts OfferInactive for quoteId=0 on a fresh registry with no registrations", async function () {
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const r2 = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
            const [, bundler1, , , , feeRecipient] = await ethers.getSigners();
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const e2 = (await upgrades.deployProxy(Escrow, [await r2.getAddress(), feeRecipient.address], { kind: "uups" })) as unknown as SLAEscrow;
            const [, , , user1] = await ethers.getSigners();
            await expect(
                e2.connect(user1).commit(0n, BYTES32_A, bundler1.address, 0, 1, { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(e2, "OfferInactive");
        });
    });

    // --- 4.7  Deregister mid-flight ------------------------------------------
    describe("4.7  Deregister during open commit", function () {
        it("existing commit can still be settled after deregister", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await registry.connect(bundler1).deregister(QUOTE_ID);
            // settle should still work (offer.active is not rechecked on settle)
            await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
        });

        it("existing commit can still be refunded after deregister", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await expect(escrow.connect(user1).claimRefund(cid)).to.not.be.reverted;
        });

        it("new commits to deregistered quoteId are rejected", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await expect(
                escrow.connect(user1).commit(QUOTE_ID, BYTES32_B, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("settled commit state is preserved after deregister", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await registry.connect(bundler1).deregister(QUOTE_ID);
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.true;
        });
    });

    // --- 4.8  Re-register after deregister -----------------------------------
    describe("4.8  Re-register after deregister", function () {
        it("re-register produces a new quoteId", async function () {
            const { registry, bundler1, QUOTE_ID } = await deploy();
            await registry.connect(bundler1).deregister(QUOTE_ID);
            const tx = await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const receipt = await tx.wait();
            const event = receipt!.logs
                .map((l) => { try { return (registry.interface as any).parseLog(l); } catch { return null; } })
                .find((e) => e?.name === "OfferRegistered");
            const newQuoteId = event!.args.quoteId as bigint;
            expect(newQuoteId).to.equal(2n); // quoteId=2 (deploy created 1, re-register gets 2)
        });

        it("old commits under original quoteId are unaffected by re-registration", async function () {
            const { escrow, registry, bundler1, user1 } = await deploy();
            // Register a longer-SLA offer so the commit doesn't expire during deregister+register
            const LONG_SLA = 20;
            await registry.connect(bundler1).register(ONE_GWEI, LONG_SLA, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const longQuoteId = (await registry.nextQuoteId()) - 1n;
            // Commit against the long-SLA offer
            const cid = await doCommit(escrow, user1, longQuoteId, BYTES32_A, { slaBlocks: LONG_SLA });
            // Deregister the long-SLA offer and re-register a new one
            await registry.connect(bundler1).deregister(longQuoteId);
            await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            // Old commit should still be settleable (deadline not yet reached)
            await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
            // Verify commit data references the original quoteId
            const c = await escrow.getCommit(cid);
            expect(c.quoteId).to.equal(longQuoteId);
            expect(c.settled).to.be.true;
        });

        it("commit to new quoteId succeeds independently", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const newQuoteId = 2n;
            const cid = await doCommit(escrow, user1, newQuoteId, BYTES32_B);
            await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
        });
    });

    // --- 4.9  Deadline boundary: settle --------------------------------------
    describe("4.9  Deadline boundary for settle()", function () {
        it("settle() succeeds at exactly the deadline block", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // deadline = acceptBlock + SLA_BLOCKS; mine SLA_BLOCKS - 1 and
            // the settle tx itself mines one block -> lands on deadline exactly
            await mine(Number(SLA_BLOCKS) - 1);
            await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
        });

        it("settle() reverts DeadlinePassed at deadline + SETTLEMENT_GRACE + 1", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const SETTLEMENT_GRACE = Number(await escrow.SETTLEMENT_GRACE_BLOCKS());
            // mine past deadline + SETTLEMENT_GRACE so settle is rejected
            await mine(Number(SLA_BLOCKS) + SETTLEMENT_GRACE + 1);
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("settle() reverts DeadlinePassed well after deadline", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mine(100);
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("settle() succeeds with one block to spare before deadline", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // Do not mine any extra blocks; settle tx mines block.number+1 which
            // is <= deadline (acceptBlock + SLA_BLOCKS)
            await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
        });
    });

    // --- 4.10  Deadline boundary: claimRefund --------------------------------
    describe("4.10  Deadline boundary for claimRefund()", function () {
        it("claimRefund() succeeds at exactly unlocksAt (deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1)", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // mineToRefundable mines to exactly unlocksAt - 1; tx mines the last block
            await mineToRefundable(escrow, cid);
            // mine one less (mineToRefundable already positions us at unlocksAt)
            await expect(escrow.connect(user1).claimRefund(cid)).to.not.be.reverted;
        });

        it("claimRefund() reverts NotExpired before unlocksAt", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // mine only past deadline+SETTLEMENT_GRACE but not REFUND_GRACE
            const SETTLEMENT_GRACE = Number(await escrow.SETTLEMENT_GRACE_BLOCKS());
            await mine(Number(SLA_BLOCKS) + SETTLEMENT_GRACE);
            await expect(
                escrow.connect(user1).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund() reverts NotExpired at the deadline block itself", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // no extra mining; tx mines block.number+1 which is still < unlocksAt
            await expect(
                escrow.connect(user1).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund() reverts NotExpired immediately after accept (before deadline)", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await expect(
                escrow.connect(user1).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund() succeeds long after unlocksAt", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mine(200);
            await expect(escrow.connect(user1).claimRefund(cid)).to.not.be.reverted;
        });
    });

    // --- 4.11  settle() after deadline has passed ----------------------------
    describe("4.11  settle() after deadline has passed", function () {
        it("reverts DeadlinePassed when mined past deadline", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("bundler cannot settle after user has claimed refund -- reverts AlreadyFinalized", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            await expect(
                escrow.connect(bundler1).settle(cid),
            ).to.be.revertedWithCustomError(escrow, "AlreadyFinalized")
             .withArgs(cid);
        });
    });

    // --- 4.12  Duplicate commits (same quoteId, same userOpHash) -------------
    describe("4.12  Duplicate commits", function () {
        it("commit with same userOp bytes twice reverts UserOpAlreadyCommitted", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            // activeCommitForHash blocks concurrent commits with the same hash;
            // prevents the double-commit attack where a user routes the same UserOp
            // to two bundlers and profits from slashing whichever misses first.
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const cid1 = await doPropose(escrow, user1, QUOTE_ID, BYTES32_A);
            await expect(
                doPropose(escrow, user1, QUOTE_ID, BYTES32_A)
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");
        });

        it("re-commit of settled userOpHash reverts UserOpHashRetired (T1/18.7.3)", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const cid1 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_A);
            // First settle succeeds; retiredHashes[hash] is now true.
            await expect(escrow.connect(bundler1).settle(cid1)).to.not.be.reverted;
            // Re-commit of the same settled hash must now revert at commit() -- not at settle().
            await expect(
                escrow.connect(user1).commit(QUOTE_ID, BYTES32_A, bundler1.address, COLLATERAL, SLA_BLOCKS, { value: ONE_GWEI })
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });

        it("commit with different userOpHashes produces two distinct commits", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const cid1 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_A);
            const cid2 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_B);
            expect(cid1).to.not.equal(cid2);
            const c1 = await escrow.getCommit(cid1);
            const c2 = await escrow.getCommit(cid2);
            expect(c1.userOpHash).to.not.equal(c2.userOpHash);
        });

        it("two commits with different userOpHashes can be settled independently", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const cid1 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_A);
            const cid2 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_B);
            await expect(escrow.connect(bundler1).settle(cid1)).to.not.be.reverted;
            await expect(escrow.connect(bundler1).settle(cid2)).to.not.be.reverted;
        });
    });

    // --- 4.13  Settle + claimPayout sequence ---------------------------------
    describe("4.13  settle -> claimPayout sequence", function () {
        it("bundler pendingWithdrawals increases by exactly ONE_GWEI after settle() (PROTOCOL_FEE_WEI=0)", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const before = await escrow.pendingWithdrawals(bundler1.address);
            await escrow.connect(bundler1).settle(cid);
            const after = await escrow.pendingWithdrawals(bundler1.address);
            expect(after).to.equal(before + ONE_GWEI);
        });

        it("bundler can claimPayout after settle()", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await expect(escrow.connect(bundler1).claimPayout()).to.not.be.reverted;
        });

        it("claimPayout zeros out pendingWithdrawals", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await escrow.connect(bundler1).claimPayout();
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
        });

        it("second claimPayout after already claimed reverts NothingToClaim", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            await escrow.connect(bundler1).claimPayout();
            await expect(
                escrow.connect(bundler1).claimPayout(),
            ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("feeRecipient receives platform fee after settle()", async function () {
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            // PROTOCOL_FEE_WEI=0: feeRecipient accrues nothing at settle
            const fee = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(fee).to.equal(0n);
        });
    });

    // --- 4.14  claimRefund + claimPayout sequence ----------------------------
    describe("4.14  claimRefund -> claimPayout sequence", function () {
        it("user pendingWithdrawals increases by feePaid + collateral after claimRefund() (100% slash to user)", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            const before = await escrow.pendingWithdrawals(user1.address);
            await escrow.connect(user1).claimRefund(cid);
            const after = await escrow.pendingWithdrawals(user1.address);
            expect(after).to.equal(before + ONE_GWEI + COLLATERAL);
        });

        it("user can claimPayout after claimRefund()", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            await expect(escrow.connect(user1).claimPayout()).to.not.be.reverted;
        });

        it("user payout = feePaid + full collateral", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            const payout = await escrow.pendingWithdrawals(user1.address);
            // 100% of collateral goes to user (no protocol split)
            const expected = ONE_GWEI + COLLATERAL;
            expect(payout).to.equal(expected);
        });

        it("feeRecipient receives 0 after claimRefund() (100% slash goes to user)", async function () {
            const { escrow, user1, feeRecipient, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            // feeRecipient receives nothing; full collateral goes to user
            const feeRecipientPending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(feeRecipientPending).to.equal(0n);
        });
    });

    // --- 4.15  State flags after finalization --------------------------------
    describe("4.15  State flags after finalization", function () {
        it("commit.settled = true after settle(), refunded = false", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.true;
            expect(c.refunded).to.be.false;
        });

        it("commit.refunded = true after claimRefund(), settled = false", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            const c = await escrow.getCommit(cid);
            expect(c.refunded).to.be.true;
            expect(c.settled).to.be.false;
        });

        it("both settled and refunded are false immediately after commit", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.false;
            expect(c.refunded).to.be.false;
        });
    });

    // --- 4.16  nextCommitId increments ---------------------------------------
    describe("4.16  nextCommitId increments correctly", function () {
        it("nextCommitId starts at 0", async function () {
            const { escrow } = await deploy();
            // The deploy helper already performs one commit (none actually -- just setup)
            // We check nextCommitId directly
            const freshEscrow = await (async () => {
                const Registry = await ethers.getContractFactory("QuoteRegistry");
                const r = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
                const [, , , , , feeRecip] = await ethers.getSigners();
                const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
                return upgrades.deployProxy(Escrow, [await r.getAddress(), feeRecip.address], { kind: "uups" });
            })();
            expect(await freshEscrow.nextCommitId()).to.equal(0n);
        });

        it("nextCommitId = 1 after first commit", async function () {
            const { escrow, user1, QUOTE_ID } = await deploy();
            await doCommit(escrow, user1, QUOTE_ID);
            expect(await escrow.nextCommitId()).to.equal(1n);
        });

        it("nextCommitId = 3 after three commits", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await doCommit(escrow, user1, QUOTE_ID, BYTES32_A);
            await doCommit(escrow, user1, QUOTE_ID, BYTES32_B);
            await doCommit(escrow, user1, QUOTE_ID, BYTES32_C);
            expect(await escrow.nextCommitId()).to.equal(3n);
        });

        it("commitIds are sequential 0, 1, 2", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const cid0 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_A);
            const cid1 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_B);
            const cid2 = await doCommit(escrow, user1, QUOTE_ID, BYTES32_C);
            expect(cid0).to.equal(0n);
            expect(cid1).to.equal(1n);
            expect(cid2).to.equal(2n);
        });

        it("finalization does not reset nextCommitId", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(cid);
            expect(await escrow.nextCommitId()).to.equal(1n);
        });
    });

    // --- 4.17  Wrong caller access control -----------------------------------
    describe("4.17  Wrong-caller access control", function () {
        it("anyone can settle a valid ACTIVE commit -- settle is permissionless; fee goes to c.bundler", async function () {
            const { escrow, bundler1, user1, stranger, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const pendingBefore = await escrow.pendingWithdrawals(bundler1.address);
            // stranger (not the bundler) can call settle
            await expect(escrow.connect(stranger).settle(cid)).to.not.be.reverted;
            // fee (ONE_GWEI) still goes to c.bundler, not to the caller (PROTOCOL_FEE_WEI=0)
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(pendingBefore + ONE_GWEI);
        });

        it("stranger cannot claimRefund on a valid commit -- reverts Unauthorized (T12)", async function () {
            const { escrow, user1, stranger, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await expect(
                escrow.connect(stranger).claimRefund(cid),
            ).to.be.revertedWithCustomError(escrow, "Unauthorized");
        });

        it("user can call settle() on their own commit (permissionless); fee goes to bundler not user", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // settle is permissionless -- user calling it is allowed; fee still goes to bundler
            await expect(escrow.connect(user1).settle(cid)).to.not.be.reverted;
            // PROTOCOL_FEE_WEI=0: bundler earns full feePerOp = ONE_GWEI
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(0n);
        });

        it("bundler can call claimRefund() after expiry -- ETH goes to user not bundler (T12)", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await mineToRefundable(escrow, cid);
            const pendingBefore = await escrow.pendingWithdrawals(user1.address);
            await escrow.connect(bundler1).claimRefund(cid);
            // User gets feePaid (ONE_GWEI) + full collateral (COLLATERAL); bundler gets nothing
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);
        });

        it("owner can settle a commit (settle is permissionless) -- fee goes to c.bundler not owner", async function () {
            const { escrow, bundler1, owner, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            // settle is permissionless; owner can call it
            await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
            // PROTOCOL_FEE_WEI=0: bundler earns full feePerOp = ONE_GWEI
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        });
    });

    // --- 4.18  Locked collateral bookkeeping during state transitions ---------
    describe("4.18  Collateral bookkeeping across state transitions", function () {
        it("lockedOf(bundler) increases by collateralWei after accept() (two-phase: locked at accept, not commit)", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const before = await escrow.lockedOf(bundler1.address);
            // doCommit = commit + accept; locking happens at accept()
            await doCommit(escrow, user1, QUOTE_ID);
            const after = await escrow.lockedOf(bundler1.address);
            expect(after - before).to.equal(COLLATERAL);
        });

        it("lockedOf(bundler) is 0 after commit() but before accept() (PROPOSED state)", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const before = await escrow.lockedOf(bundler1.address);
            await doPropose(escrow, user1, QUOTE_ID);
            const after = await escrow.lockedOf(bundler1.address);
            expect(after).to.equal(before); // no change until accept
        });

        it("lockedOf(bundler) decreases by collateralWei after settle()", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const before = await escrow.lockedOf(bundler1.address);
            await escrow.connect(bundler1).settle(cid);
            const after = await escrow.lockedOf(bundler1.address);
            expect(before - after).to.equal(COLLATERAL);
        });

        it("lockedOf(bundler) decreases by collateralWei after claimRefund()", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const before = await escrow.lockedOf(bundler1.address);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            const after = await escrow.lockedOf(bundler1.address);
            expect(before - after).to.equal(COLLATERAL);
        });

        it("deposited(bundler) decreases by collateralWei after claimRefund() (slash)", async function () {
            const { escrow, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            const before = await escrow.deposited(bundler1.address);
            await mineToRefundable(escrow, cid);
            await escrow.connect(user1).claimRefund(cid);
            const after = await escrow.deposited(bundler1.address);
            expect(before - after).to.equal(COLLATERAL);
        });
    });

    // --- 4.19  Offer deactivated mid-flight: new commits fail, existing work --
    describe("4.19  Offer deactivated mid-flight", function () {
        it("commit after deregister fails with OfferInactive", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await expect(
                escrow.connect(user1).commit(QUOTE_ID, BYTES32_A, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("open commit created before deregister can still be settled", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await expect(escrow.connect(bundler1).settle(cid)).to.not.be.reverted;
        });

        it("open commit created before deregister can still be refunded", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            const cid = await doCommit(escrow, user1, QUOTE_ID);
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await mineToRefundable(escrow, cid);
            await expect(escrow.connect(user1).claimRefund(cid)).to.not.be.reverted;
        });

        it("deregistering then re-registering does not resurrect old quoteId", async function () {
            const { escrow, registry, bundler1, user1, QUOTE_ID } = await deploy();
            await registry.connect(bundler1).deregister(QUOTE_ID);
            await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            // old QUOTE_ID still inactive
            await expect(
                escrow.connect(user1).commit(QUOTE_ID, BYTES32_A, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });
    });
});
