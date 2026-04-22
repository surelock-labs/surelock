/**
 * Full end-to-end protocol simulation -- QA engineer audit.
 *
 * Covers every major code path on a live Hardhat network:
 *  1. Deploy QuoteRegistry + SLAEscrow proxy
 *  2. Register a bundler offer
 *  3. Bundler deposits collateral
 *  4. User commits a UserOp
 *  5. Happy path: bundler settle() within deadline
 *  6. Verify pendingWithdrawals updated correctly
 *  7. Bundler claimPayout()
 *  8. Unhappy path: second commit, bundler misses deadline, user claimRefund()
 *  9. Verify collateral slashed correctly
 * 10. sweepExcess(): force-send ETH then sweep
 * 11. QuoteRegistry.listPage() pagination
 * 12. reservedBalance == address(this).balance throughout
 * 13. Proxy upgrade to V2, verify state preserved
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import type { QuoteRegistry, SLAEscrow, TimelockController } from "../typechain-types";
import {
    assertReservedInvariant,
    deployEscrow,
    ONE_GWEI,
    COLLATERAL,
    MIN_BOND,
} from "./helpers/fixtures";

// -- constants ----------------------------------------------------------------

const SLA_BLOCKS    = 5;

// -- helpers ------------------------------------------------------------------

function platformFee(_amount: bigint): bigint {
    return 0n;
}

function bundlerNet(amount: bigint): bigint {
    return amount;
}

async function doCommit(
    escrow: SLAEscrow,
    user: any,
    quoteId: bigint,
    tag: string,
    fee?: bigint,
): Promise<bigint> {
    const { commitId } = await doCommitWithBlock(escrow, user, quoteId, tag, fee);
    return commitId;
}

async function doCommitWithBlock(
    escrow: SLAEscrow,
    user: any,
    quoteId: bigint,
    tag: string,
    fee?: bigint,
): Promise<{ commitId: bigint; acceptBlock: bigint }> {
    const userOp = ethers.keccak256(ethers.toUtf8Bytes(tag));
    const reg = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const offer = await reg.getOffer(quoteId);
    const tx = await escrow.connect(user).commit(quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: fee ?? offer.feePerOp });
    const receipt = await tx.wait();
    let commitId: bigint | undefined;
    for (const log of receipt!.logs) {
        try {
            const parsed = escrow.interface.parseLog(log);
            if (parsed && parsed.name === "CommitCreated") {
                commitId = parsed.args.commitId as bigint;
                break;
            }
        } catch {}
    }
    if (commitId === undefined) throw new Error("CommitCreated event not found");

    // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
    const bundlerSigner = await ethers.getSigner(offer.bundler);
    const acceptTx = await (escrow as any).connect(bundlerSigner).accept(commitId);
    const acceptRcpt = await acceptTx.wait();

    return { commitId, acceptBlock: BigInt(acceptRcpt!.blockNumber) };
}

async function checkReservedInvariant(escrow: SLAEscrow, label: string) {
    const escrowAddr = await escrow.getAddress();
    const balance = await ethers.provider.getBalance(escrowAddr);
    const reserved = await escrow.reservedBalance();
    expect(balance).to.be.gte(reserved, `[${label}] balance < reservedBalance`);
}

async function checkExactReservedInvariant(escrow: SLAEscrow, label: string) {
    // Use assertReservedInvariant for exact equality check
    await assertReservedInvariant(escrow, ethers.provider);
}

// -- deploy fixture -----------------------------------------------------------
// Use shared deployEscrow() with skipRegister:true -- full-simulation registers
// its own offers (Step 2+) and the test counts depend on nextQuoteId starting at 1.

async function deployFull() {
    const base = await deployEscrow({ skipRegister: true });
    // Keep sweepRecipient symbol for existing tests that reference it.
    const sweepRecipient = base.bundler2;
    return {
        registry:       base.registry,
        escrow:         base.escrow,
        owner:          base.owner,
        bundler:        base.bundler,
        user:           base.user,
        feeRecipient:   base.feeRecipient,
        stranger:       base.stranger,
        sweepRecipient,
    };
}

// =============================================================================
//   FULL PROTOCOL SIMULATION
// =============================================================================

describe("Full Protocol Simulation (QA Audit)", function () {
    this.timeout(120_000); // 2 min max

    let registry: QuoteRegistry;
    let escrow: SLAEscrow;
    let owner: any, bundler: any, user: any, feeRecipient: any, stranger: any, sweepRecipient: any;
    let quoteId: bigint;

    before(async () => {
        ({ registry, escrow, owner, bundler, user, feeRecipient, stranger, sweepRecipient } = await deployFull());
        // Register the bundler offer in before() so quoteId is always set,
        // preventing cascade failures if the Step 2 registration test were to fail.
        const tx = await registry.connect(bundler).register(ONE_GWEI, SLA_BLOCKS, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const receipt = await tx.wait();
        const log = receipt!.logs
            .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
            .find((e: any) => e?.name === "OfferRegistered");
        quoteId = log!.args.quoteId as bigint;
    });

    // -- Step 1: Deploy verification ------------------------------------------

    describe("Step 1: Deploy verification", () => {
        it("QuoteRegistry deployed at nonzero address", async () => {
            const addr = await registry.getAddress();
            expect(addr).to.not.equal(ethers.ZeroAddress);
            console.log(`    QuoteRegistry: ${addr}`);
        });

        it("SLAEscrow proxy deployed at nonzero address", async () => {
            const addr = await escrow.getAddress();
            expect(addr).to.not.equal(ethers.ZeroAddress);
            const impl = await upgrades.erc1967.getImplementationAddress(addr);
            console.log(`    SLAEscrow proxy: ${addr}`);
            console.log(`    SLAEscrow impl:  ${impl}`);
        });

        it("SLAEscrow initialized correctly", async () => {
            expect(await escrow.protocolFeeWei()).to.equal(0n);
            expect(await escrow.feeRecipient()).to.equal(feeRecipient.address);
            expect(await escrow.REFUND_GRACE_BLOCKS()).to.equal(5n);
            expect(await escrow.owner()).to.equal(owner.address);
            expect(await escrow.nextCommitId()).to.equal(0n);
            expect(await escrow.reservedBalance()).to.equal(0n);
        });

        it("reservedBalance == balance at start", async () => {
            await checkExactReservedInvariant(escrow, "post-deploy");
        });
    });

    // -- Step 2: Register a bundler offer -------------------------------------

    describe("Step 2: Register a bundler offer", () => {
        it("bundler registers an offer and gets quoteId=1", async () => {
            // Registration happens in before(); this test just verifies the result.
            expect(quoteId).to.equal(1n);
            console.log(`    Registered quoteId=${quoteId}, fee=${ethers.formatUnits(ONE_GWEI, "gwei")} gwei, sla=${SLA_BLOCKS} blocks, collateral=${ethers.formatEther(COLLATERAL)} ETH`);
        });

        it("offer is listed as active", async () => {
            const offers = await registry.list();
            expect(offers.length).to.equal(1);
            expect(await registry.isActive(quoteId)).to.be.true;
            expect(offers[0].bundler).to.equal(bundler.address);
        });

        it("getOffer returns correct data", async () => {
            const offer = await registry.getOffer(quoteId);
            expect(offer.feePerOp).to.equal(ONE_GWEI);
            expect(offer.slaBlocks).to.equal(SLA_BLOCKS);
            expect(offer.collateralWei).to.equal(COLLATERAL);
        });
    });

    // -- Step 3: Bundler deposits collateral ----------------------------------

    describe("Step 3: Bundler deposits collateral", () => {
        it("deposit() succeeds and updates deposited mapping", async () => {
            const amount = COLLATERAL * 5n; // enough for multiple commits
            const tx = await escrow.connect(bundler).deposit({ value: amount });
            const receipt = await tx.wait();
            console.log(`    deposit() gas: ${receipt!.gasUsed.toString()}`);

            expect(await escrow.deposited(bundler.address)).to.equal(amount);
            expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
            expect(await escrow.idleBalance(bundler.address)).to.equal(amount);
        });

        it("reservedBalance == balance after deposit", async () => {
            await checkExactReservedInvariant(escrow, "post-deposit");
        });

        it("zero deposit reverts", async () => {
            await expect(
                escrow.connect(bundler).deposit({ value: 0n }),
            ).to.be.revertedWithCustomError(escrow, "ZeroDeposit");
        });
    });

    // -- Step 4: User commits a UserOp ----------------------------------------

    let commitId0: bigint;
    let commitId0AcceptBlock: bigint;

    describe("Step 4: User commits a UserOp (happy path)", () => {
        it("commit() succeeds and returns commitId=0", async () => {
            const r = await doCommitWithBlock(escrow, user, quoteId, "happy-path-op");
            commitId0 = r.commitId;
            commitId0AcceptBlock = r.acceptBlock;
            expect(commitId0).to.equal(0n);
            console.log(`    commitId=${commitId0}`);
        });

        it("commit struct stored correctly", async () => {
            const c = await escrow.getCommit(commitId0);
            expect(c.user).to.equal(user.address);
            expect(c.feePaid).to.equal(ONE_GWEI);
            expect(c.bundler).to.equal(bundler.address);
            expect(c.collateralLocked).to.equal(COLLATERAL);
            expect(c.settled).to.be.false;
            expect(c.refunded).to.be.false;
            expect(c.quoteId).to.equal(quoteId);
            // deadline is set at accept() to acceptBlock + slaBlocks (T9) -- exact.
            expect(c.deadline).to.equal(commitId0AcceptBlock + BigInt(SLA_BLOCKS));
        });

        it("collateral locked correctly", async () => {
            expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
            expect(await escrow.idleBalance(bundler.address)).to.equal(COLLATERAL * 5n - COLLATERAL);
        });

        it("wrong fee amount reverts", async () => {
            const reg = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
            const offer = await reg.getOffer(quoteId);
            await expect(
                escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("bad-fee-test")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: ONE_GWEI + 1n }),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("reservedBalance == balance after commit", async () => {
            await checkExactReservedInvariant(escrow, "post-commit");
        });
    });

    // -- Step 5: Happy path -- settle() -------------------------------

    describe("Step 5: Happy path -- bundler settle()", () => {
        it("settle() succeeds within deadline", async () => {
            const tx = await escrow.connect(bundler).settle(
                commitId0,
            );
            const receipt = await tx.wait();
            console.log(`    settle() gas: ${receipt!.gasUsed.toString()}`);

            // Check event
            const log = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e?.name === "Settled");
            expect(log).to.not.be.null;
            // PROTOCOL_FEE_WEI=0 => bundlerNet == feePerOp == ONE_GWEI
            expect(log!.args.bundlerNet).to.equal(ONE_GWEI);
            console.log(`    Settled event: bundlerNet=${log!.args.bundlerNet}`);
        });

        it("commit marked as settled", async () => {
            const c = await escrow.getCommit(commitId0);
            expect(c.settled).to.be.true;
            expect(c.refunded).to.be.false;
        });

        it("collateral unlocked after settle", async () => {
            expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
        });

        it("reservedBalance == balance after settle", async () => {
            await checkExactReservedInvariant(escrow, "post-settle");
        });
    });

    // -- Step 6: Verify pendingWithdrawals ------------------------------------

    describe("Step 6: Verify pendingWithdrawals updated correctly", () => {
        it("bundler has net fee in pending", async () => {
            const expectedNet = bundlerNet(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(expectedNet);
            console.log(`    bundler pending: ${ethers.formatUnits(expectedNet, "gwei")} gwei`);
        });

        it("feeRecipient has 0 pending after settle (PROTOCOL_FEE_WEI=0)", async () => {
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("bundlerNet == feePaid (bundler gets full fee, no ETH leak)", async () => {
            const pending = await escrow.pendingWithdrawals(bundler.address);
            expect(pending).to.equal(ONE_GWEI);
        });
    });

    // -- Step 7: Bundler claimPayout() ----------------------------------------

    describe("Step 7: Bundler claimPayout()", () => {
        it("bundler claims payout successfully", async () => {
            const balBefore = await ethers.provider.getBalance(bundler.address);
            const pending = await escrow.pendingWithdrawals(bundler.address);

            const tx = await escrow.connect(bundler).claimPayout();
            const receipt = await tx.wait();
            console.log(`    claimPayout() gas: ${receipt!.gasUsed.toString()}`);

            const balAfter = await ethers.provider.getBalance(bundler.address);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            expect(balAfter).to.equal(balBefore + pending - gasCost);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
        });

        it("feeRecipient has nothing pending (PROTOCOL_FEE_WEI=0)", async () => {
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("double claim reverts with NothingToClaim", async () => {
            await expect(
                escrow.connect(bundler).claimPayout(),
            ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("reservedBalance == balance after claims", async () => {
            await checkExactReservedInvariant(escrow, "post-claim");
        });
    });

    // -- Step 8: Unhappy path -- SLA miss -> claimRefund() ----------------------

    let commitId1: bigint;

    describe("Step 8: Unhappy path -- bundler misses deadline, user claimRefund()", () => {
        it("user creates a second commit", async () => {
            commitId1 = await doCommit(escrow, user, quoteId, "unhappy-path-op");
            expect(commitId1).to.equal(1n);
            console.log(`    commitId=${commitId1}`);
        });

        it("bundler cannot settle after deadline", async () => {
            const c = await escrow.getCommit(commitId1);
            const currentBlock = BigInt(await ethers.provider.getBlockNumber());
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            // Mine past deadline + SETTLEMENT_GRACE_BLOCKS so settle() fires DeadlinePassed
            const blocksToMine = Number(c.deadline - currentBlock) + Number(sg) + 1;
            if (blocksToMine > 0) await mine(blocksToMine);

            await expect(
                escrow.connect(bundler).settle(commitId1),
            ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("user cannot refund during grace period", async () => {
            // We're just past deadline; grace hasn't expired
            await expect(
                escrow.connect(user).claimRefund(commitId1),
            ).to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("user can refund after grace period expires", async () => {
            // Mine past grace
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
            await mine(Number(rg) + 1);

            const depositedBefore = await escrow.deposited(bundler.address);
            const lockedBefore = await escrow.lockedOf(bundler.address);

            const tx = await escrow.connect(user).claimRefund(commitId1);
            const receipt = await tx.wait();
            console.log(`    claimRefund() gas: ${receipt!.gasUsed.toString()}`);

            // Check event
            const log = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e?.name === "Refunded");
            expect(log).to.not.be.null;
            // userAmount = feePaid + collateral (100% refund on SLA miss)
            expect(log!.args.userAmount).to.equal(ONE_GWEI + COLLATERAL);
            console.log(`    Refunded event: userAmount=${log!.args.userAmount}`);
        });

        it("stranger cannot refund -- reverts Unauthorized (T12)", async () => {
            // Create another commit and let it expire
            const commitId2 = await doCommit(escrow, user, quoteId, "wrong-user-refund");
            const c = await escrow.getCommit(commitId2);
            const currentBlock = BigInt(await ethers.provider.getBlockNumber());
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
            // unlocksAt = deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1
            const blocksToMine = Number(c.deadline - currentBlock + sg + rg) + 2;
            if (blocksToMine > 0) await mine(blocksToMine);

            await expect(
                escrow.connect(stranger).claimRefund(commitId2),
            ).to.be.revertedWithCustomError(escrow, "Unauthorized");
        });
    });

    // -- Step 9: Verify collateral slashed correctly --------------------------

    describe("Step 9: Verify collateral slashed correctly", () => {
        it("user pending = feePaid + collateral (100% refund)", async () => {
            const userPending = await escrow.pendingWithdrawals(user.address);
            const expectedUser = ONE_GWEI + COLLATERAL;
            expect(userPending).to.equal(expectedUser);
            console.log(`    user pending: ${ethers.formatEther(userPending)} ETH`);
        });

        it("protocol pending = 0 after refund (100% goes to user)", async () => {
            const protocolPending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(protocolPending).to.equal(0n);
            console.log(`    protocol pending: ${ethers.formatEther(protocolPending)} ETH`);
        });

        it("bundler deposited reduced by full collateral", async () => {
            // started with 5*COLLATERAL, lost 1*COLLATERAL to slash
            // 1*COLLATERAL was locked by commitId1 (now refunded)
            // Need to also account for any other outstanding commits
            const deposited = await escrow.deposited(bundler.address);
            const locked = await escrow.lockedOf(bundler.address);
            console.log(`    bundler deposited: ${ethers.formatEther(deposited)} ETH`);
            console.log(`    bundler locked: ${ethers.formatEther(locked)} ETH`);
            // After slash: deposited should be reduced
            // We deposited 5*COLLATERAL, slashed 1*COLLATERAL
            // Also have 1 additional commit (commitId2 from wrong-user test still open)
            expect(deposited).to.be.lt(COLLATERAL * 5n);
        });

        it("commit struct updated correctly", async () => {
            const c = await escrow.getCommit(commitId1);
            expect(c.refunded).to.be.true;
            expect(c.settled).to.be.false;
        });

        it("reservedBalance == balance after refund", async () => {
            // First claim all pending payouts
            await escrow.connect(user).claimPayout();
            if ((await escrow.pendingWithdrawals(feeRecipient.address)) > 0n) {
                await escrow.connect(feeRecipient).claimPayout();
            }
            await checkExactReservedInvariant(escrow, "post-refund-claims");
        });
    });

    // -- Step 10: sweepExcess -- force-send ETH then sweep ---------------------

    describe("Step 10: sweepExcess()", () => {
        it("force-send ETH to escrow via selfdestruct", async () => {
            const ForceEtherFactory = await ethers.getContractFactory("ForceEther");
            const forceSendAmount = ethers.parseEther("0.1");
            const forceEther = await ForceEtherFactory.deploy({ value: forceSendAmount });
            await forceEther.waitForDeployment();

            const escrowAddr = await escrow.getAddress();
            const balBefore = await ethers.provider.getBalance(escrowAddr);
            const reservedBefore = await escrow.reservedBalance();

            await forceEther.destroy(escrowAddr);

            const balAfter = await ethers.provider.getBalance(escrowAddr);
            expect(balAfter).to.equal(balBefore + forceSendAmount);
            // reservedBalance unchanged
            expect(await escrow.reservedBalance()).to.equal(reservedBefore);
            // Now balance == contractBalBefore + excess (strict accounting)
            expect(balAfter).to.equal(balBefore + forceSendAmount);
            console.log(`    Force-sent ${ethers.formatEther(forceSendAmount)} ETH`);
            console.log(`    balance=${ethers.formatEther(balAfter)}, reserved=${ethers.formatEther(reservedBefore)}`);
        });

        it("stranger cannot sweepExcess (onlyOwner)", async () => {
            await expect(
                escrow.connect(stranger).sweepExcess(),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("owner sweeps excess ETH to feeRecipient (queued -- pull via claimPayout)", async () => {
            const escrowAddr = await escrow.getAddress();
            const feeRecipAddr = await escrow.feeRecipient();
            const excess = (await ethers.provider.getBalance(escrowAddr)) - (await escrow.reservedBalance());
            expect(excess).to.be.gt(0n);

            const pendingBefore = await escrow.pendingWithdrawals(feeRecipAddr);

            const tx = await escrow.connect(owner).sweepExcess();
            const receipt = await tx.wait();
            console.log(`    sweepExcess() gas: ${receipt!.gasUsed.toString()}`);

            // excess queued in pendingWithdrawals -- no direct transfer
            expect(await escrow.pendingWithdrawals(feeRecipAddr)).to.equal(pendingBefore + excess);
            // reserved increased by excess (now tracked)
            // balance == reserved (pull model keeps them in sync)
            await checkExactReservedInvariant(escrow, "post-sweep");
            console.log(`    Swept ${ethers.formatEther(excess)} ETH queued for feeRecipient`);
        });

        it("sweepExcess when no excess is a no-op (does not revert)", async () => {
            // No excess now, should silently return
            const feeRecipAddr = await escrow.feeRecipient();
            const recipientBefore = await ethers.provider.getBalance(feeRecipAddr);
            await escrow.connect(owner).sweepExcess();
            const recipientAfter = await ethers.provider.getBalance(feeRecipAddr);
            expect(recipientAfter).to.equal(recipientBefore);
        });
    });

    // -- Step 11: QuoteRegistry.listPage() pagination -------------------------

    describe("Step 11: QuoteRegistry.listPage() pagination", () => {
        it("register multiple offers and paginate", async () => {
            // Register 4 more offers (total 5 including the original)
            for (let i = 1; i <= 4; i++) {
                await registry.connect(bundler).register(
                    ONE_GWEI * BigInt(i + 1),
                    SLA_BLOCKS,
                    ONE_GWEI * BigInt(i + 1) + 1n, // collateral > fee
                    302_400,
                    { value: ethers.parseEther("0.0001") },
                );
            }
            const total = await registry.nextQuoteId();
            expect(total).to.equal(6n); // quoteIds 1..5
            console.log(`    Total offers registered: ${total - 1n}`);
        });

        it("listPage(1, 2) returns first 2 offers", async () => {
            const page = await registry.listPage(1, 2);
            expect(page.length).to.equal(2);
            expect(page[0].quoteId).to.equal(1n);
            expect(page[1].quoteId).to.equal(2n);
        });

        it("listPage(3, 2) returns next 2 offers", async () => {
            const page = await registry.listPage(3, 2);
            expect(page.length).to.equal(2);
            expect(page[0].quoteId).to.equal(3n);
            expect(page[1].quoteId).to.equal(4n);
        });

        it("listPage(5, 10) returns last 1 offer (capped)", async () => {
            const page = await registry.listPage(5, 10);
            expect(page.length).to.equal(1);
            expect(page[0].quoteId).to.equal(5n);
        });

        it("listPage beyond range returns empty", async () => {
            const page = await registry.listPage(100, 10);
            expect(page.length).to.equal(0);
        });

        it("listPage(0, N) returns empty (offset must be >= 1)", async () => {
            const page = await registry.listPage(0, 5);
            expect(page.length).to.equal(0);
        });

        it("list() returns only active offers", async () => {
            // Deregister quoteId 2
            await registry.connect(bundler).deregister(2n);
            const active = await registry.list();
            // quoteId 2 deactivated, so 4 active remain
            expect(active.length).to.equal(4);
            for (const o of active) {
                expect(o.quoteId).to.not.equal(2n);
            }
        });

        it("listPage() still returns deactivated offers (raw view)", async () => {
            const page = await registry.listPage(1, 5);
            expect(page.length).to.equal(5);
            const offer2 = page.find((o: any) => o.quoteId === 2n);
            // Deregistered offer must still appear in the raw listPage view and
            // must be the exact quoteId we looked up.
            expect(offer2!.quoteId).to.equal(2n);
            expect(offer2!.bond).to.equal(0n); // deregistered
        });

        it("activeCount() matches list().length", async () => {
            const count = await registry.activeCount();
            const active = await registry.list();
            expect(count).to.equal(BigInt(active.length));
        });
    });

    // -- Step 12: reservedBalance == balance throughout ------------------------

    describe("Step 12: reservedBalance integrity across operations", () => {
        it("fresh cycle: deposit + commit + settle + claim all maintain invariant", async () => {
            // Clean state check with a full cycle
            await checkExactReservedInvariant(escrow, "pre-cycle");

            const cid = await doCommit(escrow, user, quoteId, "invariant-cycle");
            await checkExactReservedInvariant(escrow, "after-commit");

            await escrow.connect(bundler).settle(cid);
            await checkExactReservedInvariant(escrow, "after-settle");

            // Claim whatever is pending
            const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
            if (bundlerPending > 0n) {
                await escrow.connect(bundler).claimPayout();
            }
            const feePending = await escrow.pendingWithdrawals(feeRecipient.address);
            if (feePending > 0n) {
                await escrow.connect(feeRecipient).claimPayout();
            }
            await checkExactReservedInvariant(escrow, "after-all-claims");
        });

        it("withdraw() maintains reservedBalance", async () => {
            const idleBefore = await escrow.idleBalance(bundler.address);
            if (idleBefore > 0n) {
                const withdrawAmount = idleBefore / 2n;
                if (withdrawAmount > 0n) {
                    await escrow.connect(bundler).withdraw(withdrawAmount);
                    await checkExactReservedInvariant(escrow, "after-withdraw");
                }
            }
        });
    });

    // -- Step 13: Additional edge cases & gas audit ---------------------------
    // NOTE: proxy-upgrade.test.ts covers V2Safe upgrade state-preservation and
    // the known deposit() bug. This step tests V1 (SLAEscrowTestable) only.

    describe("Step 13: Additional edge cases & gas audit", () => {
        it("accept by non-bundler reverts with NotBundler (T25: bundler consent required)", async () => {
            const reg = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
            const offer = await reg.getOffer(quoteId);
            const hash = ethers.keccak256(ethers.toUtf8Bytes("not-bundler-accept"));
            const tx = await escrow.connect(user).commit(
                quoteId, hash, offer.bundler, offer.collateralWei, offer.slaBlocks,
                { value: offer.feePerOp },
            );
            const receipt = await tx.wait();
            let cid: bigint | undefined;
            for (const log of receipt!.logs) {
                try {
                    const parsed = escrow.interface.parseLog(log);
                    if (parsed?.name === "CommitCreated") { cid = parsed.args.commitId as bigint; break; }
                } catch {}
            }
            await expect(
                (escrow as any).connect(stranger).accept(cid!),
            ).to.be.revertedWithCustomError(escrow, "NotBundler");
            // clean up: bundler accepts then settles
            await (escrow as any).connect(bundler).accept(cid!);
            await escrow.connect(bundler).settle(cid!);
        });

        it("commit to inactive quote reverts with OfferInactive", async () => {
            // quoteId 2 was deregistered in Step 11
            const offer2 = await registry.getOffer(2n);
            const hash = ethers.keccak256(ethers.toUtf8Bytes("inactive-quote-probe"));
            await expect(
                escrow.connect(user).commit(2n, hash, offer2.bundler, offer2.collateralWei, offer2.slaBlocks, { value: offer2.feePerOp }),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");
        });

        it("accept() reverts InsufficientCollateral when bundler has no idle balance", async () => {
            // Register stranger's offer; stranger has no deposited collateral
            const tx = await registry.connect(stranger).register(ONE_GWEI, SLA_BLOCKS, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const receipt = await tx.wait();
            const log = receipt!.logs
                .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e?.name === "OfferRegistered");
            const strangerQuoteId = log!.args.quoteId as bigint;
            const strangerOffer = await registry.getOffer(strangerQuoteId);

            // commit() succeeds -- collateral is not locked until accept()
            const commitTx = await escrow.connect(user).commit(
                strangerQuoteId, ethers.keccak256(ethers.toUtf8Bytes("no-collateral-accept")),
                strangerOffer.bundler, strangerOffer.collateralWei, strangerOffer.slaBlocks,
                { value: strangerOffer.feePerOp },
            );
            const commitReceipt = await commitTx.wait();
            let cid: bigint | undefined;
            for (const log of commitReceipt!.logs) {
                try {
                    const parsed = escrow.interface.parseLog(log);
                    if (parsed?.name === "CommitCreated") { cid = parsed.args.commitId as bigint; break; }
                } catch {}
            }
            // accept() reverts -- stranger has no deposited collateral
            await expect(
                (escrow as any).connect(stranger).accept(cid!),
            ).to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });

        it("withdraw more than idle reverts with InsufficientIdle", async () => {
            const totalDeposited = await escrow.deposited(bundler.address);
            await expect(
                escrow.connect(bundler).withdraw(totalDeposited + 1n),
            ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
        });

        it("double initialize reverts with InvalidInitialization", async () => {
            await expect(
                escrow.initialize(ethers.ZeroAddress, feeRecipient.address),
            ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
        });

        it("QuoteRegistry.register() validates constraints", async () => {
            await expect(
                registry.connect(bundler).register(ONE_GWEI, 0, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("slaBlocks must be > 0");

            await expect(
                registry.connect(bundler).register(ONE_GWEI, 50_401, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");

            await expect(
                registry.connect(bundler).register(COLLATERAL, SLA_BLOCKS, ONE_GWEI, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("collateralWei must be > feePerOp");
        });

        it("gas costs are reasonable (commit + accept + settle -- V1 two-phase)", async () => {
            const idle = await escrow.idleBalance(bundler.address);
            if (idle < COLLATERAL) {
                await escrow.connect(bundler).deposit({ value: COLLATERAL });
            }

            const reg = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
            const offer = await reg.getOffer(quoteId);
            const txCommit = await escrow.connect(user).commit(
                quoteId, ethers.keccak256(ethers.toUtf8Bytes("gas-check")),
                offer.bundler, offer.collateralWei, offer.slaBlocks,
                { value: offer.feePerOp },
            );
            const rcCommit = await txCommit.wait();
            const commitGas = rcCommit!.gasUsed;

            let cid: bigint | undefined;
            for (const log of rcCommit!.logs) {
                try {
                    const parsed = escrow.interface.parseLog(log);
                    if (parsed?.name === "CommitCreated") { cid = parsed.args.commitId as bigint; break; }
                } catch {}
            }
            const txAccept = await (escrow as any).connect(bundler).accept(cid!);
            const rcAccept = await txAccept.wait();
            const acceptGas = rcAccept!.gasUsed;

            const txSettle = await escrow.connect(bundler).settle(cid!);
            const rcSettle = await txSettle.wait();
            const settleGas = rcSettle!.gasUsed;

            console.log(`    Gas costs:`);
            console.log(`      commit():  ${commitGas.toString()}`);
            console.log(`      accept():  ${acceptGas.toString()}`);
            console.log(`      settle():  ${settleGas.toString()}`);

            expect(commitGas).to.be.lt(500_000n, "commit() gas unexpectedly high");
            expect(acceptGas).to.be.lt(500_000n, "accept() gas unexpectedly high");
            expect(settleGas).to.be.lt(500_000n, "settle() gas unexpectedly high");
        });
    });

    // -- Final summary --------------------------------------------------------

    describe("Final: reservedBalance global check", () => {
        it("exact balance == reservedBalance at end of all V1 tests", async () => {
            // Claim any remaining pending
            for (const signer of [bundler, user, feeRecipient, owner, stranger]) {
                const pending = await escrow.pendingWithdrawals(signer.address);
                if (pending > 0n) {
                    await escrow.connect(signer).claimPayout();
                }
            }
            await checkExactReservedInvariant(escrow, "FINAL");
            console.log(`    FINAL reservedBalance: ${ethers.formatEther(await escrow.reservedBalance())} ETH`);
            console.log(`    FINAL contract balance: ${ethers.formatEther(await ethers.provider.getBalance(await escrow.getAddress()))} ETH`);
        });
    });
});

// =============================================================================
//   V1 CLEAN SIMULATION -- exact A4 invariant, no V2 contamination
//   Fresh deployment; never upgraded; proves balance == reservedBalance exactly
//   at every checkpoint through the full protocol lifecycle.
// =============================================================================

describe("V1 protocol simulation -- exact A4 invariant (no V2 contamination)", function () {
    this.timeout(60_000);

    let registry: QuoteRegistry;
    let escrow: SLAEscrow;
    let owner: any, bundler: any, user: any, feeRecipient: any, stranger: any;
    let quoteId: bigint;

    before(async () => {
        const base = await deployEscrow({ skipRegister: true });
        registry     = base.registry;
        escrow       = base.escrow;
        owner        = base.owner;
        bundler      = base.bundler;
        user         = base.user;
        feeRecipient = base.feeRecipient;
        stranger     = base.stranger;

        const tx = await registry.connect(bundler).register(
            ONE_GWEI, SLA_BLOCKS, COLLATERAL, 302_400,
            { value: ethers.parseEther("0.0001") },
        );
        const receipt = await tx.wait();
        const log = receipt!.logs
            .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
            .find((e: any) => e?.name === "OfferRegistered");
        quoteId = log!.args.quoteId as bigint;
    });

    it("A4: balance == reservedBalance after deploy", async () => {
        await checkExactReservedInvariant(escrow, "V1-deploy");
    });

    it("A4: balance == reservedBalance after bundler deposit", async () => {
        await escrow.connect(bundler).deposit({ value: COLLATERAL * 3n });
        await checkExactReservedInvariant(escrow, "V1-deposit");
    });

    let cid0: bigint;

    it("A4: balance == reservedBalance after commit + accept (happy path)", async () => {
        cid0 = await doCommit(escrow, user, quoteId, "v1-clean-happy");
        await checkExactReservedInvariant(escrow, "V1-commit");
    });

    it("A4: balance == reservedBalance after settle", async () => {
        await escrow.connect(bundler).settle(cid0);
        await checkExactReservedInvariant(escrow, "V1-settle");
    });

    it("A4: balance == reservedBalance after claimPayout", async () => {
        const pending = await escrow.pendingWithdrawals(bundler.address);
        if (pending > 0n) await escrow.connect(bundler).claimPayout();
        await checkExactReservedInvariant(escrow, "V1-claimPayout");
    });

    let cid1: bigint;

    it("A4: balance == reservedBalance after second commit (will miss SLA)", async () => {
        cid1 = await doCommit(escrow, user, quoteId, "v1-clean-miss");
        await checkExactReservedInvariant(escrow, "V1-commit2");
    });

    it("A4: balance == reservedBalance after claimRefund (SLA miss)", async () => {
        const c = await escrow.getCommit(cid1);
        const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
        const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
        const current = BigInt(await ethers.provider.getBlockNumber());
        const blocksNeeded = Number(c.deadline - current + sg + rg) + 2;
        if (blocksNeeded > 0) await mine(blocksNeeded);

        await escrow.connect(user).claimRefund(cid1);
        const userPending = await escrow.pendingWithdrawals(user.address);
        if (userPending > 0n) await escrow.connect(user).claimPayout();
        await checkExactReservedInvariant(escrow, "V1-refund");
    });

    it("A4: balance == reservedBalance after sweepExcess + claimPayout", async () => {
        const ForceEtherFactory = await ethers.getContractFactory("ForceEther");
        const forcer = await ForceEtherFactory.deploy({ value: ethers.parseEther("0.05") });
        await (forcer as any).destroy(await escrow.getAddress());

        await escrow.connect(owner).sweepExcess();
        const recipPending = await escrow.pendingWithdrawals(feeRecipient.address);
        if (recipPending > 0n) await escrow.connect(feeRecipient).claimPayout();
        await checkExactReservedInvariant(escrow, "V1-sweep");
    });

    it("A4: balance == reservedBalance after bundler full withdraw", async () => {
        const idle = await escrow.idleBalance(bundler.address);
        if (idle > 0n) await escrow.connect(bundler).withdraw(idle);
        await checkExactReservedInvariant(escrow, "V1-withdraw");
    });

    it("FINAL: exact balance == reservedBalance after complete V1 lifecycle", async () => {
        for (const signer of [bundler, user, feeRecipient, owner, stranger]) {
            const pending = await escrow.pendingWithdrawals(signer.address);
            if (pending > 0n) await escrow.connect(signer).claimPayout();
        }
        await checkExactReservedInvariant(escrow, "V1-FINAL");
        const bal = await ethers.provider.getBalance(await escrow.getAddress());
        const res = await escrow.reservedBalance();
        expect(bal).to.equal(res);
        console.log(`    V1 FINAL: balance == reservedBalance == ${ethers.formatEther(res)} ETH`);
    });
});
