// Category 3: Protocol-fee / WrongFee -- adversarial test suite
// Covers the PROTOCOL_FEE_WEI flat-fee model that replaced the old FEE_BPS percentage model.

import { expect }                   from "chai";
import { ethers }                    from "hardhat";
import { setBalance, mine }          from "@nomicfoundation/hardhat-network-helpers";
import { anyValue }                  from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { QuoteRegistry, SLAEscrow }  from "../../typechain-types";
import {
    deployEscrow,
    ONE_GWEI,
} from "../helpers/fixtures";

const ONE_ETH      = ethers.parseEther("1");
const MAX_UINT96   = (1n << 96n) - 1n;
// MAX_PROTOCOL_FEE_WEI = 0.001 ether (matches contract constant)
const MAX_PROTOCOL_FEE_WEI = ethers.parseEther("0.001");

// --- helpers ------------------------------------------------------------------

/**
 * Deploy registry + escrow. Optionally activate a flat PROTOCOL_FEE_WEI.
 * Injects altRecipient (signer[4]) and stranger (signer[5]) to match original layout.
 */
async function deployWith(protocolFeeWei = 0n) {
    const result = await deployEscrow({ protocolFeeWei, preDeposit: false });
    const signers = await ethers.getSigners();
    const altRecipient = signers[4]; // original layout: [owner,bundler,user,feeRecipient,altRecipient,stranger]
    const stranger     = signers[5];
    return { ...result, altRecipient, stranger };
}

/** Register offer + deposit collateral + return quoteId. */
async function setupOffer(
    registry: QuoteRegistry,
    escrow:   SLAEscrow,
    bundler:  Awaited<ReturnType<typeof ethers.getSigner>>,
    opts: {
        feePerOp?:      bigint;
        slaBlocks?:     number;
        collateralWei?: bigint;
    } = {},
) {
    const feePerOp      = opts.feePerOp  ?? ONE_GWEI;
    const requested     = opts.collateralWei ?? ethers.parseEther("0.01");
    // T8: collateral must be > feePerOp. If caller passes 0n (or any value <= fee),
    // treat it as "use minimum valid collateral" (feePerOp + 1n) -- NOT a zero-collateral path.
    const collateralWei = requested <= feePerOp ? feePerOp + 1n : requested;

    await registry.connect(bundler).register(feePerOp, opts.slaBlocks ?? 10, collateralWei, 302_400, { value: ethers.parseEther("0.0001") });
    const quoteId = (await registry.nextQuoteId()) - 1n;

    if (collateralWei > 0n) {
        const bundlerBalance = await ethers.provider.getBalance(bundler.address);
        if (collateralWei > bundlerBalance) {
            await setBalance(bundler.address, collateralWei + ethers.parseEther("10000"));
        }
        await escrow.connect(bundler).deposit({ value: collateralWei });
    }
    return quoteId;
}

/**
 * Call commit() with the offer params read from registry.
 * `value` overrides the total msg.value (normally feePerOp + PROTOCOL_FEE_WEI).
 */
async function commitOp(
    escrow: SLAEscrow,
    registry: QuoteRegistry,
    user: Awaited<ReturnType<typeof ethers.getSigner>>,
    qid: bigint,
    userOpHash: Uint8Array | string,
    value: bigint,
) {
    const offer = await registry.getOffer(qid);
    return escrow.connect(user).commit(qid, userOpHash, offer.bundler, offer.collateralWei, offer.slaBlocks, { value });
}

// --- test suites --------------------------------------------------------------

describe("Cat3 -- Fee bypass / rounding", function () {

    // -- 1. commit() exact fee enforcement ------------------------------------
    describe("1. commit() exact fee enforcement", function () {

        it("1.01 commit with msg.value == feePerOp succeeds (PROTOCOL_FEE_WEI=0)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI),
            ).to.not.be.reverted;
        });

        it("1.02 commit with msg.value > feePerOp reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("1.03 commit with msg.value < feePerOp by 1 wei reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI - 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("1.04 commit with msg.value = feePerOp - 1 (same as above, explicit)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            const fee = ONE_GWEI;
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee - 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("1.05 commit with msg.value = 0 when feePerOp > 0 reverts WrongFee (no FeeTooSmall)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1000n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 0n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(0n, 1000n);
        });

        it("1.06 register with feePerOp=0 reverts (zero-fee offers banned)", async function () {
            const { registry, bundler } = await deployWith();
            await expect(
                registry.connect(bundler).register(0n, 10, 0n, 302_400, { value: ethers.parseEther("0.0001") }),
            ).to.be.revertedWith("feePerOp must be > 0");
        });

        it("1.07 commit with msg.value=0 when feePerOp=1000 reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, {
                feePerOp:      1000n,
                collateralWei: 1000n,
            });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 0n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(0n, 1000n);
        });

        it("1.08 commit with feePerOp = type(uint96).max - 1 and exact value succeeds", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = MAX_UINT96 - 1n;
            const qid = await setupOffer(registry, escrow, bundler, {
                feePerOp:      fee,
                collateralWei: MAX_UINT96, // strictly > fee
            });
            await setBalance(user.address, MAX_UINT96 + ethers.parseEther("1"));
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee),
            ).to.not.be.reverted;
        });

        it("1.09 commit with feePerOp = type(uint96).max - 1 and value - 1 reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = MAX_UINT96 - 1n;
            const qid = await setupOffer(registry, escrow, bundler, {
                feePerOp:      fee,
                collateralWei: MAX_UINT96,
            });
            await setBalance(user.address, MAX_UINT96 + ethers.parseEther("1"));
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee - 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("1.10 commit with feePerOp = 1000 wei and value = 1001 reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, {
                feePerOp:      1000n,
                collateralWei: 1001n, // strictly > fee
            });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1001n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(1001n, 1000n);
        });
    });

    // -- 2. setProtocolFeeWei validation --------------------------------------
    describe("2. setProtocolFeeWei validation", function () {

        it("2.01 initial PROTOCOL_FEE_WEI = 0 (fee-inactive at deploy)", async function () {
            const { escrow } = await deployWith();
            expect(await (escrow as any).protocolFeeWei()).to.equal(0n);
        });

        it("2.02 setProtocolFeeWei(0) keeps fee inactive and emits ProtocolFeeUpdated", async function () {
            const { escrow, owner } = await deployWith();
            await expect(
                (escrow as any).connect(owner).setProtocolFeeWei(0n),
            ).to.emit(escrow, "ProtocolFeeUpdated").withArgs(0n, 0n);
        });

        it("2.03 setProtocolFeeWei(MAX_PROTOCOL_FEE_WEI) succeeds", async function () {
            const { escrow, owner } = await deployWith();
            await expect(
                (escrow as any).connect(owner).setProtocolFeeWei(MAX_PROTOCOL_FEE_WEI),
            ).to.not.be.reverted;
            expect(await (escrow as any).protocolFeeWei()).to.equal(MAX_PROTOCOL_FEE_WEI);
        });

        it("2.04 setProtocolFeeWei(MAX_PROTOCOL_FEE_WEI + 1) reverts InvalidProtocolFee", async function () {
            const { escrow, owner } = await deployWith();
            await expect(
                (escrow as any).connect(owner).setProtocolFeeWei(MAX_PROTOCOL_FEE_WEI + 1n),
            ).to.be.revertedWithCustomError(escrow, "InvalidProtocolFee")
              .withArgs(MAX_PROTOCOL_FEE_WEI + 1n);
        });

        it("2.05 setProtocolFeeWei(1 ether) reverts InvalidProtocolFee", async function () {
            const { escrow, owner } = await deployWith();
            await expect(
                (escrow as any).connect(owner).setProtocolFeeWei(ONE_ETH),
            ).to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
        });

        it("2.06 setProtocolFeeWei by non-owner reverts OwnableUnauthorizedAccount", async function () {
            const { escrow, stranger } = await deployWith();
            await expect(
                (escrow as any).connect(stranger).setProtocolFeeWei(1000n),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("2.07 ProtocolFeeUpdated event carries old and new fee", async function () {
            const { escrow, owner } = await deployWith(500n);
            await expect(
                (escrow as any).connect(owner).setProtocolFeeWei(1000n),
            ).to.emit(escrow, "ProtocolFeeUpdated").withArgs(500n, 1000n);
        });
    });

    // -- 3. Protocol fee = 0 by default ---------------------------------------
    describe("3. Protocol fee = 0: bundler gets full feePerOp", function () {

        it("3.01 bundler gets full fee when PROTOCOL_FEE_WEI = 0", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("3.02 feeRecipient pendingWithdrawal stays 0 when PROTOCOL_FEE_WEI = 0", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("3.03 minimum-fee offer (1 wei, PROTOCOL_FEE_WEI=0) settles with no wei leak", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, {
                feePerOp:      1n,
                collateralWei: 2n, // strictly > fee
            });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1n);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(1n);
            expect(await escrow.pendingWithdrawals(await (escrow as any).feeRecipient())).to.equal(0n);
        });
    });

    // -- 4. PROTOCOL_FEE_WEI > 0: flat fee charged at commit time -------------
    describe("4. PROTOCOL_FEE_WEI > 0: flat fee", function () {

        it("4.01 commit requires msg.value = feePerOp + PROTOCOL_FEE_WEI (exact)", async function () {
            const flatFee = 10_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            const required = ONE_GWEI + flatFee;
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), required),
            ).to.not.be.reverted;
        });

        it("4.02 commit with msg.value = feePerOp (missing PROTOCOL_FEE_WEI) reverts WrongFee", async function () {
            const flatFee = 10_000n;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(ONE_GWEI, ONE_GWEI + flatFee);
        });

        it("4.03 commit with msg.value = feePerOp + PROTOCOL_FEE_WEI + 1 reverts WrongFee", async function () {
            const flatFee = 10_000n;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            const required = ONE_GWEI + flatFee;
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), required + 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(required + 1n, required);
        });

        it("4.04 PROTOCOL_FEE_WEI credited to feeRecipient at COMMIT time (before settle)", async function () {
            const flatFee = 10_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });

            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            // After commit, before settle:
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(flatFee);
        });

        it("4.05 bundler gets full feePerOp at settle (protocol fee already taken at commit)", async function () {
            const flatFee = 10_000n;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);
            // Bundler gets the full feePerOp (PROTOCOL_FEE_WEI was already taken at commit)
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore + ONE_GWEI);
        });

        it("4.06 platformFee + bundlerNet == total msg.value (no wei leak)", async function () {
            const flatFee = 10_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const bundlerPending   = await escrow.pendingWithdrawals(bundler.address);
            const recipientPending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(bundlerPending + recipientPending).to.equal(ONE_GWEI + flatFee);
        });
    });

    // -- 5. msg.value exact enforcement with PROTOCOL_FEE_WEI > 0 -------------
    describe("5. msg.value exact enforcement with non-zero PROTOCOL_FEE_WEI", function () {

        it("5.01 exact msg.value = feePerOp + PROTOCOL_FEE_WEI succeeds", async function () {
            const flatFee = 500_000n;
            const feePerOp = ONE_GWEI;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), feePerOp + flatFee),
            ).to.not.be.reverted;
        });

        it("5.02 one wei short reverts WrongFee", async function () {
            const flatFee = 500_000n;
            const feePerOp = ONE_GWEI;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp });
            const required = feePerOp + flatFee;
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), required - 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(required - 1n, required);
        });

        it("5.03 one wei over reverts WrongFee", async function () {
            const flatFee = 500_000n;
            const feePerOp = ONE_GWEI;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp });
            const required = feePerOp + flatFee;
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), required + 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(required + 1n, required);
        });
    });

    // -- 6. feeRecipient credited at commit time -------------------------------
    describe("6. Protocol fee credited at commit time (not settle)", function () {

        it("6.01 pending credited to feeRecipient before settle", async function () {
            const flatFee = 1_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);

            // pending credited immediately at commit
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(flatFee);
        });

        it("6.02 settle does not change feeRecipient's pending", async function () {
            const flatFee = 1_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            const pendingBeforeSettle = await escrow.pendingWithdrawals(feeRecipient.address);
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);
            // feeRecipient's pending unchanged by settle
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingBeforeSettle);
        });

        it("6.03 PROTOCOL_FEE_WEI=0 -> feeRecipient gets nothing at commit", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI);

            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("6.04 refund still credits feeRecipient via commit (not additionally via refund)", async function () {
            const flatFee = 1_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI, slaBlocks: 2 });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            // Accept to set deadline (transition to ACTIVE), then expire and refund
            await escrow.connect(bundler).accept(commitId);
            const deadline = (await escrow.getCommit(commitId)).deadline;
            const settlementGrace = await (escrow as any).SETTLEMENT_GRACE_BLOCKS();
            const refundGrace = await (escrow as any).REFUND_GRACE_BLOCKS();
            const unlocksAt = deadline + settlementGrace + refundGrace + 1n;
            const cur = BigInt(await ethers.provider.getBlockNumber());
            const toMine = Number(unlocksAt - cur) + 1;
            const { mine: mineBlocks } = await import("@nomicfoundation/hardhat-network-helpers");
            await mineBlocks(toMine);

            const pendingBefore = await escrow.pendingWithdrawals(feeRecipient.address);
            await escrow.connect(user).claimRefund(commitId);
            // Refund doesn't add more to feeRecipient (was already credited at commit)
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingBefore);
        });
    });

    // -- 7. No-wei-leak invariant ----------------------------------------------
    describe("7. No-wei-leak invariant: pendingWithdrawals sums to total fee paid", function () {

        it("7.01 invariant holds for PROTOCOL_FEE_WEI=0", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const fee = ONE_GWEI;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const total = (await escrow.pendingWithdrawals(bundler.address)) +
                          (await escrow.pendingWithdrawals(feeRecipient.address));
            expect(total).to.equal(fee);
        });

        it("7.02 invariant holds for PROTOCOL_FEE_WEI=500, fee=7777 wei", async function () {
            const flatFee = 500n;
            const feePerOp = 7777n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp, collateralWei: feePerOp });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), feePerOp + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const total = (await escrow.pendingWithdrawals(bundler.address)) +
                          (await escrow.pendingWithdrawals(feeRecipient.address));
            expect(total).to.equal(feePerOp + flatFee);
        });

        it("7.03 invariant holds for PROTOCOL_FEE_WEI=0, large fee near uint96 max", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const fee = ethers.parseEther("100");
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const total = (await escrow.pendingWithdrawals(bundler.address)) +
                          (await escrow.pendingWithdrawals(feeRecipient.address));
            expect(total).to.equal(fee);
        });

        it("7.04 1 wei feePerOp commit succeeds (no FeeTooSmall guard in new model)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1n, collateralWei: 1n });
            await escrow.connect(bundler).deposit({ value: 1n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1n),
            ).to.not.be.reverted;
        });

        it("7.05 any fee size commits succeed (no minimum threshold in PROTOCOL_FEE_WEI model)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 10n, collateralWei: 10n });
            await escrow.connect(bundler).deposit({ value: 10n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 10n),
            ).to.not.be.reverted;
        });
    });

    // -- 8. Multiple settles -- accumulation -----------------------------------
    describe("8. Multiple settles -- pendingWithdrawals accumulation", function () {

        it("8.01 two settles accumulate correctly for bundler (PROTOCOL_FEE_WEI=0)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ONE_GWEI;
            const collateral = ethers.parseEther("0.01");
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: collateral });
            await escrow.connect(bundler).deposit({ value: collateral });

            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const cid1 = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(cid1);

            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const cid2 = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(cid2);

            await escrow.connect(bundler).settle(cid1);
            await escrow.connect(bundler).settle(cid2);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee * 2n);
        });

        it("8.02 three settles: PROTOCOL_FEE_WEI accumulates at commit, bundler gets full feePerOp each time", async function () {
            const flatFee = 100n;
            const feePerOp = 1000n;
            const collateralWei = feePerOp + 1n; // strictly > fee
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp, collateralWei });
            // setupOffer deposits 1x collateral. Need total = 3 x collateralWei for 3 accepts.
            await escrow.connect(bundler).deposit({ value: collateralWei * 2n });

            const cids: bigint[] = [];
            for (let i = 0; i < 3; i++) {
                await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), feePerOp + flatFee);
                const cid = (await escrow.nextCommitId()) - 1n;
                cids.push(cid);
                await escrow.connect(bundler).accept(cid);
            }

            // feeRecipient already has 3 x flatFee pending (credited at each commit)
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(flatFee * 3n);

            for (const cid of cids) {
                await escrow.connect(bundler).settle(cid);
            }

            // bundler gets full feePerOp x 3
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(feePerOp * 3n);
            // feeRecipient still has 3 x flatFee (settle doesn't touch it)
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(flatFee * 3n);
        });

        it("8.03 total across all parties equals total fees paid (10 settles)", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const fee = 10_000n;
            const collateralWei = fee + 1n; // strictly > fee
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei });
            // setupOffer deposited 1x collateralWei; need total = 10 x collateralWei for 10 accepts.
            await escrow.connect(bundler).deposit({ value: collateralWei * 9n });

            const cids: bigint[] = [];
            for (let i = 0; i < 10; i++) {
                await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
                const cid = (await escrow.nextCommitId()) - 1n;
                cids.push(cid);
                await escrow.connect(bundler).accept(cid);
            }
            for (const cid of cids) {
                await escrow.connect(bundler).settle(cid);
            }

            const totalFees = fee * 10n;
            const bundlerPending   = await escrow.pendingWithdrawals(bundler.address);
            const recipientPending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(bundlerPending + recipientPending).to.equal(totalFees);
        });
    });

    // -- 9. setFeeRecipient -- fees go to new recipient -------------------------
    describe("9. setFeeRecipient: fees routed to new address", function () {

        it("9.01 after setFeeRecipient, protocol fee credited to new recipient at next commit", async function () {
            const flatFee = 1000n;
            const { escrow, registry, owner, bundler, user, feeRecipient, altRecipient } =
                await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI, collateralWei: 0n });

            await (escrow as any).connect(owner).setFeeRecipient(altRecipient.address);

            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);

            // flatFee credited to new recipient at commit
            expect(await escrow.pendingWithdrawals(altRecipient.address)).to.equal(flatFee);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("9.02 old recipient retains previously accumulated fees after recipient change", async function () {
            const flatFee = 1000n;
            const { escrow, registry, owner, bundler, user, feeRecipient, altRecipient } =
                await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI, collateralWei: ONE_GWEI });
            // deposit enough for a second commit (setupOffer deposited 1xcollateral)
            await escrow.connect(bundler).deposit({ value: ONE_GWEI });

            // commit before changing recipient -> flatFee goes to feeRecipient
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const oldBalance = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(oldBalance).to.equal(flatFee);

            await (escrow as any).connect(owner).setFeeRecipient(altRecipient.address);

            // commit after changing recipient -> flatFee goes to altRecipient
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);

            // old recipient keeps their previous balance
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(oldBalance);
            // new recipient receives the post-change fee
            expect(await escrow.pendingWithdrawals(altRecipient.address)).to.equal(flatFee);
        });

        it("9.03 setFeeRecipient by non-owner reverts", async function () {
            const { escrow, stranger, altRecipient } = await deployWith();
            await expect(
                (escrow as any).connect(stranger).setFeeRecipient(altRecipient.address),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("9.04 setFeeRecipient to zero address reverts ZeroAddress", async function () {
            const { escrow, owner } = await deployWith();
            await expect(
                (escrow as any).connect(owner).setFeeRecipient(ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
        });
    });

    // -- 10. Large fees near uint96 max ----------------------------------------
    describe("10. Large fees near uint96 max", function () {

        it("10.01 fee = 2^80, PROTOCOL_FEE_WEI=0: bundler gets full fee, no overflow", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            const fee = 2n ** 80n;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await setBalance(user.address, fee + ethers.parseEther("1"));
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("10.02 fee = MAX_UINT96 - 1, PROTOCOL_FEE_WEI=0: bundler gets full amount", async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith();
            // collateral must be strictly > fee, so fee = MAX_UINT96 - 1.
            const fee = MAX_UINT96 - 1n;
            const qid = await setupOffer(registry, escrow, bundler, {
                feePerOp:      fee,
                collateralWei: MAX_UINT96,
            });
            await setBalance(user.address, MAX_UINT96 + ethers.parseEther("1"));
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("10.03 fee = 2^80, PROTOCOL_FEE_WEI = MAX: both are credited, invariant holds", async function () {
            const flatFee = MAX_PROTOCOL_FEE_WEI;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const fee = 2n ** 80n;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await setBalance(user.address, fee + flatFee + ethers.parseEther("1"));
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const bundlerPending   = await escrow.pendingWithdrawals(bundler.address);
            const recipientPending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(bundlerPending).to.equal(fee);
            expect(recipientPending).to.equal(flatFee);
            expect(bundlerPending + recipientPending).to.equal(fee + flatFee);
        });

        it("10.04 fee = MAX_UINT96 - 1, PROTOCOL_FEE_WEI = MAX: no overflow, invariant holds", async function () {
            const flatFee = MAX_PROTOCOL_FEE_WEI;
            // collateral must be strictly > fee, so fee = MAX_UINT96 - 1.
            const fee = MAX_UINT96 - 1n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: MAX_UINT96 });
            await setBalance(user.address, fee + flatFee + ethers.parseEther("1"));
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const bundlerPending   = await escrow.pendingWithdrawals(bundler.address);
            const recipientPending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(bundlerPending).to.equal(fee);
            expect(recipientPending).to.equal(flatFee);
            expect(bundlerPending + recipientPending).to.equal(fee + flatFee);
        });
    });

    // -- 11. claimPayout after settle -----------------------------------------
    describe("11. claimPayout clears pending balance", function () {

        it("11.01 bundler can claimPayout after settle", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ONE_GWEI;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            await expect(escrow.connect(bundler).claimPayout())
                .to.emit(escrow, "PayoutClaimed")
                .withArgs(bundler.address, fee);

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
        });

        it("11.02 feeRecipient can claimPayout after commit (PROTOCOL_FEE_WEI > 0)", async function () {
            const flatFee = 1_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            // feeRecipient's pending was credited at commit time

            await expect(escrow.connect(feeRecipient).claimPayout())
                .to.emit(escrow, "PayoutClaimed")
                .withArgs(feeRecipient.address, flatFee);
        });

        it("11.03 claimPayout with nothing pending reverts NothingToClaim", async function () {
            const { escrow, stranger } = await deployWith();
            await expect(
                escrow.connect(stranger).claimPayout(),
            ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });

        it("11.04 claimPayout twice reverts NothingToClaim on second call", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ONE_GWEI;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            await escrow.connect(bundler).claimPayout();
            await expect(
                escrow.connect(bundler).claimPayout(),
            ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
        });
    });

    // -- 12. Minimum-fee commits succeed with new model ------------------------
    describe("12. Minimum-fee (1 wei) commits succeed (no FeeTooSmall in PROTOCOL_FEE_WEI model)", function () {

        it("12.01 commit with feePerOp=1 wei succeeds", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1n, collateralWei: 1n });
            await escrow.connect(bundler).deposit({ value: 1n });
            const accGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1n),
            )
                .to.emit(escrow, "CommitCreated")
                .withArgs(0n, qid, user.address, bundler.address, anyValue, blockBefore + 1n + accGrace);
        });

        it("12.02 commit with feePerOp=1 wei settles correctly", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1n, collateralWei: 1n });
            await escrow.connect(bundler).deposit({ value: 1n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1n);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(1n);
        });

        it("12.03 commit with feePerOp=1 wei + PROTOCOL_FEE_WEI requires exact msg.value", async function () {
            const flatFee = 500n;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1n, collateralWei: 1n });
            await escrow.connect(bundler).deposit({ value: 1n });
            const accGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());
            const blockBefore = BigInt(await ethers.provider.getBlockNumber());
            // msg.value = 1 + 500 = 501
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1n + flatFee),
            )
                .to.emit(escrow, "CommitCreated")
                .withArgs(0n, qid, user.address, bundler.address, anyValue, blockBefore + 1n + accGrace);
        });
    });

    // -- 13. WrongFee event data correctness ----------------------------------
    describe("13. WrongFee revert carries correct sent/required values", function () {

        it("13.01 WrongFee(sent=1001, required=1000) when overpaying 1000-wei offer by 1", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1000n, collateralWei: 0n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 1001n),
            )
                .to.be.revertedWithCustomError(escrow, "WrongFee")
                .withArgs(1001n, 1000n);
        });

        it("13.02 WrongFee(sent=0, required=1000) when sending nothing to 1000-wei offer", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: 1000n, collateralWei: 0n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 0n),
            )
                .to.be.revertedWithCustomError(escrow, "WrongFee")
                .withArgs(0n, 1000n);
        });

        it("13.03 WrongFee(sent=0) when sending nothing to standard offer (no FeeTooSmall)", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler);
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), 0n),
            )
                .to.be.revertedWithCustomError(escrow, "WrongFee")
                .withArgs(0n, ONE_GWEI);
        });
    });

    // -- 14. Rounding: bundler never receives more than feePaid ----------------
    describe("14. Rounding: bundlerNet == feePerOp always (no rounding in flat-fee model)", function () {

        // NOTE: collateral must be strictly > fee (T8). For the near-max case we use
        // fee = MAX_UINT96 - 1, collateral = MAX_UINT96.
        const cases: Array<[bigint, bigint]> = [
            [ONE_GWEI, ethers.parseEther("0.01")],
            [1n, 2n],
            [10n, 11n],
            [1000n, 1001n],
            [10_000n, 10_001n],
            [MAX_UINT96 - 1n, MAX_UINT96],
            [ethers.parseEther("0.1"), ethers.parseEther("0.2")],
        ];

        for (const [feePerOp, collateralWei] of cases) {
            it(`14.x bundlerNet == feePerOp for fee=${feePerOp}`, async function () {
                if (feePerOp > MAX_UINT96) return;
                const { escrow, registry, bundler, user } = await deployWith();
                const qid = await setupOffer(registry, escrow, bundler, { feePerOp, collateralWei });
                await setBalance(user.address, feePerOp + ethers.parseEther("1"));
                await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), feePerOp);
                const commitId = (await escrow.nextCommitId()) - 1n;
                await escrow.connect(bundler).accept(commitId);
                await escrow.connect(bundler).settle(commitId);

                const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
                expect(bundlerPending).to.equal(feePerOp);
                expect(bundlerPending).to.be.lte(feePerOp);
            });
        }
    });

    // -- 15. Settled event shape (2 args: commitId, bundlerNet) ---------------
    describe("15. Settled event carries commitId and bundlerNet (no platformFee arg)", function () {

        it("15.01 Settled event: PROTOCOL_FEE_WEI=0, bundlerNet = feePerOp", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = 100n;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            await escrow.connect(bundler).accept(commitId);
            await expect(escrow.connect(bundler).settle(commitId))
                .to.emit(escrow, "Settled")
                .withArgs(commitId, fee);
        });

        it("15.02 Settled event: PROTOCOL_FEE_WEI=0, fee=ONE_GWEI, bundlerNet=ONE_GWEI", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ONE_GWEI;
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            await escrow.connect(bundler).accept(commitId);
            await expect(escrow.connect(bundler).settle(commitId))
                .to.emit(escrow, "Settled")
                .withArgs(commitId, ONE_GWEI);
        });

        it("15.03 Settled event: PROTOCOL_FEE_WEI > 0, bundlerNet still = feePerOp (flat fee taken at commit)", async function () {
            const flatFee = 10_000n;
            const feePerOp = ONE_GWEI;
            const { escrow, registry, bundler, user } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp, collateralWei: 0n });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), feePerOp + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            await escrow.connect(bundler).accept(commitId);
            await expect(escrow.connect(bundler).settle(commitId))
                .to.emit(escrow, "Settled")
                .withArgs(commitId, feePerOp);
        });
    });

    // -- 16. One-wei over/under boundary --------------------------------------
    describe("16. One-wei over/under boundary", function () {

        it("16.01 feePerOp = 500 gwei; sending 500 gwei - 1 reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ethers.parseUnits("500", "gwei");
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee - 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("16.02 feePerOp = 500 gwei; sending 500 gwei + 1 reverts WrongFee", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ethers.parseUnits("500", "gwei");
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee + 1n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee");
        });

        it("16.03 feePerOp = 500 gwei; sending exact 500 gwei succeeds", async function () {
            const { escrow, registry, bundler, user } = await deployWith();
            const fee = ethers.parseUnits("500", "gwei");
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: fee, collateralWei: 0n });
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), fee),
            ).to.not.be.reverted;
        });
    });

    // -- 17. Cancel path, fee-recipient rotation, and accounting invariant ----
    describe("17. Cancel path, feeRecipient rotation, and accounting invariant", function () {

        it("17.01 cancel with nonzero PROTOCOL_FEE_WEI: user recovers feePerOp, protocol keeps flatFee (non-refundable T4)", async function () {
            const flatFee = 5_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;

            await escrow.connect(user).cancel(commitId);

            expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(flatFee);
        });

        it("17.02 race: PROTOCOL_FEE_WEI raised between off-chain read and commit -- WrongFee on stale value (T5)", async function () {
            const { escrow, registry, owner, bundler, user } = await deployWith(500n);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await (escrow as any).connect(owner).setProtocolFeeWei(1000n);
            await expect(
                commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + 500n),
            ).to.be.revertedWithCustomError(escrow, "WrongFee")
              .withArgs(ONE_GWEI + 500n, ONE_GWEI + 1000n);
        });

        it("17.03 feeRecipient rotation revokes cleanup authority -- new feeRecipient can cancel expired commit, old cannot", async function () {
            const { escrow, registry, owner, bundler, user, feeRecipient, altRecipient } = await deployWith();
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });
            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI);
            const commitId = (await escrow.nextCommitId()) - 1n;

            // mine past accept window so feeRecipient authority applies to cancel
            await mine(Number(await escrow.ACCEPT_GRACE_BLOCKS()) + 1);

            await (escrow as any).connect(owner).setFeeRecipient(altRecipient.address);

            await expect(
                escrow.connect(feeRecipient).cancel(commitId),
            ).to.be.revertedWithCustomError(escrow, "Unauthorized");

            await expect(escrow.connect(altRecipient).cancel(commitId)).to.not.be.reverted;
        });

        it("17.04 accounting invariant on nonzero-fee path: contractBalance == deposited + sum(pendingWithdrawals) after commit+settle", async function () {
            const flatFee = 2_000n;
            const { escrow, registry, bundler, user, feeRecipient } = await deployWith(flatFee);
            const qid = await setupOffer(registry, escrow, bundler, { feePerOp: ONE_GWEI });

            await commitOp(escrow, registry, user, qid, ethers.randomBytes(32), ONE_GWEI + flatFee);
            const commitId = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(bundler).accept(commitId);
            await escrow.connect(bundler).settle(commitId);

            const collateralDeposited = await escrow.deposited(bundler.address);
            const bundlerPending      = await escrow.pendingWithdrawals(bundler.address);
            const recipientPending    = await escrow.pendingWithdrawals(feeRecipient.address);
            const contractBal         = await ethers.provider.getBalance(await escrow.getAddress());

            expect(collateralDeposited + bundlerPending + recipientPending).to.equal(contractBal);
        });
    });
});
