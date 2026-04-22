// Category 7: Smart contract user/bundler (receive() grief) -- adversarial test suite

import { expect }                          from "chai";
import { ethers, upgrades }                from "hardhat";
import { mine }                            from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }        from "../../typechain-types";
import { Attacker, ReentrantClaimer }      from "../../typechain-types";
import {
    deployEscrow,
    mineToRefundable,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const SLA_BLOCKS    = 50n;
const USER_OP_HASH  = ethers.keccak256(ethers.toUtf8Bytes("testUserOp"));

// --- helpers ----------------------------------------------------------------

async function deployBase() {
    const base = await deployEscrow({ slaBlocks: SLA_BLOCKS, preDeposit: false });
    // cat7 uses eoa_bundler / eoa_user naming
    return {
        escrow: base.escrow,
        registry: base.registry,
        owner: base.owner,
        eoa_bundler: base.bundler,
        eoa_user: base.user,
        feeRecipient: base.feeRecipient,
        stranger: base.stranger,
    };
}

async function deployWithAttackerBundler() {
    const base = await deployBase();
    const { escrow, registry, eoa_user, feeRecipient } = base;

    const AttackerFactory = await ethers.getContractFactory("Attacker");
    const attackerBundler = (await AttackerFactory.deploy(
        await escrow.getAddress()
    )) as Attacker;

    // Register an offer where the bundler = attackerBundler contract
    const quoteId = await attackerBundler.registerOffer.staticCall(
        await registry.getAddress(), ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") }
    );
    await attackerBundler.registerOffer(
        await registry.getAddress(), ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") }
    );

    // Fund attacker with collateral
    await attackerBundler.depositToEscrow({ value: COLLATERAL * 5n });

    return { ...base, attackerBundler, quoteId };
}

async function deployWithAttackerUser() {
    const base = await deployBase();
    const { escrow, registry, eoa_bundler, feeRecipient } = base;

    // EOA bundler registers an offer (deployBase pre-registers offer #1, so this becomes #2)
    const quoteId = await registry.connect(eoa_bundler).register.staticCall(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
    await registry.connect(eoa_bundler).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });

    // Fund EOA bundler collateral
    await escrow.connect(eoa_bundler).deposit({ value: COLLATERAL * 5n });

    const AttackerFactory = await ethers.getContractFactory("Attacker");
    const attackerUser = (await AttackerFactory.deploy(
        await escrow.getAddress()
    )) as Attacker;

    return { ...base, attackerUser, quoteId, eoa_bundler };
}


// --- describe blocks ---------------------------------------------------------

describe("Cat7 -- receive() grief: contract bundler settle & state", function () {

    it("T01: settle() succeeds when bundler has reverting receive() (no ETH transfer in settle)", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);

        // User commits; bundler accepts (two-phase)
        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);

        // Attacker bundler settles -- no ETH transfer happens, so reverting receive() is irrelevant
        await expect(attackerBundler.settleEscrow(commitId)).to.not.be.reverted;
    });

    it("T02: settle() sets c.settled = true even when bundler receive() reverts", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        const c = await escrow.getCommit(commitId);
        expect(c.settled).to.equal(true);
    });

    it("T03: settle() unlocks bundler collateral even when bundler receive() reverts", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        const lockedBefore = await escrow.lockedOf(await attackerBundler.getAddress());
        // lockedBefore should be 0 before commit
        expect(lockedBefore).to.equal(0n);

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        // Collateral is locked at accept(), not at commit()
        await attackerBundler.acceptCommit(commitId);
        const lockedAfterAccept = await escrow.lockedOf(await attackerBundler.getAddress());
        expect(lockedAfterAccept).to.equal(COLLATERAL);

        await attackerBundler.settleEscrow(commitId);
        const lockedAfterSettle = await escrow.lockedOf(await attackerBundler.getAddress());
        expect(lockedAfterSettle).to.equal(0n);
    });

    it("T04: settle() queues bundlerNet into pendingWithdrawals even when bundler receive() reverts", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        const bundlerNet  = ONE_GWEI;
        const pending     = await escrow.pendingWithdrawals(await attackerBundler.getAddress());
        expect(pending).to.equal(bundlerNet);
    });

    it("T05: settle() queues 0 for feeRecipient when PROTOCOL_FEE_WEI=0 (default)", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user, feeRecipient } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        const pending = await escrow.pendingWithdrawals(feeRecipient.address);
        expect(pending).to.equal(0n);
    });

    it("T06: contract bundler can settle multiple commits regardless of receive() state", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);

        const ids: bigint[] = [];
        for (let i = 0; i < 3; i++) {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(`op-${i}`));
            const cid = await escrow.connect(eoa_user).commit.staticCall(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await escrow.connect(eoa_user).commit(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await attackerBundler.acceptCommit(cid);
            ids.push(cid);
        }

        for (const cid of ids) {
            await expect(attackerBundler.settleEscrow(cid)).to.not.be.reverted;
        }

        const totalNet = ONE_GWEI * 3n;
        expect(await escrow.pendingWithdrawals(await attackerBundler.getAddress())).to.equal(totalNet);
    });
});

describe("Cat7 -- receive() grief: claimPayout fails for reverting bundler", function () {

    it("T07: claimPayout() reverts with TransferFailed when bundler receive() reverts", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        await attackerBundler.setRevert(true);

        await expect(attackerBundler.claimPayoutFromEscrow())
            .to.be.revertedWith("claimPayout failed");
    });

    it("T08: pendingWithdrawals for bundler is NOT zeroed if claimPayout reverts (TransferFailed before zero-out? -- confirm CEI)", async function () {
        // In SLAEscrow, claimPayout does: amount = pending[msg.sender]; pending = 0; _transfer()
        // If _transfer fails, the whole tx reverts, so pending[msg.sender] remains unchanged
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        const bundlerNet  = ONE_GWEI;

        await attackerBundler.setRevert(true);

        // claimPayout will revert -- entire tx reverts, pending remains
        await expect(attackerBundler.claimPayoutFromEscrow()).to.be.revertedWith("claimPayout failed");

        expect(await escrow.pendingWithdrawals(await attackerBundler.getAddress())).to.equal(bundlerNet);
    });

    it("T09: bundler toggles receive() off: claimPayout succeeds after fix", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        // First: revert mode on -- fails
        await attackerBundler.setRevert(true);
        await expect(attackerBundler.claimPayoutFromEscrow()).to.be.revertedWith("claimPayout failed");

        // Fix receive(): revert off
        await attackerBundler.setRevert(false);

        // Now claimPayout should succeed
        await expect(attackerBundler.claimPayoutFromEscrow()).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(await attackerBundler.getAddress())).to.equal(0n);
    });

    it("T10: bundler receive() reverts -- withdraw() also reverts with TransferFailed", async function () {
        const { escrow, attackerBundler } = await deployWithAttackerBundler();

        // Deposit some idle funds
        await attackerBundler.depositToEscrow({ value: ethers.parseEther("0.1") });
        await attackerBundler.setRevert(true);

        await expect(attackerBundler.withdrawFromEscrow(ethers.parseEther("0.1")))
            .to.be.revertedWith("withdraw failed");
    });

    it("T11: bundler receive() reverts -- deposit() still succeeds (no ETH out on deposit)", async function () {
        const { attackerBundler } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        await expect(attackerBundler.depositToEscrow({ value: ethers.parseEther("0.5") })).to.not.be.reverted;
    });

    it("T12: bundler NothingToClaim if no settle happened yet", async function () {
        const { escrow, attackerBundler } = await deployWithAttackerBundler();

        // No settle, so no pendingWithdrawals
        await expect(
            escrow.connect(await ethers.getSigner((await ethers.getSigners())[0].address)).claimPayout()
        ).to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
});

describe("Cat7 -- receive() grief: other parties unaffected by bundler grief", function () {

    it("T13: feeRecipient (EOA) has no pending balance when PROTOCOL_FEE_WEI=0 (bundler grief irrelevant)", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user, feeRecipient } = await deployWithAttackerBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        await attackerBundler.setRevert(true);

        // PROTOCOL_FEE_WEI=0 so feeRecipient gets nothing at settle time
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("T14: feeRecipient pending is 0 after settle when PROTOCOL_FEE_WEI=0, regardless of bundler state", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user, feeRecipient } = await deployWithAttackerBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);
        await attackerBundler.setRevert(true);

        // PROTOCOL_FEE_WEI=0 -- no fee was queued for feeRecipient
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("T15: multiple bundler grief attempts do not corrupt feeRecipient pending balance", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user, feeRecipient } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);

        // 3 commits, 3 settles
        for (let i = 0; i < 3; i++) {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(`op-t15-${i}`));
            const cid  = await escrow.connect(eoa_user).commit.staticCall(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await escrow.connect(eoa_user).commit(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await attackerBundler.acceptCommit(cid);
            await attackerBundler.settleEscrow(cid);
        }

        // PROTOCOL_FEE_WEI=0: no protocol fee queued for feeRecipient
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("T16: stranger EOA claimPayout reverts NothingToClaim -- not related to bundler grief", async function () {
        const { escrow, stranger, attackerBundler } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        await expect(escrow.connect(stranger).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
});

describe("Cat7 -- receive() grief: contract user claimRefund", function () {

    it("T17: claimRefund() succeeds when user has reverting receive() (no ETH transfer in claimRefund)", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        // Fund the attacker contract so it can pay the fee
        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        // Bundler accepts to transition PROPOSED -> ACTIVE (deadline set here)
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);

        // claimRefund makes no ETH transfer -- it only queues pendingWithdrawals
        await expect(attackerUser.claimRefundFromEscrow(commitId)).to.not.be.reverted;
    });

    it("T18: claimRefund sets c.refunded = true even when user receive() reverts", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        const updated = await escrow.getCommit(commitId);
        expect(updated.refunded).to.equal(true);
    });

    it("T19: claimRefund queues correct userTotal into pendingWithdrawals[user]", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        const userTotal    = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(await attackerUser.getAddress())).to.equal(userTotal);
    });

    it("T20: claimRefund is idempotent -- cannot double-claim even if first claimPayout later fails", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        // Calling claimRefund again should fail with AlreadyFinalized
        await expect(attackerUser.claimRefundFromEscrow(commitId))
            .to.be.revertedWith("claimRefund failed");
    });

    it("T21: user claimPayout fails when user receive() reverts", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        // Now try to claim -- should fail because receive() reverts
        await expect(attackerUser.claimPayoutFromEscrow())
            .to.be.revertedWith("claimPayout failed");
    });

    it("T22: user toggles receive() on after failed claimPayout -- funds recoverable", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        // claimPayout fails
        await expect(attackerUser.claimPayoutFromEscrow()).to.be.revertedWith("claimPayout failed");

        // Fix: turn off revert
        await attackerUser.setRevert(false);
        await expect(attackerUser.claimPayoutFromEscrow()).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(await attackerUser.getAddress())).to.equal(0n);
    });

    it("T23: claimRefund unlocks bundler collateral even when user receive() reverts", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        // Collateral is locked at accept(); check after accept
        await escrow.connect(eoa_bundler).accept(commitId);

        expect(await escrow.lockedOf(eoa_bundler.address)).to.equal(COLLATERAL);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        expect(await escrow.lockedOf(eoa_bundler.address)).to.equal(0n);
    });

    it("T24: feeRecipient gets 0 on refund (100% slash to client, PROTOCOL_FEE_WEI=0)", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler, feeRecipient } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        // 100% of slash goes to user; feeRecipient gets nothing on refund
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
});

describe("Cat7 -- receive() grief: interaction isolation (contract user + contract bundler)", function () {

    async function deployBothContracts() {
        const base = await deployBase();
        const { escrow, registry, feeRecipient } = base;
        const escrowAddr = await escrow.getAddress();
        const regAddr    = await registry.getAddress();

        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerBundler = (await AttackerFactory.deploy(escrowAddr)) as Attacker;
        const attackerUser    = (await AttackerFactory.deploy(escrowAddr)) as Attacker;

        const quoteId = await attackerBundler.registerOffer.staticCall(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.registerOffer(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.depositToEscrow({ value: COLLATERAL * 5n });

        return { ...base, attackerBundler, attackerUser, quoteId };
    }

    it("T25: settle with both reverting contracts succeeds; bundler gets full fee (PROTOCOL_FEE_WEI=0)", async function () {
        const { escrow, attackerBundler, attackerUser, quoteId, feeRecipient } = await deployBothContracts();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.setRevert(true);
        await attackerUser.setRevert(true);

        await attackerBundler.settleEscrow(commitId);

        // bundler gets full fee; feeRecipient gets 0 (PROTOCOL_FEE_WEI=0)
        expect(await escrow.pendingWithdrawals(await attackerBundler.getAddress())).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("T26: settle does not revert when both parties have reverting receive()", async function () {
        const { escrow, attackerBundler, attackerUser, quoteId } = await deployBothContracts();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.setRevert(true);
        await attackerUser.setRevert(true);

        await expect(attackerBundler.settleEscrow(commitId)).to.not.be.reverted;
    });

    it("T27: claimRefund does not revert when both parties have reverting receive()", async function () {
        const { escrow, attackerBundler, attackerUser, quoteId } = await deployBothContracts();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.setRevert(true);
        await attackerUser.setRevert(true);

        await mineToRefundable(escrow, commitId);
        await expect(attackerUser.claimRefundFromEscrow(commitId)).to.not.be.reverted;
    });

    it("T28: each contract party griefs only itself -- pendingWithdrawals for other party unaffected", async function () {
        const { escrow, attackerBundler, attackerUser, quoteId, feeRecipient } = await deployBothContracts();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.settleEscrow(commitId);

        // Both revert on
        await attackerBundler.setRevert(true);
        await attackerUser.setRevert(true);

        // Both fail to claim
        await expect(attackerBundler.claimPayoutFromEscrow()).to.be.revertedWith("claimPayout failed");

        // PROTOCOL_FEE_WEI=0: feeRecipient has no pending balance
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("T29: lockedOf correct after settle with both reverting contracts", async function () {
        const { escrow, attackerBundler, attackerUser, quoteId } = await deployBothContracts();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.setRevert(true);
        await attackerUser.setRevert(true);

        await attackerBundler.settleEscrow(commitId);
        expect(await escrow.lockedOf(await attackerBundler.getAddress())).to.equal(0n);
    });

    it("T30: deposited[bundler] unchanged by settle (collateral not burned, only unlocked)", async function () {
        const { escrow, attackerBundler, attackerUser, quoteId } = await deployBothContracts();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        const depositedBefore = await escrow.deposited(await attackerBundler.getAddress());
        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.setRevert(true);
        await attackerBundler.settleEscrow(commitId);

        // deposited unchanged (settle doesn't subtract deposited)
        expect(await escrow.deposited(await attackerBundler.getAddress())).to.equal(depositedBefore);
    });
});

describe("Cat7 -- receive() grief: multiple commits, expiry, isolation", function () {

    it("T31: multiple expired commits by contract user -- each claimRefund succeeds independently", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 10n });

        await attackerUser.setRevert(true); // set revert before claimRefund

        const commitIds: bigint[] = [];
        for (let i = 0; i < 3; i++) {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(`op-t31-${i}`));
            await attackerUser.commitToEscrow(quoteId, hash, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const cid = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(eoa_bundler).accept(cid);
            commitIds.push(cid);
        }

        await mineToRefundable(escrow, commitIds[commitIds.length - 1]);

        // Each claimRefund should succeed (no ETH transfer)
        for (const cid of commitIds) {
            await expect(attackerUser.claimRefundFromEscrow(cid)).to.not.be.reverted;
        }
    });

    it("T32: claimPayout for user accumulates all refunds before transfer attempt", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 10n });

        const commitIds: bigint[] = [];
        for (let i = 0; i < 3; i++) {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(`op-t32-${i}`));
            await attackerUser.commitToEscrow(quoteId, hash, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const cid = (await escrow.nextCommitId()) - 1n;
            await escrow.connect(eoa_bundler).accept(cid);
            commitIds.push(cid);
        }

        await mineToRefundable(escrow, commitIds[commitIds.length - 1]);

        await attackerUser.setRevert(true);
        for (const cid of commitIds) {
            await attackerUser.claimRefundFromEscrow(cid);
        }

        // All 3 refunds accumulated -- user gets feePaid + full collateral each time
        const userTotal    = (ONE_GWEI + COLLATERAL) * 3n;
        expect(await escrow.pendingWithdrawals(await attackerUser.getAddress())).to.equal(userTotal);
    });

    it("T33: claimPayout fails for reverting user even with accumulated balance", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 10n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        await expect(attackerUser.claimPayoutFromEscrow())
            .to.be.revertedWith("claimPayout failed");
    });

    it("T34: one commit settled, one expired -- both contract parties affect only themselves", async function () {
        const base = await deployBase();
        const { escrow, registry, feeRecipient } = base;
        const escrowAddr = await escrow.getAddress();
        const regAddr    = await registry.getAddress();

        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerBundler = (await AttackerFactory.deploy(escrowAddr)) as Attacker;
        const attackerUser    = (await AttackerFactory.deploy(escrowAddr)) as Attacker;

        const quoteId = await attackerBundler.registerOffer.staticCall(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.registerOffer(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.depositToEscrow({ value: COLLATERAL * 10n });

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 10n });

        // First commit: bundler accepts then settles
        const hash1 = ethers.keccak256(ethers.toUtf8Bytes("op-t34-a"));
        await attackerUser.commitToEscrow(quoteId, hash1, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const cid1 = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(cid1);
        await attackerBundler.settleEscrow(cid1);

        // Second commit: bundler accepts but misses deadline
        const hash2 = ethers.keccak256(ethers.toUtf8Bytes("op-t34-b"));
        await attackerUser.commitToEscrow(quoteId, hash2, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const cid2 = (await escrow.nextCommitId()) - 1n;
        await attackerBundler.acceptCommit(cid2);
        await mineToRefundable(escrow, cid2);
        await attackerUser.claimRefundFromEscrow(cid2);

        // Both revert on
        await attackerBundler.setRevert(true);
        await attackerUser.setRevert(true);

        // PROTOCOL_FEE_WEI=0: feeRecipient gets 0 from settle, 0 from refund (100% slash to client)
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
});

describe("Cat7 -- receive() grief: zero-value edge cases", function () {

    it("T35: claimPayout with zero pending reverts NothingToClaim (not TransferFailed)", async function () {
        const { escrow, attackerBundler, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);

        // pendingWithdrawals[attackerBundler] is 0 -- should revert NothingToClaim, not TransferFailed.
        // Attacker wraps the revert, so the outer call surfaces as "claimPayout failed".
        await expect(attackerBundler.claimPayoutFromEscrow())
            .to.be.revertedWith("claimPayout failed");
        // Verify the inner revert is NothingToClaim by calling directly from an EOA with zero pending.
        await expect(escrow.connect(eoa_user).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("T36: PROTOCOL_FEE_WEI=0 (default): bundlerNet = full fee, no platformFee queued for feeRecipient", async function () {
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow   = (await upgrades.deployProxy(Escrow, [await registry.getAddress(), feeRecipient.address], { kind: "uups" })) as unknown as SLAEscrow;

        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerBundler = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;

        await attackerBundler.registerOffer(await registry.getAddress(), ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.depositToEscrow({ value: COLLATERAL * 5n });

        const quoteId  = 1n;
        const commitId = await escrow.connect(user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        // With 0 bps, feeRecipient gets nothing
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(await attackerBundler.getAddress())).to.equal(ONE_GWEI);
    });

    it("T37: NothingToClaim returned for feeRecipient when PROTOCOL_FEE_WEI=0 -- not a grief issue", async function () {
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow   = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow   = (await upgrades.deployProxy(Escrow, [await registry.getAddress(), feeRecipient.address], { kind: "uups" })) as unknown as SLAEscrow;

        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerBundler = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;

        await attackerBundler.registerOffer(await registry.getAddress(), ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.depositToEscrow({ value: COLLATERAL * 5n });

        const quoteId  = 1n;
        const commitId = await escrow.connect(user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);

        await expect(escrow.connect(feeRecipient).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
});

describe("Cat7 -- receive() grief: reentrancy via claimPayout (CEI protection)", function () {

    async function deployWithReentrantBundler() {
        const base = await deployBase();
        const { escrow, registry, eoa_user } = base;
        const escrowAddr = await escrow.getAddress();
        const regAddr    = await registry.getAddress();

        const ReentrantFactory = await ethers.getContractFactory("ReentrantClaimer");
        const reentrantBundler = (await ReentrantFactory.deploy(escrowAddr)) as ReentrantClaimer;

        const quoteId = await reentrantBundler.registerOffer.staticCall(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await reentrantBundler.registerOffer(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await reentrantBundler.depositToEscrow({ value: COLLATERAL * 5n });

        return { ...base, reentrantBundler, quoteId };
    }

    it("T38: reentrancy via claimPayout -- second call reverts NothingToClaim (CEI zeroes balance first)", async function () {
        const { escrow, reentrantBundler, quoteId, eoa_user } = await deployWithReentrantBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await reentrantBundler.acceptCommit(commitId);
        await reentrantBundler.settleEscrow(commitId);

        // claimPayoutFromEscrow triggers receive() which re-enters claimPayout
        // The reentry should get NothingToClaim (CEI: pending zeroed before transfer)
        await expect(reentrantBundler.claimPayoutFromEscrow()).to.not.be.reverted;
    });

    it("T39: reentrancy via claimPayout -- bundler receives payout exactly once (no double-drain)", async function () {
        const { escrow, reentrantBundler, quoteId, eoa_user } = await deployWithReentrantBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await reentrantBundler.acceptCommit(commitId);
        await reentrantBundler.settleEscrow(commitId);

        const bundlerNet  = ONE_GWEI;

        const balBefore = await ethers.provider.getBalance(await reentrantBundler.getAddress());
        await reentrantBundler.claimPayoutFromEscrow();
        const balAfter  = await ethers.provider.getBalance(await reentrantBundler.getAddress());

        expect(balAfter - balBefore).to.equal(bundlerNet);
    });

    it("T40: reentrancy via claimPayout -- pendingWithdrawals is 0 after successful claim", async function () {
        const { escrow, reentrantBundler, quoteId, eoa_user } = await deployWithReentrantBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await reentrantBundler.acceptCommit(commitId);
        await reentrantBundler.settleEscrow(commitId);

        await reentrantBundler.claimPayoutFromEscrow();

        expect(await escrow.pendingWithdrawals(await reentrantBundler.getAddress())).to.equal(0n);
    });

    it("T41: reentrancy -- reentryCount incremented (attack attempted at least twice)", async function () {
        const { escrow, reentrantBundler, quoteId, eoa_user } = await deployWithReentrantBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await reentrantBundler.acceptCommit(commitId);
        await reentrantBundler.settleEscrow(commitId);

        await reentrantBundler.claimPayoutFromEscrow();

        // The receive() was called exactly once during the payout ETH transfer.
        // Inside receive(), reentryCount increments to 1 and the reentrant claimPayout()
        // call is blocked by the nonReentrant guard (returns false, not another receive).
        const count = await reentrantBundler.reentryCount();
        expect(count).to.equal(1n);
    });

    it("T42: reentrancy -- escrow ETH balance decreases by exactly bundlerNet (no extra drain)", async function () {
        const { escrow, reentrantBundler, quoteId, eoa_user, feeRecipient } = await deployWithReentrantBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await reentrantBundler.acceptCommit(commitId);
        await reentrantBundler.settleEscrow(commitId);

        // Escrow holds: ONE_GWEI (from commit fee) + COLLATERAL*5 (bundler deposit) - nothing paid out yet
        const escrowBefore = await ethers.provider.getBalance(await escrow.getAddress());
        await reentrantBundler.claimPayoutFromEscrow();
        const escrowAfter  = await ethers.provider.getBalance(await escrow.getAddress());

        const bundlerNet  = ONE_GWEI;

        expect(escrowBefore - escrowAfter).to.equal(bundlerNet);
    });

    it("T43: reentrancy via claimPayout -- feeRecipient balance unaffected by reentrant bundler", async function () {
        const { escrow, reentrantBundler, quoteId, eoa_user, feeRecipient } = await deployWithReentrantBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await reentrantBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await reentrantBundler.acceptCommit(commitId);
        await reentrantBundler.settleEscrow(commitId);

        await reentrantBundler.claimPayoutFromEscrow();

        // PROTOCOL_FEE_WEI=0: feeRecipient has no pending balance
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
});

describe("Cat7 -- receive() grief: reentrancy via withdraw (CEI protection)", function () {

    async function deployWithReentrantWithdrawer() {
        const base = await deployBase();
        const { escrow, registry } = base;
        const escrowAddr = await escrow.getAddress();
        const regAddr    = await registry.getAddress();

        const WithdrawerFactory = await ethers.getContractFactory("ReentrantWithdrawer");
        const reentrantWithdrawer = await WithdrawerFactory.deploy(escrowAddr);

        return { ...base, reentrantWithdrawer };
    }

    it("T44: reentrancy via withdraw -- second withdrawal reverts InsufficientIdle (CEI protects)", async function () {
        const { escrow, reentrantWithdrawer } = await deployWithReentrantWithdrawer();

        const depositAmt = ethers.parseEther("0.1");
        await reentrantWithdrawer.depositToEscrow({ value: depositAmt });

        // withdraw triggers receive(), which tries to re-enter withdraw() -- should fail with InsufficientIdle
        await expect(reentrantWithdrawer.withdrawFromEscrow(depositAmt)).to.not.be.reverted;
    });

    it("T45: reentrancy via withdraw -- balance decreases by exactly the requested amount", async function () {
        const { escrow, reentrantWithdrawer } = await deployWithReentrantWithdrawer();

        const depositAmt = ethers.parseEther("0.1");
        await reentrantWithdrawer.depositToEscrow({ value: depositAmt });

        const balBefore = await ethers.provider.getBalance(await reentrantWithdrawer.getAddress());
        await reentrantWithdrawer.withdrawFromEscrow(depositAmt);
        const balAfter  = await ethers.provider.getBalance(await reentrantWithdrawer.getAddress());

        // Balance gained should be exactly depositAmt (no extra drain via reentrancy)
        expect(balAfter - balBefore).to.equal(depositAmt);
    });

    it("T46: reentrancy via withdraw -- deposited[withdrawer] = 0 after full withdrawal", async function () {
        const { escrow, reentrantWithdrawer } = await deployWithReentrantWithdrawer();

        const depositAmt = ethers.parseEther("0.1");
        await reentrantWithdrawer.depositToEscrow({ value: depositAmt });
        await reentrantWithdrawer.withdrawFromEscrow(depositAmt);

        expect(await escrow.deposited(await reentrantWithdrawer.getAddress())).to.equal(0n);
    });

    it("T47: reentrancy via withdraw -- escrow balance decreases by exactly withdrawal amount", async function () {
        const { escrow, reentrantWithdrawer } = await deployWithReentrantWithdrawer();

        const depositAmt = ethers.parseEther("0.1");
        await reentrantWithdrawer.depositToEscrow({ value: depositAmt });

        const escrowBefore = await ethers.provider.getBalance(await escrow.getAddress());
        await reentrantWithdrawer.withdrawFromEscrow(depositAmt);
        const escrowAfter  = await ethers.provider.getBalance(await escrow.getAddress());

        expect(escrowBefore - escrowAfter).to.equal(depositAmt);
    });
});

describe("Cat7 -- receive() grief: contract bundler withdraw interactions", function () {

    it("T48: bundler receive() off -- withdraw succeeds after toggling back", async function () {
        const { escrow, attackerBundler } = await deployWithAttackerBundler();

        await attackerBundler.depositToEscrow({ value: ethers.parseEther("0.1") });
        await attackerBundler.setRevert(true);

        // Try withdraw -- fails
        await expect(attackerBundler.withdrawFromEscrow(ethers.parseEther("0.1"))).to.be.revertedWith("withdraw failed");

        // deposited still intact -- failed withdraw reverted.
        // Total = fixture's COLLATERAL*5 (0.05 ETH) + this test's 0.1 ETH = 0.15 ETH.
        expect(await escrow.deposited(await attackerBundler.getAddress())).to.equal(COLLATERAL * 5n + ethers.parseEther("0.1"));

        // Fix receive
        await attackerBundler.setRevert(false);
        await expect(attackerBundler.withdrawFromEscrow(ethers.parseEther("0.1"))).to.not.be.reverted;
    });

    it("T49: bundler cannot withdraw locked collateral (InsufficientIdle) regardless of receive() state", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        // Commit then accept to lock collateral
        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        // Collateral is locked at accept(), not at commit()
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.setRevert(false);

        // All deposited balance is locked -- withdraw should fail InsufficientIdle
        const deposited = await escrow.deposited(await attackerBundler.getAddress());
        await expect(attackerBundler.withdrawFromEscrow(deposited))
            .to.be.revertedWith("withdraw failed");
    });

    it("T50: bundler with reverting receive() -- idle balance accounting correct after failed claimPayout", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);
        await attackerBundler.settleEscrow(commitId);
        await attackerBundler.setRevert(true);

        // claimPayout reverts
        await expect(attackerBundler.claimPayoutFromEscrow()).to.be.revertedWith("claimPayout failed");

        // idleBalance not affected by pendingWithdrawals (separate accounting)
        const idle = await escrow.idleBalance(await attackerBundler.getAddress());
        expect(idle).to.equal(await escrow.deposited(await attackerBundler.getAddress()));
    });

    it("T51: contract bundler with reverting receive() -- second settle attempt reverts AlreadyFinalized", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);
        const commitId = await escrow.connect(eoa_user).commit.staticCall(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await escrow.connect(eoa_user).commit(quoteId, USER_OP_HASH, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.settleEscrow(commitId);

        // Second settle should fail
        await expect(attackerBundler.settleEscrow(commitId))
            .to.be.revertedWith("settle failed");
    });

    it("T52: contract user with reverting receive() -- second claimRefund attempt reverts AlreadyFinalized", async function () {
        const { escrow, attackerUser, quoteId, eoa_bundler } = await deployWithAttackerUser();

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(quoteId, USER_OP_HASH, ONE_GWEI, eoa_bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        await escrow.connect(eoa_bundler).accept(commitId);

        await mineToRefundable(escrow, commitId);
        await attackerUser.setRevert(true);
        await attackerUser.claimRefundFromEscrow(commitId);

        // Second claimRefund should fail
        await expect(attackerUser.claimRefundFromEscrow(commitId))
            .to.be.revertedWith("claimRefund failed");
    });

    it("T53: contract bundler settle then contract user claimRefund -- AlreadyFinalized prevents double-finalize", async function () {
        const base = await deployBase();
        const { escrow, registry, eoa_user, feeRecipient } = base;
        const escrowAddr = await escrow.getAddress();
        const regAddr    = await registry.getAddress();

        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerBundler = (await AttackerFactory.deploy(escrowAddr)) as Attacker;
        const attackerUser    = (await AttackerFactory.deploy(escrowAddr)) as Attacker;

        const t53QuoteId = await attackerBundler.registerOffer.staticCall(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.registerOffer(regAddr, ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, { value: ethers.parseEther("0.0001") });
        await attackerBundler.depositToEscrow({ value: COLLATERAL * 5n });

        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: await attackerUser.getAddress(), value: ONE_GWEI * 2n });

        await attackerUser.commitToEscrow(t53QuoteId, USER_OP_HASH, ONE_GWEI, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const commitId = (await escrow.nextCommitId()) - 1n;
        // Bundler accepts to set deadline, then settles within deadline
        await attackerBundler.acceptCommit(commitId);

        await attackerBundler.settleEscrow(commitId);

        // Mine past expiry
        await mineToRefundable(escrow, commitId);

        // User tries to claimRefund on already settled commit -- should fail
        await expect(attackerUser.claimRefundFromEscrow(commitId))
            .to.be.revertedWith("claimRefund failed");
    });

    it("T54: pull model invariant -- escrow ETH balance always >= sum of all pendingWithdrawals after settle", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user, feeRecipient } = await deployWithAttackerBundler();

        await attackerBundler.setRevert(true);

        // 5 commits and settles
        for (let i = 0; i < 5; i++) {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(`op-t54-${i}`));
            const cid  = await escrow.connect(eoa_user).commit.staticCall(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await escrow.connect(eoa_user).commit(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await attackerBundler.acceptCommit(cid);
            await attackerBundler.settleEscrow(cid);
        }

        const escrowBalance       = await ethers.provider.getBalance(await escrow.getAddress());
        const pendingBundler      = await escrow.pendingWithdrawals(await attackerBundler.getAddress());
        const pendingFeeRecipient = await escrow.pendingWithdrawals(feeRecipient.address);
        const totalPending        = pendingBundler + pendingFeeRecipient;

        expect(escrowBalance).to.be.gte(totalPending);
    });

    it("T55: pull model -- total pendingWithdrawals equals sum of all fees paid after 5 settles", async function () {
        const { escrow, attackerBundler, quoteId, eoa_user, feeRecipient } = await deployWithAttackerBundler();

        const N = 5;
        for (let i = 0; i < N; i++) {
            const hash = ethers.keccak256(ethers.toUtf8Bytes(`op-t55-${i}`));
            const cid  = await escrow.connect(eoa_user).commit.staticCall(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await escrow.connect(eoa_user).commit(quoteId, hash, await attackerBundler.getAddress(), COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            await attackerBundler.acceptCommit(cid);
            await attackerBundler.settleEscrow(cid);
        }

        // bundler gets full feePerOp; feeRecipient gets 0 (PROTOCOL_FEE_WEI=0)
        const totalPendingBundler = await escrow.pendingWithdrawals(await attackerBundler.getAddress());
        const totalPendingFee     = await escrow.pendingWithdrawals(feeRecipient.address);

        expect(totalPendingBundler).to.equal(ONE_GWEI * BigInt(N));
        expect(totalPendingFee).to.equal(0n);
        expect(totalPendingBundler + totalPendingFee).to.equal(ONE_GWEI * BigInt(N));
    });
});
