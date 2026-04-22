// Category 13: Access Control & Privilege Escalation -- adversarial test suite

import { expect }                          from "chai";
import { ethers, upgrades }                from "hardhat";
import { mine, setBalance }                from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow, Attacker } from "../../typechain-types";
import {
    deployEscrow,
    makeCommit as fixturesMakeCommit,
    mineToRefundable,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const ONE_ETH    = ethers.parseEther("1");
const SLA_BLOCKS = 2n;

async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
    return await ethers.provider.getBalance(await escrow.getAddress());
}

async function deploy() {
    const result = await deployEscrow({ slaBlocks: SLA_BLOCKS, preDeposit: COLLATERAL * 10n });
    // cat13 tests need newOwner (signer[6]) and extra (signer[7])
    const signers = await ethers.getSigners();
    const newOwner = signers[6];
    const extra    = signers[7];
    return { ...result, newOwner, extra };
}

/** Create a commit and return its commitId */
async function makeCommit(
    escrow: SLAEscrow,
    signer: any,
    quoteId: bigint,
    tag?: string,
): Promise<bigint> {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const { commitId } = await fixturesMakeCommit(escrow, registry, signer, quoteId, tag ?? "op");
    return commitId;
}

// -----------------------------------------------------------------------------
// setFeeRecipient -- role restrictions
// -----------------------------------------------------------------------------
describe("Cat13 -- setFeeRecipient role restrictions", () => {
    it("13.01 bundler cannot call setFeeRecipient", async () => {
        const { escrow, bundler, attacker } = await deploy();
        await expect(escrow.connect(bundler).setFeeRecipient(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(bundler.address);
    });

    it("13.02 user cannot call setFeeRecipient", async () => {
        const { escrow, user, attacker } = await deploy();
        await expect(escrow.connect(user).setFeeRecipient(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(user.address);
    });

    it("13.03 feeRecipient (non-owner) cannot call setFeeRecipient", async () => {
        const { escrow, feeRecipient, attacker } = await deploy();
        await expect(escrow.connect(feeRecipient).setFeeRecipient(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(feeRecipient.address);
    });

    it("13.04 stranger cannot call setFeeRecipient", async () => {
        const { escrow, stranger, attacker } = await deploy();
        await expect(escrow.connect(stranger).setFeeRecipient(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(stranger.address);
    });

    it("13.05 owner CAN call setFeeRecipient successfully", async () => {
        const { escrow, owner, stranger } = await deploy();
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("13.06 setFeeRecipient to zero address reverts ZeroAddress", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).setFeeRecipient(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(escrow, "ZeroAddress")
            .withArgs("feeRecipient");
    });

    it("13.07 setFeeRecipient emits FeeRecipientUpdated with correct old/new", async () => {
        const { escrow, owner, feeRecipient, stranger } = await deploy();
        await expect(escrow.connect(owner).setFeeRecipient(stranger.address))
            .to.emit(escrow, "FeeRecipientUpdated")
            .withArgs(feeRecipient.address, stranger.address);
    });

    it("13.08 setFeeRecipient to same address emits event (no-op but valid)", async () => {
        const { escrow, owner, feeRecipient } = await deploy();
        await expect(escrow.connect(owner).setFeeRecipient(feeRecipient.address))
            .to.emit(escrow, "FeeRecipientUpdated")
            .withArgs(feeRecipient.address, feeRecipient.address);
    });
});

// -----------------------------------------------------------------------------
// Ownership transfer
// -----------------------------------------------------------------------------
describe("Cat13 -- Ownership transfer", () => {
    it("13.09 transferOwnership emits OwnershipTransferred event", async () => {
        const { escrow, owner, newOwner } = await deploy();
        await expect(escrow.connect(owner).transferOwnership(newOwner.address))
            .to.emit(escrow, "OwnershipTransferred")
            .withArgs(owner.address, newOwner.address);
    });

    it("13.10 transfer to zero address reverts OwnableInvalidOwner", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).transferOwnership(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(escrow, "OwnableInvalidOwner")
            .withArgs(ethers.ZeroAddress);
    });

    it("13.11 transfer to self succeeds, ownership unchanged", async () => {
        const { escrow, owner } = await deploy();
        await escrow.connect(owner).transferOwnership(owner.address);
        expect(await escrow.owner()).to.equal(owner.address);
    });

    it("13.12 after transfer, PREVIOUS owner cannot call setFeeRecipient", async () => {
        const { escrow, owner, newOwner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        await expect(escrow.connect(owner).setFeeRecipient(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(owner.address);
    });

    it("13.13 after transfer, NEW owner CAN call setFeeRecipient", async () => {
        const { escrow, owner, newOwner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        await escrow.connect(newOwner).setFeeRecipient(stranger.address);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("13.14 OZ v5 transferOwnership is immediate (no pending-owner pattern)", async () => {
        const { escrow, owner, newOwner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        // Immediately effective -- new owner can act right away
        expect(await escrow.owner()).to.equal(newOwner.address);
        await escrow.connect(newOwner).setFeeRecipient(stranger.address);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("13.15 non-owner cannot call transferOwnership", async () => {
        const { escrow, stranger, attacker } = await deploy();
        await expect(escrow.connect(stranger).transferOwnership(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(stranger.address);
    });

    it("13.16 chain of transfers: A -> B -> C; only C is owner", async () => {
        const { escrow, owner, newOwner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        await escrow.connect(newOwner).transferOwnership(stranger.address);
        expect(await escrow.owner()).to.equal(stranger.address);
        // A can't do anything
        await expect(escrow.connect(owner).setFeeRecipient(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        // B can't do anything
        await expect(escrow.connect(newOwner).setFeeRecipient(newOwner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        // C can
        await escrow.connect(stranger).setFeeRecipient(stranger.address);
    });

    it("13.17 transfer ownership to contract address (no onlyOwner) -- escrow still works", async () => {
        const { escrow, registry, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        // Transfer ownership to the registry (a contract with no onlyOwner awareness)
        await escrow.connect(owner).transferOwnership(await registry.getAddress());
        // Escrow still functions: commits, settle, withdraw all work
        const cid = await makeCommit(escrow, user, QUOTE_ID, "xfer-test");
        await escrow.connect(bundler).settle(cid);
        // But nobody can call setFeeRecipient (registry has no way to call it)
        await expect(escrow.connect(owner).setFeeRecipient(feeRecipient.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
});

// -----------------------------------------------------------------------------
// renounceOwnership
// -----------------------------------------------------------------------------
describe("Cat13 -- renounceOwnership", () => {
    it("13.18 renounceOwnership reverts RenounceOwnershipDisabled -- owner stays non-zero (T22)", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        expect(await escrow.owner()).to.equal(owner.address);
    });

    it("13.19 renounceOwnership disabled -- owner can still call setFeeRecipient normally", async () => {
        const { escrow, owner, stranger } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        // Owner still in place -- setFeeRecipient works
        await expect(escrow.connect(owner).setFeeRecipient(stranger.address)).to.not.be.reverted;
        // Non-owner still blocked
        await expect(escrow.connect(stranger).setFeeRecipient(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("13.20 deposit works regardless of ownership state", async () => {
        const { escrow, bundler } = await deploy();
        await escrow.connect(bundler).deposit({ value: ONE_ETH });
        // Fixture preDeposit is COLLATERAL*10n (see deploy()) + this test's ONE_ETH deposit.
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n + ONE_ETH);
    });

    it("13.21 commit works regardless of ownership state", async () => {
        const { escrow, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "ownership-commit");
        expect(cid).to.equal(0n); // first commit gets id=0
    });

    it("13.22 settle works regardless of ownership state", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "ownership-settle");
        await escrow.connect(bundler).settle(cid);
        const c = await escrow.getCommit(cid);
        expect(c.settled).to.be.true;
    });

    it("13.23 claimRefund works regardless of ownership state", async () => {
        const { escrow, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "ownership-refund");
        await mineToRefundable(escrow, cid);
        await escrow.connect(user).claimRefund(cid);
        const c = await escrow.getCommit(cid);
        expect(c.refunded).to.be.true;
    });

    it("13.24 claimPayout works regardless of ownership state", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "ownership-payout");
        await escrow.connect(bundler).settle(cid);
        const pending = await escrow.pendingWithdrawals(bundler.address);
        expect(pending).to.equal(ONE_GWEI);
        await escrow.connect(bundler).claimPayout();
    });

    it("13.25 withdraw works regardless of ownership state", async () => {
        const { escrow, bundler } = await deploy();
        const idleBefore = await escrow.idleBalance(bundler.address);
        await escrow.connect(bundler).withdraw(idleBefore);
    });

    it("13.26 non-owner cannot renounceOwnership", async () => {
        const { escrow, stranger } = await deploy();
        await expect(escrow.connect(stranger).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
            .withArgs(stranger.address);
    });

    it("13.27 renounceOwnership disabled -- transferOwnership still works; ownership is always held by someone (T22)", async () => {
        const { escrow, owner, stranger } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        // transferOwnership still works -- ownership moves to stranger
        await escrow.connect(owner).transferOwnership(stranger.address);
        expect(await escrow.owner()).to.equal(stranger.address);
    });
});

// -----------------------------------------------------------------------------
// Owner has NO special privileges on core functions
// -----------------------------------------------------------------------------
describe("Cat13 -- Owner parity with regular users", () => {
    it("13.28 owner can settle (permissionless) but fee goes to commit's bundler, not owner", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "owner-settle");
        const bundlerPendingBefore = await escrow.pendingWithdrawals(bundler.address);
        await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
        // Fee credited to the snapshotted bundler, not the owner
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerPendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("13.29 feeRecipient can trigger claimRefund after expiry (T12) -- ETH goes to user, not feeRecipient", async () => {
        const { escrow, feeRecipient, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "owner-refund");
        await mineToRefundable(escrow, cid);
        const pendingBefore = await escrow.pendingWithdrawals(user.address);
        const feeRecipientPendingBefore = await escrow.pendingWithdrawals(feeRecipient.address);
        await escrow.connect(feeRecipient).claimRefund(cid);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(feeRecipientPendingBefore); // feeRecipient gets nothing
    });

    it("13.30 owner cannot withdraw ETH they haven't deposited", async () => {
        const { escrow, owner } = await deploy();
        // Owner deposited == 0, cannot withdraw anything
        await expect(escrow.connect(owner).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("13.31 owner cannot claimPayout with zero pending", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("13.32 owner CAN deposit as a regular bundler (no special treatment)", async () => {
        const { escrow, owner } = await deploy();
        await escrow.connect(owner).deposit({ value: ONE_ETH });
        expect(await escrow.deposited(owner.address)).to.equal(ONE_ETH);
    });

    it("13.33 owner CAN commit as a regular user (no special treatment)", async () => {
        const { escrow, owner, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, owner, QUOTE_ID, "owner-commit");
        const c = await escrow.getCommit(cid);
        expect(c.user).to.equal(owner.address);
    });
});

// -----------------------------------------------------------------------------
// Owner cannot extract funds without depositing
// -----------------------------------------------------------------------------
describe("Cat13 -- Owner fund extraction attempts", () => {
    it("13.34 owner cannot drain escrow via setFeeRecipient(self) + claimPayout without earned fees", async () => {
        const { escrow, owner } = await deploy();
        // Owner sets self as feeRecipient
        await escrow.connect(owner).setFeeRecipient(owner.address);
        // But owner has no pendingWithdrawals yet
        await expect(escrow.connect(owner).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("13.35 owner redirects fees to self -- with PROTOCOL_FEE_WEI=0 gets nothing from settle", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "owner-fee");
        await escrow.connect(bundler).settle(cid);

        // PROTOCOL_FEE_WEI=0 by default, so feeRecipient gets 0 from settle
        const ownerPending = await escrow.pendingWithdrawals(owner.address);
        expect(ownerPending).to.equal(0n);
    });

    it("13.36 owner sets feeRecipient to self, but cannot access bundler deposits", async () => {
        const { escrow, owner, bundler } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const bundlerDeposited = await escrow.deposited(bundler.address);
        expect(bundlerDeposited).to.equal(COLLATERAL * 10n);
        // Owner cannot withdraw bundler funds
        await expect(escrow.connect(owner).withdraw(bundlerDeposited))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("13.37 owner cannot manufacture pendingWithdrawals without a real commit/settle flow", async () => {
        const { escrow, owner } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        // No commits -> no settlements -> no fees -> nothing to claim
        const pending = await escrow.pendingWithdrawals(owner.address);
        expect(pending).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// feeRecipient griefing
// -----------------------------------------------------------------------------
describe("Cat13 -- feeRecipient griefing", () => {
    it("13.38 feeRecipient that reverts on receive -- with PROTOCOL_FEE_WEI=0 no pending accrues to feeRecipient", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerContract = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;
        const attackerAddr = await attackerContract.getAddress();

        // Set attacker contract as feeRecipient
        await escrow.connect(owner).setFeeRecipient(attackerAddr);

        // Create and settle a commit -- PROTOCOL_FEE_WEI=0, no fee accrues to feeRecipient
        const cid = await makeCommit(escrow, user, QUOTE_ID, "grief-1");
        await escrow.connect(bundler).settle(cid);

        // With PROTOCOL_FEE_WEI=0, pending for attacker (feeRecipient) is 0
        const pending = await escrow.pendingWithdrawals(attackerAddr);
        expect(pending).to.equal(0n);

        // Bundler still gets their fee
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("13.39 reverting feeRecipient does NOT block bundler claimPayout (pull model)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerContract = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;
        await escrow.connect(owner).setFeeRecipient(await attackerContract.getAddress());
        await attackerContract.setRevert(true);

        const cid = await makeCommit(escrow, user, QUOTE_ID, "grief-2");
        await escrow.connect(bundler).settle(cid);

        // Bundler can still claim their portion
        const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
        expect(bundlerPending).to.equal(ONE_GWEI);
        await escrow.connect(bundler).claimPayout();
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
    });

    it("13.40 reverting feeRecipient does NOT block user claimRefund + claimPayout", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerContract = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;
        await escrow.connect(owner).setFeeRecipient(await attackerContract.getAddress());
        await attackerContract.setRevert(true);

        const cid = await makeCommit(escrow, user, QUOTE_ID, "grief-3");
        await mineToRefundable(escrow, cid);
        // claimRefund should work (no external call)
        await escrow.connect(user).claimRefund(cid);
        // user can claim their payout
        await escrow.connect(user).claimPayout();
    });

    it("13.41 setFeeRecipient to escrow address reverts ZeroAddress (T15)", async () => {
        const { escrow, owner } = await deploy();
        const escrowAddr = await escrow.getAddress();
        await expect(escrow.connect(owner).setFeeRecipient(escrowAddr))
            .to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("13.42 feeRecipient set to bundler address -- bundler gets full settlement net (PROTOCOL_FEE_WEI=0)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(bundler.address);

        const cid = await makeCommit(escrow, user, QUOTE_ID, "bundler-fee");
        await escrow.connect(bundler).settle(cid);

        // With PROTOCOL_FEE_WEI=0, bundler gets full ONE_GWEI; feeRecipient (bundler) gets 0 from protocol
        const total = await escrow.pendingWithdrawals(bundler.address);
        expect(total).to.equal(ONE_GWEI);
    });
});

// -----------------------------------------------------------------------------
// feeRecipient changed mid-flight
// -----------------------------------------------------------------------------
describe("Cat13 -- feeRecipient changed mid-flight", () => {
    it("13.43 feeRecipient changed between commit and settle -- PROTOCOL_FEE_WEI=0, no fee was credited at commit time either (settle() does not read feeRecipient; fee routing happens at commit())", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-flight");

        // Change feeRecipient between commit and settle
        await escrow.connect(owner).setFeeRecipient(stranger.address);

        await escrow.connect(bundler).settle(cid);

        // With PROTOCOL_FEE_WEI=0: no protocol fee at settle, feeRecipient gets nothing
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        // Bundler gets full fee
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("13.44 claimRefund: user gets feePaid + collateral (100%), feeRecipient gets nothing", async () => {
        const { escrow, owner, user, feeRecipient, stranger, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-flight-refund");

        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user).claimRefund(cid);

        // New model: 100% of collateral goes to user (feePaid + collateral), nothing to protocol
        const userTotal = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(userTotal);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("13.45 rapid feeRecipient changes: PROTOCOL_FEE_WEI=0, bundler always gets full fee, feeRecipient gets nothing", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, attacker, QUOTE_ID } = await deploy();

        // Commit 1 with original feeRecipient
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "scatter-1");
        await escrow.connect(bundler).settle(cid1);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);

        // Change to stranger
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "scatter-2");
        await escrow.connect(bundler).settle(cid2);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);

        // Change to attacker
        await escrow.connect(owner).setFeeRecipient(attacker.address);
        const cid3 = await makeCommit(escrow, user, QUOTE_ID, "scatter-3");
        await escrow.connect(bundler).settle(cid3);
        expect(await escrow.pendingWithdrawals(attacker.address)).to.equal(0n);

        // Bundler gets all 3 fees (no protocol fee taken)
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 3n);
    });
});

// -----------------------------------------------------------------------------
// PROTOCOL_FEE_WEI access control
// -----------------------------------------------------------------------------
describe("Cat13 -- PROTOCOL_FEE_WEI access control", () => {
    it("13.46 PROTOCOL_FEE_WEI defaults to 0 at initialization", async () => {
        const { escrow } = await deploy();
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });

    it("13.47 setProtocolFeeWei is owner-only -- stranger cannot change PROTOCOL_FEE_WEI", async () => {
        const { escrow, stranger } = await deploy();
        await expect(
            escrow.connect(stranger).setProtocolFeeWei(500n)
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("13.48 no external setter named updateFEE_BPS -- raw call reverts", async () => {
        const { escrow, owner } = await deploy();
        const iface = new ethers.Interface(["function updateFEE_BPS(uint16)"]);
        const calldata = iface.encodeFunctionData("updateFEE_BPS", [500]);
        // Non-existent selector: proxy fallback delegates, impl has no matching selector -> empty revert
        await expect(
            owner.sendTransaction({ to: await escrow.getAddress(), data: calldata })
        ).to.be.reverted; // bare revert: no matching external selector, no custom error
    });

    it("13.49 PROTOCOL_FEE_WEI unchanged after multiple settles", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deploy();
        for (let i = 0; i < 5; i++) {
            const cid = await makeCommit(escrow, user, QUOTE_ID, `fee-bps-${i}`);
            await escrow.connect(bundler).settle(cid);
        }
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });

    it("13.50 PROTOCOL_FEE_WEI unchanged after refund slashes", async () => {
        const { escrow, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "bps-refund");
        await mineToRefundable(escrow, cid);
        await escrow.connect(user).claimRefund(cid);
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });
});

// -----------------------------------------------------------------------------
// initialize() -- re-init attacks
// -----------------------------------------------------------------------------
describe("Cat13 -- initialize() re-initialization", () => {
    it("13.51 proxy cannot be re-initialized", async () => {
        const { escrow, feeRecipient, registry } = await deploy();
        await expect(
            escrow.initialize(await registry.getAddress(), feeRecipient.address)
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });

    it("13.52 stranger cannot re-initialize proxy", async () => {
        const { escrow, stranger, feeRecipient, registry } = await deploy();
        await expect(
            escrow.connect(stranger).initialize(await registry.getAddress(), feeRecipient.address)
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });

    it("13.53 owner cannot re-initialize proxy", async () => {
        const { escrow, owner, feeRecipient, registry } = await deploy();
        await expect(
            escrow.connect(owner).initialize(await registry.getAddress(), feeRecipient.address)
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });

    it("13.54 setProtocolFeeWei above MAX_PROTOCOL_FEE_WEI reverts InvalidProtocolFee", async () => {
        const { escrow, owner } = await deploy();
        const MAX = ethers.parseEther("0.001");
        await expect(
            escrow.connect(owner).setProtocolFeeWei(MAX + 1n)
        ).to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
    });

    it("13.55 setProtocolFeeWei = MAX_PROTOCOL_FEE_WEI is valid (boundary)", async () => {
        const { escrow, owner } = await deploy();
        const MAX = ethers.parseEther("0.001");
        await escrow.connect(owner).setProtocolFeeWei(MAX);
        expect(await escrow.protocolFeeWei()).to.equal(MAX);
    });

    it("13.56 setProtocolFeeWei = 0 is valid (no protocol fee)", async () => {
        const { escrow, owner } = await deploy();
        // Default is already 0, set explicitly
        await escrow.connect(owner).setProtocolFeeWei(0n);
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });

    it("13.57 initialize with zero registry reverts ZeroAddress", async () => {
        const [, , , , , signer] = await ethers.getSigners();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        await expect(
            upgrades.deployProxy(
                Escrow,
                [ethers.ZeroAddress, signer.address],
                { kind: "uups" }
            )
        ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
    });

    it("13.58 initialize with zero feeRecipient reverts ZeroAddress", async () => {
        const [, , , , , signer] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        await expect(
            upgrades.deployProxy(
                Escrow,
                [await registry.getAddress(), ethers.ZeroAddress],
                { kind: "uups" }
            )
        ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
    });
});

// -----------------------------------------------------------------------------
// UUPS upgrade authorization
// -----------------------------------------------------------------------------
describe("Cat13 -- UUPS upgrade authorization", () => {
    it("13.59 non-owner cannot upgrade proxy", async () => {
        const { escrow, stranger } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await expect(
            escrow.connect(stranger).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("13.60 bundler cannot upgrade proxy", async () => {
        const { escrow, bundler } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await expect(
            escrow.connect(bundler).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("13.61 feeRecipient cannot upgrade proxy", async () => {
        const { escrow, feeRecipient } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await expect(
            escrow.connect(feeRecipient).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("13.62 owner CAN upgrade proxy (sanity)", async () => {
        const { escrow, owner } = await deploy();
        // Deploy a new impl (same code is fine for testing the auth gate)
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        // Should not revert
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");
    });

    it("13.63 renounceOwnership disabled -- owner retains upgrade ability (T22)", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        // Owner still in place -- upgrade still works
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await expect(escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")).to.not.be.reverted;
    });
});

// -----------------------------------------------------------------------------
// upgradeToAndCall calldata privilege escalation attacks
// -----------------------------------------------------------------------------
describe("Cat13 -- upgradeToAndCall calldata attacks", () => {
    it("13.64 upgradeToAndCall with setFeeRecipient calldata -- owner does it (succeeds, fees redirected)", async () => {
        const { escrow, owner, attacker } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), calldata);
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });

    it("13.65 non-owner upgradeToAndCall with setFeeRecipient calldata -- reverts before calldata executes", async () => {
        const { escrow, attacker } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);
        await expect(
            escrow.connect(attacker).upgradeToAndCall(await newImpl.getAddress(), calldata)
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        // feeRecipient unchanged
    });

    it("13.66 upgradeToAndCall with transferOwnership calldata by non-owner -- blocked", async () => {
        const { escrow, attacker } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        const calldata = escrow.interface.encodeFunctionData("transferOwnership", [attacker.address]);
        await expect(
            escrow.connect(attacker).upgradeToAndCall(await newImpl.getAddress(), calldata)
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("13.67 upgradeToAndCall with renounceOwnership calldata reverts -- ownership not lost (T22)", async () => {
        const { escrow, owner } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        const calldata = escrow.interface.encodeFunctionData("renounceOwnership");
        await expect(
            escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), calldata)
        ).to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        expect(await escrow.owner()).to.equal(owner.address);
    });

    it("13.68 upgradeToAndCall with transferOwnership calldata by owner -- transfers in same tx", async () => {
        const { escrow, owner, attacker } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        const calldata = escrow.interface.encodeFunctionData("transferOwnership", [attacker.address]);
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), calldata);
        expect(await escrow.owner()).to.equal(attacker.address);
    });

    it("13.69 upgradeToAndCall with initialize calldata -- reverts InvalidInitialization (already initialized)", async () => {
        const { escrow, owner, registry, feeRecipient } = await deploy();
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        const calldata = escrow.interface.encodeFunctionData("initialize", [
            await registry.getAddress(),
            feeRecipient.address,
        ]);
        await expect(
            escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), calldata)
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });
});

// -----------------------------------------------------------------------------
// State preservation across upgrades
// -----------------------------------------------------------------------------
describe("Cat13 -- State preservation across upgrades", () => {
    it("13.70 upgrade preserves PROTOCOL_FEE_WEI, REGISTRY, feeRecipient, owner", async () => {
        const { escrow, owner, registry, feeRecipient } = await deploy();
        const origRegistry = await escrow.registry();
        const origProtocolFeeWei = await escrow.protocolFeeWei();
        const origFeeRecipient = await escrow.feeRecipient();
        const origOwner = await escrow.owner();

        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await escrow.registry()).to.equal(origRegistry);
        expect(await escrow.protocolFeeWei()).to.equal(origProtocolFeeWei);
        expect(await escrow.feeRecipient()).to.equal(origFeeRecipient);
        expect(await escrow.owner()).to.equal(origOwner);
    });

    it("13.71 upgrade preserves deposited, lockedOf, commits, pendingWithdrawals", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "upgrade-state");
        await escrow.connect(bundler).settle(cid);
        const depositedBefore = await escrow.deposited(bundler.address);
        const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
        const commitBefore = await escrow.getCommit(cid);

        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore);
        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.settled).to.equal(commitBefore.settled);
        expect(commitAfter.user).to.equal(commitBefore.user);
    });

    it("13.72 claimPayout works after upgrade with accumulated pendingWithdrawals", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "pre-upgrade-payout");
        await escrow.connect(bundler).settle(cid);
        const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
        expect(pendingBefore).to.equal(ONE_GWEI);

        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

        // Claim payout after upgrade
        const balBefore = await ethers.provider.getBalance(bundler.address);
        await escrow.connect(bundler).claimPayout();
        const balAfter = await ethers.provider.getBalance(bundler.address);
        // Received at least most of pendingBefore (minus gas)
        expect(balAfter - balBefore).to.be.gt(pendingBefore - ethers.parseEther("0.001"));
    });
});

// -----------------------------------------------------------------------------
// Implementation contract direct calls
// -----------------------------------------------------------------------------
describe("Cat13 -- Implementation contract isolation", () => {
    it("13.73 implementation contract has initializers disabled (cannot initialize)", async () => {
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const impl = await Escrow.deploy();
        const [signer] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
        await expect(
            impl.initialize(await registry.getAddress(), signer.address)
        ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
});

// -----------------------------------------------------------------------------
// Cross-role confusion
// -----------------------------------------------------------------------------
describe("Cat13 -- Cross-role confusion", () => {
    it("13.74 same address is owner + bundler: owner ops and bundler ops both work", async () => {
        const { escrow, owner, registry, user, QUOTE_ID, feeRecipient, stranger } = await deploy();
        // Owner registers as bundler and deposits
        await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const ownerQuoteId = 2n; // second quote (deploy() created quoteId 1)
        await escrow.connect(owner).deposit({ value: COLLATERAL * 5n });

        // Owner commits as user to their own offer -- that's fine
        const cid = await makeCommit(escrow, user, ownerQuoteId, "owner-bundler");
        // Owner settles as bundler
        await escrow.connect(owner).settle(cid);
        // Owner also calls setFeeRecipient as owner
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("13.75 same address is owner + user: can commit and claim refund, also owner ops", async () => {
        const { escrow, owner, bundler, QUOTE_ID, stranger } = await deploy();
        const cid = await makeCommit(escrow, owner, QUOTE_ID, "owner-user");
        await mineToRefundable(escrow, cid);
        await escrow.connect(owner).claimRefund(cid);
        // Still owner
        await escrow.connect(owner).setFeeRecipient(stranger.address);
    });

    it("13.76 same address is owner + feeRecipient: PROTOCOL_FEE_WEI=0, no protocol fees accrue from settle", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "owner-fee-recv");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI=0: owner (as feeRecipient) gets 0 from settle
        const pending = await escrow.pendingWithdrawals(owner.address);
        expect(pending).to.equal(0n);
        // Bundler gets full fee
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("13.77 bundler cannot commit to own offer -- SelfCommitForbidden blocks role confusion", async () => {
        const { escrow, registry, bundler, QUOTE_ID } = await deploy();
        const offer = await registry.getOffer(QUOTE_ID);
        // Bundler commits as user -- this is now forbidden at commit time
        await expect(
            escrow.connect(bundler).commit(
                QUOTE_ID, ethers.keccak256(ethers.toUtf8Bytes("bundler-is-user")),
                offer.bundler, offer.collateralWei, offer.slaBlocks,
                { value: offer.feePerOp },
            ),
        ).to.be.revertedWithCustomError(escrow, "SelfCommitForbidden")
         .withArgs(bundler.address);
    });

    it("13.78 feeRecipient is also bundler with PROTOCOL_FEE_WEI=0 -- bundler gets full feePerOp (no platform fee to credit separately)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(bundler.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "fee-bundler");
        await escrow.connect(bundler).settle(cid);
        const expectedFull = ONE_GWEI; // platform + bundlerNet = full fee
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(expectedFull);
    });
});

// -----------------------------------------------------------------------------
// Edge cases on setFeeRecipient
// -----------------------------------------------------------------------------
describe("Cat13 -- setFeeRecipient edge cases", () => {
    it("13.79 setFeeRecipient to owner address -- valid", async () => {
        const { escrow, owner } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        expect(await escrow.feeRecipient()).to.equal(owner.address);
    });

    it("13.80 setFeeRecipient twice in same block -- last one wins", async () => {
        const { escrow, owner, stranger, attacker } = await deploy();
        // Both txns will be in separate blocks in hardhat, but test the state
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await escrow.connect(owner).setFeeRecipient(attacker.address);
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });

    it("13.81 setFeeRecipient to proxy address itself reverts ZeroAddress (T15)", async () => {
        const { escrow, owner } = await deploy();
        const escrowAddr = await escrow.getAddress();
        await expect(escrow.connect(owner).setFeeRecipient(escrowAddr))
            .to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("13.82 setFeeRecipient to registry address -- valid (registry can receive ETH? depends on fallback)", async () => {
        const { escrow, owner, registry } = await deploy();
        const regAddr = await registry.getAddress();
        await escrow.connect(owner).setFeeRecipient(regAddr);
        expect(await escrow.feeRecipient()).to.equal(regAddr);
    });

    it("13.83 setFeeRecipient does not affect bundler pendingWithdrawals (PROTOCOL_FEE_WEI=0, feeRecipient gets 0)", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "old-fees-1");
        await escrow.connect(bundler).settle(cid1);
        // PROTOCOL_FEE_WEI=0: feeRecipient gets nothing from settle
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        // Bundler got full fee
        const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
        expect(bundlerPending).to.equal(ONE_GWEI);

        // Change feeRecipient
        await escrow.connect(owner).setFeeRecipient(stranger.address);

        // Bundler's pending should be unchanged
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerPending);
        // Bundler can still claim
        await escrow.connect(bundler).claimPayout();
    });
});

// -----------------------------------------------------------------------------
// Multiple owner transfers and admin actions
// -----------------------------------------------------------------------------
describe("Cat13 -- Complex ownership scenarios", () => {
    it("13.84 ownership ping-pong: A->B->A -- original owner regains control", async () => {
        const { escrow, owner, newOwner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        await escrow.connect(newOwner).transferOwnership(owner.address);
        expect(await escrow.owner()).to.equal(owner.address);
        await escrow.connect(owner).setFeeRecipient(stranger.address);
    });

    it("13.85 ownership transfer during active commit -- settle still works", async () => {
        const { escrow, owner, bundler, user, newOwner, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "xfer-active");
        await escrow.connect(owner).transferOwnership(newOwner.address);
        await escrow.connect(bundler).settle(cid);
        const c = await escrow.getCommit(cid);
        expect(c.settled).to.be.true;
    });

    it("13.86 ownership transfer during active commit -- claimRefund still works", async () => {
        const { escrow, owner, user, newOwner, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "xfer-refund-active");
        await escrow.connect(owner).transferOwnership(newOwner.address);
        await mineToRefundable(escrow, cid);
        await escrow.connect(user).claimRefund(cid);
        const c = await escrow.getCommit(cid);
        expect(c.refunded).to.be.true;
    });

    it("13.87 new owner can upgrade after transfer", async () => {
        const { escrow, owner, newOwner } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await escrow.connect(newOwner).upgradeToAndCall(await newImpl.getAddress(), "0x");
    });

    it("13.88 old owner cannot upgrade after transfer", async () => {
        const { escrow, owner, newOwner } = await deploy();
        await escrow.connect(owner).transferOwnership(newOwner.address);
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await expect(
            escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
});

// -----------------------------------------------------------------------------
// Attacker contract as feeRecipient edge cases
// -----------------------------------------------------------------------------
describe("Cat13 -- Contract feeRecipient edge cases", () => {
    it("13.89 feeRecipient set to reverting contract with PROTOCOL_FEE_WEI=0 -- no fees accrue; claimPayout would revert NothingToClaim", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerContract = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;
        const attackerAddr = await attackerContract.getAddress();
        await escrow.connect(owner).setFeeRecipient(attackerAddr);

        // Commit 1 -- no revert
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "toggle-1");
        await escrow.connect(bundler).settle(cid1);
        // PROTOCOL_FEE_WEI=0: attacker (feeRecipient) gets 0, claimPayout reverts NothingToClaim
        expect(await escrow.pendingWithdrawals(attackerAddr)).to.equal(0n);

        // Commit 2 -- revert enabled
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "toggle-2");
        await escrow.connect(bundler).settle(cid2);
        await attackerContract.setRevert(true);
        // Still 0 pending -- nothing to claim
        expect(await escrow.pendingWithdrawals(attackerAddr)).to.equal(0n);

        // Commit 3 -- revert disabled again
        await attackerContract.setRevert(false);
        const cid3 = await makeCommit(escrow, user, QUOTE_ID, "toggle-3");
        await escrow.connect(bundler).settle(cid3);
        // All 3 settles: 0 to attacker (feeRecipient), bundler gets all
        expect(await escrow.pendingWithdrawals(attackerAddr)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 3n);
    });

    it("13.90 feeRecipient contract as attacker -- PROTOCOL_FEE_WEI=0, no fees accrue so no griefing possible", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        // Attacker contract set as feeRecipient
        const AttackerFactory = await ethers.getContractFactory("Attacker");
        const attackerContract = (await AttackerFactory.deploy(await escrow.getAddress())) as Attacker;
        await escrow.connect(owner).setFeeRecipient(await attackerContract.getAddress());

        const cid = await makeCommit(escrow, user, QUOTE_ID, "gas-recv");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI=0: nothing accrued to attacker contract
        expect(await escrow.pendingWithdrawals(await attackerContract.getAddress())).to.equal(0n);
        // Bundler gets full fee regardless
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });
});

// -----------------------------------------------------------------------------
// PROTOCOL_FEE_WEI at extreme values
// -----------------------------------------------------------------------------
describe("Cat13 -- PROTOCOL_FEE_WEI boundary behavior", () => {
    it("13.91 PROTOCOL_FEE_WEI = 0 (default): settle allocates zero to feeRecipient, full to bundler", async () => {
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), feeRecipient.address],
            { kind: "uups" }
        )) as unknown as SLAEscrow;
        await registry.connect(bundler).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });
        const cid = await makeCommit(escrow, user, 1n, "zero-fee-wei");
        await escrow.connect(bundler).settle(cid);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("13.92 PROTOCOL_FEE_WEI = MAX (0.001 ether): feeRecipient gets flat fee per commit at commit time", async () => {
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), feeRecipient.address],
            { kind: "uups" }
        )) as unknown as SLAEscrow;
        const MAX_FEE_WEI = ethers.parseEther("0.001");
        await escrow.connect(owner).setProtocolFeeWei(MAX_FEE_WEI);
        await registry.connect(bundler).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });
        // Commit must send feePerOp + PROTOCOL_FEE_WEI
        const tx = await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("max-fee-wei")), bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + MAX_FEE_WEI });
        const receipt = await tx.wait();
        const commitLogs92 = receipt!.logs
            .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
            .map(log => escrow.interface.parseLog(log)!);
        expect(commitLogs92.length, "CommitCreated not emitted").to.equal(1);
        const cid = commitLogs92[0].args.commitId as bigint;
        // Two-phase: bundler must accept() before settle()
        await escrow.connect(bundler).accept(cid);
        await escrow.connect(bundler).settle(cid);
        // Protocol fee was taken at commit time; bundler gets full feePerOp at settle
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("13.93 PROTOCOL_FEE_WEI = 1 wei: very small flat fee paid at commit", async () => {
        const [owner, bundler, user, feeRecipient] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), feeRecipient.address],
            { kind: "uups" }
        )) as unknown as SLAEscrow;
        await escrow.connect(owner).setProtocolFeeWei(1n);
        await registry.connect(bundler).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });
        const tx = await escrow.connect(user).commit(1n, ethers.keccak256(ethers.toUtf8Bytes("1wei-fee")), bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI + 1n });
        const receipt = await tx.wait();
        const commitLogs93 = receipt!.logs
            .filter(log => log.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
            .map(log => escrow.interface.parseLog(log)!);
        expect(commitLogs93.length, "CommitCreated not emitted").to.equal(1);
        const cid = commitLogs93[0].args.commitId as bigint;
        // Two-phase: bundler must accept() before settle()
        await escrow.connect(bundler).accept(cid);
        await escrow.connect(bundler).settle(cid);
        // Bundler gets full feePerOp; protocol fee (1 wei) was collected at commit
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });
});

// -----------------------------------------------------------------------------
// Privilege escalation via raw low-level calls
// -----------------------------------------------------------------------------
describe("Cat13 -- Raw call privilege escalation", () => {
    it("13.94 raw call to _authorizeUpgrade selector -- reverts (internal function)", async () => {
        const { escrow, attacker } = await deploy();
        // _authorizeUpgrade is internal; calling its selector should not match any external function
        const selector = ethers.id("_authorizeUpgrade(address)").slice(0, 10);
        // bare revert: internal function has no external selector, proxy fallback reverts with no data
        await expect(
            attacker.sendTransaction({
                to: await escrow.getAddress(),
                data: selector + ethers.ZeroAddress.slice(2).padStart(64, "0"),
            })
        ).to.be.reverted; // bare revert: no external selector match
    });

    it("13.95 raw call to __Ownable_init selector -- reverts (initializer modifier)", async () => {
        const { escrow, attacker } = await deploy();
        const selector = ethers.id("__Ownable_init(address)").slice(0, 10);
        // bare revert: initializer function is not external, no matching selector in proxy dispatch
        await expect(
            attacker.sendTransaction({
                to: await escrow.getAddress(),
                data: selector + attacker.address.slice(2).padStart(64, "0"),
            })
        ).to.be.reverted; // bare revert: no external selector match
    });

    it("13.96 raw call to non-existent function selector -- reverts", async () => {
        const { escrow, attacker } = await deploy();
        // bare revert: unknown selector, no fallback defined in impl
        await expect(
            attacker.sendTransaction({
                to: await escrow.getAddress(),
                data: "0xdeadbeef",
            })
        ).to.be.reverted; // bare revert: unknown selector, no fallback
    });
});

// -----------------------------------------------------------------------------
// Interaction between ownership and deposit/withdraw
// -----------------------------------------------------------------------------
describe("Cat13 -- Ownership + deposit/withdraw interaction", () => {
    it("13.97 transferring ownership does not affect deposited balances", async () => {
        const { escrow, owner, bundler, newOwner } = await deploy();
        const depositedBefore = await escrow.deposited(bundler.address);
        await escrow.connect(owner).transferOwnership(newOwner.address);
        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
    });

    it("13.98 renounceOwnership reverts -- lockedOf balances unaffected by failed renounce (T22)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "lock-renounce");
        const lockedBefore = await escrow.lockedOf(bundler.address);
        expect(lockedBefore).to.equal(COLLATERAL);
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
    });

    it("13.99 upgradeToAndCall does not alter contract ETH balance", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await makeCommit(escrow, user, QUOTE_ID, "upgrade-bal");
        const balBefore = await contractBalance(escrow);
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");
        expect(await contractBalance(escrow)).to.equal(balBefore);
    });

    it("13.100 full attack scenario: attacker tries every privilege escalation path -- all blocked", async () => {
        const { escrow, owner, bundler, user, feeRecipient, attacker, QUOTE_ID } = await deploy();

        // 1. Try setFeeRecipient
        await expect(escrow.connect(attacker).setFeeRecipient(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 2. Try transferOwnership
        await expect(escrow.connect(attacker).transferOwnership(attacker.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 3. Try renounceOwnership
        await expect(escrow.connect(attacker).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 4. Try upgradeToAndCall
        const EscrowV2 = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await EscrowV2.deploy();
        await expect(
            escrow.connect(attacker).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 5. Try upgradeToAndCall with hijack calldata
        const hijackCalldata = escrow.interface.encodeFunctionData("transferOwnership", [attacker.address]);
        await expect(
            escrow.connect(attacker).upgradeToAndCall(await newImpl.getAddress(), hijackCalldata)
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 6. Try initialize
        await expect(
            escrow.connect(attacker).initialize(attacker.address, attacker.address)
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");

        // 7. Try withdraw without deposit
        await expect(escrow.connect(attacker).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");

        // 8. settle() is permissionless -- attacker can call it, but fee goes to bundler not attacker
        const cid = await makeCommit(escrow, user, QUOTE_ID, "full-attack");
        const bundlerPendingBefore = await escrow.pendingWithdrawals(bundler.address);
        await expect(escrow.connect(attacker).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerPendingBefore + ONE_GWEI);
        expect(await escrow.pendingWithdrawals(attacker.address)).to.equal(0n);

        // 9. Commit is already settled -- claimRefund reverts AlreadyFinalized regardless of who calls
        await mineToRefundable(escrow, cid);
        await expect(escrow.connect(attacker).claimRefund(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");

        // 9b. claimRefund on a different commit -- attacker is not CLIENT/BUNDLER/feeRecipient
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "full-attack-2");
        await mineToRefundable(escrow, cid2);
        await expect(escrow.connect(attacker).claimRefund(cid2))
            .to.be.revertedWithCustomError(escrow, "Unauthorized");

        // 10. Try claimPayout with no pending
        await expect(escrow.connect(attacker).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");

        // Verify nothing changed
        expect(await escrow.owner()).to.equal(owner.address);
        expect(await escrow.feeRecipient()).to.equal(feeRecipient.address);
    });
});

// -----------------------------------------------------------------------------
// setRegistry with open commits
// -----------------------------------------------------------------------------
describe("Cat13 -- setRegistry does not affect open commits", () => {
    it("13.101 setRegistry while a commit is in-flight: pending commit settles at original snapshotted economics", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

        // Commit under the current registry (feePaid = ONE_GWEI snapshotted at commit time)
        const cid = await makeCommit(escrow, user, QUOTE_ID, "setregistry-open");
        const commitBefore = await escrow.getCommit(cid);
        expect(commitBefore.feePaid).to.equal(ONE_GWEI);

        // Deploy a fresh registry (owner may have different params but that doesn't matter for this commit)
        const RegFactory = await ethers.getContractFactory("QuoteRegistry");
        const newReg = await RegFactory.deploy(owner.address, ethers.parseEther("0.0001"));
        await newReg.waitForDeployment();
        await escrow.connect(owner).setRegistry(await newReg.getAddress());
        expect(await escrow.registry()).to.equal(await newReg.getAddress());

        // Settle the original commit -- reads feePaid from commit struct, not registry
        await escrow.connect(bundler).settle(cid);

        // Economics unchanged: bundler receives the original feePaid
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(commitBefore.feePaid);
        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.feePaid).to.equal(commitBefore.feePaid);
        expect(commitAfter.settled).to.be.true;
    });
});
