// UUPS proxy upgrade and TimelockController test suite
// Covers scenarios NOT present in the 696 adversarial tests.

import { expect }                       from "chai";
import { ethers, upgrades }             from "hardhat";
import { mine, time }                   from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow, TimelockController } from "../typechain-types";
import {
    deployEscrow,
    deployRealEscrow,
    deployWithTimelock as fixturesDeployWithTimelock,
    makeCommit as fixturesMakeCommit,
    COLLATERAL,
} from "./helpers/fixtures";

const SLA_BLOCKS   = 2;

// -- shared deploy fixture ----------------------------------------------------

async function deployBase() {
    return deployEscrow({ slaBlocks: BigInt(SLA_BLOCKS), preDeposit: COLLATERAL * 10n });
}

/** Deploy base + TimelockController (zero delay by default), transfer ownership to timelock */
async function deployWithTimelock(minDelay = 0) {
    return fixturesDeployWithTimelock(minDelay, { slaBlocks: BigInt(SLA_BLOCKS), preDeposit: COLLATERAL * 10n });
}

/** Helper: create a commit and return its commitId */
async function makeCommit(
    escrow: SLAEscrow,
    user: any,
    quoteId: bigint,
    tag?: string,
): Promise<bigint> {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, tag ?? "op");
    return commitId;
}

// =============================================================================
//  1. Implementation direct call protection
// =============================================================================

describe("Proxy -- Implementation direct call protection", () => {
    it("calling initialize() on the implementation contract reverts with InvalidInitialization", async () => {
        const { feeRecipient } = await deployBase();

        // Deploy a bare implementation (no proxy)
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const impl = await Escrow.deploy();
        await impl.waitForDeployment();

        // The constructor called _disableInitializers(), so initialize must revert
        await expect(
            impl.initialize(ethers.ZeroAddress, feeRecipient.address),
        ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
});

// =============================================================================
//  2. Double initialization
// =============================================================================

describe("Proxy -- Double initialization", () => {
    it("calling initialize() a second time on the proxy reverts", async () => {
        const { escrow, registry, feeRecipient } = await deployBase();

        await expect(
            escrow.initialize(await registry.getAddress(), feeRecipient.address),
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });
});

// =============================================================================
//  3. Upgrade authorization
// =============================================================================

describe("Proxy -- Upgrade authorization", () => {
    it("upgradeToAndCall by non-owner reverts with OwnableUnauthorizedAccount", async () => {
        const { escrow, registry, feeRecipient, stranger } = await deployBase();

        // Deploy a new implementation to upgrade to
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();

        const proxyAddr = await escrow.getAddress();
        // Attach to proxy via the UUPSUpgradeable ABI to call upgradeToAndCall
        const proxy = newImpl.attach(proxyAddr) as SLAEscrow;

        await expect(
            proxy.connect(stranger).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
         .withArgs(stranger.address);
    });

    it("upgradeToAndCall by owner succeeds and new implementation is active", async () => {
        const { escrow, stranger } = await deployBase();

        const proxyAddr = await escrow.getAddress();

        // Deploy a bare implementation and call upgradeToAndCall directly (not via plugin).
        // The plugin reuses the same address when bytecode is identical, so we test the
        // authorization path directly: owner can call, proxy accepts, contract stays live.
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();
        const newImplAddr = await newImpl.getAddress();

        // upgradeToAndCall via the proxy (owner is the signer from deployBase -- first account)
        const [owner] = await ethers.getSigners();
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await expect(
            proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x"),
        ).to.not.be.reverted;

        // Implementation slot now points to the new address
        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(newImplAddr);

        // Contract still functional
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });

    it("state (deposited, commits, pendingWithdrawals) persists after upgrade", async () => {
        const { escrow, registry, owner, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();

        // Create some state: commit + settle so there are pending withdrawals
        const cid = await makeCommit(escrow, user, QUOTE_ID, "persist-test");
        await escrow.connect(bundler).settle(cid);

        // Snapshot state before upgrade
        const depositedBefore  = await escrow.deposited(bundler.address);
        const pendingBundler   = await escrow.pendingWithdrawals(bundler.address);
        const pendingFee       = await escrow.pendingWithdrawals(feeRecipient.address);
        const nextCommitBefore = await escrow.nextCommitId();

        const proxyAddr = await escrow.getAddress();
        const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);

        // Deploy a fresh impl to guarantee a new address (OZ plugin reuses same impl for identical bytecode)
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const freshImpl = await Escrow.deploy();
        await freshImpl.waitForDeployment();
        const freshImplAddr = await freshImpl.getAddress();

        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(freshImplAddr, "0x");

        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(freshImplAddr);
        expect(implAfter).to.not.equal(implBefore);

        // Verify state persists across the impl swap
        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBundler);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingFee);
        expect(await escrow.nextCommitId()).to.equal(nextCommitBefore);

        // Verify the settled commit struct is intact
        const commit = await escrow.getCommit(cid);
        expect(commit.settled).to.be.true;
        expect(commit.user).to.equal(user.address);
        expect(commit.bundler).to.equal(bundler.address);
    });

    it("entryPoint immutable drifts across upgrade -- upgrading implementation changes entryPoint()", async () => {
        const { escrow, owner } = await deployBase();

        // SLAEscrowTestable bakes in address(1) as the entryPoint immutable
        const epBefore = await escrow.entryPoint();
        expect(epBefore).to.equal("0x0000000000000000000000000000000000000001");

        // Deploy production SLAEscrow with a different entryPoint immutable (address(2))
        const ProdImpl = await ethers.getContractFactory("SLAEscrow");
        const newImpl = await ProdImpl.deploy("0x0000000000000000000000000000000000000002");
        await newImpl.waitForDeployment();

        const proxyAddr = await escrow.getAddress();
        const proxy = (await ethers.getContractFactory("SLAEscrowTestable")).attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

        // entryPoint() now returns address(2) -- no storage write needed; the immutable is in bytecode
        const epAfter = await escrow.entryPoint();
        expect(epAfter).to.equal("0x0000000000000000000000000000000000000002");
        expect(epAfter).to.not.equal(epBefore);
    });
});

// =============================================================================
//  3b. T22 upgrade precondition enforcement (production SLAEscrow, not Testable)
//      SLAEscrowTestable overrides _authorizeUpgrade to skip these checks so the
//      200+ upgrade functional tests don't need the ceremony. These tests verify
//      the production path directly using deployRealEscrow().
// =============================================================================

describe("Proxy -- T22 upgrade precondition enforcement", () => {
    it("upgrade reverts with UpgradeRequiresFrozenCommits when commits are not frozen", async () => {
        const { escrow, owner } = await deployRealEscrow();
        const proxyAddr = await escrow.getAddress();

        const Impl = await ethers.getContractFactory("SLAEscrow");
        const newImpl = await Impl.deploy(await escrow.entryPoint());
        await newImpl.waitForDeployment();

        // commitsFrozen is false -- upgrade must revert
        await expect(
            escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(escrow, "UpgradeRequiresFrozenCommits");
    });

    it("upgrade reverts with UpgradeFreezeWindowActive when freeze window has not elapsed", async () => {
        const { escrow, owner } = await deployRealEscrow();

        await escrow.connect(owner).freezeCommits();
        // Do NOT advance time -- freeze window has not elapsed

        const Impl = await ethers.getContractFactory("SLAEscrow");
        const newImpl = await Impl.deploy(await escrow.entryPoint());
        await newImpl.waitForDeployment();

        await expect(
            escrow.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(escrow, "UpgradeFreezeWindowActive");
    });

    it("upgrade succeeds after freeze + MAX_RESOLUTION_WINDOW_SECONDS elapsed", async () => {
        const { escrow, owner } = await deployRealEscrow();
        const proxyAddr = await escrow.getAddress();

        await escrow.connect(owner).freezeCommits();
        await time.increase(2057); // > MAX_RESOLUTION_WINDOW_SECONDS (2056)

        const Impl = await ethers.getContractFactory("SLAEscrow");
        const newImpl = await Impl.deploy(await escrow.entryPoint());
        await newImpl.waitForDeployment();
        const newImplAddr = await newImpl.getAddress();

        await expect(
            escrow.connect(owner).upgradeToAndCall(newImplAddr, "0x"),
        ).to.not.be.reverted;

        expect(await upgrades.erc1967.getImplementationAddress(proxyAddr)).to.equal(newImplAddr);
    });

    it("non-owner still reverts with OwnableUnauthorizedAccount (onlyOwner fires before preconditions)", async () => {
        const { escrow, owner } = await deployRealEscrow();
        const [, , , , stranger] = await ethers.getSigners();

        await escrow.connect(owner).freezeCommits();
        await time.increase(2057);

        const Impl = await ethers.getContractFactory("SLAEscrow");
        const newImpl = await Impl.deploy(await escrow.entryPoint());
        await newImpl.waitForDeployment();

        await expect(
            escrow.connect(stranger).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("commitsFrozenAt is recorded when freezeCommits() is called", async () => {
        const { escrow, owner } = await deployRealEscrow();
        expect(await escrow.commitsFrozenAt()).to.equal(0n);

        const tx = await escrow.connect(owner).freezeCommits();
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);

        expect(await escrow.commitsFrozenAt()).to.equal(BigInt(block!.timestamp));
    });
});

// =============================================================================
//  4. TimelockController as owner
// =============================================================================

describe("Proxy -- TimelockController as owner", () => {
    it("after transferOwnership(timelock), old owner cannot upgradeToAndCall", async () => {
        const { escrow, owner } = await deployWithTimelock();

        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();

        const proxyAddr = await escrow.getAddress();
        const proxy = newImpl.attach(proxyAddr) as SLAEscrow;

        await expect(
            proxy.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
         .withArgs(owner.address);
    });

    it("upgrade proposed through timelock and executed after delay succeeds", async () => {
        const DELAY = 60; // 60 seconds
        const { escrow, owner, timelock } = await deployWithTimelock(DELAY);

        const proxyAddr = await escrow.getAddress();
        const timelockAddr = await timelock.getAddress();
        const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);

        // Deploy new implementation
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();
        const newImplAddr = await newImpl.getAddress();

        // Build the upgradeToAndCall calldata
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            newImplAddr,
            "0x",
        ]);

        const salt = ethers.id("upgrade-v2");
        const predecessor = ethers.ZeroHash;

        // Schedule through timelock
        await timelock.connect(owner).schedule(
            proxyAddr,  // target
            0,          // value
            upgradeData,
            predecessor,
            salt,
            DELAY,
        );

        // Cannot execute before delay
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // Advance time past delay
        await time.increase(DELAY);

        // Execute the upgrade
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(newImplAddr);
        expect(implAfter).to.not.equal(implBefore);

        // Contract still functional
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });

    it("full mainnet handover: escrow + registry both timelock-owned, deployer renounces DEFAULT_ADMIN_ROLE", async () => {
        const { escrow, registry, owner } = await deployBase();

        const Timelock = await ethers.getContractFactory("TimelockController");
        const timelock = await Timelock.deploy(
            3600,                 // 1 h delay (mainnet will use 48 h)
            [owner.address],      // proposer
            [ethers.ZeroAddress], // executor (anyone)
            owner.address,        // initial admin (will be renounced)
        );
        const timelockAddr = await timelock.getAddress();

        // Transfer escrow ownership to timelock
        await escrow.connect(owner).transferOwnership(timelockAddr);
        expect(await escrow.owner()).to.equal(timelockAddr);

        // Transfer registry ownership to timelock
        await registry.connect(owner).transferOwnership(timelockAddr);
        expect(await registry.owner()).to.equal(timelockAddr);

        // Deployer renounces DEFAULT_ADMIN_ROLE -- no more privileged timelock admin
        const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
        await timelock.connect(owner).renounceRole(DEFAULT_ADMIN_ROLE, owner.address);
        expect(await timelock.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.false;

        // Old owner can no longer call onlyOwner functions on either contract
        await expect(
            escrow.connect(owner).setFeeRecipient(owner.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(
            registry.connect(owner).setBond(1n),
        ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
});

// =============================================================================
//  5. Owner functions post-ownership-transfer
// =============================================================================

describe("Proxy -- Owner functions post-ownership-transfer", () => {
    it("setFeeRecipient called by old owner after timelock owns contract reverts", async () => {
        const { escrow, owner, stranger } = await deployWithTimelock();

        await expect(
            escrow.connect(owner).setFeeRecipient(stranger.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
         .withArgs(owner.address);
    });

    it("setFeeRecipient called through timelock after delay succeeds", async () => {
        const DELAY = 30;
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(DELAY);

        const proxyAddr = await escrow.getAddress();
        const newRecipient = stranger.address;

        // Build setFeeRecipient calldata
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [newRecipient]);

        const salt = ethers.id("set-fee-recipient-v2");
        const predecessor = ethers.ZeroHash;

        // Schedule
        await timelock.connect(owner).schedule(
            proxyAddr,
            0,
            calldata,
            predecessor,
            salt,
            DELAY,
        );

        // Advance time past delay
        await time.increase(DELAY);

        // Execute
        await timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt);

        // Verify the fee recipient was changed
        expect(await escrow.feeRecipient()).to.equal(newRecipient);
    });

    it("setFeeRecipient through timelock before delay expires reverts", async () => {
        const DELAY = 100;
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(DELAY);

        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);

        const salt = ethers.id("set-fee-recipient-too-early");
        const predecessor = ethers.ZeroHash;

        // Schedule
        await timelock.connect(owner).schedule(
            proxyAddr, 0, calldata, predecessor, salt, DELAY,
        );

        // Try to execute immediately (before delay)
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });
});

// =============================================================================
//  6. version() bumps on upgrade
// =============================================================================

describe("Proxy -- version() bumps on upgrade", () => {
    it("version() returns '0.8' on initial deploy", async () => {
        const { escrow } = await deployBase();
        expect(await escrow.version()).to.equal("0.8");
    });

    it("version() returns '2.0.0' after upgrade to V2Safe", async () => {
        const { escrow } = await deployBase();
        const proxyAddr = await escrow.getAddress();

        // Upgrade the proxy to SLAEscrowV2Safe
        const V2SafeFactory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2SafeFactory, {
            kind: "uups",
            unsafeSkipStorageCheck: true,   // V2Safe __gap layout is a test variant
        });

        // Attach to the proxy with the V2Safe factory to access new ABI
        const v2 = V2SafeFactory.attach(proxyAddr) as Awaited<ReturnType<typeof V2SafeFactory.deploy>>;

        // version() should now return the V2Safe string
        expect(await v2.version()).to.equal("2.0.0");

        // State is still intact -- PROTOCOL_FEE_WEI persists across the upgrade
        expect(await v2.protocolFeeWei()).to.equal(0n);
    });
});

// =============================================================================
//  7. V2Safe upgrade: state preservation and known contract bugs
//     Each test is self-contained (own deployBase() call).
// =============================================================================

describe("Proxy -- V2Safe upgrade: state preservation and known contract bugs", () => {
    it("OZ upgrade checker rejects SLAEscrowV2Safe due to storage gap mismatch (bug in test V2)", async () => {
        const { escrow } = await deployBase();
        const proxyAddr = await escrow.getAddress();
        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        let rejected = false;
        try {
            await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups" });
        } catch (e: any) {
            if (e.message.includes("incompatible") || e.message.includes("storage gap")) {
                rejected = true;
            } else {
                throw e;
            }
        }
        expect(rejected).to.be.true;
    });

    it("upgrade with unsafeSkipStorageCheck succeeds and implementation address changes", async () => {
        const { escrow } = await deployBase();
        const proxyAddr = await escrow.getAddress();
        const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups", unsafeSkipStorageCheck: true });
        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.not.equal(implBefore);
    });

    it("state preserved across upgrade: deposited, nextCommitId, protocolFeeWei, feeRecipient, reservedBalance", async () => {
        const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await deployBase();
        const proxyAddr = await escrow.getAddress();

        // Create state: commit + settle
        const cid = await makeCommit(escrow, user, QUOTE_ID, "v2-state-preservation");
        await escrow.connect(bundler).settle(cid);

        const depositedBefore   = await escrow.deposited(bundler.address);
        const nextCommitBefore  = await escrow.nextCommitId();
        const protocolFeeBefore = await escrow.protocolFeeWei();
        const feeRecipBefore    = await escrow.feeRecipient();
        const reservedBefore    = await escrow.reservedBalance();

        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups", unsafeSkipStorageCheck: true });
        const v2 = V2Factory.attach(proxyAddr) as any;

        expect(await v2.deposited(bundler.address)).to.equal(depositedBefore);
        expect(await v2.nextCommitId()).to.equal(nextCommitBefore);
        expect(await v2.protocolFeeWei()).to.equal(protocolFeeBefore);
        expect(await v2.feeRecipient()).to.equal(feeRecipBefore);
        expect(await v2.reservedBalance()).to.equal(reservedBefore);
    });

    it("historical commit data intact after upgrade to V2Safe", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deployBase();
        const proxyAddr = await escrow.getAddress();

        const cid = await makeCommit(escrow, user, QUOTE_ID, "v2-history");
        await escrow.connect(bundler).settle(cid);

        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups", unsafeSkipStorageCheck: true });
        const v2 = V2Factory.attach(proxyAddr) as any;

        const c = await v2.commits(cid);
        expect(c.settled).to.be.true;
        expect(c.user).to.equal(user.address);
        expect(c.bundler).to.equal(bundler.address);
    });

    it("V2Safe extraField is 0 after upgrade and can be set by owner", async () => {
        const { escrow, owner } = await deployBase();
        const proxyAddr = await escrow.getAddress();
        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups", unsafeSkipStorageCheck: true });
        const v2 = V2Factory.attach(proxyAddr) as any;

        expect(await v2.extraField()).to.equal(0n);
        await v2.connect(owner).setExtraField(42n);
        expect(await v2.extraField()).to.equal(42n);
    });

    it("contract remains functional after upgrade: commit + settle succeeds on V2Safe", async () => {
        // V2Safe is single-phase (no accept()) -- commit() directly creates active commit.
        const { escrow, registry, bundler, user, QUOTE_ID } = await deployBase();
        const proxyAddr = await escrow.getAddress();
        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups", unsafeSkipStorageCheck: true });
        const v2 = V2Factory.attach(proxyAddr) as any;

        // Deposit extra collateral (V2Safe deposit() has the known bug but we only need one commit)
        const idle = await v2.idleBalance(bundler.address);
        if (idle < COLLATERAL) await v2.connect(bundler).deposit({ value: COLLATERAL });

        const offer = await registry.getOffer(QUOTE_ID);
        const hash = ethers.keccak256(ethers.toUtf8Bytes("v2-functional"));
        const tx = await v2.connect(user).commit(QUOTE_ID, hash, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
        const receipt = await tx.wait();
        let cid: bigint | undefined;
        for (const log of receipt!.logs) {
            try {
                const parsed = v2.interface.parseLog(log);
                if (parsed?.name === "CommitCreated") { cid = parsed.args.commitId as bigint; break; }
            } catch {}
        }
        await v2.connect(bundler).settle(cid!);
        const c = await v2.commits(cid!);
        expect(c.settled).to.be.true;
    });

    it("FINDING: V2Safe deposit() does not update reservedBalance (bug in test V2, not in V1)", async () => {
        const { escrow, bundler } = await deployBase();
        const proxyAddr = await escrow.getAddress();
        const V2Factory = await ethers.getContractFactory("SLAEscrowV2Safe");
        await upgrades.upgradeProxy(proxyAddr, V2Factory, { kind: "uups", unsafeSkipStorageCheck: true });
        const v2 = V2Factory.attach(proxyAddr) as any;

        const reservedBefore = await v2.reservedBalance();
        const balanceBefore  = await ethers.provider.getBalance(proxyAddr);
        const extra = COLLATERAL;

        await v2.connect(bundler).deposit({ value: extra });

        const reservedAfter = await v2.reservedBalance();
        const balanceAfter  = await ethers.provider.getBalance(proxyAddr);

        expect(balanceAfter - balanceBefore).to.equal(extra);    // balance grew
        expect(reservedAfter).to.equal(reservedBefore);          // reservedBalance did NOT grow (bug)
        expect(balanceAfter - reservedAfter).to.equal(           // gap == extra (consequence of bug)
            (balanceBefore - reservedBefore) + extra,
        );
    });
});
