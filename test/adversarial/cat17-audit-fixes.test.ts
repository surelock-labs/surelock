// Category 17: Audit fix verification
// Verifies that all findings from the 2026-04-07 expert audit are fixed.

import { expect }                  from "chai";
import { ethers, upgrades }        from "hardhat";
import { mine, setBalance }        from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow } from "../../typechain-types";
import {
    deployEscrow,
    registerOffer,
    makeCommit as fixturesMakeCommit,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const SLA_BLOCKS = 10;

// -- helpers -------------------------------------------------------------------

async function deploy() {
    return deployEscrow({ slaBlocks: BigInt(SLA_BLOCKS), preDeposit: false });
}

async function setupOffer(registry: QuoteRegistry, escrow: SLAEscrow, bundler: any) {
    const quoteId = await registerOffer(registry, escrow, bundler, {
        slaBlocks: BigInt(SLA_BLOCKS),
        deposit: COLLATERAL,
    });
    return quoteId;
}

async function makeCommit(escrow: SLAEscrow, user: any, quoteId: bigint) {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, `commit-${Date.now()}-${Math.random()}`);
    const deadline = (await escrow.getCommit(commitId)).deadline;
    return { commitId, deadline };
}

// -- Finding 1 (Medium): setRegistry event now indexed ------------------------

describe("Cat17.1 -- RegistryUpdated event has indexed addresses (Medium fix)", function () {

    it("17.01 RegistryUpdated event has indexed oldRegistry and newRegistry", async function () {
        const { escrow, registry, owner } = await deploy();

        // Deploy a second registry to use as new registry
        const Registry2 = await ethers.getContractFactory("QuoteRegistry");
        const registry2 = await Registry2.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));

        const oldAddr = await registry.getAddress();
        const newAddr = await registry2.getAddress();

        await expect(escrow.connect(owner).setRegistry(newAddr))
            .to.emit(escrow, "RegistryUpdated")
            .withArgs(oldAddr, newAddr);
    });

    it("17.02 RegistryUpdated event is filterable by oldRegistry topic (indexed)", async function () {
        const { escrow, registry, owner } = await deploy();

        const Registry2 = await ethers.getContractFactory("QuoteRegistry");
        const registry2 = await Registry2.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));

        const oldAddr = await registry.getAddress();
        const newAddr = await registry2.getAddress();

        await escrow.connect(owner).setRegistry(newAddr);

        // Query logs filtered by oldRegistry (first indexed param)
        const filter = escrow.filters.RegistryUpdated(oldAddr, null);
        const logs = await escrow.queryFilter(filter);
        expect(logs.length).to.equal(1);
        expect(logs[0].args.oldRegistry).to.equal(oldAddr);
        expect(logs[0].args.newRegistry).to.equal(newAddr);
    });
});

// -- Finding 2 (Low): Settlement grace period ---------------------------------

describe("Cat17.2 -- Settlement grace period: bundler can settle at deadline+1 (Low fix)", function () {

    it("17.03 SETTLEMENT_GRACE_BLOCKS constant equals 10", async function () {
        const { escrow } = await deploy();
        expect(await escrow.SETTLEMENT_GRACE_BLOCKS()).to.equal(10n);
    });

    it("17.04 settle at exactly deadline+1 succeeds (was DeadlinePassed before fix)", async function () {
        const { escrow, registry, bundler, user } = await deploy();
        const quoteId = await setupOffer(registry, escrow, bundler);
        const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

        // Mine so settle TX lands at deadline+1:
        // current after mine = deadline, then TX mines deadline+1
        const current = BigInt(await ethers.provider.getBlockNumber());
        await mine(Number(deadline - current)); // current becomes deadline, TX -> deadline+1

        // inclusionBlock must be <= deadline and have a known blockhash
        // safeInclBlock: cur=deadline -> returns deadline-1
        const inclBlock = await safeInclBlock(escrow, commitId);

        await expect(
            escrow.connect(bundler).settle(commitId)
        ).to.not.be.reverted;
    });

    it("17.05 settle at exactly deadline+11 reverts DeadlinePassed (SETTLEMENT_GRACE=10)", async function () {
        const { escrow, registry, bundler, user } = await deploy();
        const quoteId = await setupOffer(registry, escrow, bundler);
        const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

        // Mine so settle TX lands at deadline+11 (past grace window)
        const current = BigInt(await ethers.provider.getBlockNumber());
        await mine(Number(deadline - current + 10n)); // current = deadline+10, TX -> deadline+11

        const inclBlock = await safeInclBlock(escrow, commitId);

        await expect(
            escrow.connect(bundler).settle(commitId)
        ).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("17.06 bundler includes at deadline block, settles at deadline+1 -- full happy path", async function () {
        const { escrow, registry, bundler, user } = await deploy();
        const quoteId = await setupOffer(registry, escrow, bundler);
        const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

        // Mine to deadline-1 so next block is the deadline block (where bundler "includes")
        const current = BigInt(await ethers.provider.getBlockNumber());
        if (deadline > current + 1n) {
            await mine(Number(deadline - current - 1n));
        }

        // Now current block = deadline-1; deadline block is next.
        // Mine 1 more to simulate bundler including at deadline block.
        await mine(1); // current = deadline, representing "included at block deadline"

        // At this point current == deadline.
        // blockhash(deadline) == 0 (current block), so bundler uses deadline-1 as proof.
        // Settle TX will mine at deadline+1 (SETTLEMENT_GRACE=10 -> allowed).
        const inclBlock = deadline - 1n; // known block with valid blockhash

        await expect(
            escrow.connect(bundler).settle(commitId)
        ).to.not.be.reverted;

        expect((await escrow.getCommit(commitId)).settled).to.be.true;
    });

    it("17.07 claimRefund window shifts by SETTLEMENT_GRACE_BLOCKS (unlocksAt = deadline + SETTLE_GRACE + REFUND_GRACE + 1)", async function () {
        const { escrow, registry, bundler, user } = await deploy();
        const quoteId = await setupOffer(registry, escrow, bundler);
        const { commitId, deadline } = await makeCommit(escrow, user, quoteId);

        const settleGrace = await escrow.SETTLEMENT_GRACE_BLOCKS();
        const refundGrace = await escrow.REFUND_GRACE_BLOCKS();
        const expectedUnlocksAt = deadline + settleGrace + refundGrace + 1n;

        // Still locked one block before unlocksAt
        const current = BigInt(await ethers.provider.getBlockNumber());
        await mine(Number(expectedUnlocksAt - current - 2n)); // TX mines at unlocksAt-1

        await expect(
            escrow.connect(user).claimRefund(commitId)
        ).to.be.revertedWithCustomError(escrow, "NotExpired")
         .withArgs(commitId, expectedUnlocksAt, expectedUnlocksAt - 1n);

        // Unlocked at exactly unlocksAt
        await mine(1); // TX now mines at expectedUnlocksAt
        await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
    });
});

// -- Finding 3 (Low): sweepExcess pull model -----------------------------------

describe("Cat17.3 -- sweepExcess uses pull model; reverting feeRecipient cannot brick sweep (Low fix)", function () {

    it("17.08 sweepExcess queues excess into pendingWithdrawals instead of transferring directly", async function () {
        const { escrow, owner, feeRecipient } = await deploy();
        const addr = await escrow.getAddress();

        // Force-send ETH via ForceEther helper contract
        const ForceEtherFactory = await ethers.getContractFactory("ForceEther");
        const excess = ethers.parseEther("0.3");
        const forcer = await ForceEtherFactory.connect(owner).deploy({ value: excess });
        await (forcer as any).destroy(addr);

        const recipBalBefore = await ethers.provider.getBalance(feeRecipient.address);
        const pendingBefore  = await escrow.pendingWithdrawals(feeRecipient.address);
        const reservedBefore = await escrow.reservedBalance();

        await escrow.connect(owner).sweepExcess();

        // Pull model: feeRecipient ETH balance unchanged
        expect(await ethers.provider.getBalance(feeRecipient.address)).to.equal(recipBalBefore);
        // pendingWithdrawals increased by excess
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingBefore + excess);
        // reservedBalance increased to account for queued sweep
        expect(await escrow.reservedBalance()).to.equal(reservedBefore + excess);
        // balance == reservedBalance (invariant holds)
        expect(await ethers.provider.getBalance(addr)).to.equal(await escrow.reservedBalance());
    });

    it("17.09 feeRecipient claims swept excess via claimPayout()", async function () {
        const { escrow, owner, feeRecipient } = await deploy();
        const addr = await escrow.getAddress();

        const ForceEtherFactory = await ethers.getContractFactory("ForceEther");
        const excess = ethers.parseEther("0.2");
        const forcer = await ForceEtherFactory.connect(owner).deploy({ value: excess });
        await (forcer as any).destroy(addr);

        await escrow.connect(owner).sweepExcess();

        const recipBalBefore = await ethers.provider.getBalance(feeRecipient.address);
        const tx = await escrow.connect(feeRecipient).claimPayout();
        const receipt = await tx.wait();
        const gasCost = receipt!.gasUsed * receipt!.gasPrice;

        expect(await ethers.provider.getBalance(feeRecipient.address)).to.equal(recipBalBefore + excess - gasCost);
    });

    it("17.10 sweepExcess does NOT revert when feeRecipient is a reverting contract", async function () {
        // Deploy a reverting receiver as feeRecipient
        const RevertingReceiverFactory = await ethers.getContractFactory("RevertingReceiver");
        const revertingReceiver = await RevertingReceiverFactory.deploy();

        const [owner, , , , stranger] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), await revertingReceiver.getAddress()],
            { kind: "uups" },
        )) as unknown as SLAEscrow;

        const addr = await escrow.getAddress();
        const ForceEtherFactory = await ethers.getContractFactory("ForceEther");
        const excess = ethers.parseEther("0.1");
        const forcer = await ForceEtherFactory.connect(owner).deploy({ value: excess });
        await (forcer as any).destroy(addr);

        // With old direct transfer: this would revert because feeRecipient.receive() reverts.
        // With pull model: no external call, no revert.
        await expect(escrow.connect(owner).sweepExcess()).to.not.be.reverted;

        // Excess queued in pendingWithdrawals for the reverting receiver
        expect(await escrow.pendingWithdrawals(await revertingReceiver.getAddress())).to.equal(excess);
    });

    it("17.11 sweepExcess emits ExcessSwept event with correct recipient and amount", async function () {
        const { escrow, owner, feeRecipient } = await deploy();
        const addr = await escrow.getAddress();

        const ForceEtherFactory = await ethers.getContractFactory("ForceEther");
        const excess = ethers.parseEther("0.05");
        const forcer = await ForceEtherFactory.connect(owner).deploy({ value: excess });
        await (forcer as any).destroy(addr);

        await expect(escrow.connect(owner).sweepExcess())
            .to.emit(escrow, "ExcessSwept")
            .withArgs(feeRecipient.address, excess);
    });
});

// -- Finding 4 (Low): QuoteRegistry minimum fee -------------------------------

describe("Cat17.4 -- QuoteRegistry rejects zero-fee offers (Low fix)", function () {

    it("17.12 register with feePerOp = 0 reverts", async function () {
        const { registry, bundler } = await deploy();
        await expect(
            registry.connect(bundler).register(0, 10, 0, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWith("feePerOp must be > 0");
    });

    it("17.13 register with feePerOp = 0, collateralWei = 0 reverts (zero fee still blocked)", async function () {
        const { registry, bundler } = await deploy();
        await expect(
            registry.connect(bundler).register(0, 5, 0, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWith("feePerOp must be > 0");
    });

    it("17.14 register with feePerOp = 1 wei, collateral = 2 wei succeeds (strict collateral > fee)", async function () {
        const { registry, bundler } = await deploy();
        await expect(
            registry.connect(bundler).register(1, 10, 2, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.not.be.reverted;
    });

    it("17.15 register with feePerOp = ONE_GWEI succeeds", async function () {
        const { registry, bundler } = await deploy();
        await expect(
            registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.not.be.reverted;
    });

    it("17.16 collateralWei = 0 still blocked if feePerOp > 0 (collateral > fee strict requirement)", async function () {
        const { registry, bundler } = await deploy();
        // feePerOp=1wei, collateralWei=0 -> collateral <= fee -> blocked by existing check
        await expect(
            registry.connect(bundler).register(1, 10, 0, 302_400, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWith("collateralWei must be > feePerOp");
    });
});

// -- Finding 5 (initialize hardening): EOA registry and self-feeRecipient blocked -

describe("Cat17.5 -- initialize() input validation hardening", function () {

    it("17.17 initialize() rejects EOA as registry_ (InvalidRegistry)", async function () {
        const [, , , feeRecipient] = await ethers.getSigners();
        const F = await ethers.getContractFactory("SLAEscrowTestable");
        // feeRecipient.address is an EOA (zero code length) -- new guard fires InvalidRegistry
        await expect(
            upgrades.deployProxy(F, [feeRecipient.address, feeRecipient.address], { kind: "uups" })
        ).to.be.revertedWithCustomError(F, "InvalidRegistry");
    });

    it("17.18 initialize() rejects feeRecipient_ == address(this) (ZeroAddress feeRecipient)", async function () {
        const [owner] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = await Registry.deploy(owner.address, ethers.parseEther("0.0001"));
        await registry.waitForDeployment();

        const F = await ethers.getContractFactory("SLAEscrowTestable");
        // Pre-warm impl cache so deployProxy sends exactly one tx (the proxy itself)
        await upgrades.deployImplementation(F, { kind: "uups" });

        // Proxy lands at the CREATE address for owner's next nonce
        const nonce = await ethers.provider.getTransactionCount(owner.address);
        const predictedProxy = ethers.getCreateAddress({ from: owner.address, nonce });

        await expect(
            upgrades.deployProxy(F, [await registry.getAddress(), predictedProxy], { kind: "uups" })
        ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
});
