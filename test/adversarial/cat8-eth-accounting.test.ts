// Category 8: ETH accounting invariants -- adversarial test suite

import { expect }                   from "chai";
import { ethers, upgrades }           from "hardhat";
import { mine, setBalance }           from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    ONE_GWEI,
    COLLATERAL,
    mineToRefundable,
    assertBalanceInvariant,
} from "../helpers/fixtures";

const ONE_ETH          = ethers.parseEther("1");
const SLA_BLOCKS       = 100n;

async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
    return await ethers.provider.getBalance(await escrow.getAddress());
}


interface Ctx {
    escrow: SLAEscrow;
    registry: QuoteRegistry;
    owner: Awaited<ReturnType<typeof ethers.getSigner>>;
    bundler1: Awaited<ReturnType<typeof ethers.getSigner>>;
    bundler2: Awaited<ReturnType<typeof ethers.getSigner>>;
    user1: Awaited<ReturnType<typeof ethers.getSigner>>;
    user2: Awaited<ReturnType<typeof ethers.getSigner>>;
    feeRecipient: Awaited<ReturnType<typeof ethers.getSigner>>;
    stranger: Awaited<ReturnType<typeof ethers.getSigner>>;
    QUOTE_ID: bigint;
    QUOTE_ID_B2: bigint;
}

async function deploy(): Promise<Ctx> {
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

    // bundler1 registers quote 1
    await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID = 1n;

    // bundler2 registers quote 2
    await registry.connect(bundler2).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    const QUOTE_ID_B2 = 2n;

    return {
        escrow, registry, owner,
        bundler1, bundler2,
        user1, user2,
        feeRecipient, stranger,
        QUOTE_ID, QUOTE_ID_B2,
    };
}

// ---------------------------------------------
// Helpers
// ---------------------------------------------

async function depositAndCommit(
    ctx: Ctx,
    bundler: Awaited<ReturnType<typeof ethers.getSigner>>,
    user: Awaited<ReturnType<typeof ethers.getSigner>>,
    quoteId: bigint,
): Promise<bigint> {
    await ctx.escrow.connect(bundler).deposit({ value: ONE_ETH });
    const tx = await ctx.escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
    const receipt = await tx.wait();
    const event = receipt!.logs
        .map((l: any) => {
            try { return ctx.escrow.interface.parseLog(l); } catch { return null; }
        })
        .find((e: any) => e && e.name === "CommitCreated");
    const commitId = event!.args.commitId as bigint;
    // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
    await ctx.escrow.connect(bundler).accept(commitId);
    return commitId;
}

// ---------------------------------------------
// Test suites
// ---------------------------------------------

describe("Cat-8: ETH accounting invariants", () => {

    // =========================================================
    describe("8.1 deposit()", () => {

        it("8.1.1 single deposit preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;
            const bundlers = [bundler1.address];
            const parties: string[] = [];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after deposit");
        });

        it("8.1.2 two deposits from same bundler preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after 1st deposit");

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after 2nd deposit");

            expect(await escrow.deposited(bundler1.address)).to.equal(2n * ONE_ETH);
        });

        it("8.1.3 deposits from two different bundlers preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, bundler2 } = ctx;
            const bundlers = [bundler1.address, bundler2.address];
            await setBalance(bundler1.address, ethers.parseEther("100"));
            await setBalance(bundler2.address, ethers.parseEther("100"));

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after bundler1 deposit");

            await escrow.connect(bundler2).deposit({ value: 2n * ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after bundler2 deposit");
        });

        it("8.1.4 very small deposit (1 wei) preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;

            await escrow.connect(bundler1).deposit({ value: 1n });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n);
            expect(await escrow.deposited(bundler1.address)).to.equal(1n);
        });

        it("8.1.5 large deposit preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;
            await setBalance(bundler1.address, ethers.parseEther("200"));
            const large = ethers.parseEther("100");

            await escrow.connect(bundler1).deposit({ value: large });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n);
        });
    });

    // =========================================================
    describe("8.2 withdraw()", () => {

        it("8.2.1 partial withdrawal preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after deposit");

            await escrow.connect(bundler1).withdraw(ONE_ETH / 2n);
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after partial withdraw");
        });

        it("8.2.2 full withdrawal leaves contract empty", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after deposit");

            await escrow.connect(bundler1).withdraw(ONE_ETH);
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after full withdraw");

            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.2.3 multiple sequential partial withdrawals preserve invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            for (let i = 0; i < 5; i++) {
                await escrow.connect(bundler1).withdraw(ONE_ETH / 10n);
                await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, `withdraw #${i}`);
            }
        });

        it("8.2.4 two bundlers withdraw independently, invariant holds throughout", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, bundler2 } = ctx;
            const bundlers = [bundler1.address, bundler2.address];
            await setBalance(bundler1.address, ethers.parseEther("100"));
            await setBalance(bundler2.address, ethers.parseEther("100"));

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: 2n * ONE_ETH });

            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after deposits");

            await escrow.connect(bundler1).withdraw(ONE_ETH / 2n);
            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after b1 partial withdraw");

            await escrow.connect(bundler2).withdraw(ONE_ETH);
            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after b2 partial withdraw");

            await escrow.connect(bundler1).withdraw(ONE_ETH / 2n);
            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after b1 full withdraw");

            await escrow.connect(bundler2).withdraw(ONE_ETH);
            await assertBalanceInvariant(escrow, bundlers, [], 0n, "after b2 full withdraw");

            expect(await contractBalance(escrow)).to.equal(0n);
        });
    });

    // =========================================================
    describe("8.3 commit()", () => {

        it("8.3.1 commit: feePaid from open commit held in escrow (unresolvedFeePaid)", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after deposit");

            await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            // ONE_GWEI feePaid from open commit is unresolvedFeePaid
            await assertBalanceInvariant(escrow, [bundler1.address], [], ONE_GWEI, "after commit");
        });

        it("8.3.2 two commits: unresolvedFeePaid accumulates correctly", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await assertBalanceInvariant(escrow, [bundler1.address], [], ONE_GWEI, "after 1st commit");

            await escrow.connect(user2).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 2n * ONE_GWEI, "after 2nd commit");
        });

        it("8.3.3 commits from two bundlers: unresolvedFeePaid tracked correctly", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, bundler2, user1, user2, QUOTE_ID, QUOTE_ID_B2 } = ctx;
            await setBalance(bundler1.address, ethers.parseEther("100"));
            await setBalance(bundler2.address, ethers.parseEther("100"));

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });

            await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await assertBalanceInvariant(
                escrow, [bundler1.address, bundler2.address], [], ONE_GWEI, "after b1 commit",
            );

            await escrow.connect(user2).commit(QUOTE_ID_B2, ethers.randomBytes(32), bundler2.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await assertBalanceInvariant(
                escrow, [bundler1.address, bundler2.address], [], 2n * ONE_GWEI, "after b2 commit",
            );
        });
    });

    // =========================================================
    describe("8.4 settle()", () => {

        it("8.4.1 settle moves fee from pendingFees to pendingWithdrawals", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            // After commit: ONE_GWEI feePaid is unresolvedFeePaid
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address, user1.address],
                ONE_GWEI, "after commit",
            );

            await escrow.connect(bundler1).settle(commitId);

            const bundlerNet = ONE_GWEI; // PROTOCOL_FEE_WEI=0: bundler gets full feePaid

            // After settle: unresolvedFeePaid = 0; pendingWithdrawals[bundler] += bundlerNet
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address, user1.address],
                0n, "after settle",
            );

            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(bundlerNet);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("8.4.2 settle -- all fee to bundler (PROTOCOL_FEE_WEI=0)", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await escrow.connect(bundler1).settle(commitId);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "settle PROTOCOL_FEE_WEI=0",
            );
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
        });

        it("8.4.3 settle -- bundler gets full fee, feeRecipient gets 0 (PROTOCOL_FEE_WEI=0)", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await escrow.connect(bundler1).settle(commitId);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "settle PROTOCOL_FEE_WEI=0",
            );
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
        });

        it("8.4.4 multiple settles from same bundler accumulate correctly", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address, user1.address],
                ONE_GWEI, "after commit1",
            );

            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address, user2.address],
                2n * ONE_GWEI, "after commit2",
            );

            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address, user1.address, user2.address],
                ONE_GWEI, "after settle1",
            );

            await escrow.connect(bundler1).settle(id2);
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address, user1.address, user2.address],
                0n, "after settle2",
            );
        });
    });

    // =========================================================
    describe("8.5 claimRefund()", () => {

        it("8.5.1 claimRefund moves fee+slash to pendingWithdrawals, slashes deposited", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await mineToRefundable(escrow, commitId);

            const bundlerDepositBefore = await escrow.deposited(bundler1.address);

            await escrow.connect(user1).claimRefund(commitId);

            const userTotal = ONE_GWEI + COLLATERAL;

            await assertBalanceInvariant(
                escrow, [bundler1.address], [user1.address, feeRecipient.address, bundler1.address],
                0n, "after claimRefund",
            );

            expect(await escrow.deposited(bundler1.address)).to.equal(bundlerDepositBefore - COLLATERAL);
            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(userTotal);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("8.5.2 after full slash deposited[bundler] decreases by collateralLocked", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            // Deposit EXACTLY collateral -- no extra -- so after slash deposited = 0
            await escrow.connect(bundler1).deposit({ value: COLLATERAL });

            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const receipt = await tx.wait();
            const event = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = event!.args.commitId as bigint;
            // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
            await escrow.connect(bundler1).accept(commitId);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            // deposited should now be 0 (all collateral slashed)
            expect(await escrow.deposited(bundler1.address)).to.equal(0n);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [user1.address, feeRecipient.address],
                0n, "after full slash",
            );
        });

        it("8.5.3 invariant holds after slash: sum(deposited)+sum(pendingWithdrawals)+unresolvedFeePaid == balance", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            // After claimRefund: no unresolvedFeePaid remains
            await assertBalanceInvariant(
                escrow, [bundler1.address], [user1.address, feeRecipient.address],
                0n, "after claimRefund",
            );
        });
    });

    // =========================================================
    describe("8.6 claimPayout()", () => {

        it("8.6.1 claimPayout decreases pendingWithdrawals and contract balance equally", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(commitId);

            const bundlerNet = ONE_GWEI;
            const balBefore = await contractBalance(escrow);

            await escrow.connect(bundler1).claimPayout();

            expect(await contractBalance(escrow)).to.equal(balBefore - bundlerNet);
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "after bundler claimPayout",
            );
        });

        it("8.6.2 all parties claimPayout leaves correct final balance", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(commitId);

            await escrow.connect(bundler1).claimPayout();
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "after bundler claim",
            );

            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim; invariant still holds
            const feeRecipientPending = await escrow.pendingWithdrawals(feeRecipient.address);
            if (feeRecipientPending > 0n) {
                await escrow.connect(feeRecipient).claimPayout();
            }
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "after feeRecipient step",
            );

            // remaining balance = bundler1's idle deposit (ONE_ETH - COLLATERAL already freed)
            // deposited[bundler1] = ONE_ETH (deposit not withdrawn)
            const expectedBalance = await escrow.deposited(bundler1.address);
            expect(await contractBalance(escrow)).to.equal(expectedBalance);
        });

        it("8.6.3 fee recipient claimPayout after refund decreases balance correctly", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);
            await assertBalanceInvariant(
                escrow, [bundler1.address], [user1.address, feeRecipient.address],
                0n, "after claimRefund",
            );

            // 100% slash goes to user; feeRecipient gets 0 on refund
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);

            // No pending for feeRecipient; skip claimPayout to avoid NothingToClaim
            await assertBalanceInvariant(
                escrow, [bundler1.address], [user1.address, feeRecipient.address],
                0n, "after feeRecipient claimPayout",
            );
        });
    });

    // =========================================================
    describe("8.7 Full lifecycle -- happy path", () => {

        it("8.7.1 deposit->commit->settle->claimPayout->withdraw leaves contract empty", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            // deposit
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after deposit");

            // commit
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit");

            // settle
            await escrow.connect(bundler1).settle(commitId);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after settle");

            // claimPayout (bundler)
            await escrow.connect(bundler1).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after bundler claim");

            // claimPayout (feeRecipient) -- PROTOCOL_FEE_WEI=0, nothing queued, skip to avoid NothingToClaim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after fee claim");

            // withdraw remaining deposit
            const remaining = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(remaining);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after withdraw");

            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.7.2 multiple commits, all settled, full drain", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address, user2.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "initial deposit");

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit1");

            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "after commit2");

            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after settle1");

            await escrow.connect(bundler1).settle(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after settle2");

            await escrow.connect(bundler1).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "bundler claimed");

            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "fee claimed");

            const remaining = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(remaining);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "fully drained");

            expect(await contractBalance(escrow)).to.equal(0n);
        });
    });

    // =========================================================
    describe("8.8 Full lifecycle -- sad path (refund)", () => {

        it("8.8.1 deposit->commit->claimRefund->all claimPayout leaves contract empty", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after deposit");

            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit");

            await mineToRefundable(escrow, commitId);

            await escrow.connect(user1).claimRefund(commitId);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after claimRefund");

            await escrow.connect(user1).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after user claimPayout");

            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after fee step");

            // withdraw remaining deposit (slashed portion already deducted from deposited)
            const remaining = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(remaining);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after bundler withdraw");

            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.8.2 partial withdrawal after claimRefund preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after claimRefund");

            // partial withdraw of remaining idle balance
            const idle = await escrow.idleBalance(bundler1.address);
            await escrow.connect(bundler1).withdraw(idle / 2n);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after partial withdraw");
        });
    });

    // =========================================================
    describe("8.9 Mixed settle + refund", () => {

        it("8.9.1 one commit settled, one refunded -- invariant throughout", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address, user2.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "initial deposit");

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit1");

            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "after commit2");

            // settle id1
            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after settle id1");

            // expire and refund id2
            await mineToRefundable(escrow, id2);
            await escrow.connect(user2).claimRefund(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after refund id2");

            // all parties claim
            await escrow.connect(bundler1).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "bundler claimed");

            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "fee step");

            await escrow.connect(user2).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "user2 claimed");

            const remaining = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(remaining);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "fully drained");

            expect(await contractBalance(escrow)).to.equal(0n);
        });
    });

    // =========================================================
    describe("8.10 Two bundlers, two users -- parallel commits", () => {

        it("8.10.1 parallel commits mix of settle and refund -- invariant throughout", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, bundler2, user1, user2, feeRecipient, QUOTE_ID, QUOTE_ID_B2 } = ctx;
            const bundlers = [bundler1.address, bundler2.address];
            const parties  = [bundler1.address, bundler2.address, feeRecipient.address, user1.address, user2.address];
            await setBalance(bundler1.address, ethers.parseEther("100"));
            await setBalance(bundler2.address, ethers.parseEther("100"));

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "both deposited");

            // user1 -> bundler1, user2 -> bundler2
            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "commit1");

            const id2 = await depositAndCommit(ctx, bundler2, user2, QUOTE_ID_B2);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "commit2");

            // bundler1 settles, bundler2 misses deadline
            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after b1 settle");

            await mineToRefundable(escrow, id2);
            await escrow.connect(user2).claimRefund(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after user2 refund");

            // drain all (feeRecipient has nothing when PROTOCOL_FEE_WEI=0)
            await escrow.connect(bundler1).claimPayout();
            await escrow.connect(user2).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "all payouts claimed");

            const rem1 = await escrow.deposited(bundler1.address);
            const rem2 = await escrow.deposited(bundler2.address);
            if (rem1 > 0n) await escrow.connect(bundler1).withdraw(rem1);
            if (rem2 > 0n) await escrow.connect(bundler2).withdraw(rem2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "all withdrawn");

            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.10.2 both bundlers settle -- contract drains fully", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, bundler2, user1, user2, feeRecipient, QUOTE_ID, QUOTE_ID_B2 } = ctx;
            const bundlers = [bundler1.address, bundler2.address];
            const parties  = [bundler1.address, bundler2.address, feeRecipient.address, user1.address, user2.address];
            await setBalance(bundler1.address, ethers.parseEther("100"));
            await setBalance(bundler2.address, ethers.parseEther("100"));

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            const id2 = await depositAndCommit(ctx, bundler2, user2, QUOTE_ID_B2);

            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after b1 settle");

            await escrow.connect(bundler2).settle(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after b2 settle");

            await escrow.connect(bundler1).claimPayout();
            await escrow.connect(bundler2).claimPayout();
            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "all claims done");

            const rem1 = await escrow.deposited(bundler1.address);
            const rem2 = await escrow.deposited(bundler2.address);
            await escrow.connect(bundler1).withdraw(rem1);
            await escrow.connect(bundler2).withdraw(rem2);

            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.10.3 both bundlers refunded -- contract drains fully", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, bundler2, user1, user2, feeRecipient, QUOTE_ID, QUOTE_ID_B2 } = ctx;
            const bundlers = [bundler1.address, bundler2.address];
            const parties  = [bundler1.address, bundler2.address, feeRecipient.address, user1.address, user2.address];
            await setBalance(bundler1.address, ethers.parseEther("100"));
            await setBalance(bundler2.address, ethers.parseEther("100"));

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await escrow.connect(bundler2).deposit({ value: ONE_ETH });

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            const id2 = await depositAndCommit(ctx, bundler2, user2, QUOTE_ID_B2);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "after both commits");

            {
                const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
                const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
                await mine(Number(SLA_BLOCKS) + Number(sg) + Number(rg) + 2);
            }

            await escrow.connect(user1).claimRefund(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after refund1");

            await escrow.connect(user2).claimRefund(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after refund2");

            await escrow.connect(user1).claimPayout();
            await escrow.connect(user2).claimPayout();
            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after all payouts");

            const rem1 = await escrow.deposited(bundler1.address);
            const rem2 = await escrow.deposited(bundler2.address);
            if (rem1 > 0n) await escrow.connect(bundler1).withdraw(rem1);
            if (rem2 > 0n) await escrow.connect(bundler2).withdraw(rem2);

            expect(await contractBalance(escrow)).to.equal(0n);
        });
    });

    // =========================================================
    describe("8.11 Multiple simultaneous open commits -- unresolvedFeePaid tracking", () => {

        it("8.11.1 five open commits then five settles -- unresolvedFeePaid decreases with each settle", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, feeRecipient, QUOTE_ID } = ctx;
            const [, , , , , , , extra1, extra2, extra3] = await ethers.getSigners();
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const users  = [extra1, extra2, extra3];
            const ids: bigint[] = [];

            for (const u of users) {
                const tx = await escrow.connect(u).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
                const r = await tx.wait();
                const ev = r!.logs
                    .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                    .find((e: any) => e && e.name === "CommitCreated");
                const id = ev!.args.commitId as bigint;
                // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
                await escrow.connect(bundler1).accept(id);
                ids.push(id);
                await assertBalanceInvariant(
                    escrow, bundlers, [...parties, u.address],
                    BigInt(ids.length) * ONE_GWEI,
                    `after commit #${ids.length}`,
                );
            }

            let openFees = BigInt(ids.length) * ONE_GWEI;
            for (const id of ids) {
                await escrow.connect(bundler1).settle(id);
                openFees -= ONE_GWEI;
                await assertBalanceInvariant(escrow, bundlers, parties, openFees, `after settle ${id}`);
            }

            expect(openFees).to.equal(0n);
        });

        it("8.11.2 unresolvedFeePaid equals count × feePaid for open commits", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, [bundler1.address, feeRecipient.address, user1.address], ONE_GWEI, "1 open");

            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, [bundler1.address, feeRecipient.address, user1.address, user2.address], 2n * ONE_GWEI, "2 open");

            // settle one -- unresolvedFeePaid drops by ONE_GWEI
            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, [bundler1.address, feeRecipient.address, user1.address, user2.address], ONE_GWEI, "1 settled, 1 open");

            // settle two -- all feePaid resolved
            await escrow.connect(bundler1).settle(id2);
            await assertBalanceInvariant(escrow, bundlers, [bundler1.address, feeRecipient.address, user1.address, user2.address], 0n, "both settled");
        });
    });

    // =========================================================
    describe("8.12 Force-send ETH (selfdestruct vector)", () => {

        it("8.12.1 force-sent ETH makes balance > reservedBalance; accounting maps are unaffected", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, feeRecipient } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const escrowAddr   = await escrow.getAddress();
            const reservedBefore = await escrow.reservedBalance();
            const balBefore    = await contractBalance(escrow);
            expect(balBefore).to.equal(reservedBefore); // tight before force-send

            // Force-send 0.5 ETH by bumping the account balance directly
            // (simulates a selfdestruct send that bypasses receive()).
            const forcedAmount = ethers.parseEther("0.5");
            await setBalance(escrowAddr, balBefore + forcedAmount);

            const balAfter     = await contractBalance(escrow);
            const reservedAfter = await escrow.reservedBalance(); // unchanged
            expect(balAfter).to.equal(balBefore + forcedAmount);
            expect(reservedAfter).to.equal(reservedBefore); // accounting unaffected

            // balance > reservedBalance: the accounting maps (deposited, pendingWithdrawals)
            // are correct; only the raw ETH balance is inflated.
            expect(balAfter).to.be.gt(reservedAfter);
            expect(balAfter - reservedAfter).to.equal(forcedAmount);

            // deposited mapping is untouched
            expect(await escrow.deposited(bundler1.address)).to.equal(ONE_ETH);

            // sweepExcess() moves excess to feeRecipient.pendingWithdrawals, restoring the invariant
            await escrow.sweepExcess();
            const reservedAfterSweep = await escrow.reservedBalance();
            expect(reservedAfterSweep).to.equal(balAfter);           // invariant restored
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(forcedAmount);
        });
    });

    // =========================================================
    describe("8.13 PROTOCOL_FEE_WEI edge cases", () => {

        it("8.13.1 PROTOCOL_FEE_WEI=0 -- feeRecipient pendingWithdrawals never increases after settle", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(commitId);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "settle PROTOCOL_FEE_WEI=0",
            );
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
        });

        it("8.13.2 PROTOCOL_FEE_WEI=0 -- full lifecycle drains to zero", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit");

            await escrow.connect(bundler1).settle(id);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after settle");

            await escrow.connect(bundler1).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after claim");

            const rem = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(rem);
            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.13.3 PROTOCOL_FEE_WEI=0 -- invariant holds across commit/settle/claim", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit");

            await escrow.connect(bundler1).settle(id);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after settle");

            const bNet = ONE_GWEI;
            const fee  = 0n;
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(bNet);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(fee);

            await escrow.connect(bundler1).claimPayout();
            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after claims");
        });

        it("8.13.4 PROTOCOL_FEE_WEI=0 -- claimRefund invariant holds", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            await mineToRefundable(escrow, id);
            await escrow.connect(user1).claimRefund(id);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after claimRefund");

            await escrow.connect(user1).claimPayout();
            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim on refund
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after claims");
        });
    });

    // =========================================================
    describe("8.14 Invariant across many sequential operations", () => {

        it("8.14.1 10 deposits, 10 commits, 5 settle, 5 refund -- invariant holds each step", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, feeRecipient, QUOTE_ID } = ctx;
            const allSigners = await ethers.getSigners();
            // use signers 7..16 as users
            const users = allSigners.slice(7, 17);
            const bundlers = [bundler1.address];
            const allParties = [bundler1.address, feeRecipient.address, ...users.map(u => u.address)];

            // big deposit so bundler has enough collateral for 10 commits
            await escrow.connect(bundler1).deposit({ value: ethers.parseEther("10") });
            await assertBalanceInvariant(escrow, bundlers, allParties, 0n, "initial deposit");

            const ids: bigint[] = [];
            for (let i = 0; i < 10; i++) {
                const tx = await escrow.connect(users[i]).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
                const r = await tx.wait();
                const ev = r!.logs
                    .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                    .find((e: any) => e && e.name === "CommitCreated");
                const id = ev!.args.commitId as bigint;
                // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
                await escrow.connect(bundler1).accept(id);
                ids.push(id);
                await assertBalanceInvariant(
                    escrow, bundlers, allParties, BigInt(ids.length) * ONE_GWEI, `commit #${i}`,
                );
            }

            // settle first 5
            for (let i = 0; i < 5; i++) {
                await escrow.connect(bundler1).settle(ids[i]);
                const openFees = BigInt(10 - (i + 1)) * ONE_GWEI;
                await assertBalanceInvariant(escrow, bundlers, allParties, openFees, `settle #${i}`);
            }

            // expire and refund last 5
            {
                const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
                const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
                await mine(Number(SLA_BLOCKS) + Number(sg) + Number(rg) + 2);
            }
            for (let i = 5; i < 10; i++) {
                await escrow.connect(users[i]).claimRefund(ids[i]);
                const openFees = BigInt(10 - (i + 1)) * ONE_GWEI;
                await assertBalanceInvariant(escrow, bundlers, allParties, openFees, `refund #${i}`);
            }

            // PROTOCOL_FEE_WEI=0: bundler earns ONE_GWEI for each of the 5 settled commits
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(5n * ONE_GWEI);
        });

        it("8.14.2 invariant holds after interleaved deposit/commit/settle/withdraw", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address, user2.address];

            // step 1: deposit
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "step1");

            // step 2: commit
            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "step2");

            // step 3: extra deposit mid-flight
            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "step3");

            // step 4: another commit
            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "step4");

            // step 5: settle id1
            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "step5");

            // step 6: partial withdraw (idle balance)
            const idle = await escrow.idleBalance(bundler1.address);
            await escrow.connect(bundler1).withdraw(idle / 2n);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "step6");

            // step 7: settle id2
            await escrow.connect(bundler1).settle(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "step7");

            // step 8: claim bundler
            await escrow.connect(bundler1).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "step8");

            // step 9: PROTOCOL_FEE_WEI=0 -- feeRecipient has nothing to claim
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "step9");

            // step 10: full withdraw remaining
            const rem = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(rem);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "step10");

            expect(await contractBalance(escrow)).to.equal(0n);
        });

        it("8.14.3 repeated deposit-withdraw cycles preserve zero balance", async () => {
            const ctx = await deploy();
            const { escrow, bundler1 } = ctx;

            for (let i = 0; i < 5; i++) {
                await escrow.connect(bundler1).deposit({ value: ONE_ETH });
                await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, `deposit cycle ${i}`);

                await escrow.connect(bundler1).withdraw(ONE_ETH);
                await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, `withdraw cycle ${i}`);

                expect(await contractBalance(escrow)).to.equal(0n);
            }
        });
    });

    // =========================================================
    describe("8.15 Slash accounting edge cases", () => {

        it("8.15.1 slash halves collateral correctly -- no wei lost", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const commitId = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            const depBefore = await escrow.deposited(bundler1.address);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            const depAfter = await escrow.deposited(bundler1.address);
            const userPW   = await escrow.pendingWithdrawals(user1.address);
            const feePW    = await escrow.pendingWithdrawals(feeRecipient.address);

            // deposited decreased by collateral
            expect(depBefore - depAfter).to.equal(COLLATERAL);

            // user gets feePaid + full collateral (100% slash to client)
            expect(userPW).to.equal(ONE_GWEI + COLLATERAL);

            // feeRecipient gets 0 on refund
            expect(feePW).to.equal(0n);

            // No ETH created or destroyed
            const contractBal = await contractBalance(escrow);
            expect(contractBal).to.equal(depAfter + userPW + feePW);
        });

        it("8.15.2 odd collateral -- full slash to user, no wei leak", async () => {
            // Use collateral = 5 wei (odd); user gets feePaid + collateral = 3 + 5 = 8; feeRecipient gets 0
            const [, bundler, , user1, , feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;

            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow, [await registry.getAddress(), feeRecipient.address], { kind: "uups" }
            )) as unknown as SLAEscrow;

            // fee = 3 wei, collateral = 5 wei (collateral must be strictly > fee)
            await registry.connect(bundler).register(3n, 2, 5n, 302_400, { value: ethers.parseEther("0.0001") });
            const QUOTE_ID = 1n;

            await escrow.connect(bundler).deposit({ value: 1000n });
            await assertBalanceInvariant(escrow, [bundler.address], [], 0n, "after deposit");

            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler.address, 5n, 2, { value: 3n });
            const r = await tx.wait();
            const ev = r!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
            await escrow.connect(bundler).accept(commitId);

            await assertBalanceInvariant(escrow, [bundler.address], [], 3n, "after commit");

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            const dep = await escrow.deposited(bundler.address);
            const pw_user = await escrow.pendingWithdrawals(user1.address);
            const pw_fee  = await escrow.pendingWithdrawals(feeRecipient.address);
            const bal = await contractBalance(escrow);

            // Verify: no wei lost
            expect(bal).to.equal(dep + pw_user + pw_fee);

            // 100% slash to client: user gets feePaid + collateral = 3 + 5 = 8
            expect(pw_user).to.equal(3n + 5n);
            expect(pw_fee).to.equal(0n);
        });

        it("8.15.3 collateral = 2 wei -- user gets feePaid + collateral, no wei leak", async () => {
            const [owner, bundler, , user1, , feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow, [await registry.getAddress(), feeRecipient.address], { kind: "uups" }
            )) as unknown as SLAEscrow;

            // fee = 1 wei, collateral = 2 wei (collateral must be strictly > fee)
            await registry.connect(bundler).register(1n, 2, 2n, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: 1000n });

            const tx = await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler.address, 2n, 2, { value: 1n });
            const r = await tx.wait();
            const ev = r!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
            await escrow.connect(bundler).accept(commitId);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            const dep    = await escrow.deposited(bundler.address);
            const pw_u   = await escrow.pendingWithdrawals(user1.address);
            const pw_fee = await escrow.pendingWithdrawals(feeRecipient.address);
            const bal    = await contractBalance(escrow);

            expect(bal).to.equal(dep + pw_u + pw_fee);
            // 100% slash to user: user gets feePaid + collateral = 1 + 2 = 3
            expect(pw_u).to.equal(1n + 2n);
            expect(pw_fee).to.equal(0n);
        });

        it("8.15.4 multiple refunds do not double-count slash in deposited", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address, user2.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit1");

            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "after commit2");

            {
                const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
                const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
                await mine(Number(SLA_BLOCKS) + Number(sg) + Number(rg) + 2);
            }

            await escrow.connect(user1).claimRefund(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after refund1");

            await escrow.connect(user2).claimRefund(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after refund2");

            // deposited should have been slashed twice
            // initial ONE_ETH + 2 x ONE_ETH from depositAndCommit = 3 x ONE_ETH
            const dep = await escrow.deposited(bundler1.address);
            expect(dep).to.equal(3n * ONE_ETH - 2n * COLLATERAL);
        });
    });

    // =========================================================
    describe("8.16 claimPayout reduces pendingWithdrawals to zero", () => {

        it("8.16.1 claimPayout zeroes out caller's pendingWithdrawals", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(id);

            // PROTOCOL_FEE_WEI=0: bundler earns the full feePerOp = ONE_GWEI
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
            await escrow.connect(bundler1).claimPayout();
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(0n);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "after claimPayout",
            );
        });

        it("8.16.2 calling claimPayout twice fails second time (NothingToClaim)", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await escrow.connect(bundler1).settle(id);

            await escrow.connect(bundler1).claimPayout();
            await expect(escrow.connect(bundler1).claimPayout()).to.be.revertedWithCustomError(
                escrow, "NothingToClaim",
            );

            // invariant still holds after the failed second claim
            const { feeRecipient } = ctx;
            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "after double-claim attempt",
            );
        });
    });

    // =========================================================
    describe("8.17 Contract balance never goes negative", () => {

        it("8.17.1 balance is always >= 0 through lifecycle", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            const checkNonNegative = async (label: string) => {
                const bal = await contractBalance(escrow);
                expect(bal, `negative balance at ${label}`).to.be.gte(0n);
            };

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await checkNonNegative("after deposit");

            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await checkNonNegative("after commit");

            await escrow.connect(bundler1).settle(id);
            await checkNonNegative("after settle");

            await escrow.connect(bundler1).claimPayout();
            await checkNonNegative("after bundler claim");

            // PROTOCOL_FEE_WEI=0: feeRecipient has nothing to claim; balance still non-negative
            await checkNonNegative("after fee step");

            const rem = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(rem);
            await checkNonNegative("after withdraw");
        });
    });

    // =========================================================
    describe("8.18 deposited[bundler] consistency with lockedOf", () => {

        it("8.18.1 lockedOf[bundler] returns to 0 after settle", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);

            await escrow.connect(bundler1).settle(id);
            expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, feeRecipient.address],
                0n, "after settle, locked=0",
            );
        });

        it("8.18.2 lockedOf[bundler] returns to 0 after claimRefund", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);

            expect(await escrow.lockedOf(bundler1.address)).to.equal(COLLATERAL);

            await mineToRefundable(escrow, id);
            await escrow.connect(user1).claimRefund(id);

            expect(await escrow.lockedOf(bundler1.address)).to.equal(0n);

            await assertBalanceInvariant(
                escrow, [bundler1.address], [bundler1.address, user1.address, feeRecipient.address],
                0n, "after refund, locked=0",
            );
        });

        it("8.18.3 idle balance + locked equals deposited", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);

            const dep    = await escrow.deposited(bundler1.address);
            const locked = await escrow.lockedOf(bundler1.address);
            const idle   = await escrow.idleBalance(bundler1.address);

            expect(idle + locked).to.equal(dep);
        });
    });

    // =========================================================
    describe("8.19 Accounting with feeRecipient == bundler", () => {

        it("8.19.1 feeRecipient same as bundler -- total payout is full feePaid", async () => {
            // Deploy where feeRecipient == bundler1
            const [owner, bundler1, , user1] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            // bundler1 is also feeRecipient
            const escrow = (await upgrades.deployProxy(
                Escrow, [await registry.getAddress(), bundler1.address], { kind: "uups" }
            )) as unknown as SLAEscrow;

            await registry.connect(bundler1).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, [bundler1.address], [], 0n, "after deposit");

            const tx = await escrow.connect(user1).commit(1n, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const r = await tx.wait();
            const ev = r!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
            await escrow.connect(bundler1).accept(commitId);

            await assertBalanceInvariant(escrow, [bundler1.address], [bundler1.address], ONE_GWEI, "after commit");

            await escrow.connect(bundler1).settle(commitId);
            // pendingWithdrawals[bundler1] = feePaid (bundler gets full fee; PROTOCOL_FEE_WEI=0)
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);

            await assertBalanceInvariant(escrow, [bundler1.address], [bundler1.address], 0n, "after settle");
        });
    });

    // =========================================================
    describe("8.20 unresolvedFeePaid tracked correctly across concurrent commits", () => {

        it("8.20.1 opening and closing commits in LIFO order preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address, user2.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const id1 = await depositAndCommit(ctx, bundler1, user1, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "1 open");

            const id2 = await depositAndCommit(ctx, bundler1, user2, QUOTE_ID);
            await assertBalanceInvariant(escrow, bundlers, parties, 2n * ONE_GWEI, "2 open");

            // close in LIFO order
            await escrow.connect(bundler1).settle(id2);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "1 closed, 1 open");

            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "both closed");
        });

        it("8.20.2 opening commits alternating with settling preserves invariant", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, feeRecipient, QUOTE_ID } = ctx;
            const allSigners = await ethers.getSigners();
            const users = allSigners.slice(7, 13);
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, ...users.map(u => u.address)];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            // commit, settle, commit, settle ... alternating
            for (let i = 0; i < 6; i++) {
                const tx = await escrow.connect(users[i]).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
                const r = await tx.wait();
                const ev = r!.logs
                    .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                    .find((e: any) => e && e.name === "CommitCreated");
                const id = ev!.args.commitId as bigint;
                // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
                await escrow.connect(bundler1).accept(id);
                await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, `after open ${i}`);

                await escrow.connect(bundler1).settle(id);
                await assertBalanceInvariant(escrow, bundlers, parties, 0n, `after settle ${i}`);
            }
        });
    });

    // =========================================================
    describe("8.21 deposited >= lockedOf solvency invariant", () => {

        it("8.21.1 deposited >= lockedOf after each commit", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            for (let i = 0; i < 5; i++) {
                const u = i % 2 === 0 ? user1 : user2;
                const tx = await escrow.connect(u).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
                const r = await tx.wait();
                const ev = r!.logs
                    .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                    .find((e: any) => e && e.name === "CommitCreated");
                const id = ev!.args.commitId as bigint;
                // Two-phase: bundler must accept() to lock collateral (PROPOSED -> ACTIVE).
                await escrow.connect(bundler1).accept(id);
                const dep = await escrow.deposited(bundler1.address);
                const locked = await escrow.lockedOf(bundler1.address);
                expect(dep, `deposited < lockedOf after commit #${i}`).to.be.gte(locked);
            }
        });

        it("8.21.2 deposited >= lockedOf after settle releases collateral", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const r = await tx.wait();
            const ev = r!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
            await escrow.connect(bundler1).accept(commitId);

            await escrow.connect(bundler1).settle(commitId);
            const dep = await escrow.deposited(bundler1.address);
            const locked = await escrow.lockedOf(bundler1.address);
            expect(dep).to.be.gte(locked);
            expect(locked).to.equal(0n);
        });

        it("8.21.3 deposited >= lockedOf after claimRefund slashes collateral", async () => {
            const ctx = await deploy();
            const { escrow, bundler1, user1, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const r = await tx.wait();
            const ev = r!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            // Two-phase: bundler must accept() to transition PROPOSED -> ACTIVE.
            await escrow.connect(bundler1).accept(commitId);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            const dep = await escrow.deposited(bundler1.address);
            const locked = await escrow.lockedOf(bundler1.address);
            expect(dep).to.be.gte(locked);
            // Both deposited and locked decrease: locked to 0, deposited by collateral
            expect(locked).to.equal(0n);
            expect(dep).to.equal(ONE_ETH - COLLATERAL);
        });
    });

    // =========================================================
    describe("8.22 duplicate userOpHash", () => {

        it("8.22.1 second commit with same userOpHash reverts; balance invariant holds after first settles", async () => {
            // activeCommitForHash blocks the second commit entirely, so only one
            // commit exists. Balance invariant is checked before and after settle.
            const ctx = await deploy();
            const { escrow, bundler1, user1, user2, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address, user2.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const hash = ethers.keccak256(ethers.toUtf8Bytes("duplicate"));
            const commitTx = await escrow.connect(user1).commit(QUOTE_ID, hash, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const commitRec = await commitTx.wait();
            const commitEv  = commitRec!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const firstCommitId = commitEv!.args.commitId as bigint;

            // Second commit with same hash is rejected: balance invariant still holds
            await expect(
                escrow.connect(user2).commit(QUOTE_ID, hash, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI })
            ).to.be.revertedWithCustomError(escrow, "UserOpAlreadyCommitted");

            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after 1 commit + 1 rejected");

            // Two-phase: bundler accepts to transition PROPOSED -> ACTIVE
            await escrow.connect(bundler1).accept(firstCommitId);

            // Settle the first commit; hash is cleared
            await escrow.connect(bundler1).settle(firstCommitId);

            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after first settled");
        });

        it("8.22.2 same userOpHash: re-commit after settle reverts UserOpHashRetired (T1/18.7.3)", async () => {
            // retiredHashes is permanent -- same hash can never be re-committed or settled twice.
            // commit() now checks retiredHashes, so the attack path is closed at source.
            const ctx = await deploy();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });

            const hash = ethers.keccak256(ethers.toUtf8Bytes("reuse"));
            const tx1 = await escrow.connect(user1).commit(QUOTE_ID, hash, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const r1 = await tx1.wait();
            const ev1 = r1!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const id1 = ev1!.args.commitId as bigint;
            await escrow.connect(bundler1).accept(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after first commit");

            await escrow.connect(bundler1).settle(id1);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after first settle");

            // Re-commit with the same settled hash must revert at commit() itself.
            await expect(
                escrow.connect(user1).commit(QUOTE_ID, hash, bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI })
            ).to.be.revertedWithCustomError(escrow, "UserOpHashRetired");

            // Balance invariant unchanged -- no new commit was created.
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after rejected re-commit");
        });
    });

    // =========================================================
    describe("8.23 PROTOCOL_FEE_WEI > 0 -- flat fee accounting invariants", () => {
        const FLAT_FEE = 5_000n; // wei

        async function deployWithFlatFee() {
            const ctx = await deploy();
            await (ctx.escrow as any).connect(ctx.owner).setProtocolFeeWei(FLAT_FEE);
            return ctx;
        }

        it("8.23.1 commit requires feePerOp + PROTOCOL_FEE_WEI; invariant holds after commit", async () => {
            const ctx = await deployWithFlatFee();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            // commit with feePerOp + FLAT_FEE
            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + FLAT_FEE });
            await tx.wait();
            // protocolFeeWei credited to feeRecipient immediately
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FLAT_FEE);
            // unresolvedFeePaid = ONE_GWEI (feePaid; protocolFeeWei already moved to pending)
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit with flatFee");
        });

        it("8.23.2 protocolFeeWei credited at commit time, not at settle -- feeRecipient pending unchanged by settle", async () => {
            const ctx = await deployWithFlatFee();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + FLAT_FEE });
            const receipt = await tx.wait();
            const ev = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            await escrow.connect(bundler1).accept(commitId);

            const pendingBeforeSettle = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(pendingBeforeSettle).to.equal(FLAT_FEE); // credited at commit

            await escrow.connect(bundler1).settle(commitId);
            // settle does NOT change feeRecipient's pending
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingBeforeSettle);
            // bundler gets full feePerOp
            expect(await escrow.pendingWithdrawals(bundler1.address)).to.equal(ONE_GWEI);
        });

        it("8.23.3 cancel() returns only feePaid to user -- protocolFeeWei is non-refundable (T4)", async () => {
            const ctx = await deployWithFlatFee();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + FLAT_FEE });
            const receipt = await tx.wait();
            const ev = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;

            await escrow.connect(user1).cancel(commitId);

            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(ONE_GWEI);         // feePaid returned
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FLAT_FEE);  // retained
        });

        it("8.23.4 claimRefund returns feePaid + collateral -- protocolFeeWei stays with feeRecipient", async () => {
            const ctx = await deployWithFlatFee();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + FLAT_FEE });
            const receipt = await tx.wait();
            const ev = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            await escrow.connect(bundler1).accept(commitId);

            await mineToRefundable(escrow, commitId);
            await escrow.connect(user1).claimRefund(commitId);

            expect(await escrow.pendingWithdrawals(user1.address)).to.equal(ONE_GWEI + COLLATERAL);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FLAT_FEE);
        });

        it("8.23.5 full balance decomposition: sum(deposited)+sum(pendingWithdrawals)+unresolvedFeePaid == balance throughout", async () => {
            const ctx = await deployWithFlatFee();
            const { escrow, bundler1, user1, feeRecipient, QUOTE_ID } = ctx;
            const bundlers = [bundler1.address];
            const parties  = [bundler1.address, feeRecipient.address, user1.address];

            await escrow.connect(bundler1).deposit({ value: ONE_ETH });
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after deposit");

            const tx = await escrow.connect(user1).commit(QUOTE_ID, ethers.randomBytes(32), bundler1.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + FLAT_FEE });
            const receipt = await tx.wait();
            const ev = receipt!.logs
                .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e && e.name === "CommitCreated");
            const commitId = ev!.args.commitId as bigint;
            // unresolvedFeePaid = ONE_GWEI; FLAT_FEE already in pendingWithdrawals[feeRecipient]
            await assertBalanceInvariant(escrow, bundlers, parties, ONE_GWEI, "after commit");

            await escrow.connect(bundler1).accept(commitId);
            await escrow.connect(bundler1).settle(commitId);
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after settle");

            await escrow.connect(bundler1).claimPayout();
            await escrow.connect(feeRecipient).claimPayout();
            await assertBalanceInvariant(escrow, bundlers, parties, 0n, "after all payouts");

            const rem = await escrow.deposited(bundler1.address);
            await escrow.connect(bundler1).withdraw(rem);
            expect(await contractBalance(escrow)).to.equal(0n);
        });
    });
});
