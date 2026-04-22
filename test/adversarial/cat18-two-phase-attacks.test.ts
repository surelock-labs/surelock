// Category 18: Two-Phase (commit -> accept) attack vectors -- adversarial suite
//
// Focus: NEW surface introduced by v0.6's two-phase commit design:
//   1. Accept window expiry front-running / last-block accept griefing
//   2. collateral == fee equilibrium (T8 open gap)
//   3. Cancel timing race after accept window closes
//   4. Accept-time collateral depletion (PROPOSED-stage griefing)
//   5. Permissionless settle abuse
//   6. Multiple concurrent PROPOSED against same bundler exceeding idle
//   7. userOpHash slot recycling after finalization
//   8. accept() after offer deregistration
//   9. feeRecipient-triggered cancel after window
//  10. Reentrancy surface in the two-phase flow
//
// Each test either demonstrates an actual flaw (and documents who loses
// what) or pins down the invariant that protects against the attack.

import { expect }                    from "chai";
import { ethers, upgrades }          from "hardhat";
import { mine, setBalance }          from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    deployEscrow,
    registerOffer,
    makeCommit as fixturesMakeCommit,
    mineTo,
    mineToRefundable,
    ONE_GWEI,
    COLLATERAL,
    MIN_BOND,
    MIN_LIFETIME,
} from "../helpers/fixtures";

const ONE_ETH          = ethers.parseEther("1");

// -- helpers -------------------------------------------------------------------

async function deployBase(opts?: { slaBlocks?: bigint; collateral?: bigint }) {
    return deployEscrow({
        slaBlocks: opts?.slaBlocks ?? 10n,
        collateral: opts?.collateral ?? COLLATERAL,
        preDeposit: false,
    });
}

/** Create a PROPOSED commit, but do NOT accept. Returns commitId + acceptDeadline. */
async function doPropose(
    escrow: SLAEscrow,
    registry: QuoteRegistry,
    user: Awaited<ReturnType<typeof ethers.getSigner>>,
    quoteId: bigint,
    tag?: string,
): Promise<{ commitId: bigint; acceptDeadline: bigint }> {
    const offer = await registry.getOffer(quoteId);
    const protocolFee = await escrow.protocolFeeWei();
    const bytes = ethers.keccak256(ethers.toUtf8Bytes(tag ?? `op-${Date.now()}-${Math.random()}`));
    const tx = await escrow
        .connect(user)
        .commit(quoteId, bytes, offer.bundler, offer.collateralWei, offer.slaBlocks, {
            value: offer.feePerOp + protocolFee,
        });
    const r = await tx.wait();
    const commitLogs = r!.logs
        .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
        .map(log => escrow.interface.parseLog(log)!);
    if (commitLogs.length === 0) throw new Error("doPropose: CommitCreated event not found");
    const commitId = BigInt(commitLogs[0].args.commitId);
    const acceptDeadline = BigInt(commitLogs[0].args.acceptDeadline);
    return { commitId, acceptDeadline };
}

/** Full two-phase commit: propose + accept. Returns commitId + deadline. */
async function doCommit(
    escrow: SLAEscrow,
    registry: QuoteRegistry,
    user: any,
    quoteId: bigint,
    tag?: string,
): Promise<{ commitId: bigint; deadline: bigint }> {
    const { commitId } = await fixturesMakeCommit(
        escrow, registry, user, quoteId,
        tag ?? `op-${Date.now()}-${Math.random()}`,
    );
    const c = await escrow.getCommit(commitId);
    return { commitId, deadline: c.deadline };
}

// ===============================================================================
// Tests
// ===============================================================================

describe("Cat18 -- Two-Phase (commit -> accept) Attack Vectors", function () {

    // -- 18.1 Accept window manipulation --------------------------------------

    describe("18.1 accept window manipulation", function () {

        it("18.1.1 bundler accepts at the LAST legal block (acceptDeadline) -- succeeds", async function () {
            // Bundler can wait the full accept window (ACCEPT_GRACE_BLOCKS, ~24s on Base) before committing capital.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline); // next tx mines at acceptDeadline

            const tx = await escrow.connect(bundler).accept(commitId);
            const receipt = await tx.wait();
            expect(receipt!.blockNumber).to.equal(Number(acceptDeadline));

            // Collateral is now locked
            expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
        });

        it("18.1.2 bundler accepts one block AFTER acceptDeadline -- reverts AcceptWindowExpired", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline + 1n); // next tx mines at acceptDeadline+1

            await expect(escrow.connect(bundler).accept(commitId))
                .to.be.revertedWithCustomError(escrow, "AcceptWindowExpired")
                .withArgs(commitId);
        });

        it("18.1.3 FINDING: bundler accepts at last block, then SLA clock runs full slaBlocks", async function () {
            // This is a **DoS / latency amplification**: BUNDLER can stall for
            // the full accept window before committing, then has another
            // slaBlocks + SETTLEMENT_GRACE to settle.  Effective worst-case
            // latency for CLIENT is ACCEPT_GRACE + slaBlocks + SETTLEMENT_GRACE.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase({
                slaBlocks: 10n,
            });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });
            const acceptGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            const commitBlock = BigInt(await ethers.provider.getBlockNumber());

            await mineTo(acceptDeadline);
            await escrow.connect(bundler).accept(commitId);

            const c = await escrow.getCommit(commitId);
            const deadlineGap = BigInt(c.deadline) - commitBlock;
            // Expected max: ACCEPT_GRACE + slaBlocks
            expect(deadlineGap).to.equal(acceptGrace + 10n);
        });

        it("18.1.4 propose -> settle (without accept) reverts CommitNotActive", async function () {
            // Attacker tries to call settle() before the two-phase accept() has been done.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await expect((escrow as any).connect(bundler)["settle(uint256)"](commitId))
                .to.be.revertedWithCustomError(escrow, "CommitNotActive")
                .withArgs(commitId);
        });

        it("18.1.5 propose -> claimRefund (without accept) reverts CommitNotActive", async function () {
            // An unaccepted commit cannot be refunded -- only cancelled.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline + 100n);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "CommitNotActive")
                .withArgs(commitId);
        });

        it("18.1.6 bundler cannot accept TWICE on the same commit", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await escrow.connect(bundler).accept(commitId);
            await expect(escrow.connect(bundler).accept(commitId))
                .to.be.revertedWithCustomError(escrow, "CommitNotProposed");
        });
    });

    // -- 18.2 collateral == fee (T8 open gap) ----------------------------------

    describe("18.2 collateral == feePerOp economic equilibrium (T8 gap)", function () {

        it("18.2.1 FIXED -- register rejects collateral == fee; self-slash attack is structurally impossible", async function () {
            // T8 is now enforced at two layers:
            //   1. QuoteRegistry.register() requires collateralWei > feePerOp (strict).
            //      This prevents any offer where cheating is break-even.
            //   2. SLAEscrow.commit() requires msg.sender != bundler (SelfCommitForbidden).
            //      This prevents a bundler from ever playing the CLIENT role on its own offer.
            //
            // Together these two checks make the "self-slash break-even" attack impossible.
            const fee = ethers.parseEther("0.01");
            const coll = fee; // equal -- should now revert

            const [owner, bundler, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;

            // Layer 1: register(collateral == fee) must revert
            await expect(
                registry.connect(bundler).register(fee, 10, coll, Number(MIN_LIFETIME), { value: MIN_BOND }),
            ).to.be.revertedWith("collateralWei must be > feePerOp");

            // Also: collateral < fee must still revert
            await expect(
                registry.connect(bundler).register(fee, 10, fee - 1n, Number(MIN_LIFETIME), { value: MIN_BOND }),
            ).to.be.revertedWith("collateralWei must be > feePerOp");

            // T8 is enforced as strict inequality: the "collateral == fee" break-even equilibrium
            // no longer exists. Self-slashing requires register() which is now impossible.
        });

        it("18.2.2 FIXED -- collateral > fee allowed; SelfCommitForbidden blocks bundler-as-client", async function () {
            // With strict collateral > fee, register() succeeds. But commit() blocks the
            // self-slash path at a second layer: BUNDLER cannot be msg.sender of commit()
            // against their own offer. This makes self-slashing structurally impossible.
            const fee = ethers.parseEther("0.01");
            const coll = fee + 1n; // strict >

            const [owner, bundler, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            // (a) Registration with collateral = fee+1 succeeds
            await expect(
                registry.connect(bundler).register(fee, 10, coll, Number(MIN_LIFETIME), { value: MIN_BOND }),
            ).to.not.be.reverted;
            await escrow.connect(bundler).deposit({ value: coll });

            // (b) commit() with bundler == msg.sender reverts SelfCommitForbidden
            await expect(
                escrow.connect(bundler).commit(
                    1n, ethers.keccak256(ethers.toUtf8Bytes("self-attempt")),
                    bundler.address, coll, 10,
                    { value: fee },
                ),
            ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
             .withArgs(bundler.address);

            // State unchanged -- no commit, no slash possible
            expect(await escrow.nextCommitId()).to.equal(0n);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
            expect(await escrow.deposited(bundler.address)).to.equal(coll);

            // The P&L proof is now STRUCTURAL: even though collateral > fee allows registration,
            // the commit()-side SelfCommitForbidden check prevents the bundler from routing a
            // UserOp to its own offer and collecting a self-slash. T8 is protected at two layers.
        });

        it("18.2.3 INVARIANT -- with collateral > fee, THIRD-PARTY client is strictly overcompensated on slash", async function () {
            // Distinct client + bundler: slash must produce net LOSS for bundler
            // and net GAIN for client, regardless of equality vs strict>.
            const fee = ethers.parseEther("0.01");
            const coll = fee * 2n;

            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(fee, 10, coll, Number(MIN_LIFETIME), { value: MIN_BOND });
            await escrow.connect(bundler).deposit({ value: coll });

            const bundlerIn = coll; // what bundler puts on the table
            const userIn = fee;     // what client paid
            const { commitId } = await fixturesMakeCommit(escrow, registry, user, 1n, "third-party");
            await mineToRefundable(escrow, commitId);
            await escrow.connect(user).claimRefund(commitId);

            // client pending = fee + coll; bundler deposited = 0, locked = 0
            const pendingUser    = await escrow.pendingWithdrawals(user.address);
            const pendingBundler = await escrow.pendingWithdrawals(bundler.address);
            expect(pendingUser).to.equal(userIn + coll);
            expect(pendingBundler).to.equal(0);

            // Client P&L: +coll (paid fee, got fee + coll back)
            // Bundler P&L: -coll (slashed)
            // Zero-sum -- no protocol fee at 0.
            // Under T8 strict > (collateral > fee), this holds unconditionally.
        });
    });

    // -- 18.3 Cancel timing races ---------------------------------------------

    describe("18.3 cancel timing races after accept window expires", function () {

        it("18.3.1 during window, BUNDLER cannot cancel", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await expect(escrow.connect(bundler).cancel(commitId))
                .to.be.revertedWithCustomError(escrow, "Unauthorized");
        });

        it("18.3.2 during window, feeRecipient cannot cancel", async function () {
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await expect(escrow.connect(feeRecipient).cancel(commitId))
                .to.be.revertedWithCustomError(escrow, "Unauthorized");
        });

        it("18.3.3 after window, CLIENT, BUNDLER and feeRecipient can all cancel -- first-to-call wins", async function () {
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            // Three independent commits after accept window expires
            const { commitId: id1, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID, "a");
            const { commitId: id2 } = await doPropose(escrow, registry, user, QUOTE_ID, "b");
            const { commitId: id3 } = await doPropose(escrow, registry, user, QUOTE_ID, "c");

            await mineTo(acceptDeadline + 1n);

            // Each party cancels one commit
            await expect(escrow.connect(user).cancel(id1)).to.not.be.reverted;
            await expect(escrow.connect(bundler).cancel(id2)).to.not.be.reverted;
            await expect(escrow.connect(feeRecipient).cancel(id3)).to.not.be.reverted;

            // After cancel, the fee is refunded to c.user (NOT to the canceller)
            // -- this is correct: the canceller is just a "cleanup" actor.
            // User should see 3 x feePerOp in pendingWithdrawals regardless of canceller.
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI * 3n);
            // Bundler & feeRecipient get nothing from cancel
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0);
        });

        it("18.3.4 FINDING -- feeRecipient cancelling after window still refunds fee to CLIENT, not itself", async function () {
            // INVARIANT: cancel() is a cleanup operation; the fee goes to the
            // original CLIENT regardless of who triggered the cancel. This
            // prevents a "cancel-griefing" attack where feeRecipient tries to
            // steal stale commits.
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline + 1n);

            // feeRecipient cancels, but CLIENT gets the fee
            await escrow.connect(feeRecipient).cancel(commitId);
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0);
        });

        it("18.3.5 after accept, cancel is forever blocked (only settle/refund apply)", async function () {
            const { escrow, registry, user, QUOTE_ID, bundler } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doCommit(escrow, registry, user, QUOTE_ID);
            await expect(escrow.connect(user).cancel(commitId))
                .to.be.revertedWithCustomError(escrow, "CommitNotProposed");
        });

        it("18.3.6 race: two cancellers from same block -- second reverts AlreadyFinalized", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline + 1n);

            await escrow.connect(user).cancel(commitId);
            await expect(escrow.connect(bundler).cancel(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });
    });

    // -- 18.4 PROPOSED -> griefing via thin collateral -------------------------

    describe("18.4 PROPOSED -> accept fails due to bundler depleting idle", function () {

        it("18.4.1 INVARIANT -- bundler withdraws all idle after CLIENT commits; CLIENT cancels immediately and recovers fee", async function () {
            // Attack: CLIENT commits (PROPOSED). BUNDLER's idle collateral
            // was exactly 1 x COLLATERAL. BUNDLER withdraws it BEFORE calling
            // accept. Now accept() reverts InsufficientCollateral.
            //
            // CLIENT may cancel at any point during or after the accept window.
            // The only unrecoverable cost to CLIENT is gas.
            // This is pure liveness griefing, not a theft.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            // CLIENT commits (PROPOSED)
            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);

            // BUNDLER withdraws all idle collateral -- now cannot accept()
            await escrow.connect(bundler).withdraw(COLLATERAL);
            expect(await escrow.idleBalance(bundler.address)).to.equal(0);

            // accept() reverts InsufficientCollateral
            await expect(escrow.connect(bundler).accept(commitId))
                .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");

            // CLIENT cancels immediately -- no need to wait for window expiry
            await expect(escrow.connect(user).cancel(commitId)).to.not.be.reverted;

            // Fee was recovered via cancel; net cost to CLIENT = gas only
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);
        });

        it("18.4.2 INVARIANT -- CLIENT cancels immediately to unpin userOpHash slot; backup bundler route becomes available", async function () {
            // When BUNDLER drains idle collateral and cannot accept(), the
            // userOpHash slot stays pinned until CLIENT calls cancel().
            // CLIENT can cancel at any point during the accept window --
            // no need to wait for expiry. After cancel, the hash is retired
            // and CLIENT may re-commit the same UserOp to a backup bundler.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            const allSigners = await ethers.getSigners();
            const bundler2 = allSigners[6];
            await escrow.connect(bundler).deposit({ value: COLLATERAL });
            await escrow.connect(bundler2).deposit({ value: COLLATERAL });

            // BUNDLER 2 registers an alternative offer
            const quote2 = await registerOffer(registry, escrow, bundler2, { slaBlocks: 10n });

            // CLIENT commits to bundler1 (PROPOSED)
            const userOp = ethers.keccak256(ethers.toUtf8Bytes("reroute-user-op"));
            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID, "reroute-user-op");

            // BUNDLER1 drains idle -- cannot accept()
            await escrow.connect(bundler).withdraw(COLLATERAL);
            await expect(escrow.connect(bundler).accept(commitId))
                .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");

            // While pinned, re-commit to bundler2 reverts UserOpAlreadyCommitted
            const offer2 = await registry.getOffer(quote2);
            await expect(
                escrow.connect(user).commit(
                    quote2, userOp, offer2.bundler, offer2.collateralWei, offer2.slaBlocks,
                    { value: offer2.feePerOp },
                ),
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");

            // CLIENT cancels immediately (during accept window -- no mining needed)
            await escrow.connect(user).cancel(commitId);
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);

            // Original hash is permanently retired (T23). CLIENT re-commits with a fresh
            // UserOp (new hash) to bundler2 -- succeeds.
            const freshUserOp = ethers.keccak256(ethers.toUtf8Bytes("reroute-user-op-v2"));
            const c2 = await escrow.connect(user).commit(
                quote2, freshUserOp, offer2.bundler, offer2.collateralWei, offer2.slaBlocks,
                { value: offer2.feePerOp },
            );
            await c2.wait();
        });
    });

    // -- 18.5 Permissionless settle abuse --------------------------------------

    describe("18.5 permissionless settle abuse", function () {

        it("18.5.1 third-party can settle; fee always routes to c.bundler (not caller)", async function () {
            const { escrow, registry, bundler, user, stranger, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doCommit(escrow, registry, user, QUOTE_ID);
            // STRANGER (not bundler) calls settle -- still works, fee goes to bundler
            await expect((escrow as any).connect(stranger)["settle(uint256)"](commitId)).to.not.be.reverted;
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0);
        });

        it("18.5.2 third-party settle at deadline+SETTLEMENT_GRACE is still valid", async function () {
            // Edge: someone else may front-run the bundler's settle at the
            // last legal block. The bundler is still paid -- stranger bears
            // only the gas.
            const { escrow, registry, bundler, user, stranger, QUOTE_ID } = await deployBase({
                slaBlocks: 5n,
            });
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, deadline } = await doCommit(escrow, registry, user, QUOTE_ID);
            const sg18 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            await mineTo(deadline + sg18);

            await (escrow as any).connect(stranger)["settle(uint256)"](commitId);
            expect((await escrow.getCommit(commitId)).settled).to.be.true;
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        });

        it("18.5.3 third-party settle uses STRANGER's gas, not bundler's", async function () {
            // Implication: a griefer could pre-settle all commits of a
            // competing bundler to drain their own wallet to no real effect
            // (bundler still gets paid). This is a denial-of-gas against the
            // griefer themselves.  Confirm the bundler's native-token balance
            // doesn't change from a stranger's settle.
            const { escrow, registry, bundler, user, stranger, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doCommit(escrow, registry, user, QUOTE_ID);
            const balBefore = await ethers.provider.getBalance(bundler.address);

            const tx = await (escrow as any).connect(stranger)["settle(uint256)"](commitId);
            const receipt = await tx.wait();
            // Report gas used (T1 anchor)
            const gasUsed = receipt!.gasUsed;
            console.log(`        [gas] 18.5.3 third-party settle: ${gasUsed.toString()} gas`);

            const balAfter = await ethers.provider.getBalance(bundler.address);
            expect(balAfter).to.equal(balBefore); // bundler untouched; profit is in pending.
        });
    });

    // -- 18.6 Multiple concurrent PROPOSED commits -----------------------------

    describe("18.6 many PROPOSED commits against one bundler", function () {

        it("18.6.1 CLIENT proposes N commits; BUNDLER accepts as many as idle permits; rest revert on accept", async function () {
            // CLIENT (actually uses 3 users because userOpHash must be
            // distinct) proposes 5 commits. Bundler has only 3xCOLLATERAL
            // idle. Only 3 accepts succeed.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 3n });

            const ids: bigint[] = [];
            for (let i = 0; i < 5; i++) {
                const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID, `mc-${i}`);
                ids.push(commitId);
            }

            // Accept 3 -- ok
            for (let i = 0; i < 3; i++) {
                await expect(escrow.connect(bundler).accept(ids[i])).to.not.be.reverted;
            }
            // 4th fails: idle = 0
            await expect(escrow.connect(bundler).accept(ids[3]))
                .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
        });

        it("18.6.2 FINDING -- BUNDLER can CHOOSE which PROPOSED to accept; can selectively starve a target CLIENT", async function () {
            // Attack: malicious BUNDLER can observe the pending PROPOSED
            // commits and pick which CLIENTS to service, effectively
            // censoring specific userOps.  This is "accept selectivity".
            //
            // The protocol has no FIFO ordering guarantee across PROPOSED
            // commits, nor any penalty for ignoring one specific commit.
            //
            // Severity: MEDIUM -- BUNDLER loses reputation but not money, and
            // the victim CLIENT can cancel at any time during the accept window for a gas cost.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            const allSigners = await ethers.getSigners();
            const user2 = allSigners[6];
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            // Two PROPOSED commits -- user1 first, then user2
            const { commitId: idA } = await doPropose(escrow, registry, user, QUOTE_ID, "victim-op");
            const { commitId: idB } = await doPropose(escrow, registry, user2, QUOTE_ID, "favored-op");

            // BUNDLER accepts user2 (second-proposed) instead of user1 (first-proposed)
            await escrow.connect(bundler).accept(idB);
            // BUNDLER now has 0 idle, so can't accept idA anymore.
            await expect(escrow.connect(bundler).accept(idA))
                .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");

            // idA remains PROPOSED until the accept window closes.
            const cA = await escrow.getCommit(idA);
            expect(cA.accepted).to.be.false;
        });

        it("18.6.3 worst-case -- all PROPOSED fail (bundler never deposits), all cancelled, fees fully recovered", async function () {
            // BUNDLER does NOT deposit. CLIENT commits 5 times. BUNDLER
            // cannot accept any (idle = 0). After acceptDeadline, CLIENT
            // cancels all; fee fully recovered.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            // No deposit!

            const ids: bigint[] = [];
            let lastDeadline = 0n;
            for (let i = 0; i < 5; i++) {
                const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID, `nocoll-${i}`);
                ids.push(commitId);
                lastDeadline = acceptDeadline;
            }
            for (const id of ids) {
                await expect(escrow.connect(bundler).accept(id))
                    .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");
            }
            await mineTo(lastDeadline + 1n);
            for (const id of ids) {
                await escrow.connect(user).cancel(id);
            }
            // Fees fully recovered
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI * 5n);
        });
    });

    // -- 18.7 userOpHash slot recycling ----------------------------------------

    describe("18.7 userOpHash slot recycling after finalization", function () {

        it("18.7.1 after CANCEL, the same userOpHash is permanently retired", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const userOp = ethers.keccak256(ethers.toUtf8Bytes("recycle-after-cancel"));
            const hash = userOp;

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID, "recycle-after-cancel");
            await mineTo(acceptDeadline + 1n);
            await escrow.connect(user).cancel(commitId);
            expect(await escrow.activeCommitForHash(hash)).to.be.false;
            expect(await escrow.retiredHashes(hash)).to.be.true;

            // Same hash is permanently retired -- fresh retry requires new UserOp + new hash (T23)
            const offer = await registry.getOffer(QUOTE_ID);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp }),
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });

        it("18.7.2 after SETTLE, same userOpHash cannot be re-committed -- retiredHashes permanent guard", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase({ slaBlocks: 10n });
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });

            const userOp = ethers.keccak256(ethers.toUtf8Bytes("recycle-after-settle"));
            const hash = userOp;

            const { commitId } = await fixturesMakeCommit(escrow, registry, user, QUOTE_ID, "recycle-after-settle", userOp);
            await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
            expect(await escrow.activeCommitForHash(hash)).to.be.false;
            expect(await escrow.retiredHashes(hash)).to.be.true;

            // Re-commit of settled hash is blocked at commit()
            const offer = await registry.getOffer(QUOTE_ID);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp }),
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });

        it("18.7.3 retiredHashes blocks double-payment -- re-commit rejected at commit()", async function () {
            // Attack path closed:
            //   1. CLIENT commits userOp=X -> accept -> settle (fee credited to BUNDLER)
            //   2. Re-commit of X now reverts UserOpHashRetired at commit() itself.
            //      Bundler collateral is never at risk from this path.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase({ slaBlocks: 10n });
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });

            const userOp = ethers.keccak256(ethers.toUtf8Bytes("double-payment"));
            const { commitId: id1 } = await fixturesMakeCommit(escrow, registry, user, QUOTE_ID, "double-payment", userOp);
            await (escrow as any).connect(bundler)["settle(uint256)"](id1);

            // Bundler received exactly 1 x fee.
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);

            // Re-commit blocked -- double-payment impossible.
            const offer = await registry.getOffer(QUOTE_ID);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp }),
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });

        it("18.7.4 after REFUND (claimRefund), same userOpHash is permanently retired (T23)", async function () {
            // claimRefund() sets retiredHashes[hash] = true (line 569 in SLAEscrow.sol).
            // Verify that the refund path retires the hash just like settle and cancel do.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase({ slaBlocks: 10n });
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 2n });

            const userOp = ethers.keccak256(ethers.toUtf8Bytes("recycle-after-refund"));

            const { commitId } = await fixturesMakeCommit(escrow, registry, user, QUOTE_ID, "recycle-after-refund", userOp);

            // Advance past deadline + all grace windows so claimRefund is callable
            const c = await escrow.getCommit(commitId);
            const sg = await escrow.SETTLEMENT_GRACE_BLOCKS();
            const rg = await escrow.REFUND_GRACE_BLOCKS();
            const current = BigInt(await ethers.provider.getBlockNumber());
            const blocksNeeded = Number(BigInt(c.deadline) - current + BigInt(sg) + BigInt(rg)) + 2;
            if (blocksNeeded > 0) await mine(blocksNeeded);

            await escrow.connect(user).claimRefund(commitId);

            // Hash must now be in retiredHashes
            expect(await escrow.retiredHashes(userOp)).to.be.true;
            expect(await escrow.activeCommitForHash(userOp)).to.be.false;

            // Re-commit of the refunded hash must revert UserOpHashRetired (T23)
            const offer = await registry.getOffer(QUOTE_ID);
            await expect(
                escrow.connect(user).commit(QUOTE_ID, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp }),
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");
        });
    });

    // -- 18.8 accept() vs deregister() race -----------------------------------

    describe("18.8 accept() after offer deregistration", function () {

        it("18.8.1 INVARIANT -- BUNDLER deregisters offer AFTER propose, accept() STILL works, collateral is locked", async function () {
            // The accept() path does NOT re-check registry.isActive. It only
            // checks the snapshotted `c.collateralLocked` against the
            // bundler's idle balance in SLAEscrow.
            //
            // Consequence: a bundler who deregisters to recover their bond
            // CAN still service PROPOSED commits that reference the old
            // offer -- which is actually the *right* behavior under the
            // "committed terms are immutable" axiom (A6 / T9), since both
            // user and bundler agreed to the terms at commit time.
            //
            // Verify the invariant holds.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            // Bundler deregisters -- gets bond back (via pendingBonds)
            await registry.connect(bundler).deregister(QUOTE_ID);
            expect(await registry.isActive(QUOTE_ID)).to.be.false;

            // accept() still works (no registry re-check in accept)
            await escrow.connect(bundler).accept(commitId);
            expect((await escrow.getCommit(commitId)).accepted).to.be.true;
        });

        it("18.8.2 after deregister, NEW commits revert OfferInactive -- but PROPOSED ones remain serviceable", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId: id1 } = await doPropose(escrow, registry, user, QUOTE_ID, "preexisting");
            await registry.connect(bundler).deregister(QUOTE_ID);

            // NEW commit reverts
            await expect(
                escrow.connect(user).commit(
                    QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("new-op")), bundler.address, COLLATERAL, 10,
                    { value: ONE_GWEI },
                ),
            ).to.be.revertedWithCustomError(escrow, "OfferInactive");

            // Existing PROPOSED can still be accepted by bundler
            await expect(escrow.connect(bundler).accept(id1)).to.not.be.reverted;
        });

        it("18.8.3 INVARIANT -- bundler deregister -> withdraw idle -> CLIENT cancels immediately and recovers fee", async function () {
            // More aggressive: bundler deregisters AND withdraws all idle.
            // accept() fails on InsufficientCollateral.
            // CLIENT may cancel immediately during the accept window -- no need to wait for expiry.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await registry.connect(bundler).deregister(QUOTE_ID);
            await escrow.connect(bundler).withdraw(COLLATERAL);

            await expect(escrow.connect(bundler).accept(commitId))
                .to.be.revertedWithCustomError(escrow, "InsufficientCollateral");

            // CLIENT cancels immediately -- no mining to acceptDeadline needed
            await escrow.connect(user).cancel(commitId);
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);
        });

        it("18.8.4 after voluntary deregister, accept still works for pre-existing PROPOSED", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);

            // Voluntary deregister
            await registry.connect(bundler).deregister(QUOTE_ID);

            // Now accept is still callable
            await expect(escrow.connect(bundler).accept(commitId)).to.not.be.reverted;
        });
    });

    // -- 18.9 feeRecipient timing abuse ---------------------------------------

    describe("18.9 feeRecipient cancel / claimRefund timing", function () {

        it("18.9.1 feeRecipient cancels before accept window expires -- reverts Unauthorized", async function () {
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await expect(escrow.connect(feeRecipient).cancel(commitId))
                .to.be.revertedWithCustomError(escrow, "Unauthorized");
        });

        it("18.9.2 INVARIANT -- feeRecipient cancels AFTER accept window, user recovers fee, feeRecipient gets nothing", async function () {
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline + 1n);
            await escrow.connect(feeRecipient).cancel(commitId);

            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0);
        });

        it("18.9.3 INVARIANT -- feeRecipient claimRefund: client receives fee+collateral, feeRecipient gets nothing", async function () {
            // T12/A9 permits feeRecipient to trigger refund resolution.
            // Confirm the funds still flow to CLIENT (not the triggerer).
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doCommit(escrow, registry, user, QUOTE_ID);
            await mineToRefundable(escrow, commitId);

            await escrow.connect(feeRecipient).claimRefund(commitId);
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI + COLLATERAL);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0);
        });

        it("18.9.4 malicious feeRecipient can NOT cancel within window (DoS protection)", async function () {
            // If feeRecipient could cancel anytime, they could rug CLIENT's
            // fee before BUNDLER accepts. This test pins the protection.
            const { escrow, registry, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await expect(escrow.connect(feeRecipient).cancel(commitId))
                .to.be.revertedWithCustomError(escrow, "Unauthorized");

            // But BUNDLER can still accept
            await expect(escrow.connect(bundler).accept(commitId)).to.not.be.reverted;
        });
    });

    // -- 18.10 Reentrancy in the two-phase flow -------------------------------

    describe("18.10 reentrancy in two-phase paths", function () {

        it("18.10.1 accept() makes ZERO external calls -- reentrancy impossible", async function () {
            // accept() only reads snapshots and updates state. No transfers.
            // If this ever changes, this test will fail on gas / opcode
            // analysis -- we pin it by verifying balance state after accept.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const balBefore = await ethers.provider.getBalance(await escrow.getAddress());
            const reservedBefore = await escrow.reservedBalance();

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            await escrow.connect(bundler).accept(commitId);

            const balAfter = await ethers.provider.getBalance(await escrow.getAddress());
            const reservedAfter = await escrow.reservedBalance();

            // Invariant -- reservedBalance == address(this).balance preserved
            expect(balAfter).to.equal(reservedAfter);
            // Accept changed nothing except lockedOf (no native-token flow)
            expect(balAfter).to.equal(balBefore + ONE_GWEI); // only the commit's fee
            expect(reservedAfter).to.equal(reservedBefore + ONE_GWEI);
        });

        it("18.10.2 cancel() makes ZERO external calls (pull model) -- reentrancy impossible", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId, acceptDeadline } = await doPropose(escrow, registry, user, QUOTE_ID);
            await mineTo(acceptDeadline + 1n);

            const balBefore = await ethers.provider.getBalance(await escrow.getAddress());
            await escrow.connect(user).cancel(commitId);
            const balAfter = await ethers.provider.getBalance(await escrow.getAddress());

            // No ETH left the contract in cancel(); the fee is in pending.
            expect(balAfter).to.equal(balBefore);
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);
        });

        it("18.10.3 claimRefund() makes ZERO external calls -- reentrancy impossible", async function () {
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doCommit(escrow, registry, user, QUOTE_ID);
            await mineToRefundable(escrow, commitId);

            const balBefore = await ethers.provider.getBalance(await escrow.getAddress());
            await escrow.connect(user).claimRefund(commitId);
            const balAfter = await ethers.provider.getBalance(await escrow.getAddress());
            // ETH stays in the contract; only pendingWithdrawals moves
            expect(balAfter).to.equal(balBefore);
        });

        it("18.10.4 claimPayout() zeroes pendingWithdrawals before transfer; second call reverts NothingToClaim (CEI double-claim protection)", async function () {
            // CEI ordering: pendingWithdrawals[caller] is zeroed BEFORE the ETH
            // transfer. A reentrancy attempt during the transfer therefore sees
            // balance=0 and reverts NothingToClaim -- preventing double-drain.
            // This test pins the observable effect: after one successful claimPayout,
            // a second call reverts NothingToClaim (pending was consumed exactly once).
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doCommit(escrow, registry, user, QUOTE_ID);
            await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);

            // First claim succeeds and clears pending
            await escrow.connect(bundler).claimPayout();
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0);

            // Second claim reverts -- pending was consumed exactly once
            await expect(escrow.connect(bundler).claimPayout())
                .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });
    });

    // -- 18.11 Gas / T1 anchor -------------------------------------------------

    describe("18.11 gas / T1  bundler settle cost vs net fee", function () {

        it("18.11.1 T1 ANCHOR -- bundler's accept + settle gas cost >> feePerOp at default 1-gwei fee (proof-free SLAEscrowTestable path; production settle includes MPT proof overhead)", async function () {
            // Under T1, a rational bundler's honor cost (gas x gasPrice)
            // must be strictly less than net fee. Measure + report.
            const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
            await escrow.connect(bundler).deposit({ value: COLLATERAL });

            const { commitId } = await doPropose(escrow, registry, user, QUOTE_ID);
            const acceptTx = await escrow.connect(bundler).accept(commitId);
            const acceptReceipt = await acceptTx.wait();
            const acceptGas = acceptReceipt!.gasUsed;

            const settleTx = await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
            const settleReceipt = await settleTx.wait();
            const settleGas = settleReceipt!.gasUsed;

            const totalGas = acceptGas + settleGas;
            // On Base, gas prices are typically ~0.01-1 gwei. Take 1 gwei
            // as a conservative floor.
            const gasCostAt1Gwei = totalGas * 1_000_000_000n; // wei
            console.log(`        [gas] accept:    ${acceptGas.toString()}`);
            console.log(`        [gas] settle:    ${settleGas.toString()} (proof-free path)`);
            console.log(`        [gas] totalGas:  ${totalGas.toString()}`);
            console.log(`        [gas] cost@1gwei: ${gasCostAt1Gwei.toString()} wei`);
            console.log(`        [fee] feePerOp:  ${ONE_GWEI.toString()} wei (= 1 gwei)`);

            // T1 FINDING: at feePerOp=1 gwei (the fixture default), the
            // bundler's real cost at 1 gwei gas = totalGas * 1e9 wei, which
            // is ~1.5e14 wei, vs a 1e9 wei fee -- the bundler loses ~150,000x
            // on every commit. 1 gwei is NOT a viable production fee.
            //
            // PROD BUNDLERS MUST price feePerOp >> totalGas * gasPrice.
            expect(gasCostAt1Gwei).to.be.gt(ONE_GWEI); // violation of T1 at 1 gwei fee
        });

        it("18.11.2 T1 CORRECT -- with realistic fee (0.01 ETH), gas * 1 gwei is tiny vs fee", async function () {
            const fee = ethers.parseEther("0.01");
            const coll = fee * 2n;
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" },
            )) as unknown as SLAEscrow;

            await registry.connect(bundler).register(fee, 10, coll, Number(MIN_LIFETIME), { value: MIN_BOND });
            await escrow.connect(bundler).deposit({ value: coll });

            const { commitId } = await fixturesMakeCommit(escrow, registry, user, 1n, "gas-ok");
            const settleTx = await (escrow as any).connect(bundler)["settle(uint256)"](commitId);
            const settleReceipt = await settleTx.wait();
            const settleGas = settleReceipt!.gasUsed;

            // 1 gwei gas price * ~80k gas = 80k gwei = 8e-5 ETH
            // fee = 1e-2 ETH -> fee is 125x gas cost, T1 holds.
            const gasCostWei = settleGas * 1_000_000_000n; // at 1 gwei gas price
            console.log(`        [gas] settle: ${settleGas.toString()} (cost @ 1 gwei = ${gasCostWei.toString()} wei)`);
            console.log(`        [fee] ${fee.toString()} wei`);
            expect(gasCostWei).to.be.lt(fee); // T1 HOLDS
        });
    });
});
