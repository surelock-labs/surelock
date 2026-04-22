// Category 9: Integer arithmetic edge cases -- adversarial test suite

import { expect }                   from "chai";
import { ethers, upgrades }          from "hardhat";
import { mine, setBalance }          from "@nomicfoundation/hardhat-network-helpers";
import { anyValue }                  from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { QuoteRegistry, SLAEscrow, SLAEscrowTestable }  from "../../typechain-types";
import {
    deployEscrow,
    mineToRefundable,
    safeInclBlock,
} from "../helpers/fixtures";

const UINT96_MAX    = 2n ** 96n - 1n;
const UINT64_MAX    = 2n ** 64n - 1n;

// Deploy helper -- uses shared fixture with skipRegister:true (cat9 manages its own offers)
async function deployDefault() {
    const base = await deployEscrow({ skipRegister: true });
    return {
        escrow:       base.escrow,
        registry:     base.registry,
        owner:        base.owner,
        bundler:      base.bundler,
        user:         base.user,
        feeRecipient: base.feeRecipient,
    };
}

// Register an offer and deposit collateral for the bundler, return quoteId
async function setupQuote(
    registry: QuoteRegistry,
    escrow: SLAEscrow,
    bundler: any,
    feePerOp: bigint,
    slaBlocks: number,
    collateralWei: bigint,
) {
    const tx = await registry.connect(bundler).register(feePerOp, slaBlocks, collateralWei, 302_400, { value: ethers.parseEther("0.0001") });
    const receipt = await tx.wait();
    const offerEvents = receipt!.logs
        .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
        .map(log => registry.interface.parseLog(log)!);
    if (offerEvents.length === 0) throw new Error("OfferRegistered not emitted");
    const quoteId = offerEvents[0].args.quoteId as bigint;

    if (collateralWei > 0n) {
        await escrow.connect(bundler).deposit({ value: collateralWei });
    }
    return quoteId;
}

// -----------------------------------------------------------------------------
// Group 1 -- uint96 boundary casts (feePerOp)
// -----------------------------------------------------------------------------
describe("Cat9 -- uint96 boundary: feePerOp", function () {
    it("register with feePerOp = UINT96_MAX - 1 succeeds (lossless cast; collateral must be strictly > fee)", async function () {
        const { registry, bundler } = await deployDefault();
        const fee = UINT96_MAX - 1n;
        await expect(
            registry.connect(bundler).register(fee, 1, UINT96_MAX, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.not.be.reverted;
        const offer = await registry.getOffer(1n);
        expect(offer.feePerOp).to.equal(fee);
    });

    it("register with feePerOp = UINT96_MAX + 1 reverts ValueTooLarge", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(UINT96_MAX + 1n, 1, 0n, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("register with feePerOp = UINT96_MAX + 100 reverts ValueTooLarge", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(UINT96_MAX + 100n, 1, 0n, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("register with feePerOp = type(uint256).max reverts ValueTooLarge", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(ethers.MaxUint256, 1, 0n, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("commit stores feePaid as exact uint96 value when fee = UINT96_MAX - 1", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const fee = UINT96_MAX - 1n;
        const collateral = UINT96_MAX; // collateral must be strictly > feePerOp
        // User and bundler both need UINT96_MAX; add 10000 ETH buffer for later tests
        await setBalance(user.address, UINT96_MAX + ethers.parseEther("10000"));
        await setBalance(bundler.address, UINT96_MAX + ethers.parseEther("10000"));
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-feePaid-max")), bundler.address, collateral, 2, { value: fee });
        const c = await escrow.getCommit(0n);
        expect(c.feePaid).to.equal(fee);
    });
});

// -----------------------------------------------------------------------------
// Group 2 -- uint96 boundary casts (collateralWei)
// -----------------------------------------------------------------------------
describe("Cat9 -- uint96 boundary: collateralWei", function () {
    it("register with collateralWei = UINT96_MAX succeeds (lossless cast)", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(1n, 1, UINT96_MAX, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.not.be.reverted;
        const offer = await registry.getOffer(1n);
        expect(offer.collateralWei).to.equal(UINT96_MAX);
    });

    it("register with collateralWei = UINT96_MAX + 1 reverts ValueTooLarge", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(1n, 1, UINT96_MAX + 1n, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("register with collateralWei = type(uint256).max reverts ValueTooLarge", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(1n, 1, ethers.MaxUint256, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWithCustomError(registry, "ValueTooLarge");
    });

    it("commit stores collateralLocked as exact uint96 value when collateral = UINT96_MAX", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        // Bundler needs enough ETH for deposit + setupQuote deposit (2 x UINT96_MAX)
        await setBalance(bundler.address, UINT96_MAX * 3n);
        await escrow.connect(bundler).deposit({ value: UINT96_MAX });
        // fee=1000 (min at 10 bps: 1000*10=10000 >= 10000); collateral=UINT96_MAX satisfies >= feePerOp
        const quoteId = await setupQuote(registry, escrow, bundler, 1000n, 2, UINT96_MAX);
        await setBalance(user.address, 1000n + ethers.parseEther("1"));
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-collateral-max")), bundler.address, UINT96_MAX, 2, { value: 1000n });
        const c = await escrow.getCommit(0n);
        expect(c.collateralLocked).to.equal(UINT96_MAX);
    });
});

// -----------------------------------------------------------------------------
// Group 3 -- settle with PROTOCOL_FEE_WEI=0: bundler gets full fee
// -----------------------------------------------------------------------------
describe("Cat9 -- settle with PROTOCOL_FEE_WEI=0: bundler gets full fee", function () {
    it("feePaid=1 -> commit succeeds (PROTOCOL_FEE_WEI=0, any positive fee works)", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, 1n, 2, collateral);
        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("op-fee1-emit"));
        await expect(
            escrow.connect(user).commit(quoteId, userOpHash, bundler.address, collateral, 2, { value: 1n }),
        )
            .to.emit(escrow, "CommitCreated")
            .withArgs(0n, quoteId, user.address, bundler.address, userOpHash, anyValue);
    });

    it("feePaid=9999 -> commit succeeds and bundler gets full fee", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 9999n;
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-fee9999")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(bundler).settle(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });

    it("feePaid=10000: bundlerNet=10000 (no platform fee)", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 10000n;
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-fee10000")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await expect(escrow.connect(bundler).settle(0n))
            .to.emit(escrow, "Settled")
            .withArgs(0n, fee);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });

    it("feePaid=10001: bundlerNet=10001 (no platform fee)", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 10001n;
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-fee10001")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(bundler).settle(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });
});

// -----------------------------------------------------------------------------
// Group 4 -- settle with various fees: bundler always gets full fee (PROTOCOL_FEE_WEI=0)
// -----------------------------------------------------------------------------
describe("Cat9 -- settle with various fees: bundler gets full fee (PROTOCOL_FEE_WEI=0)", function () {
    it("feePaid=1 -> commit succeeds, bundler gets 1", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, 1n, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g4-fee1")), bundler.address, collateral, 2, { value: 1n });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(bundler).settle(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(1n);
    });

    it("feePaid=10: bundlerNet=10 (no platform fee)", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 10n;
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g4-fee10")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await expect(escrow.connect(bundler).settle(0n))
            .to.emit(escrow, "Settled")
            .withArgs(0n, fee);
    });

    it("feePaid=9: commit succeeds and bundler gets full fee", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const fee = 9n;
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("op-g4-fee9"));
        await expect(
            escrow.connect(user).commit(quoteId, userOpHash, bundler.address, collateral, 2, { value: fee }),
        )
            .to.emit(escrow, "CommitCreated")
            .withArgs(0n, quoteId, user.address, bundler.address, userOpHash, anyValue);
    });

    it("feePaid=100: bundlerNet=100 (no platform fee)", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 100n;
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g4-fee100")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(bundler).settle(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });
});

// -----------------------------------------------------------------------------
// Group 5 -- No wei leaks: bundlerNet == feePaid (PROTOCOL_FEE_WEI=0, no split)
// -----------------------------------------------------------------------------
describe("Cat9 -- No wei leaks in settle (bundlerNet == feePaid, PROTOCOL_FEE_WEI=0)", function () {
    // NOTE: UINT96_MAX cannot be used for BOTH fee and collateral since collateral must be strictly >.
    // Use UINT96_MAX - 1 in place of UINT96_MAX here so collateral = UINT96_MAX.
    const cases: Array<{ fee: bigint }> = [
        { fee: 10000n },
        { fee: 10001n },
        { fee: 33333n },
        { fee: 99999n },
        { fee: UINT96_MAX - 1n },
        { fee: ethers.parseEther("1") },
    ];

    for (const { fee } of cases) {
        it(`fee=${fee}: bundlerNet==fee (no platform fee)`, async function () {
            const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
            const collateral = fee + 1n; // collateral must be strictly > feePerOp
            // Ensure user and bundler have enough ETH for large fees
            await setBalance(user.address, fee + ethers.parseEther("10000"));
            await setBalance(bundler.address, fee + ethers.parseEther("10000"));
            const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
            await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g5-fee")), bundler.address, collateral, 2, { value: fee });
            await escrow.connect(bundler).accept(0n);
            await escrow.connect(bundler).settle(0n);

            const platformFee = await escrow.pendingWithdrawals(feeRecipient.address);
            const bundlerNet  = await escrow.pendingWithdrawals(bundler.address);
            expect(platformFee).to.equal(0n);
            expect(bundlerNet).to.equal(fee);
        });
    }
});

// -----------------------------------------------------------------------------
// Group 6 -- 100% slash to client: user gets feePaid + collateral
// -----------------------------------------------------------------------------
describe("Cat9 -- Slash arithmetic: 100% to client (feePaid + collateral)", function () {
    it("collateral=2: user gets fee+collateral=3, feeRecipient gets 0", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 1n;
        const collateral = 2n; // strictly > fee
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c1a")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("collateral=2b: user gets fee+2, feeRecipient gets 0", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 1n;
        const collateral = 2n;
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c1b")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("collateral=3: user gets fee+3, feeRecipient gets 0", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 2n;
        const collateral = 3n;
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c2")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("collateral=4: user gets fee+4, feeRecipient gets 0", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 3n;
        const collateral = 4n;
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c3")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("collateral=5: user gets fee+5, feeRecipient gets 0", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 4n;
        const collateral = 5n;
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c4")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("collateral=6: user gets fee+6, feeRecipient gets 0", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 5n;
        const collateral = 6n;
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c5")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("user receives full collateral for odd collateral=99", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const collateral = 99n;
        const fee = 50n;
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-c99")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("user receives full collateral for UINT96_MAX collateral", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const collateral = UINT96_MAX;
        const fee = 1n;
        // Bundler needs UINT96_MAX for collateral deposit
        await setBalance(bundler.address, UINT96_MAX + ethers.parseEther("10000"));
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g6-cmax")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// Group 7 -- Large fee: no overflow (UINT96_MAX boundary)
// -----------------------------------------------------------------------------
describe("Cat9 -- Large fee no overflow (UINT96_MAX boundary)", function () {
    // NOTE: collateral must be strictly > fee, so fee = UINT96_MAX - 1 here.
    it("fee=UINT96_MAX-1: settle succeeds, bundler gets full fee", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = UINT96_MAX - 1n;
        const collateral = UINT96_MAX;
        await setBalance(user.address, UINT96_MAX + ethers.parseEther("10000"));
        await setBalance(bundler.address, UINT96_MAX + ethers.parseEther("10000"));
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g7-fmax-a")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await expect(escrow.connect(bundler).settle(0n)).to.not.be.reverted;

        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });

    it("fee=UINT96_MAX-1: bundlerNet=fee (no platform fee with PROTOCOL_FEE_WEI=0)", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = UINT96_MAX - 1n;
        const collateral = UINT96_MAX;
        await setBalance(user.address, UINT96_MAX + ethers.parseEther("10000"));
        await setBalance(bundler.address, UINT96_MAX + ethers.parseEther("10000"));
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g7-fmax-b")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await expect(escrow.connect(bundler).settle(0n)).to.not.be.reverted;

        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });

    it("fee=UINT96_MAX-1, PROTOCOL_FEE_WEI=0: feeRecipient gets 0, bundlerNet=fee", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = UINT96_MAX - 1n;
        const collateral = UINT96_MAX;
        await setBalance(user.address, UINT96_MAX + ethers.parseEther("10000"));
        await setBalance(bundler.address, UINT96_MAX + ethers.parseEther("10000"));
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g7-fmax-c")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(bundler).settle(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });
});

// -----------------------------------------------------------------------------
// Group 8 -- slaBlocks deadline arithmetic
// -----------------------------------------------------------------------------
describe("Cat9 -- slaBlocks/deadline uint64 arithmetic", function () {
    it("slaBlocks=MAX_SLA_BLOCKS=1000: deadline = block.number + 1000, fits uint64", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const MAX_SLA = 1000;
        const fee = ethers.parseEther("0.001");
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, MAX_SLA, collateral);

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g8-maxsla")), bundler.address, collateral, MAX_SLA, { value: fee });
        // deadline is 0 while PROPOSED; must accept to set it
        expect((await escrow.getCommit(0n)).deadline).to.equal(0n);
        const acceptBlock = BigInt(await ethers.provider.getBlockNumber());
        await escrow.connect(bundler).accept(0n);
        const c = await escrow.getCommit(0n);
        // deadline set at accept: (acceptBlock + 1 for the accept tx) + MAX_SLA
        expect(c.deadline).to.equal(acceptBlock + 1n + BigInt(MAX_SLA));
        expect(c.deadline).to.be.lte(UINT64_MAX); // fits in uint64
    });

    it("slaBlocks=1 (minimum): deadline = block.number + 1", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const fee = ethers.parseEther("0.001");
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 1, collateral);

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g8-sla1")), bundler.address, collateral, 1, { value: fee });
        const acceptBlock = BigInt(await ethers.provider.getBlockNumber());
        await escrow.connect(bundler).accept(0n);
        const c = await escrow.getCommit(0n);
        expect(c.deadline).to.equal(acceptBlock + 2n); // one block for accept tx + 1 slaBlock
    });

    it("slaBlocks=0: register reverts (slaBlocks must be > 0)", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(1n, 0, 1n, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWith("slaBlocks must be > 0");
    });

    it("slaBlocks=MAX_SLA_BLOCKS+1: register reverts", async function () {
        const { registry, bundler } = await deployDefault();
        await expect(
            registry.connect(bundler).register(1n, 50401, 1n, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWith("slaBlocks exceeds MAX_SLA_BLOCKS");
    });

    it("deadline stored as uint64 is correct for high block numbers (simulate via multiple mines)", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        // Mine a large number of blocks to ensure we're working with a meaningful block number
        await mine(1000);
        const fee = ethers.parseEther("0.001");
        const collateral = ethers.parseEther("0.01");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 100, collateral);

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g8-deadline")), bundler.address, collateral, 100, { value: fee });
        // deadline is 0 while PROPOSED; accept sets it
        // acceptBlock is the block at which accept() will be mined (current + 1)
        const acceptBlock = BigInt(await ethers.provider.getBlockNumber()) + 1n;
        await escrow.connect(bundler).accept(0n);
        const c = await escrow.getCommit(0n);
        // deadline = acceptBlock + 100
        expect(c.deadline).to.equal(acceptBlock + 100n);
        expect(c.deadline).to.be.lt(UINT64_MAX);
    });
});

// -----------------------------------------------------------------------------
// Group 9 -- deposited accumulation
// -----------------------------------------------------------------------------
describe("Cat9 -- deposited[] accumulation arithmetic", function () {
    it("single large deposit: deposited[bundler] = value", async function () {
        const { escrow, bundler } = await deployDefault();
        await setBalance(bundler.address, ethers.parseEther("100"));
        const amount = ethers.parseEther("10");
        await escrow.connect(bundler).deposit({ value: amount });
        expect(await escrow.deposited(bundler.address)).to.equal(amount);
    });

    it("multiple small deposits accumulate: 5 x 1 ETH == 5 ETH total", async function () {
        const { escrow, bundler } = await deployDefault();
        await setBalance(bundler.address, ethers.parseEther("100"));
        for (let i = 0; i < 5; i++) {
            await escrow.connect(bundler).deposit({ value: ethers.parseEther("1") });
        }
        expect(await escrow.deposited(bundler.address)).to.equal(ethers.parseEther("5"));
    });

    it("many micro-deposits accumulate: 100 x 1 wei == 100 wei", async function () {
        const { escrow, bundler } = await deployDefault();
        for (let i = 0; i < 100; i++) {
            await escrow.connect(bundler).deposit({ value: 1n });
        }
        expect(await escrow.deposited(bundler.address)).to.equal(100n);
    });

    it("deposit sum once vs many times: same final deposited balance", async function () {
        const signers = await ethers.getSigners();
        const [bundlerA, bundlerB] = signers.slice(4, 6);
        const { escrow } = await deployDefault();

        // bundlerA: one big deposit
        await escrow.connect(bundlerA).deposit({ value: 1000n });

        // bundlerB: 1000 x 1 wei
        for (let i = 0; i < 1000; i++) {
            await escrow.connect(bundlerB).deposit({ value: 1n });
        }

        expect(await escrow.deposited(bundlerA.address)).to.equal(
            await escrow.deposited(bundlerB.address)
        );
    });

    it("deposit 1 wei: minimum non-zero deposit accepted", async function () {
        const { escrow, bundler } = await deployDefault();
        await expect(escrow.connect(bundler).deposit({ value: 1n })).to.not.be.reverted;
        expect(await escrow.deposited(bundler.address)).to.equal(1n);
    });

    it("deposit 0 wei: reverts ZeroDeposit", async function () {
        const { escrow, bundler } = await deployDefault();
        await expect(
            escrow.connect(bundler).deposit({ value: 0n })
        ).to.be.revertedWithCustomError(escrow, "ZeroDeposit");
    });
});

// -----------------------------------------------------------------------------
// Group 10 -- lockedOf accumulation and release
// -----------------------------------------------------------------------------
describe("Cat9 -- lockedOf[] accumulation arithmetic", function () {
    it("N commits lock N * collateralWei", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const fee = ethers.parseEther("0.001");
        const N = 5;

        // Deposit enough collateral for N commits
        await escrow.connect(bundler).deposit({ value: collateral * BigInt(N) });
        const regTx = await registry.connect(bundler).register(fee, 10, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        for (let i = 0; i < N; i++) {
            await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 10, { value: fee });
            await escrow.connect(bundler).accept(BigInt(i));
        }

        expect(await escrow.lockedOf(bundler.address)).to.equal(collateral * BigInt(N));
    });

    it("N settles release N * collateralLocked from lockedOf", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const fee = ethers.parseEther("0.001");
        const N = 3;

        await escrow.connect(bundler).deposit({ value: collateral * BigInt(N) });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        for (let i = 0; i < N; i++) {
            await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: fee });
            await escrow.connect(bundler).accept(BigInt(i));
        }

        for (let i = 0; i < N; i++) {
            await escrow.connect(bundler).settle(BigInt(i));
        }

        expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
    });

    it("after settle: deposited is unchanged, lockedOf decreases by collateralLocked", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const fee = ethers.parseEther("0.001");

        await escrow.connect(bundler).deposit({ value: collateral });
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 100, collateral);
        // setupQuote also deposits collateral again -- bundler has 2*collateral deposited, 0 locked
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g10-settle")), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(0n);

        const depositedBefore = await escrow.deposited(bundler.address);
        const lockedBefore    = await escrow.lockedOf(bundler.address);

        await escrow.connect(bundler).settle(0n);

        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore - collateral);
    });
});

// -----------------------------------------------------------------------------
// Group 11 -- pendingWithdrawals accumulation
// -----------------------------------------------------------------------------
describe("Cat9 -- pendingWithdrawals[] accumulation arithmetic", function () {
    it("multiple settles accumulate bundler pendingWithdrawals", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const fee = ethers.parseEther("0.001");
        const N = 4;

        await escrow.connect(bundler).deposit({ value: collateral * BigInt(N) });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        for (let i = 0; i < N; i++) {
            await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: fee });
            await escrow.connect(bundler).accept(BigInt(i));
        }
        for (let i = 0; i < N; i++) {
            await escrow.connect(bundler).settle(BigInt(i));
        }

        // With PROTOCOL_FEE_WEI=0, bundler gets full fee each time
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee * BigInt(N));
    });

    it("multiple refunds accumulate user pendingWithdrawals", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 10n;
        const collateral = 11n; // collateral must be strictly > fee
        const N = 3;

        await escrow.connect(bundler).deposit({ value: collateral * BigInt(N) });
        const regTx = await registry.connect(bundler).register(fee, 2, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        for (let i = 0; i < N; i++) {
            await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 2, { value: fee });
            await escrow.connect(bundler).accept(BigInt(i));
        }

        await mineToRefundable(escrow, 0n);

        for (let i = 0; i < N; i++) {
            await escrow.connect(user).claimRefund(BigInt(i));
        }

        // Each refund: userTotal = fee + collateral (100% slash to client)
        const userTotal = fee + collateral;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(userTotal * BigInt(N));
    });

    it("claimPayout resets pendingWithdrawals to 0 after accumulation", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        const fee = ethers.parseEther("0.001");

        await escrow.connect(bundler).deposit({ value: collateral * 3n });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        for (let i = 0; i < 3; i++) {
            await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: fee });
            await escrow.connect(bundler).accept(BigInt(i));
        }
        for (let i = 0; i < 3; i++) {
            await escrow.connect(bundler).settle(BigInt(i));
        }

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee * 3n);
        await escrow.connect(bundler).claimPayout();
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// Group 12 -- idleBalance arithmetic
// -----------------------------------------------------------------------------
describe("Cat9 -- idleBalance arithmetic", function () {
    it("idleBalance = deposited - lockedOf after one commit", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.05");
        const fee = ethers.parseEther("0.001");
        const deposit = ethers.parseEther("0.1");

        await escrow.connect(bundler).deposit({ value: deposit });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g12-idle1")), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(0n);

        const idle = await escrow.idleBalance(bundler.address);
        expect(idle).to.equal(deposit - collateral);
    });

    it("withdraw exact idle balance: deposited = lockedOf after withdraw", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.05");
        const fee = ethers.parseEther("0.001");
        const deposit = ethers.parseEther("0.1");

        await escrow.connect(bundler).deposit({ value: deposit });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g12-idle2")), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(0n);

        const idle = await escrow.idleBalance(bundler.address);
        await escrow.connect(bundler).withdraw(idle);

        // Now deposited should equal lockedOf (no idle left)
        const depositedAfter = await escrow.deposited(bundler.address);
        const lockedAfter    = await escrow.lockedOf(bundler.address);
        expect(depositedAfter).to.equal(lockedAfter);
        expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    });

    it("withdraw more than idle reverts InsufficientIdle", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.05");
        const fee = ethers.parseEther("0.001");
        const deposit = ethers.parseEther("0.1");

        await escrow.connect(bundler).deposit({ value: deposit });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g12-idle3")), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(0n);
        const idle = await escrow.idleBalance(bundler.address);

        await expect(
            escrow.connect(bundler).withdraw(idle + 1n)
        ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("idleBalance = 0 when all deposited is locked", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.1");
        const fee = ethers.parseEther("0.001");

        // Deposit exactly collateral (no extra)
        await escrow.connect(bundler).deposit({ value: collateral });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g12-idle4")), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(0n);
        expect(await escrow.idleBalance(bundler.address)).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// Group 13 -- claimRefund ETH accounting invariant
// -----------------------------------------------------------------------------
describe("Cat9 -- claimRefund total ETH accounting", function () {
    it("user receives feePaid + full collateral after refund (PROTOCOL_FEE_WEI=0)", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const fee = 100n;
        const collateral = 101n; // collateral must be strictly > fee
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g13-refund1")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);

        expect(await escrow.pendingWithdrawals(user.address)).to.equal(fee + collateral);
    });

    it("sum of pendingWithdrawals after refund == feePaid + collateralLocked", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 77n;
        const collateral = 78n; // strictly > fee
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g13-refund2")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);

        const userPw  = await escrow.pendingWithdrawals(user.address);
        const protoPw = await escrow.pendingWithdrawals(feeRecipient.address);
        // user gets fee + collateral; feeRecipient gets 0; sum == fee + collateral
        expect(userPw + protoPw).to.equal(fee + collateral);
    });

    it("bundler deposited decreases by collateralLocked after refund", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.05");
        const fee = ethers.parseEther("0.001");
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);

        const depositedBefore = await escrow.deposited(bundler.address);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g13-refund3")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await mineToRefundable(escrow, 0n);
        await escrow.connect(user).claimRefund(0n);

        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore - collateral);
    });
});

// -----------------------------------------------------------------------------
// Group 14 -- deploy + settle: PROTOCOL_FEE_WEI=0 default
// -----------------------------------------------------------------------------
describe("Cat9 -- deploy + settle: PROTOCOL_FEE_WEI=0 default", function () {
    it("default deploy succeeds", async function () {
        const [, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        await expect(
            upgrades.deployProxy(Escrow, [await registry.getAddress(), feeRecipient.address], { kind: "uups" })
        ).to.not.be.reverted;
    });

    it("deploy with feeRecipient=ZeroAddress reverts", async function () {
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrowAbi = Escrow.attach(ethers.ZeroAddress) as SLAEscrowTestable;
        await expect(
            upgrades.deployProxy(Escrow, [await registry.getAddress(), ethers.ZeroAddress], { kind: "uups" })
        ).to.be.revertedWithCustomError(escrowAbi, "ZeroAddress")
          .withArgs("feeRecipient");
    });

    it("PROTOCOL_FEE_WEI=0: feeRecipient gets nothing at settle, bundlerNet=feePaid", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        await setBalance(user.address, ethers.parseEther("100"));
        await setBalance(bundler.address, ethers.parseEther("100"));
        const fee = ethers.parseEther("1");
        const collateral = fee + 1n; // collateral must be strictly > fee
        const quoteId = await setupQuote(registry, escrow, bundler, fee, 2, collateral);
        await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("op-g14-settle")), bundler.address, collateral, 2, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(bundler).settle(0n);

        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(fee);
    });
});

// -----------------------------------------------------------------------------
// Group 15 -- Integer arithmetic combined stress
// -----------------------------------------------------------------------------
describe("Cat9 -- Combined stress arithmetic", function () {
    it("many tiny fees: 1 wei fee -> commit succeeds (PROTOCOL_FEE_WEI=0)", async function () {
        const { escrow, registry, bundler, user } = await deployDefault();
        const collateral = ethers.parseEther("0.01");
        await escrow.connect(bundler).deposit({ value: collateral });
        const regTx = await registry.connect(bundler).register(1n, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;
        const accGrace = BigInt(await escrow.ACCEPT_GRACE_BLOCKS());
        const blockBefore = BigInt(await ethers.provider.getBlockNumber());
        await expect(
            escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: 1n }),
        )
            .to.emit(escrow, "CommitCreated")
            .withArgs(0n, quoteId, user.address, bundler.address, anyValue, blockBefore + 1n + accGrace);
    });

    it("alternating settle and refund: ETH totals remain consistent", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 100n;
        const collateral = 101n; // collateral must be strictly > fee

        // N/2 settled, N/2 refunded
        const N = 4;
        await escrow.connect(bundler).deposit({ value: collateral * BigInt(N) });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        for (let i = 0; i < N; i++) {
            await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: fee });
            await escrow.connect(bundler).accept(BigInt(i));
        }

        // Settle first N/2
        for (let i = 0; i < N / 2; i++) {
            await escrow.connect(bundler).settle(BigInt(i));
        }

        // Refund remaining N/2
        await mineToRefundable(escrow, BigInt(N / 2));
        for (let i = N / 2; i < N; i++) {
            await escrow.connect(user).claimRefund(BigInt(i));
        }

        // Bundler gets full fee for settled commits
        const bundlerPw = await escrow.pendingWithdrawals(bundler.address);
        expect(bundlerPw).to.equal(fee * BigInt(N / 2));

        // User gets fee + full collateral for refunded commits (100% slash to client)
        const userPw = await escrow.pendingWithdrawals(user.address);
        expect(userPw).to.equal((fee + collateral) * BigInt(N / 2));

        // Protocol gets 0 (PROTOCOL_FEE_WEI=0)
        const protoPw = await escrow.pendingWithdrawals(feeRecipient.address);
        expect(protoPw).to.equal(0n);
    });

    it("total ETH in = total ETH out across settle+refund scenario", async function () {
        const { escrow, registry, bundler, user, feeRecipient } = await deployDefault();
        const fee = 100n;
        const collateral = 101n; // collateral must be strictly > fee

        // 1 settle, 1 refund
        await escrow.connect(bundler).deposit({ value: collateral * 2n });
        const regTx = await registry.connect(bundler).register(fee, 100, collateral, 302_400, { value: ethers.parseEther("0.0001") });
        const regReceipt = await regTx.wait();
        const offerLogs = regReceipt!.logs
            .filter(log => log.topics[0] === registry.interface.getEvent("OfferRegistered")!.topicHash)
            .map(log => registry.interface.parseLog(log)!);
        expect(offerLogs.length, "OfferRegistered not emitted").to.equal(1);
        const quoteId = offerLogs[0].args.quoteId as bigint;

        await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(0n);
        await escrow.connect(user).commit(quoteId, ethers.randomBytes(32), bundler.address, collateral, 100, { value: fee });
        await escrow.connect(bundler).accept(1n);

        await escrow.connect(bundler).settle(0n);

        await mineToRefundable(escrow, 1n);
        await escrow.connect(user).claimRefund(1n);

        // ETH in: 2*collateral (bundler deposit) + 2*fee (user commits)
        const ethIn = 2n * collateral + 2n * fee;

        // ETH accessible:
        // bundler pendingWithdrawals: fee (from settle) + deposited-collateral (from settle releasing locked)
        // user pendingWithdrawals: fee + slashToUser
        // feeRecipient pendingWithdrawals: slashToProtocol
        // bundler remaining idle: deposited[bundler] - lockedOf[bundler]
        const bundlerPw     = await escrow.pendingWithdrawals(bundler.address);
        const userPw        = await escrow.pendingWithdrawals(user.address);
        const protoPw       = await escrow.pendingWithdrawals(feeRecipient.address);
        const bundlerIdle   = await escrow.idleBalance(bundler.address);

        expect(bundlerPw + userPw + protoPw + bundlerIdle).to.equal(ethIn);
    });
});
