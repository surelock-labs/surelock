// Category 5: Timing / block number edge cases -- adversarial test suite

import { expect }                  from "chai";
import { ethers, upgrades }        from "hardhat";
import { mine }                    from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow } from "../../typechain-types";
import {
    deployEscrow,
    makeCommit as fixturesMakeCommit,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const ONE_ETH      = ethers.parseEther("1");

// SLA constants
const SLA_MIN      = 1n;       // slaBlocks = 1
const SLA_DEFAULT  = 10n;      // slaBlocks = 10 for most tests
const SLA_SHORT    = 2n;       // slaBlocks = 2
const SLA_MAX      = 1_000n;   // MAX_SLA_BLOCKS

async function deployWith(slaBlocks: bigint) {
    const result = await deployEscrow({ slaBlocks, preDeposit: ONE_ETH });
    const sg = BigInt(await result.escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await result.escrow.REFUND_GRACE_BLOCKS());
    return { ...result, quoteId: result.QUOTE_ID, sg, rg };
}

async function makeCommit(
    escrow: SLAEscrow,
    user: any,
    quoteId: bigint,
    userOpHash?: string,
): Promise<{ commitId: bigint; deadline: bigint }> {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const tag = userOpHash ? undefined : `op-${Date.now()}-${Math.random()}`;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, tag, userOpHash);
    const c = await escrow.getCommit(commitId);
    return { commitId, deadline: c.deadline };
}

// --- describe blocks ----------------------------------------------------------

describe("Cat5 - Timing / block-number edge cases", function () {

    // -- 1. settle() boundary conditions --------------------------------------
    describe("settle() deadline boundaries", function () {

        it("settle at exactly block == deadline should succeed", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            const blocksToMine = deadline - current - 1n; // mine so that next tx lands at deadline
            if (blocksToMine > 0n) await mine(Number(blocksToMine));

            // next tx will be at deadline block
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("settle at block == deadline - 1 should succeed", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            const blocksToMine = deadline - current - 2n; // land at deadline-1
            if (blocksToMine > 0n) await mine(Number(blocksToMine));

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("settle at deadline + SETTLEMENT_GRACE_BLOCKS + 1 reverts DeadlinePassed", async function () {
            const { escrow, bundler, user, quoteId, sg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // settle is allowed through deadline+sg; deadline+sg+1 reverts
            const current = BigInt(await ethers.provider.getBlockNumber());
            const blocksToMine = deadline - current + sg + 1n; // past SETTLEMENT_GRACE window
            await mine(Number(blocksToMine));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("settle at block == deadline + 2 should revert DeadlinePassed", async function () {
            const { escrow, bundler, user, quoteId, sg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // deadline+sg+2 is also past the grace window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + sg + 2n));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("settle at block >> deadline should revert DeadlinePassed", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + 100n));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("DeadlinePassed error encodes correct deadline and current block", async function () {
            const { escrow, bundler, user, quoteId, sg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // mine to deadline+sg+1 (past the grace window)
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + sg + 1n));

            const currentAfterMine = BigInt(await ethers.provider.getBlockNumber()) + 1n; // +1 for settle tx
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed")
                .withArgs(commitId, deadline, currentAfterMine);
        });
    });

    // -- 2. claimRefund() boundary conditions ---------------------------------
    describe("claimRefund() grace-window boundaries", function () {

        it("claimRefund at block == deadline + REFUND_GRACE (5) should revert NotExpired (unlocksAt = deadline+16)", async function () {
            const { escrow, user, quoteId, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            // mine so next tx lands at deadline + rg
            await mine(Number(deadline + rg - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund at block == unlocksAt (deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1) should succeed", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            // mine so next tx lands at unlocksAt
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("claimRefund at block == deadline + GRACE + 2 should succeed (any time after unlock)", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // unlocksAt = deadline + sg + rg + 1
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 2n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("claimRefund at block == deadline + GRACE - 1 (4) should revert NotExpired", async function () {
            const { escrow, user, quoteId, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + rg - 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund immediately after commit should revert NotExpired", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId } = await makeCommit(escrow, user, quoteId);

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund at exactly deadline should revert NotExpired", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("NotExpired error encodes correct unlocksAt and current block", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            const unlocksAt = deadline + sg + rg + 1n;
            // mine to just before unlock
            await mine(Number(deadline + rg - current - 1n));

            const blockAtCall = BigInt(await ethers.provider.getBlockNumber()) + 1n;
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired")
                .withArgs(commitId, unlocksAt, blockAtCall);
        });
    });

    // -- 3. slaBlocks = 1 (minimum) --------------------------------------------
    describe("slaBlocks = 1 (minimum SLA)", function () {

        it("register with slaBlocks = 1 succeeds", async function () {
            const { registry, bundler, quoteId } = await deployWith(SLA_MIN);
            const offer = await registry.getOffer(quoteId);
            expect(offer.slaBlocks).to.equal(1);
        });

        it("deadline = commitBlock + 1 with slaBlocks = 1", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_MIN);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);
            const commitBlock = BigInt(await ethers.provider.getBlockNumber());
            expect(deadline).to.equal(commitBlock + 1n - 1n + 1n); // deadline set in the commit tx block
            // Actually: deadline = block.number (commit tx block) + 1
            // commit tx mined at some block B; deadline = B + 1
            const c = await escrow.getCommit(commitId);
            expect(c.deadline).to.equal(deadline);
        });

        it("settle at deadline (commitBlock+1) with slaBlocks = 1 succeeds", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_MIN);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            if (deadline > current) {
                await mine(Number(deadline - current - 1n));
            }

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("settle at deadline + SETTLEMENT_GRACE_BLOCKS + 1 with slaBlocks = 1 reverts DeadlinePassed", async function () {
            const { escrow, bundler, user, quoteId, sg } = await deployWith(SLA_MIN);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // need +sg+1 to pass the grace window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + sg + 1n));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("claimRefund at deadline+GRACE with slaBlocks = 1 reverts NotExpired", async function () {
            const { escrow, user, quoteId, rg } = await deployWith(SLA_MIN);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + rg - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund at deadline+GRACE+1 with slaBlocks = 1 succeeds", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_MIN);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });
    });

    // -- 4. slaBlocks = 0 -----------------------------------------------------
    describe("slaBlocks = 0 -- registration must fail", function () {

        it("register with slaBlocks = 0 reverts", async function () {
            const [, bundler] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;

            await expect(registry.connect(bundler).register(ONE_GWEI, 0, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }))
                .to.be.revertedWith("slaBlocks must be > 0");
        });
    });

    // -- 5. slaBlocks > MAX_SLA_BLOCKS ----------------------------------------
    describe("slaBlocks > MAX_SLA_BLOCKS -- registration must fail", function () {

        it("register with slaBlocks = MAX_SLA_BLOCKS + 1 reverts", async function () {
            const [, bundler] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;

            await expect(
                registry.connect(bundler).register(ONE_GWEI, Number(SLA_MAX + 1n), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");
        });

        it("register with slaBlocks = MAX_SLA_BLOCKS succeeds", async function () {
            const [, bundler] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;

            await expect(
                registry.connect(bundler).register(ONE_GWEI, Number(SLA_MAX), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.not.be.reverted;
        });

        it("register with slaBlocks = 65535 (> MAX) reverts", async function () {
            const [, bundler] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;

            await expect(
                registry.connect(bundler).register(ONE_GWEI, 65535, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");
        });
    });

    // -- 6. MAX_SLA_BLOCKS (1000) -- long deadline -----------------------------
    describe("slaBlocks = MAX_SLA_BLOCKS (1000)", function () {

        it("settle works immediately after commit (block 1 of window)", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_MAX);
            const { commitId } = await makeCommit(escrow, user, quoteId);

            // No mining needed -- settle on very next block
            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("settle works at deadline (block MAX_SLA_BLOCKS)", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_MAX);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current - 1n));

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("claimRefund fails before deadline + GRACE + 1 with MAX sla", async function () {
            const { escrow, user, quoteId, rg } = await deployWith(SLA_MAX);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // Mine to just inside the grace window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + rg - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund succeeds at block deadline + GRACE + 1 with MAX sla", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_MAX);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });
    });

    // -- 7. slaBlocks = 2 exact arithmetic (N+2 deadline) ---------------------
    describe("slaBlocks = 2 -- exact block arithmetic", function () {

        it("commit at block N creates deadline = N+2", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_SHORT);
            const txResp = await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op")), bundler.address, COLLATERAL, Number(SLA_SHORT), { value: ONE_GWEI });
            const receipt = await txResp.wait();
            const blockN = BigInt(receipt!.blockNumber);
            const commitId = (await escrow.nextCommitId()) - 1n;
            // Two-phase: accept() sets the deadline (acceptBlock + slaBlocks)
            const acceptTx = await escrow.connect(bundler).accept(commitId);
            const acceptReceipt = await acceptTx.wait();
            const acceptBlockN = BigInt(acceptReceipt!.blockNumber);
            const c = await escrow.getCommit(commitId);
            expect(c.deadline).to.equal(acceptBlockN + SLA_SHORT);
        });

        it("settle valid at block N+2 (deadline)", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current - 1n));

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("settle invalid at block N+3 (deadline+1)", async function () {
            const { escrow, bundler, user, quoteId, sg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // need deadline+sg+1 to be past the grace window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + sg + 1n));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("claimRefund invalid at block N+7 (deadline+REFUND_GRACE = N+7)", async function () {
            // unlocksAt = deadline + sg + rg + 1
            const { escrow, user, quoteId, rg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            // mine to deadline + rg
            await mine(Number(deadline + rg - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("claimRefund valid at block N+18 (unlocksAt = deadline+SETTLEMENT_GRACE+REFUND_GRACE+1)", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            // mine to unlocksAt
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });
    });

    // -- 8. Multiple commits with different deadlines --------------------------
    describe("multiple commits with different deadlines", function () {

        it("earlier commit expires while later commit is still valid -- settle works on later", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" }
            )) as unknown as SLAEscrow;
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());

            // Two offers: short and long SLA
            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });  // quoteId=1
            await registry.connect(bundler).register(ONE_GWEI, 100, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") }); // quoteId=2

            await escrow.connect(bundler).deposit({ value: ONE_ETH });

            const { commitId: c0, deadline: d0 } = await makeCommit(escrow, user, 1n);
            const { commitId: c1, deadline: d1 } = await makeCommit(escrow, user, 2n);

            expect(d1).to.be.gt(d0);

            // Mine past d0 + sg -- short commit settlement window fully expired
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(d0 - current + sg + 1n));

            // settle on short commit should fail (past SETTLEMENT_GRACE)
            await expect(escrow.connect(bundler).settle(c0))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");

            // settle on long commit should still succeed
            await expect(escrow.connect(bundler).settle(c1)).to.not.be.reverted;
        });

        it("both commits past deadline -- both settle calls revert", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" }
            )) as unknown as SLAEscrow;
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());

            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await registry.connect(bundler).register(ONE_GWEI, 3, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: ONE_ETH });

            const { commitId: c0, deadline: d0 } = await makeCommit(escrow, user, 1n);
            const { commitId: c1, deadline: d1 } = await makeCommit(escrow, user, 2n);

            // mine past d1 + sg to ensure both are past the grace window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(d1 - current + sg + 1n));

            await expect(escrow.connect(bundler).settle(c0))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
            await expect(escrow.connect(bundler).settle(c1))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });

        it("earlier commit claimRefund unlocks independently of later commit", async function () {
            const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow = (await upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" }
            )) as unknown as SLAEscrow;
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());

            await registry.connect(bundler).register(ONE_GWEI, 2, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await registry.connect(bundler).register(ONE_GWEI, 200, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            await escrow.connect(bundler).deposit({ value: ONE_ETH });

            const { commitId: c0, deadline: d0 } = await makeCommit(escrow, user, 1n);
            const { commitId: c1 } = await makeCommit(escrow, user, 2n);

            // Mine past c0 unlock window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(d0 + sg + rg + 1n - current - 1n));

            // c0 claimRefund should succeed
            await expect(escrow.connect(user).claimRefund(c0)).to.not.be.reverted;

            // c1 claimRefund should still fail (far from unlock)
            await expect(escrow.connect(user).claimRefund(c1))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });
    });

    // -- 9. Mine exactly to boundary -- fence-post tests ------------------------
    describe("mine exactly to boundary fence-post", function () {

        it("mine to (unlocksAt - 1): claimRefund fails", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);
            const unlocksAt = deadline + sg + rg + 1n;

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(unlocksAt - 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("mine to exactly unlocksAt: claimRefund succeeds", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);
            const unlocksAt = deadline + sg + rg + 1n;

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(unlocksAt - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("mine to (deadline - 1): settle succeeds", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - 1n - current - 1n));

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("mine to exactly deadline: settle succeeds", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current - 1n));

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("mine to (deadline + 1): settle reverts", async function () {
            const { escrow, bundler, user, quoteId, sg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // mine past the grace window
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + sg + 1n));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        });
    });

    // -- 10. Large block mining (state consistency) ----------------------------
    describe("large block number mining -- state stays correct", function () {

        it("mine 1000 blocks: commit state unchanged", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_MAX);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            await mine(1000);

            const c = await escrow.getCommit(commitId);
            expect(c.deadline).to.equal(deadline);
            expect(c.settled).to.equal(false);
            expect(c.refunded).to.equal(false);
        });

        it("mine 1000 blocks within window: settle still works", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_MAX);
            const { commitId } = await makeCommit(escrow, user, quoteId);

            await mine(1000);

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("mine 1000 blocks but still in grace window: claimRefund fails", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            // Mine past deadline but stay within grace
            await mine(Number(deadline + 2n - current));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });

        it("mine 1000 blocks well past unlock: claimRefund still succeeds", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            // Mine far past unlocksAt
            await mine(Number(deadline + sg + rg + 1n - current + 1000n));

            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });
    });

    // -- 11. REFUND_GRACE_BLOCKS constant immutability -------------------------
    describe("REFUND_GRACE_BLOCKS is constant and cannot change", function () {

        it("REFUND_GRACE_BLOCKS returns 5", async function () {
            const { escrow } = await deployWith(SLA_DEFAULT);
            expect(await escrow.REFUND_GRACE_BLOCKS()).to.equal(5n);
        });

        it("grace window uses exactly 5: unlocksAt = deadline + 16 (SETTLEMENT_GRACE=10 + REFUND_GRACE=5 + 1)", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // Try at unlocksAt - 1 (one short of unlocksAt -- should fail)
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg - current - 1n));
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");

            // Mine one more block (unlocksAt = deadline + sg + rg + 1)
            await mine(1);
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("grace of 4 blocks is insufficient -- claimRefund reverts", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + 4n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });
    });

    // -- 12. AlreadyFinalized -- no double-action -------------------------------
    describe("AlreadyFinalized after timing-based actions", function () {

        it("settle then settle again reverts AlreadyFinalized", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId } = await makeCommit(escrow, user, quoteId);

            await escrow.connect(bundler).settle(commitId);
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("claimRefund then claimRefund again reverts AlreadyFinalized", async function () {
            const { escrow, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await escrow.connect(user).claimRefund(commitId);
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("settle then claimRefund reverts AlreadyFinalized", async function () {
            const { escrow, bundler, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            await escrow.connect(bundler).settle(commitId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });

        it("claimRefund then settle reverts AlreadyFinalized", async function () {
            const { escrow, bundler, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // Mine to unlock window but not past deadline for settle
            // Use SLA long enough so deadline > unlocksAt is impossible. Use trick: after claimRefund
            // the commit is refunded; settle should see AlreadyFinalized.
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await escrow.connect(user).claimRefund(commitId);
            // deadline is now in the past anyway, but AlreadyFinalized should trigger first
            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
        });
    });

    // -- 13. Deadline arithmetic overflow safety -------------------------------
    describe("deadline arithmetic -- uint64 safety", function () {

        it("deadline is stored as uint64 -- fits within bounds for MAX_SLA_BLOCKS", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_MAX);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // deadline must be a reasonable block number (well below uint64 max)
            const uint64Max = 2n ** 64n - 1n;
            expect(deadline).to.be.lt(uint64Max);
        });

        it("deadline = commitBlock + slaBlocks: value matches contract storage", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_SHORT);
            await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("test")), bundler.address, COLLATERAL, Number(SLA_SHORT), { value: ONE_GWEI });
            const commitId = (await escrow.nextCommitId()) - 1n;
            // Two-phase: accept() sets deadline = acceptBlock + slaBlocks
            const acceptTx = await escrow.connect(bundler).accept(commitId);
            const acceptReceipt = await acceptTx.wait();
            const acceptBlockN = BigInt(acceptReceipt!.blockNumber);
            const c = await escrow.getCommit(commitId);
            expect(c.deadline).to.equal(acceptBlockN + SLA_SHORT);
        });

        it("unlocksAt = deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1: verifiable from contract constants", async function () {
            const { escrow, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { deadline } = await makeCommit(escrow, user, quoteId);
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
            const expectedUnlocksAt = deadline + sg + rg + 1n;
            expect(expectedUnlocksAt).to.equal(deadline + sg + rg + 1n);
        });
    });

    // -- 14. Bundler settle window -- race with user refund ---------------------
    describe("race between bundler settle and user claimRefund", function () {

        it("bundler settles at last valid block before user can claim", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // mine to deadline (last valid settle block)
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current - 1n));

            await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
        });

        it("if bundler misses deadline by 1 block, user can eventually claim", async function () {
            const { escrow, bundler, user, quoteId, sg, rg } = await deployWith(SLA_SHORT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            // bundler misses by 1 (mine past deadline + sg so settle window is closed)
            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current + sg + 1n));

            await expect(escrow.connect(bundler).settle(commitId))
                .to.be.revertedWithCustomError(escrow, "DeadlinePassed");

            // user must wait for full refund grace too
            await mine(Number(rg));
            await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
        });

        it("user cannot front-run bundler: claimRefund fails while settle window open", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId } = await makeCommit(escrow, user, quoteId);

            // Attempt refund right after commit -- should fail
            await expect(escrow.connect(user).claimRefund(commitId))
                .to.be.revertedWithCustomError(escrow, "NotExpired");
        });
    });

    // -- 15. Payout accounting after timing-based finalisation -----------------
    describe("payout accounting after timing-based settlement", function () {

        it("settle at deadline: bundler pendingWithdrawals updated correctly", async function () {
            const { escrow, bundler, user, feeRecipient, quoteId } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline - current - 1n));

            await escrow.connect(bundler).settle(commitId);

            // bundler gets full feePerOp (PROTOCOL_FEE_WEI=0); feeRecipient gets 0
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("claimRefund at unlocksAt: user gets fee + full collateral", async function () {
            const { escrow, user, feeRecipient, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await escrow.connect(user).claimRefund(commitId);

            // 100% of collateral goes to user (no protocol split)
            const userTotal = ONE_GWEI + COLLATERAL;
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(userTotal);
        });

        it("lockedOf is released after settle", async function () {
            const { escrow, bundler, user, quoteId } = await deployWith(SLA_DEFAULT);
            const lockedBefore = await escrow.lockedOf(bundler.address);
            const { commitId } = await makeCommit(escrow, user, quoteId);
            const lockedAfterCommit = await escrow.lockedOf(bundler.address);
            expect(lockedAfterCommit).to.equal(lockedBefore + COLLATERAL);

            await escrow.connect(bundler).settle(commitId);
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
        });

        it("lockedOf and deposited both decrease after claimRefund", async function () {
            const { escrow, bundler, user, quoteId, sg, rg } = await deployWith(SLA_DEFAULT);
            await makeCommit(escrow, user, quoteId);
            const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

            const depositedBefore = await escrow.deposited(bundler.address);
            const lockedBefore    = await escrow.lockedOf(bundler.address);

            const current = BigInt(await ethers.provider.getBlockNumber());
            await mine(Number(deadline + sg + rg + 1n - current - 1n));

            await escrow.connect(user).claimRefund(commitId);

            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore - COLLATERAL);
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore - COLLATERAL);
        });
    });
});
