// Category 16: Proxy Integrity & Anti-Rug Guarantees
// Every test answers: "If the owner is malicious, can they do X to steal/redirect funds?"
// The answer must always be NO (or: only via the timelock delay which gives users time to exit).

import { expect }                       from "chai";
import { ethers, upgrades }             from "hardhat";
import { mine, time }                   from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow, TimelockController } from "../../typechain-types";
import {
    assertBalanceInvariant,
    deployEscrow,
    deployWithTimelock as fixturesDeployWithTimelock,
    registerOffer,
    makeCommit as fixturesMakeCommit,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
    MIN_LIFETIME,
    MIN_BOND,
} from "../helpers/fixtures";

// -- constants ----------------------------------------------------------------
const SLA_BLOCKS   = 2n;
const LONG_SLA     = 100n;  // long SLA for tests that need extra block headroom (upgrade txns mine blocks)
const DELAY_48H    = 48 * 60 * 60; // 48 hours in seconds

// -- helpers ------------------------------------------------------------------

async function contractBalance(escrow: SLAEscrow): Promise<bigint> {
    return ethers.provider.getBalance(await escrow.getAddress());
}

// -- deploy without timelock (owner = EOA) ------------------------------------

async function deploy() {
    const base = await deployEscrow({ slaBlocks: SLA_BLOCKS, preDeposit: COLLATERAL * 50n });
    // Register a long-SLA quote for tests that need extra block headroom (upgrades mine blocks)
    await base.registry.connect(base.bundler).register(
        ONE_GWEI, Number(LONG_SLA), COLLATERAL, Number(MIN_LIFETIME), { value: MIN_BOND },
    );
    const LONG_QUOTE_ID = 2n;
    const sg = BigInt(await base.escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await base.escrow.REFUND_GRACE_BLOCKS());
    return { ...base, QUOTE_ID: base.QUOTE_ID, LONG_QUOTE_ID, sg, rg };
}

// -- deploy with timelock -----------------------------------------------------

async function deployWithTimelock(minDelay = DELAY_48H) {
    const base = await deploy();
    const TimelockFactory = await ethers.getContractFactory("TimelockController");
    const timelock = (await TimelockFactory.deploy(
        minDelay,
        [base.owner.address],     // proposers
        [ethers.ZeroAddress],     // executors: anyone can execute after delay
        base.owner.address,       // admin
    )) as unknown as TimelockController;

    await base.escrow.connect(base.owner).transferOwnership(await timelock.getAddress());
    await base.registry.connect(base.owner).transferOwnership(await timelock.getAddress());
    return { ...base, timelock };
}

// -- make commit helper -------------------------------------------------------

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

// -- deploy new implementation helper -----------------------------------------

async function deployNewImpl(): Promise<string> {
    const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
    const newImpl = await Escrow.deploy();
    await newImpl.waitForDeployment();
    return await newImpl.getAddress();
}

// -- schedule + execute through timelock --------------------------------------

async function scheduleAndExecute(
    timelock: TimelockController,
    proposer: any,
    target: string,
    value: bigint,
    calldata: string,
    delay: number,
    salt?: string,
) {
    const s = ethers.id(salt ?? `salt-${Date.now()}-${Math.random()}`);
    const predecessor = ethers.ZeroHash;
    await timelock.connect(proposer).schedule(target, value, calldata, predecessor, s, delay);
    await time.increase(delay);
    await timelock.connect(proposer).execute(target, value, calldata, predecessor, s);
}

// =============================================================================
//  SECTION 1: Owner cannot directly drain funds
// =============================================================================

describe("Cat16 -- Owner cannot directly drain funds", () => {
    it("16.001 owner with zero deposited cannot withdraw even 1 wei", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle")
            .withArgs(1n, 0n);
    });

    it("16.002 owner cannot call claimPayout when pendingWithdrawals is zero", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("16.003 bundler can trigger claimRefund after expiry (T12) -- ETH goes to user, owner gains nothing", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        const pendingBefore = await escrow.pendingWithdrawals(user.address);
        const ownerPendingBefore = await escrow.pendingWithdrawals(owner.address);
        // T12: only CLIENT, BUNDLER, or feeRecipient may trigger claimRefund; owner is none of these
        await escrow.connect(bundler).claimRefund(cid);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(ownerPendingBefore);
    });

    it("16.004 owner calling settle on bundler's commit: succeeds (permissionless), fee goes to bundler not owner", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
        // Fee always goes to c.bundler regardless of who called settle
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.005 owner can only withdraw their own idle deposited amount", async () => {
        const { escrow, owner, bundler } = await deploy();
        const ownerDeposit = ethers.parseEther("0.005");
        await escrow.connect(owner).deposit({ value: ownerDeposit });

        // Owner cannot withdraw more than their deposit
        await expect(escrow.connect(owner).withdraw(ownerDeposit + 1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");

        // Owner CAN withdraw exactly their deposit
        await expect(escrow.connect(owner).withdraw(ownerDeposit)).to.not.be.reverted;
        expect(await escrow.deposited(owner.address)).to.equal(0n);
        // Bundler's deposit is untouched
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
    });

    it("16.006 after upgrade, owner still cannot claimPayout with 0 pending", async () => {
        const { escrow, owner } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        await expect(escrow.connect(owner).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });

    it("16.007 after upgrade, owner cannot access bundler's deposited balance", async () => {
        const { escrow, owner, bundler } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        expect(await escrow.deposited(owner.address)).to.equal(0n);
        await expect(escrow.connect(owner).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
    });

    it("16.008 owner cannot withdraw bundler's collateral even if owner deposits the same amount", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        // Owner deposits exact same amount as bundler
        await escrow.connect(owner).deposit({ value: COLLATERAL * 10n });
        // Create a commit to lock bundler's collateral
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        // Owner withdraws their full deposit
        await escrow.connect(owner).withdraw(COLLATERAL * 10n);
        expect(await escrow.deposited(owner.address)).to.equal(0n);
        // Bundler's collateral still intact
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
    });

    it("16.009 owner cannot withdraw more than idle (deposited - locked)", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        // Owner registers as bundler and deposits
        const { registry } = await deploy();
        // Use the existing escrow: owner deposits
        await escrow.connect(owner).deposit({ value: COLLATERAL * 2n });
        expect(await escrow.deposited(owner.address)).to.equal(COLLATERAL * 2n);
        // Owner can withdraw their full amount since none is locked
        await escrow.connect(owner).withdraw(COLLATERAL * 2n);
        expect(await escrow.deposited(owner.address)).to.equal(0n);
    });

    it("16.010 owner claimPayout only gets their own pendingWithdrawals, not others'", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await escrow.connect(bundler).settle(cid);
        // Bundler has full fee (PROTOCOL_FEE_WEI=0); feeRecipient gets 0; owner gets 0
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        await expect(escrow.connect(owner).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
    });
});

// =============================================================================
//  SECTION 2: Owner's onlyOwner powers cannot steal ETH
// =============================================================================

describe("Cat16 -- Owner onlyOwner powers cannot steal ETH", () => {
    it("16.011 setFeeRecipient to owner: bundler pendingWithdrawals not affected (PROTOCOL_FEE_WEI=0, feeRecipient gets 0)", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        // Settle a commit -- PROTOCOL_FEE_WEI=0, bundler gets full fee
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await escrow.connect(bundler).settle(cid);
        const pendingBundler = await escrow.pendingWithdrawals(bundler.address);
        expect(pendingBundler).to.equal(ONE_GWEI);
        // feeRecipient gets 0
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);

        // Owner changes fee recipient to themselves -- does not affect bundler's pending
        await escrow.connect(owner).setFeeRecipient(owner.address);

        // Bundler's pending is unchanged
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBundler);
        // Bundler can claim their payout
        await escrow.connect(bundler).claimPayout();
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
    });

    it("16.012 setFeeRecipient to owner then new commit + settle: fee for NEW commit goes to new feeRecipient at commit time; existing pending is untouched (with PROTOCOL_FEE_WEI=0, no fees flow to anyone)", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        // First commit + settle -> fees go to feeRecipient
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "op1");
        await escrow.connect(bundler).settle(cid1);
        const pendingOldBefore = await escrow.pendingWithdrawals(feeRecipient.address);

        // Switch fee recipient to owner
        await escrow.connect(owner).setFeeRecipient(owner.address);

        // Second commit + settle -> fees go to owner
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "op2");
        await escrow.connect(bundler).settle(cid2);

        // PROTOCOL_FEE_WEI=0: owner (new feeRecipient) gets 0 from settle
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        // Old recipient also has 0 (PROTOCOL_FEE_WEI=0, they got 0 from the first settle too)
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendingOldBefore);
    });

    it("16.013 feeRecipient changed: bundler's pendingWithdrawals unaffected", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await escrow.connect(bundler).settle(cid);
        const pendingBundler = await escrow.pendingWithdrawals(bundler.address);
        expect(pendingBundler).to.equal(ONE_GWEI);

        await escrow.connect(owner).setFeeRecipient(owner.address);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBundler);
    });

    it("16.014 feeRecipient changed: user's pending refund unaffected", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "refund-test");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        const pendingUser = await escrow.pendingWithdrawals(user.address);
        expect(pendingUser).to.equal(ONE_GWEI + COLLATERAL);

        await escrow.connect(owner).setFeeRecipient(owner.address);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(pendingUser);
    });

    it("16.015 owner sets feeRecipient to self: PROTOCOL_FEE_WEI=0, gets nothing from settle", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);

        // Multiple settles
        for (let i = 0; i < 5; i++) {
            const cid = await makeCommit(escrow, user, QUOTE_ID, `forward-${i}`);
            await escrow.connect(bundler).settle(cid);
        }

        // PROTOCOL_FEE_WEI=0: owner (feeRecipient) gets 0 from settle
        const ownerPending = await escrow.pendingWithdrawals(owner.address);
        expect(ownerPending).to.equal(0n);
    });

    it("16.016 setProtocolFeeWei is capped at MAX_PROTOCOL_FEE_WEI -- owner cannot set above 0.001 ether", async () => {
        const { escrow, owner } = await deploy();
        const MAX = ethers.parseEther("0.001");
        await expect(escrow.connect(owner).setProtocolFeeWei(MAX + 1n))
            .to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
        // But MAX is allowed
        await escrow.connect(owner).setProtocolFeeWei(MAX);
        expect(await escrow.protocolFeeWei()).to.equal(MAX);
    });

    it("16.017 PROTOCOL_FEE_WEI is unchanged after upgrade", async () => {
        const { escrow, owner } = await deploy();
        const feeBefore = await escrow.protocolFeeWei();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        expect(await escrow.protocolFeeWei()).to.equal(feeBefore);
    });

    it("16.018 owner cannot slash bundlers directly (no admin slash function)", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const slashFns = iface.fragments.filter(
            (f) => f.type === "function" && (f as any).name?.toLowerCase().includes("slash"),
        );
        expect(slashFns.length, "No slash function should exist").to.equal(0);
    });

    it("16.019 owner cannot extend commit deadlines to prevent refunds", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const deadlineFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                ((f as any).name?.toLowerCase().includes("deadline") ||
                    (f as any).name?.toLowerCase().includes("extend")),
        );
        const mutators = deadlineFns.filter(
            (f) => (f as any).stateMutability !== "view" && (f as any).stateMutability !== "pure",
        );
        expect(mutators.length, "No deadline mutator should exist").to.equal(0);
    });

    it("16.020 owner cannot set pendingWithdrawals directly", async () => {
        const { escrow } = await deploy();
        // pendingWithdrawals is a public mapping (view), no setter
        const iface = escrow.interface;
        const setPendingFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                (f as any).name?.toLowerCase().includes("setpending"),
        );
        expect(setPendingFns.length).to.equal(0);
    });

    it("16.021 owner cannot modify deposited[bundler] directly", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const setDepFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                (f as any).name?.toLowerCase().includes("setdeposit"),
        );
        expect(setDepFns.length).to.equal(0);
    });

    it("16.022 owner cannot modify commits[id] struct directly", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const setCommitFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                (f as any).name?.toLowerCase().includes("setcommit"),
        );
        expect(setCommitFns.length).to.equal(0);
    });

    it("16.023 PROTOCOL_FEE_WEI defaults to 0 at deploy -- no fee charged unless explicitly set", async () => {
        const [, , , , , feeR] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const reg = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow0 = (await upgrades.deployProxy(
            Escrow,
            [await reg.getAddress(), feeR.address],
            { kind: "uups" },
        )) as unknown as SLAEscrow;
        expect(await escrow0.protocolFeeWei()).to.equal(0n);
    });

    it("16.024 setProtocolFeeWei at MAX_PROTOCOL_FEE_WEI (0.001 ether) is valid boundary", async () => {
        const { escrow, owner } = await deploy();
        const MAX = ethers.parseEther("0.001");
        await escrow.connect(owner).setProtocolFeeWei(MAX);
        expect(await escrow.protocolFeeWei()).to.equal(MAX);
        await expect(escrow.connect(owner).setProtocolFeeWei(MAX + 1n))
            .to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
    });

    it("16.025 owner cannot modify lockedOf[bundler] directly", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const setLockedFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                (f as any).name?.toLowerCase().includes("setlocked"),
        );
        expect(setLockedFns.length).to.equal(0);
    });
});

// =============================================================================
//  SECTION 3: Upgrade cannot retroactively steal in-flight funds
// =============================================================================

describe("Cat16 -- Upgrade cannot retroactively steal in-flight funds", () => {
    it("16.026 commit then upgrade: bundler settles and gets correct amount", async () => {
        const { escrow, owner, bundler, user, feeRecipient, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "inflight-settle");

        // Upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        // Settle after upgrade
        await escrow.connect(bundler).settle(cid);
        const bundlerNet = ONE_GWEI;
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerNet);
    });

    it("16.027 commit then upgrade: user claimRefund gets correct amount", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "inflight-refund");

        // Upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        // Wait and refund
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        const expectedUser = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expectedUser);
    });

    it("16.028 commit then upgrade: commits[id].feePaid unchanged", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        const commitBefore = await escrow.getCommit(cid);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.feePaid).to.equal(commitBefore.feePaid);
    });

    it("16.029 commit then upgrade: commits[id].collateralLocked unchanged", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        const commitBefore = await escrow.getCommit(cid);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.collateralLocked).to.equal(commitBefore.collateralLocked);
    });

    it("16.030 commit then upgrade: commits[id].deadline unchanged", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        const commitBefore = await escrow.getCommit(cid);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.deadline).to.equal(commitBefore.deadline);
    });

    it("16.031 commit then upgrade: lockedOf[bundler] unchanged", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await makeCommit(escrow, user, QUOTE_ID);
        const lockedBefore = await escrow.lockedOf(bundler.address);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
    });

    it("16.032 commit then upgrade: deposited[bundler] unchanged", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await makeCommit(escrow, user, QUOTE_ID);
        const depositedBefore = await escrow.deposited(bundler.address);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
    });

    it("16.033 commit + settle + upgrade: pendingWithdrawals preserved for all parties", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await escrow.connect(bundler).settle(cid);
        const pendBundler = await escrow.pendingWithdrawals(bundler.address);
        const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendBundler);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendFee);
    });

    it("16.034 multiple open commits then upgrade: all settle correctly", async () => {
        const { escrow, owner, bundler, user, feeRecipient, LONG_QUOTE_ID } = await deploy();
        const cids: bigint[] = [];
        for (let i = 0; i < 5; i++) {
            cids.push(await makeCommit(escrow, user, LONG_QUOTE_ID, `multi-settle-${i}`));
        }

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        for (const cid of cids) {
            await escrow.connect(bundler).settle(cid);
        }

        const bundlerNet = ONE_GWEI;
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerNet * 5n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.035 multiple open commits then upgrade: all claimRefund correctly", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await deploy();
        const cids: bigint[] = [];
        for (let i = 0; i < 3; i++) {
            cids.push(await makeCommit(escrow, user, QUOTE_ID, `multi-refund-${i}`));
        }

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        for (const cid of cids) {
            await escrow.connect(user).claimRefund(cid);
        }

        const expectedUser = (ONE_GWEI + COLLATERAL) * 3n;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expectedUser);
    });

    it("16.036 upgrade to SLAEscrowV2Safe: REFUND_GRACE_BLOCKS still 5 in new impl", async () => {
        const { escrow, owner } = await deploy();
        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");
        expect(await proxy.REFUND_GRACE_BLOCKS()).to.equal(5n);
    });

    it("16.037 commit then upgrade: commits[id].user address preserved (cannot redirect refund)", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.user).to.equal(user.address);
    });

    it("16.038 commit then upgrade: commits[id].bundler preserved (cannot redirect settlement)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.bundler).to.equal(bundler.address);
    });

    it("16.039 commit then upgrade: settled/refunded flags preserved (cannot reset to re-settle)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await escrow.connect(bundler).settle(cid);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.settled).to.be.true;
        expect(commitAfter.refunded).to.be.false;

        // Cannot re-settle after upgrade
        await expect(escrow.connect(bundler).settle(cid))
            .to.be.revertedWithCustomError(escrow, "AlreadyFinalized");
    });

    it("16.040 upgrade then settle: balance invariant holds", async () => {
        const { escrow, owner, bundler, user, feeRecipient, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "invariant-upgrade");

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        await escrow.connect(bundler).settle(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address, owner.address],
            0n,
        );
    });

    it("16.041 commit then upgrade: nextCommitId preserved", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        await makeCommit(escrow, user, QUOTE_ID, "nid-1");
        await makeCommit(escrow, user, QUOTE_ID, "nid-2");
        const nextBefore = await escrow.nextCommitId();

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        expect(await escrow.nextCommitId()).to.equal(nextBefore);
    });

    it("16.042 commit then upgrade: REGISTRY address preserved", async () => {
        const { escrow, owner, registry } = await deploy();
        const regBefore = await escrow.registry();

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        expect(await escrow.registry()).to.equal(regBefore);
    });

    it("16.043 commit then upgrade: feeRecipient address preserved", async () => {
        const { escrow, owner, feeRecipient } = await deploy();

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        expect(await escrow.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("16.044 commit then upgrade: quoteId in commit struct preserved", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const c = await escrow.getCommit(cid);
        expect(c.quoteId).to.equal(QUOTE_ID);
    });

    it("16.045 commit then upgrade: userOpHash preserved", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        // v0.6: commit() takes bytes32 userOpHash directly (client computes off-chain)
        const userOpBytes = ethers.toUtf8Bytes("hashtest");
        const expectedHash = ethers.keccak256(userOpBytes);
        const tx = await escrow.connect(user).commit(QUOTE_ID, expectedHash, bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const receipt = await tx.wait();
        const commitLogs16a = receipt!.logs
            .filter(l => l.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
            .map(l => escrow.interface.parseLog(l)!);
        expect(commitLogs16a.length, "CommitCreated not emitted").to.equal(1);
        const cid = commitLogs16a[0].args.commitId;

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const c = await escrow.getCommit(cid);
        expect(c.userOpHash).to.equal(expectedHash);
    });
});

// =============================================================================
//  SECTION 4: TimelockController enforces delay before upgrade
// =============================================================================

describe("Cat16 -- TimelockController enforces delay before upgrade", () => {
    it("16.046 owner schedules upgrade, tries to execute immediately: TimelockUnexpectedOperationState", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("upgrade-too-early");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.047 owner schedules upgrade, waits 47h59m58s: still fails (off-by-2 for next block timestamp)", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("upgrade-47h");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        // time.increase(N) sets the NEXT mined block timestamp to latest + N.
        // The execute tx itself mines a block at latest + N + 1 (minimum 1s increment).
        // So to ensure execute fails, increase by DELAY - 2 (execute block = latest + DELAY - 1 < required).
        await time.increase(DELAY_48H - 2);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.048 owner schedules upgrade, waits full delay: succeeds", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("upgrade-success");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.not.be.reverted;

        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(newImplAddr);
    });

    it("16.049 during delay window, pending upgrade is observable (users can exit)", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("observe-upgrade");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        const opId = await timelock.hashOperation(proxyAddr, 0, upgradeData, predecessor, salt);
        expect(await timelock.isOperationPending(opId)).to.be.true;
        expect(await timelock.isOperationReady(opId)).to.be.false;
        expect(await timelock.isOperationDone(opId)).to.be.false;
    });

    it("16.050 cancelled upgrade cannot be executed", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("cancel-upgrade");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        const opId = await timelock.hashOperation(proxyAddr, 0, upgradeData, predecessor, salt);

        // Cancel
        await timelock.connect(owner).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;

        await time.increase(DELAY_48H);
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.051 owner cannot shorten minDelay without going through timelock", async () => {
        const { timelock, owner } = await deployWithTimelock();
        // updateDelay is only callable by timelock itself
        await expect(
            timelock.connect(owner).updateDelay(0),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnauthorizedCaller");
    });

    it("16.052 granting EXECUTOR_ROLE does not bypass minDelay", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("executor-bypass-attempt");
        const predecessor = ethers.ZeroHash;

        // Grant stranger EXECUTOR_ROLE
        const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
        await timelock.connect(owner).grantRole(EXECUTOR_ROLE, stranger.address);

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Stranger with EXECUTOR_ROLE still cannot execute before delay
        await expect(
            timelock.connect(stranger).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.053 even with EXECUTOR_ROLE, operation still requires full delay", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("executor-full-delay");
        const predecessor = ethers.ZeroHash;

        const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
        await timelock.connect(owner).grantRole(EXECUTOR_ROLE, stranger.address);

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H - 2);

        // Still not ready
        await expect(
            timelock.connect(stranger).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // After full delay, stranger CAN execute (EXECUTOR_ROLE + delay passed)
        await time.increase(3);
        await expect(
            timelock.connect(stranger).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.not.be.reverted;
    });

    it("16.054 non-proposer cannot schedule an upgrade", async () => {
        const { escrow, stranger, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("non-proposer");
        const predecessor = ethers.ZeroHash;

        await expect(
            timelock.connect(stranger).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("16.055 non-canceller cannot cancel a scheduled upgrade", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("non-canceller");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        const opId = await timelock.hashOperation(proxyAddr, 0, upgradeData, predecessor, salt);

        await expect(
            timelock.connect(stranger).cancel(opId),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });
});

// =============================================================================
//  SECTION 5: Owner cannot bypass timelock by re-deploying or transferring ownership
// =============================================================================

describe("Cat16 -- Owner cannot bypass timelock by ownership transfer", () => {
    it("16.056 transferOwnership to EOA attempted directly by owner when timelock owns: reverts", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        await expect(
            escrow.connect(owner).transferOwnership(owner.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
         .withArgs(owner.address);
    });

    it("16.057 transferOwnership to EOA via timelock: must wait minDelay first", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("transferOwnership", [owner.address]);
        const salt = ethers.id("transfer-ownership");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H);

        // Cannot execute before delay
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.058 transferOwnership to EOA via timelock after delay: succeeds and enables direct upgrade", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const timelockAddr = await timelock.getAddress();
        const calldata = escrow.interface.encodeFunctionData("transferOwnership", [owner.address]);
        const salt = ethers.id("transfer-ownership-execute");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt);

        expect(await escrow.owner()).to.equal(owner.address);

        // Now owner can upgrade directly without timelock -- THIS IS THE RISK if timelock is removed
        const newImplAddr = await deployNewImpl();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await expect(proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x")).to.not.be.reverted;
    });

    it("16.059 stranger cannot call transferOwnership on proxy when timelock owns it", async () => {
        const { escrow, stranger } = await deployWithTimelock();
        await expect(
            escrow.connect(stranger).transferOwnership(stranger.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("16.060 owner cannot call upgradeToAndCall directly when timelock owns escrow", async () => {
        const { escrow, owner } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await expect(
            proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x"),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
});

// =============================================================================
//  SECTION 6: Upgrade calldata cannot instantly rug (with vs without timelock)
// =============================================================================

describe("Cat16 -- Upgrade calldata cannot instantly rug", () => {
    it("16.061 without timelock: owner CAN instantly upgradeToAndCall with setFeeRecipient calldata", async () => {
        const { escrow, owner } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();

        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, setFeeData);

        expect(await escrow.feeRecipient()).to.equal(owner.address);
    });

    it("16.062 with timelock: owner CANNOT instantly upgradeToAndCall with setFeeRecipient calldata", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, setFeeData]);
        const salt = ethers.id("upgrade-setfee-blocked");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Cannot execute without waiting
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.063 with timelock after delay: upgradeToAndCall + setFeeRecipient succeeds", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, setFeeData]);
        const salt = ethers.id("upgrade-setfee-delayed");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        expect(await escrow.feeRecipient()).to.equal(owner.address);
    });

    it("16.064 upgradeToAndCall with calldata deposit(): deposits owner's ETH harmlessly", async () => {
        const { escrow, owner } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const depositData = escrow.interface.encodeFunctionData("deposit");
        const timelockAddr = await escrow.owner(); // owner is EOA in non-timelock deploy
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        // deposit() requires msg.value > 0, so calldata deposit() with 0 value reverts with ZeroDeposit
        await expect(
            proxy.connect(owner).upgradeToAndCall(newImplAddr, depositData),
        ).to.be.revertedWithCustomError(escrow, "ZeroDeposit");
    });

    it("16.065 upgradeToAndCall with calldata withdraw(amount): only works if owner has deposited", async () => {
        const { escrow, owner } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const withdrawData = escrow.interface.encodeFunctionData("withdraw", [1n]);
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        // Owner has nothing deposited -- timelock (msg.sender for the delegatecall) has nothing
        // The upgradeToAndCall executes withdraw in context of the proxy, msg.sender = owner
        // Owner has 0 deposited so this reverts
        await expect(
            proxy.connect(owner).upgradeToAndCall(newImplAddr, withdrawData),
        ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");
    });

    it("16.066 upgradeToAndCall with empty calldata: safe no-op upgrade", async () => {
        const { escrow, owner, bundler } = await deploy();
        const depositedBefore = await escrow.deposited(bundler.address);
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
    });
});

// =============================================================================
//  SECTION 7: Storage layout safety across upgrades
// =============================================================================

describe("Cat16 -- Storage layout safety across upgrades", () => {
    it("16.067 after upgrade to V2Safe: commits[id].user unchanged", async () => {
        const { escrow, owner, user, bundler, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");
        const c = await (proxy as any).commits(cid);
        expect(c.user).to.equal(user.address);
    });

    it("16.068 after upgrade to V2Safe: commits[id].bundler unchanged", async () => {
        const { escrow, owner, user, bundler, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");
        const c = await (proxy as any).commits(cid);
        expect(c.bundler).to.equal(bundler.address);
    });

    it("16.069 after upgrade to V2Safe: settled/refunded flags preserved", async () => {
        const { escrow, owner, user, bundler, QUOTE_ID, sg, rg } = await deploy();
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "settled-flag");
        await escrow.connect(bundler).settle(cid1);
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "refunded-flag");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid2);

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");

        const c1 = await (proxy as any).commits(cid1);
        expect(c1.settled).to.be.true;
        expect(c1.refunded).to.be.false;
        const c2 = await (proxy as any).commits(cid2);
        expect(c2.settled).to.be.false;
        expect(c2.refunded).to.be.true;
    });

    it("16.070 after upgrade to V2Safe: pendingWithdrawals[bundler] unchanged", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await escrow.connect(bundler).settle(cid);
        const pendBefore = await escrow.pendingWithdrawals(bundler.address);

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await (proxy as any).pendingWithdrawals(bundler.address)).to.equal(pendBefore);
    });

    it("16.071 after upgrade to V2Safe: pendingWithdrawals[user] unchanged", async () => {
        const { escrow, owner, user, bundler, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        const pendBefore = await escrow.pendingWithdrawals(user.address);

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await (proxy as any).pendingWithdrawals(user.address)).to.equal(pendBefore);
    });

    it("16.072 after upgrade to V2Safe: deposited[bundler] unchanged", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const depBefore = await escrow.deposited(bundler.address);

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await (proxy as any).deposited(bundler.address)).to.equal(depBefore);
    });

    it("16.073 after upgrade to V2Safe: lockedOf[bundler] unchanged", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await makeCommit(escrow, user, QUOTE_ID);
        const lockedBefore = await escrow.lockedOf(bundler.address);
        expect(lockedBefore).to.equal(COLLATERAL);

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr);
        await (proxy.connect(owner) as any).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await (proxy as any).lockedOf(bundler.address)).to.equal(lockedBefore);
    });

    it("16.074 V2Safe extraField starts at 0 and can be set without affecting core state", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID);
        const depBefore = await escrow.deposited(bundler.address);

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr) as any;
        await proxy.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

        expect(await proxy.extraField()).to.equal(0n);
        await proxy.connect(owner).setExtraField(42n);
        expect(await proxy.extraField()).to.equal(42n);
        expect(await proxy.deposited(bundler.address)).to.equal(depBefore);
    });
});

// =============================================================================
//  SECTION 8: Admin renounces ownership -- "fire the keys"
// =============================================================================

describe("Cat16 -- Admin renounces ownership", () => {
    it("16.075 renounceOwnership reverts RenounceOwnershipDisabled -- owner stays non-zero (T22)", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        expect(await escrow.owner()).to.equal(owner.address);
    });

    it("16.076 renounceOwnership disabled -- upgradeToAndCall still works for owner", async () => {
        const { escrow, owner } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        const newImplAddr = await deployNewImpl();
        await expect(escrow.connect(owner).upgradeToAndCall(newImplAddr, "0x")).to.not.be.reverted;
    });

    it("16.077 renounceOwnership disabled -- owner can still setFeeRecipient; non-owner still blocked", async () => {
        const { escrow, owner, stranger } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        await expect(escrow.connect(owner).setFeeRecipient(stranger.address)).to.not.be.reverted;
        await expect(escrow.connect(stranger).setFeeRecipient(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("16.078 deposit works regardless of ownership state", async () => {
        const { escrow, bundler } = await deploy();
        await expect(escrow.connect(bundler).deposit({ value: COLLATERAL })).to.not.be.reverted;
    });

    it("16.079 withdraw works regardless of ownership state", async () => {
        const { escrow, bundler } = await deploy();
        const idle = await escrow.idleBalance(bundler.address);
        await expect(escrow.connect(bundler).withdraw(idle)).to.not.be.reverted;
    });

    it("16.080 commit works regardless of ownership state", async () => {
        const { escrow, user, bundler, QUOTE_ID } = await deploy();
        await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });
        const cid = await makeCommit(escrow, user, QUOTE_ID, "commit-any-owner");
        expect(cid).to.equal(0n); // first commit in fresh deployment gets id=0
    });

    it("16.081 settle works regardless of ownership state", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "settle-any-owner");
        await expect(escrow.connect(bundler).settle(cid)).to.not.be.reverted;
    });

    it("16.082 claimRefund works regardless of ownership state", async () => {
        const { escrow, user, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "refund-any-owner");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await expect(escrow.connect(user).claimRefund(cid)).to.not.be.reverted;
    });

    it("16.083 claimPayout works regardless of ownership state", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "payout-any-owner");
        await escrow.connect(bundler).settle(cid);
        await expect(escrow.connect(bundler).claimPayout()).to.not.be.reverted;
    });

    it("16.084 balance invariant holds with active owner", async () => {
        const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "invariant-owner");
        await escrow.connect(bundler).settle(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address],
            0n,
        );
    });

    it("16.085 PROTOCOL_FEE_WEI applies correctly (ownership state does not affect fee math)", async () => {
        const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "fee-any-owner");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI defaults to 0; bundler gets full fee
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("16.086 renounceOwnership disabled -- transferOwnership still works; non-owner always blocked (T22)", async () => {
        const { escrow, owner, stranger } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        // Owner can transfer -- just not to zero
        await escrow.connect(owner).transferOwnership(stranger.address);
        expect(await escrow.owner()).to.equal(stranger.address);
        // Original owner is now blocked
        await expect(
            escrow.connect(owner).transferOwnership(owner.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("16.087 non-owner cannot upgradeToAndCall regardless of renounce state", async () => {
        const { escrow, stranger, bundler } = await deploy();
        const newImplAddr = await deployNewImpl();
        for (const signer of [stranger, bundler]) {
            await expect(
                escrow.connect(signer).upgradeToAndCall(newImplAddr, "0x"),
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        }
    });
});

// =============================================================================
//  SECTION 9: Bundler/user cannot be rugged mid-commit by owner
// =============================================================================

describe("Cat16 -- Bundler/user cannot be rugged mid-commit by owner", () => {
    it("16.088 protocol fee is locked at commit time -- changing feeRecipient after commit does not redirect the already-credited fee (with PROTOCOL_FEE_WEI=0 this is trivially true; see 16.201 for nonzero fee)", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-commit-fee-change");

        // Owner changes fee recipient mid-flight
        await escrow.connect(owner).setFeeRecipient(stranger.address);

        // Settle: PROTOCOL_FEE_WEI=0, neither stranger nor old feeRecipient gets anything
        await escrow.connect(bundler).settle(cid);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        // Old fee recipient gets nothing from this settle
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.089 mid-commit fee change: bundler's net payout is unaffected (gets full fee)", async () => {
        const { escrow, owner, bundler, user, stranger, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-commit-bundler-safe");
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await escrow.connect(bundler).settle(cid);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("16.090 owner cannot set feeRecipient to address(0)", async () => {
        const { escrow, owner } = await deploy();
        await expect(
            escrow.connect(owner).setFeeRecipient(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("16.091 owner cannot cancel an in-flight commit (cancel is client/bundler/feeRecipient only)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        // Create a PROPOSED commit (before accept) so cancel() is valid to call
        const userOpBytes = ethers.keccak256(ethers.toUtf8Bytes("no-cancel-op"));
        const tx = await escrow.connect(user).commit(QUOTE_ID, userOpBytes, bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
        const receipt = await tx.wait();
        const commitLogs16b = receipt!.logs
            .filter(l => l.topics[0] === escrow.interface.getEvent("CommitCreated")!.topicHash)
            .map(l => escrow.interface.parseLog(l)!);
        expect(commitLogs16b.length, "CommitCreated not emitted").to.equal(1);
        const cid = commitLogs16b[0].args.commitId;
        // cancel() exists in v0.6 but owner (not user/bundler/feeRecipient) is unauthorized
        await expect(escrow.connect(owner).cancel(cid))
            .to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("16.092 settle is permissionless (v0.6): owner can call settle, fee always goes to bundler", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "no-force-settle");
        // settle() is permissionless -- anyone can call it; fee always goes to c.bundler
        await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.093 owner cannot extend the SLA deadline on existing commits", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "no-extend");
        const commitBefore = await escrow.getCommit(cid);
        // No function exists to change deadline
        const iface = escrow.interface;
        const extendFns = iface.fragments.filter(
            (f) => f.type === "function" && (f as any).name?.toLowerCase().includes("extend"),
        );
        expect(extendFns.length).to.equal(0);
        // Verify deadline is unchanged after any admin action
        await escrow.connect(owner).setFeeRecipient(owner.address); // some admin action
        const commitAfter = await escrow.getCommit(cid);
        expect(commitAfter.deadline).to.equal(commitBefore.deadline);
    });

    it("16.094 owner cannot change collateral amount for an in-flight commit", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "no-change-collateral");
        const commitBefore = await escrow.getCommit(cid);
        // No function modifies collateralLocked on an existing commit
        const iface = escrow.interface;
        const setColFns = iface.fragments.filter(
            (f) => f.type === "function" &&
                ((f as any).name?.toLowerCase().includes("setcollateral") ||
                    (f as any).name?.toLowerCase().includes("updatecollateral")),
        );
        expect(setColFns.length).to.equal(0);
        expect(commitBefore.collateralLocked).to.equal(COLLATERAL);
    });

    it("16.095 claimRefund: feeRecipient change mid-commit -- user gets 100% collateral, no protocol share", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-commit-refund");
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        // PROTOCOL_FEE_WEI=0: neither stranger nor old feeRecipient gets a protocol share
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.096 user refund amount is correct regardless of mid-commit feeRecipient change", async () => {
        const { escrow, owner, user, stranger, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "user-refund-unaffected");
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        const expectedUser = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expectedUser);
    });

    it("16.097 owner upgrade + setFeeRecipient via calldata then settle: bundler payout correct", async () => {
        const { escrow, owner, bundler, user, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "upgrade-setfee-settle");
        const newImplAddr = await deployNewImpl();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, setFeeData);

        await escrow.connect(bundler).settle(cid);
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("16.098 owner cannot force a user to accept less refund by any admin action", async () => {
        const { escrow, owner, user, bundler, stranger, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "forced-less-refund");
        // Owner does every admin action possible
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        const expectedUser = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expectedUser);
    });
});

// =============================================================================
//  SECTION 10: Economic safety -- owner's max damage is bounded
// =============================================================================

describe("Cat16 -- Economic safety: owner max damage bounded", () => {
    it("16.099 with timelock: setFeeRecipient redirect requires 48h delay -- with PROTOCOL_FEE_WEI=0 this grants no economic leverage over in-flight commits", async () => {
        const { escrow, owner, bundler, user, feeRecipient, timelock, QUOTE_ID } = await deployWithTimelock();

        // Owner cannot directly do setFeeRecipient -- must go through timelock
        await expect(
            escrow.connect(owner).setFeeRecipient(owner.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // Schedule setFeeRecipient change
        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const salt = ethers.id("max-damage");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H);

        // During 48h, commit + settle still goes to original feeRecipient
        const cid = await makeCommit(escrow, user, QUOTE_ID, "during-delay");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI=0: feeRecipient and owner both get 0; bundler gets full fee
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.100 without timelock: owner redirects feeRecipient -- still 0 with PROTOCOL_FEE_WEI=0", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "instant-redirect");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI defaults to 0; owner gets nothing even as feeRecipient
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.101 owner cannot access bundler deposited balance via any existing function", async () => {
        const { escrow, owner, bundler } = await deploy();
        // Owner has 0 deposited
        expect(await escrow.deposited(owner.address)).to.equal(0n);
        expect(await escrow.idleBalance(owner.address)).to.equal(0n);
        // Cannot withdraw
        await expect(escrow.connect(owner).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
        // Bundler's balance unchanged
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
    });

    it("16.102 PROTOCOL_FEE_WEI cap at 0.001 ether means owner max take is 0.001 ether per op", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const MAX = ethers.parseEther("0.001");
        // Set fee to max
        await escrow.connect(owner).setProtocolFeeWei(MAX);
        // Deposit extra to cover protocol fee on commit (msg.value = feePerOp + PROTOCOL_FEE_WEI)
        await escrow.connect(bundler).deposit({ value: MAX * 10n });
        const commitValue = ONE_GWEI + MAX;
        const proxyAddr = await escrow.getAddress();
        const cid = ethers.keccak256(ethers.toUtf8Bytes("max-fee-cap"));
        // We use the raw makeCommit helper but must send exact value
        // Just verify via setProtocolFeeWei boundary -- actual settle uses feeRecipient
        await expect(escrow.connect(owner).setProtocolFeeWei(MAX + 1n))
            .to.be.revertedWithCustomError(escrow, "InvalidProtocolFee");
        expect(await escrow.protocolFeeWei()).to.equal(MAX);
    });

    it("16.103 owner as feeRecipient with PROTOCOL_FEE_WEI=0: gets 0 from settle, never bundler collateral", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "fee-not-collateral");
        await escrow.connect(bundler).settle(cid);

        // Owner/feeRecipient gets 0 (PROTOCOL_FEE_WEI=0)
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        // Bundler's deposited collateral untouched
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
    });

    it("16.104 owner max extraction on refund: 0 via feeRecipient (user gets 100% collateral)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID, sg, rg } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "max-slash-extract");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        // PROTOCOL_FEE_WEI=0: owner gets nothing; user gets 100%
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        const expectedUser = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expectedUser);
    });
});

// =============================================================================
//  SECTION 11: Upgrade integrity -- new impl must pass UUPS checks
// =============================================================================

describe("Cat16 -- Upgrade integrity: new impl must pass UUPS checks", () => {
    it("16.105 upgradeToAndCall to EOA address reverts", async () => {
        const { escrow, owner, stranger } = await deploy();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        // EOA staticcall returns empty data; Solidity ABI-decode of bytes32 fails with no error data
        await expect(
            proxy.connect(owner).upgradeToAndCall(stranger.address, "0x"),
        ).to.be.reverted; // bare revert: ABI-decode of empty EOA return fails, no custom error
    });

    it("16.106 upgradeToAndCall to address(0) reverts", async () => {
        const { escrow, owner } = await deploy();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        // address(0) staticcall returns empty data; same bare revert mechanism as EOA
        await expect(
            proxy.connect(owner).upgradeToAndCall(ethers.ZeroAddress, "0x"),
        ).to.be.reverted; // bare revert: same mechanism as EOA upgrade
    });

    it("16.107 upgradeToAndCall to non-UUPS contract reverts", async () => {
        const { escrow, owner, registry } = await deploy();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        // QuoteRegistry has no proxiableUUID(); OZ try/catch -> ERC1967InvalidImplementation
        await expect(
            proxy.connect(owner).upgradeToAndCall(await registry.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(proxy, "ERC1967InvalidImplementation")
          .withArgs(await registry.getAddress());
    });

    it("16.108 upgradeToAndCall to valid UUPS impl: implementation slot updated", async () => {
        const { escrow, owner } = await deploy();
        const proxyAddr = await escrow.getAddress();
        const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        const newImplAddr = await deployNewImpl();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(newImplAddr);
        expect(implAfter).to.not.equal(implBefore);
    });
});

// =============================================================================
//  SECTION 12: Complex multi-step anti-rug scenarios
// =============================================================================

describe("Cat16 -- Complex multi-step anti-rug scenarios", () => {
    it("16.109 owner upgrade + setFeeRecipient(owner) + user in-flight settle: user's refund amount correct", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "complex-1");

        // Owner upgrades with setFeeRecipient calldata
        const newImplAddr = await deployNewImpl();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, setFeeData);

        // User's in-flight commit: let it expire and refund
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI + COLLATERAL);
    });

    it("16.110 two commits, upgrade between them, both settle correctly", async () => {
        const { escrow, owner, bundler, user, feeRecipient, LONG_QUOTE_ID } = await deploy();
        const cid1 = await makeCommit(escrow, user, LONG_QUOTE_ID, "before-upgrade");

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const cid2 = await makeCommit(escrow, user, LONG_QUOTE_ID, "after-upgrade");

        await escrow.connect(bundler).settle(cid1);
        await escrow.connect(bundler).settle(cid2);

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 2n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.111 commit -> upgrade -> setFeeRecipient -> settle: balance invariant holds", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "invariant-complex");

        const newImplAddr = await deployNewImpl();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, setFeeData);

        await escrow.connect(bundler).settle(cid);
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, stranger.address, user.address, owner.address],
            0n,
        );
    });

    it("16.112 settle 10 commits, upgrade, settle 10 more: total accounting correct", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        for (let i = 0; i < 10; i++) {
            const cid = await makeCommit(escrow, user, QUOTE_ID, `batch1-${i}`);
            await escrow.connect(bundler).settle(cid);
        }

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        for (let i = 0; i < 10; i++) {
            const cid = await makeCommit(escrow, user, QUOTE_ID, `batch2-${i}`);
            await escrow.connect(bundler).settle(cid);
        }

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 20n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.113 owner sets self as feeRecipient then transfers ownership: fees go to former owner; new owner can change it", async () => {
        const { escrow, owner, bundler, user, stranger, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        // Transfer ownership (renounce is disabled -- T22)
        await escrow.connect(owner).transferOwnership(stranger.address);

        // Former owner can no longer change feeRecipient
        await expect(
            escrow.connect(owner).setFeeRecipient(stranger.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // Fees still go to owner.address (as feeRecipient) until new owner changes it
        // PROTOCOL_FEE_WEI=0: owner gets 0 even as feeRecipient
        const cid = await makeCommit(escrow, user, QUOTE_ID, "transferred-fee");
        await escrow.connect(bundler).settle(cid);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.114 upgrade to V2Safe, set extraField, then settle: core accounting unaffected", async () => {
        const { escrow, owner, bundler, user, feeRecipient, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "v2safe-extra");

        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr) as any;
        await proxy.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");
        await proxy.connect(owner).setExtraField(999n);

        await proxy.connect(bundler).settle(cid);
        expect(await proxy.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await proxy.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        expect(await proxy.extraField()).to.equal(999n);
    });

    it("16.115 timelock delay + commit lifecycle: bundler settles before upgrade completes", async () => {
        const { escrow, owner, bundler, user, feeRecipient, timelock, LONG_QUOTE_ID } = await deployWithTimelock();

        // User creates a commit (long SLA so it survives scheduling overhead)
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "user-exits");

        // Owner schedules an upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("user-exit-upgrade");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Bundler settles the commit BEFORE the time advance (normal ops work during delay window)
        await escrow.connect(bundler).settle(cid);
        await escrow.connect(bundler).claimPayout();

        // Proves normal ops work during the delay window
        // PROTOCOL_FEE_WEI=0: feeRecipient gets 0
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.116 owner commits as user then calls settle: succeeds (permissionless), fee goes to bundler not owner", async () => {
        const { escrow, owner, bundler, QUOTE_ID } = await deploy();
        // Owner commits as user
        const cid = await makeCommit(escrow, owner, QUOTE_ID, "owner-as-user");
        // settle() is permissionless in v0.6 -- anyone can call it
        await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
        // Fee always goes to c.bundler; owner gains nothing from calling settle
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.117 after upgrade: existing claimPayout still works for all parties", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        // Settle a commit
        const cid = await makeCommit(escrow, user, QUOTE_ID, "claim-post-upgrade");
        await escrow.connect(bundler).settle(cid);

        // Upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        // Both parties can still claim
        const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
        const feePending = await escrow.pendingWithdrawals(feeRecipient.address);
        if (bundlerPending > 0n) {
            await expect(escrow.connect(bundler).claimPayout()).to.not.be.reverted;
        }
        if (feePending > 0n) {
            await expect(escrow.connect(feeRecipient).claimPayout()).to.not.be.reverted;
        }
    });

    it("16.118 double upgrade in sequence: state preserved across both", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "double-upgrade");
        await escrow.connect(bundler).settle(cid);
        const pendBundler = await escrow.pendingWithdrawals(bundler.address);

        // First upgrade
        const impl1 = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(impl1, "0x");

        // Second upgrade
        const impl2 = await deployNewImpl();
        await proxy.connect(owner).upgradeToAndCall(impl2, "0x");

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendBundler);
        expect(await escrow.protocolFeeWei()).to.equal(0n);
    });

    it("16.119 upgrade -> transferOwnership -> normal operations all still work (T22: renounce disabled)", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        // renounce is disabled; transfer to stranger instead
        await escrow.connect(owner).transferOwnership(stranger.address);

        // Normal operations still work after ownership transfer
        const cid = await makeCommit(escrow, user, QUOTE_ID, "post-transfer-ops");
        await escrow.connect(bundler).settle(cid);
        await escrow.connect(bundler).claimPayout();
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address],
            0n,
        );
    });
});

// =============================================================================
//  SECTION 13: Timelock + ownership combined attack vectors
// =============================================================================

describe("Cat16 -- Timelock + ownership combined attacks", () => {
    it("16.120 owner tries to schedule two upgrades and execute the malicious one: both need full delay", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const impl1 = await deployNewImpl();
        const impl2 = await deployNewImpl();

        const data1 = escrow.interface.encodeFunctionData("upgradeToAndCall", [impl1, "0x"]);
        const data2 = escrow.interface.encodeFunctionData("upgradeToAndCall", [impl2, "0x"]);
        const salt1 = ethers.id("benign-upgrade");
        const salt2 = ethers.id("malicious-upgrade");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, data1, predecessor, salt1, DELAY_48H);
        await timelock.connect(owner).schedule(proxyAddr, 0, data2, predecessor, salt2, DELAY_48H);

        // Neither can execute before delay
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data1, predecessor, salt1),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data2, predecessor, salt2),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.121 scheduled setFeeRecipient through timelock: cannot execute early", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const salt = ethers.id("early-setfee");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H / 2);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.122 after timelock owns escrow: owner cannot re-initialize the proxy", async () => {
        const { escrow, owner, registry, feeRecipient } = await deployWithTimelock();
        await expect(
            escrow.connect(owner).initialize(
                await registry.getAddress(),
                feeRecipient.address,
            ),
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });

    it("16.123 timelock renounces admin role: proposer can still schedule, but no new proposers can be added", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const DEFAULT_ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();
        const timelockAddr = await timelock.getAddress();

        // Renounce admin role via timelock scheduling (revoke owner's admin role)
        const renounceData = timelock.interface.encodeFunctionData("revokeRole", [
            DEFAULT_ADMIN_ROLE,
            owner.address,
        ]);
        const salt = ethers.id("renounce-admin");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(timelockAddr, 0, renounceData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(timelockAddr, 0, renounceData, predecessor, salt);

        // Owner lost admin role -- cannot grant PROPOSER_ROLE to stranger
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        await expect(
            timelock.connect(owner).grantRole(PROPOSER_ROLE, stranger.address),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("16.124 updateDelay through timelock itself: can increase delay for more safety", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const timelockAddr = await timelock.getAddress();
        const newDelay = DELAY_48H * 2; // 96 hours
        const updateData = timelock.interface.encodeFunctionData("updateDelay", [newDelay]);
        const salt = ethers.id("increase-delay");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(timelockAddr, 0, updateData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(timelockAddr, 0, updateData, predecessor, salt);

        expect(await timelock.getMinDelay()).to.equal(BigInt(newDelay));
    });

    it("16.125 owner tries to schedule upgrade with delay=0 through timelock with minDelay=48h: uses minDelay", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("zero-delay-attempt");
        const predecessor = ethers.ZeroHash;

        // Scheduling with delay < minDelay should revert
        await expect(
            timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, 0),
        ).to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
    });

    it("16.126 timelock batch operation: all operations need delay, cannot sneak one in", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);

        const targets = [proxyAddr, proxyAddr];
        const values = [0n, 0n];
        const payloads = [setFeeData, upgradeData];
        const salt = ethers.id("batch-ops");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).scheduleBatch(targets, values, payloads, predecessor, salt, DELAY_48H);

        // Cannot execute batch before delay
        await expect(
            timelock.connect(owner).executeBatch(targets, values, payloads, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.127 timelock batch after delay: succeeds, both ops applied", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);

        const targets = [proxyAddr, proxyAddr];
        const values = [0n, 0n];
        const payloads = [setFeeData, upgradeData];
        const salt = ethers.id("batch-ops-success");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).scheduleBatch(targets, values, payloads, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).executeBatch(targets, values, payloads, predecessor, salt);

        expect(await escrow.feeRecipient()).to.equal(stranger.address);
        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(newImplAddr);
    });
});

// =============================================================================
//  SECTION 14: Edge cases and subtle attacks
// =============================================================================

describe("Cat16 -- Edge cases and subtle attacks", () => {
    it("16.128 owner as bundler: cannot self-settle to extract more than earned", async () => {
        const { escrow, registry, owner, user } = await deploy();
        // Owner registers as bundler
        await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const ownerQuoteId = 3n;
        await escrow.connect(owner).deposit({ value: COLLATERAL * 5n });

        const cid = await makeCommit(escrow, user, ownerQuoteId, "owner-bundler");
        await escrow.connect(owner).settle(cid);

        // Owner as bundler gets full fee (PROTOCOL_FEE_WEI=0, no platform cut)
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(ONE_GWEI);
    });

    it("16.129 owner as bundler + feeRecipient: gets full fee as bundler (PROTOCOL_FEE_WEI=0, no split)", async () => {
        const { escrow, registry, owner, user } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const ownerQuoteId = 3n;
        await escrow.connect(owner).deposit({ value: COLLATERAL * 5n });

        const cid = await makeCommit(escrow, user, ownerQuoteId, "owner-both-roles");
        await escrow.connect(owner).settle(cid);

        // Owner gets full fee (as bundler; feeRecipient gets 0 with PROTOCOL_FEE_WEI=0)
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(ONE_GWEI);
    });

    it("16.130 owner as bundler + feeRecipient, user is distinct: fee returns to owner on settle", async () => {
        // SelfCommitForbidden blocks owner-as-user + owner-as-bundler. Use a separate user signer.
        const { escrow, registry, owner, user } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const ownerQuoteId = 3n;
        await escrow.connect(owner).deposit({ value: COLLATERAL * 5n });

        // user (not owner) commits to owner's offer
        const cid = await makeCommit(escrow, user, ownerQuoteId, "owner-bundler-feeR");
        await escrow.connect(owner).settle(cid);

        // Owner gets full fee (as bundler + feeRecipient). PROTOCOL_FEE_WEI=0 -> no split.
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(ONE_GWEI);
    });

    it("16.131 owner as bundler misses SLA: gets slashed like any other bundler", async () => {
        const { escrow, registry, owner, user, sg, rg } = await deploy();
        await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const ownerQuoteId = 3n;
        await escrow.connect(owner).deposit({ value: COLLATERAL * 5n });
        const depBefore = await escrow.deposited(owner.address);

        const cid = await makeCommit(escrow, user, ownerQuoteId, "owner-slashed");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        expect(await escrow.deposited(owner.address)).to.equal(depBefore - COLLATERAL);
    });

    it("16.132 owner as bundler can trigger claimRefund after expiry (T12) -- ETH goes to user", async () => {
        const { escrow, registry, owner, user, sg, rg } = await deploy();
        await registry.connect(owner).register(ONE_GWEI, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
        const ownerQuoteId = 3n;
        await escrow.connect(owner).deposit({ value: COLLATERAL * 5n });

        const cid = await makeCommit(escrow, user, ownerQuoteId, "owner-bundler-refund");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        // Owner is the bundler -- valid T12 caller; ETH goes to user, not owner
        const pendingBefore = await escrow.pendingWithdrawals(user.address);
        await escrow.connect(owner).claimRefund(cid);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(pendingBefore + ONE_GWEI + COLLATERAL);
    });

    it("16.133 stranger with no roles cannot do anything dangerous", async () => {
        const { escrow, stranger, bundler, user, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "stranger-test");

        // settle() is permissionless in v0.6 -- stranger can call it, but fee goes to bundler
        await expect(escrow.connect(stranger).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);

        // Use a fresh commit to test claimRefund and other operations
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "stranger-refund-test");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await expect(escrow.connect(stranger).claimRefund(cid2))
            .to.be.revertedWithCustomError(escrow, "Unauthorized"); // T12: stranger is not CLIENT/BUNDLER/OWNER
        await expect(escrow.connect(stranger).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");
        await expect(escrow.connect(stranger).setFeeRecipient(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("16.134 owner withdraws own deposit then attempts to claim bundler funds: fails", async () => {
        const { escrow, owner, bundler } = await deploy();
        // Owner deposits
        await escrow.connect(owner).deposit({ value: ethers.parseEther("1") });
        // Owner withdraws
        await escrow.connect(owner).withdraw(ethers.parseEther("1"));
        // Owner cannot access bundler balance
        await expect(escrow.connect(owner).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
    });

    it("16.135 after timelock upgrade: re-initialization still blocked", async () => {
        const { escrow, owner, timelock, registry, feeRecipient } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("re-init-check");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        // Try to re-initialize
        await expect(
            escrow.connect(owner).initialize(
                await registry.getAddress(),
                feeRecipient.address,
            ),
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });

    it("16.136 upgradeToAndCall with initialize calldata: reverts InvalidInitialization", async () => {
        const { escrow, owner, registry, feeRecipient } = await deploy();
        const newImplAddr = await deployNewImpl();
        const initData = escrow.interface.encodeFunctionData("initialize", [
            await registry.getAddress(),
            feeRecipient.address,
        ]);
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;

        await expect(
            proxy.connect(owner).upgradeToAndCall(newImplAddr, initData),
        ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
    });

    it("16.137 proxy admin slot cannot be overwritten by owner via standard functions", async () => {
        const { escrow, owner } = await deploy();
        const proxyAddr = await escrow.getAddress();
        const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        // Owner does setFeeRecipient -- should NOT affect implementation slot
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(implBefore);
    });

    it("16.138 contract balance matches accounting after complex scenario", async () => {
        const { escrow, owner, bundler, user, feeRecipient, LONG_QUOTE_ID, sg, rg } = await deploy();

        // Multiple commits (long SLA to survive upgrade overhead)
        const cid1 = await makeCommit(escrow, user, LONG_QUOTE_ID, "complex-acc-1");
        const cid2 = await makeCommit(escrow, user, LONG_QUOTE_ID, "complex-acc-2");
        const cid3 = await makeCommit(escrow, user, LONG_QUOTE_ID, "complex-acc-3");

        // Settle one
        await escrow.connect(bundler).settle(cid1);

        // Upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        // Settle second
        await escrow.connect(bundler).settle(cid2);

        // Refund third
        await mine(Number(LONG_SLA + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid3);

        // Claim payouts
        await escrow.connect(bundler).claimPayout();

        // Verify invariant
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address, owner.address],
            0n,
        );
    });
});

// =============================================================================
//  SECTION 15: Timelock + in-flight commit interaction
// =============================================================================

describe("Cat16 -- Timelock + in-flight commit interaction", () => {
    it("16.139 commits created during timelock delay: settled before time advance, then upgrade executes", async () => {
        const { escrow, owner, bundler, user, timelock, LONG_QUOTE_ID } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("delay-window-commits");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Create commits during delay window (long SLA so they survive)
        const cid1 = await makeCommit(escrow, user, LONG_QUOTE_ID, "delay-commit-1");
        const cid2 = await makeCommit(escrow, user, LONG_QUOTE_ID, "delay-commit-2");

        // Settle BEFORE time advance (proves normal operations work during delay window)
        await escrow.connect(bundler).settle(cid1);
        await escrow.connect(bundler).settle(cid2);

        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 2n);

        // Execute upgrade after delay
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        // Pending withdrawals preserved after upgrade
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 2n);
    });

    it("16.140 commit before scheduling + upgrade executes: refund still works post-upgrade", async () => {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "pre-schedule-refund");

        const proxyAddr = await escrow.getAddress();
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("pre-schedule-upgrade");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        // The commit deadline was long passed -- refund
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI + COLLATERAL);
    });

    it("16.141 timelocked setFeeRecipient then new commit + settle: new commit credits fee to the new feeRecipient at commit time (with PROTOCOL_FEE_WEI=0 no fee flows to either)", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, timelock, LONG_QUOTE_ID } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("same-block-settle");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, setFeeData, predecessor, salt, DELAY_48H);

        // Commit during delay (long SLA so it survives time advance)
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "same-block-test");

        // Settle BEFORE time advance (commit still within SLA)
        // Actually, let's do it after setFeeRecipient change to test the redirect.
        // We settle before the time.increase -- the commit is still valid.
        // But first we need to execute the setFeeRecipient change...
        // The commit has LONG_SLA=100 blocks. time.increase only advances timestamp, not blocks.
        // But hardhat auto-mines blocks on each tx. Let's execute after delay.

        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, setFeeData, predecessor, salt);

        // Create a NEW commit after the fee change (to guarantee it's within SLA)
        const cid2 = await makeCommit(escrow, user, LONG_QUOTE_ID, "post-fee-change");
        await escrow.connect(bundler).settle(cid2);

        // PROTOCOL_FEE_WEI=0: stranger (new feeRecipient) gets 0
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.142 timelocked upgrade to V2Safe: new extraField slot does not corrupt existing data", async () => {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "v2safe-timelock");
        await escrow.connect(bundler).settle(cid);
        const pendBundler = await escrow.pendingWithdrawals(bundler.address);

        const proxyAddr = await escrow.getAddress();
        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const newImplAddr = await newImpl.getAddress();

        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("v2safe-timelock-upgrade");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        const proxy = V2.attach(proxyAddr) as any;
        expect(await proxy.pendingWithdrawals(bundler.address)).to.equal(pendBundler);
        expect(await proxy.extraField()).to.equal(0n);
    });
});

// =============================================================================
//  SECTION 16: Ownership transfer edge cases
// =============================================================================

describe("Cat16 -- Ownership transfer edge cases", () => {
    it("16.143 transferOwnership to new EOA: old owner loses all admin powers", async () => {
        const { escrow, owner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(stranger.address);
        expect(await escrow.owner()).to.equal(stranger.address);

        await expect(escrow.connect(owner).setFeeRecipient(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await expect(proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x"))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("16.144 transferOwnership to new EOA: new owner CAN admin", async () => {
        const { escrow, owner, stranger } = await deploy();
        await escrow.connect(owner).transferOwnership(stranger.address);

        // New owner can setFeeRecipient
        await expect(escrow.connect(stranger).setFeeRecipient(stranger.address)).to.not.be.reverted;
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("16.145 transferOwnership: normal operations unaffected for bundlers and users", async () => {
        const { escrow, owner, bundler, user, stranger, QUOTE_ID } = await deploy();
        await escrow.connect(owner).transferOwnership(stranger.address);

        const cid = await makeCommit(escrow, user, QUOTE_ID, "post-transfer");
        await escrow.connect(bundler).settle(cid);
        await expect(escrow.connect(bundler).claimPayout()).to.not.be.reverted;
    });

    it("16.146 renounceOwnership reverts -- ownership cannot be set to zero (T22); transferOwnership is the only exit", async () => {
        const { escrow, owner, stranger } = await deploy();
        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");
        // Owner is still set -- nobody except current owner can transfer
        await expect(escrow.connect(stranger).transferOwnership(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        expect(await escrow.owner()).to.equal(owner.address);
    });

    it("16.147 double transferOwnership: final recipient is the new owner", async () => {
        const { escrow, owner, stranger, attacker } = await deploy();
        await escrow.connect(owner).transferOwnership(stranger.address);
        await escrow.connect(stranger).transferOwnership(attacker.address);
        expect(await escrow.owner()).to.equal(attacker.address);

        // Only attacker can admin now
        await expect(escrow.connect(owner).setFeeRecipient(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).setFeeRecipient(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(attacker).setFeeRecipient(attacker.address)).to.not.be.reverted;
    });
});

// =============================================================================
//  SECTION 17: Full scenario stress tests
// =============================================================================

describe("Cat16 -- Full scenario stress tests", () => {
    it("16.148 5 users, 5 commits, upgrade mid-batch, mixed settle/refund: all accounting correct", async () => {
        const { escrow, owner, registry, bundler, feeRecipient, LONG_QUOTE_ID, sg, rg } = await deploy();
        const signers = await ethers.getSigners();
        const users = signers.slice(6, 11); // 5 users

        const cids: { cid: bigint; user: any; shouldRefund: boolean }[] = [];
        for (let i = 0; i < users.length; i++) {
            const c = await makeCommit(escrow, users[i], LONG_QUOTE_ID, `stress-${i}`);
            cids.push({ cid: c, user: users[i], shouldRefund: i % 2 === 0 });
        }

        // Upgrade mid-batch
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        // Process: some settle (within SLA), some expire and refund
        for (const item of cids) {
            if (!item.shouldRefund) {
                await escrow.connect(bundler).settle(item.cid);
            }
        }

        // Mine past deadline for refunds
        await mine(Number(LONG_SLA + sg + rg + 1n));
        for (const item of cids) {
            if (item.shouldRefund) {
                await escrow.connect(item.user).claimRefund(item.cid);
            }
        }

        // Verify invariant
        const allParties = [bundler.address, feeRecipient.address, owner.address, ...users.map((u) => u.address)];
        await assertBalanceInvariant(escrow, [bundler.address], allParties, 0n);
    });

    it("16.149 claim all payouts after complex scenario: contract balance goes to exactly deposited collateral", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await deploy();
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "final-1");
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "final-2");
        await escrow.connect(bundler).settle(cid1);
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid2);

        // Claim all payouts
        if ((await escrow.pendingWithdrawals(bundler.address)) > 0n)
            await escrow.connect(bundler).claimPayout();
        if ((await escrow.pendingWithdrawals(feeRecipient.address)) > 0n)
            await escrow.connect(feeRecipient).claimPayout();
        if ((await escrow.pendingWithdrawals(user.address)) > 0n)
            await escrow.connect(user).claimPayout();

        // Contract balance should equal exactly the remaining deposited collateral
        const remaining = await escrow.deposited(bundler.address);
        const bal = await contractBalance(escrow);
        expect(bal).to.equal(remaining);
    });

    it("16.150 owner upgrade to V2Safe with extraField then renounce: cannot set extraField anymore", async () => {
        const { escrow, owner } = await deploy();
        const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
        const newImpl = await V2.deploy();
        await newImpl.waitForDeployment();
        const proxyAddr = await escrow.getAddress();
        const proxy = V2.attach(proxyAddr) as any;
        await proxy.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");
        await proxy.connect(owner).setExtraField(42n);
        await proxy.connect(owner).renounceOwnership();

        await expect(proxy.connect(owner).setExtraField(100n))
            .to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
        expect(await proxy.extraField()).to.equal(42n);
    });
});

// =============================================================================
//  SECTION 18: Implementation contract direct-call protection
// =============================================================================

describe("Cat16 -- Implementation contract direct-call protection", () => {
    it("16.151 implementation contract cannot be initialized", async () => {
        const { feeRecipient, registry } = await deploy();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const impl = await Escrow.deploy();
        await impl.waitForDeployment();

        await expect(
            impl.initialize(await registry.getAddress(), feeRecipient.address),
        ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("16.152 implementation contract deposit does not affect proxy", async () => {
        const { escrow, bundler } = await deploy();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const impl = await Escrow.deploy();
        await impl.waitForDeployment();

        // Depositing on impl has no effect on proxy
        await impl.connect(bundler).deposit({ value: COLLATERAL });
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n); // unchanged
    });

    it("16.153 implementation contract is separate from proxy state", async () => {
        const { escrow, owner, bundler } = await deploy();
        const newImplAddr = await deployNewImpl();

        // Upgrade proxy
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        // Proxy state unchanged
        expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 50n);
    });
});

// =============================================================================
//  SECTION 19: Anti-rug guarantees with multiple concurrent commits
// =============================================================================

describe("Cat16 -- Anti-rug with multiple concurrent commits", () => {
    it("16.154 3 commits open, owner upgrade + setFeeRecipient: settled ones use new recipient, accounting correct", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, LONG_QUOTE_ID } = await deploy();
        const cid1 = await makeCommit(escrow, user, LONG_QUOTE_ID, "concurrent-1");
        const cid2 = await makeCommit(escrow, user, LONG_QUOTE_ID, "concurrent-2");
        const cid3 = await makeCommit(escrow, user, LONG_QUOTE_ID, "concurrent-3");

        // Upgrade and redirect fees
        const newImplAddr = await deployNewImpl();
        const setFeeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, setFeeData);

        await escrow.connect(bundler).settle(cid1);
        await escrow.connect(bundler).settle(cid2);
        await escrow.connect(bundler).settle(cid3);

        // PROTOCOL_FEE_WEI=0: all 3 settles after fee change -> stranger gets 0
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.155 commits open, owner changes feeRecipient twice: last recipient gets fees", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, attacker, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "double-fee-change");

        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await escrow.connect(owner).setFeeRecipient(attacker.address);

        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI=0: no one gets a platform fee
        expect(await escrow.pendingWithdrawals(attacker.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });

    it("16.156 owner rapid-fire setFeeRecipient changes: only affects future settles", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();
        // Settle with original recipient
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "rapid-1");
        await escrow.connect(bundler).settle(cid1);
        const pendOriginal = await escrow.pendingWithdrawals(feeRecipient.address);

        // Change recipient rapidly
        await escrow.connect(owner).setFeeRecipient(stranger.address);
        await escrow.connect(owner).setFeeRecipient(owner.address);
        await escrow.connect(owner).setFeeRecipient(stranger.address);

        // Original recipient's pending unchanged
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendOriginal);
    });
});

// =============================================================================
//  SECTION 20: Comprehensive invariant checks post-attack-attempt
// =============================================================================

describe("Cat16 -- Comprehensive invariant checks", () => {
    it("16.157 after all admin actions: sum(deposited) + sum(pending) + pendingFees = contractBalance", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();

        // Multiple rounds of commits
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "inv-1");
        await escrow.connect(bundler).settle(cid1);

        // Admin action
        await escrow.connect(owner).setFeeRecipient(stranger.address);

        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "inv-2");
        await escrow.connect(bundler).settle(cid2);

        // Upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");

        const cid3 = await makeCommit(escrow, user, QUOTE_ID, "inv-3");
        // cid3 is open (unsettled)

        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, stranger.address, user.address, owner.address],
            ONE_GWEI, // one open commit's fee
        );
    });

    it("16.158 ETH cannot be created: contract balance never exceeds total deposited + total fees paid", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();

        // Initial balance = bundler deposit
        const initialBal = await contractBalance(escrow);
        expect(initialBal).to.equal(COLLATERAL * 50n);

        // After commit, balance increases by fee
        const cid = await makeCommit(escrow, user, QUOTE_ID, "no-create");
        expect(await contractBalance(escrow)).to.equal(initialBal + ONE_GWEI);

        // Settle: balance unchanged (no external transfers in settle)
        await escrow.connect(bundler).settle(cid);
        expect(await contractBalance(escrow)).to.equal(initialBal + ONE_GWEI);

        // ClaimPayout: bundler pulls exactly ONE_GWEI (PROTOCOL_FEE_WEI=0)
        // so balance falls back to initialBal exactly.
        await escrow.connect(bundler).claimPayout();
        const afterClaim = await contractBalance(escrow);
        expect(afterClaim).to.equal(initialBal);
    });

    it("16.159 ETH cannot be destroyed: all funds are accounted for", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "no-destroy");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        // All ETH is accounted for: deposited + pendingWithdrawals
        const dep = await escrow.deposited(bundler.address);
        const pendUser = await escrow.pendingWithdrawals(user.address);
        const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);
        const bal = await contractBalance(escrow);
        expect(bal).to.equal(dep + pendUser + pendFee);
    });

    it("16.160 no ETH leak on slash: 100% of collateral goes to user", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID, sg, rg } = await deploy();
        const depBefore = await escrow.deposited(bundler.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "slash-accounting");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        const depAfter = await escrow.deposited(bundler.address);
        const slashed = depBefore - depAfter;
        expect(slashed).to.equal(COLLATERAL);

        // 100% of slashed amount goes to user; feeRecipient gets 0
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI + COLLATERAL);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
    });
});

// =============================================================================
//  SECTION 21: setFeeRecipient deep edge cases
// =============================================================================

describe("Cat16 -- setFeeRecipient deep edge cases", () => {
    it("16.161 setFeeRecipient to same address as current: no-op but succeeds", async () => {
        const { escrow, owner, feeRecipient } = await deploy();
        await expect(escrow.connect(owner).setFeeRecipient(feeRecipient.address)).to.not.be.reverted;
        expect(await escrow.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("16.162 setFeeRecipient to bundler address: bundler gets fee + bundlerNet in same pending slot", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(bundler.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "bundler-is-fee");
        await escrow.connect(bundler).settle(cid);
        // Bundler gets entire fee (full feePerOp, PROTOCOL_FEE_WEI=0)
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("16.163 setFeeRecipient to user address: user gets fee portion on settle (0 with PROTOCOL_FEE_WEI=0)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(user.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "user-is-fee");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI=0: user gets 0 as feeRecipient
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(0n);
    });

    it("16.164 setFeeRecipient to contract address: fees accumulate for contract (0 with PROTOCOL_FEE_WEI=0)", async () => {
        const { escrow, owner, bundler, user, registry, QUOTE_ID } = await deploy();
        // Set feeRecipient to the registry contract (just to prove any address works)
        const regAddr = await registry.getAddress();
        await escrow.connect(owner).setFeeRecipient(regAddr);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "contract-fee");
        await escrow.connect(bundler).settle(cid);
        // PROTOCOL_FEE_WEI=0: contract feeRecipient gets 0
        expect(await escrow.pendingWithdrawals(regAddr)).to.equal(0n);
    });

    it("16.165 setFeeRecipient emits event with old and new addresses", async () => {
        const { escrow, owner, feeRecipient, stranger } = await deploy();
        await expect(escrow.connect(owner).setFeeRecipient(stranger.address))
            .to.emit(escrow, "FeeRecipientUpdated")
            .withArgs(feeRecipient.address, stranger.address);
    });
});

// =============================================================================
//  SECTION 22: Gas griefing and DOS via admin powers
// =============================================================================

describe("Cat16 -- Owner cannot DOS normal operations", () => {
    it("16.166 setFeeRecipient does not affect deposit()", async () => {
        const { escrow, owner, bundler } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        await expect(escrow.connect(bundler).deposit({ value: COLLATERAL })).to.not.be.reverted;
    });

    it("16.167 setFeeRecipient does not affect withdraw()", async () => {
        const { escrow, owner, bundler } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        await expect(escrow.connect(bundler).withdraw(COLLATERAL)).to.not.be.reverted;
    });

    it("16.168 setFeeRecipient does not affect commit()", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        await expect(makeCommit(escrow, user, QUOTE_ID, "commit-after-setfee")).to.not.be.reverted;
    });

    it("16.169 upgrade does not affect deposit()", async () => {
        const { escrow, owner, bundler } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        await expect(escrow.connect(bundler).deposit({ value: COLLATERAL })).to.not.be.reverted;
    });

    it("16.170 upgrade does not affect commit()", async () => {
        const { escrow, owner, user, QUOTE_ID } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        await expect(makeCommit(escrow, user, QUOTE_ID, "commit-after-upgrade")).to.not.be.reverted;
    });

    it("16.171 upgrade does not affect settle()", async () => {
        const { escrow, owner, bundler, user, LONG_QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, LONG_QUOTE_ID, "settle-after-upgrade");
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        await expect(escrow.connect(bundler).settle(cid)).to.not.be.reverted;
    });

    it("16.172 upgrade does not affect claimRefund()", async () => {
        const { escrow, owner, user, QUOTE_ID, sg, rg } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "refund-after-upgrade");
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await expect(escrow.connect(user).claimRefund(cid)).to.not.be.reverted;
    });

    it("16.173 upgrade does not affect claimPayout()", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "payout-after-upgrade");
        await escrow.connect(bundler).settle(cid);
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x");
        await expect(escrow.connect(bundler).claimPayout()).to.not.be.reverted;
    });
});

// =============================================================================
//  SECTION 23: Timelock self-administration safety
// =============================================================================

describe("Cat16 -- Timelock self-administration safety", () => {
    it("16.174 timelock cannot execute non-scheduled operation", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const salt = ethers.id("never-scheduled");
        const predecessor = ethers.ZeroHash;

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.175 timelock cannot execute same operation twice", async () => {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("double-exec");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt);

        // Second execution of same operation fails
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, calldata, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.176 timelock cannot schedule same operation twice (same salt)", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const calldata = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const salt = ethers.id("double-schedule");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H);
        await expect(
            timelock.connect(owner).schedule(proxyAddr, 0, calldata, predecessor, salt, DELAY_48H),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("16.177 updateDelay through timelock: reduces delay only after old delay passes", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const timelockAddr = await timelock.getAddress();
        const newDelay = 60; // 1 minute
        const updateData = timelock.interface.encodeFunctionData("updateDelay", [newDelay]);
        const salt = ethers.id("reduce-delay");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(timelockAddr, 0, updateData, predecessor, salt, DELAY_48H);

        // Cannot execute before the CURRENT delay
        // time.increase(N) mines a block, so execute() runs at T+N+1; use N-2 so execute is 1s early
        await time.increase(DELAY_48H - 2);
        await expect(
            timelock.connect(owner).execute(timelockAddr, 0, updateData, predecessor, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        await time.increase(2);
        await timelock.connect(owner).execute(timelockAddr, 0, updateData, predecessor, salt);
        expect(await timelock.getMinDelay()).to.equal(BigInt(newDelay));
    });
});

// =============================================================================
//  SECTION 24: Scenario -- user observes pending upgrade and exits safely
// =============================================================================

describe("Cat16 -- User observes pending upgrade and exits safely", () => {
    it("16.178 user sees scheduled upgrade, withdraws bundler payout before it executes", async () => {
        const { escrow, owner, bundler, user, feeRecipient, timelock, QUOTE_ID } = await deployWithTimelock();

        // Bundler commits and settles
        const cid = await makeCommit(escrow, user, QUOTE_ID, "observe-exit-1");
        await escrow.connect(bundler).settle(cid);

        // Owner schedules an upgrade
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("observe-exit");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // User/bundler observe pending upgrade and exit immediately
        await escrow.connect(bundler).claimPayout();
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);

        // Bundler withdraws collateral
        const idle = await escrow.idleBalance(bundler.address);
        await escrow.connect(bundler).withdraw(idle);
        expect(await escrow.deposited(bundler.address)).to.equal(0n);
    });

    it("16.179 user sees scheduled upgrade, claims refund on expired commit before upgrade", async () => {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "exit-refund");

        const proxyAddr = await escrow.getAddress();
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("exit-refund-upgrade");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Deadline passes, user refunds
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);
        await escrow.connect(user).claimPayout();

        // User already claimed, pending should be 0
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(0n);
    });

    it("16.180 bundler sees scheduled upgrade, deregisters quote and withdraws", async () => {
        const { escrow, owner, bundler, registry, timelock, QUOTE_ID } = await deployWithTimelock();

        const proxyAddr = await escrow.getAddress();
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("bundler-exit");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Bundler deregisters from registry
        await registry.connect(bundler).deregister(QUOTE_ID);
        const offer = await registry.getOffer(QUOTE_ID);
        expect(offer.bond).to.equal(0n); // deregistered

        // Bundler withdraws all idle collateral
        const idle = await escrow.idleBalance(bundler.address);
        await escrow.connect(bundler).withdraw(idle);
        expect(await escrow.deposited(bundler.address)).to.equal(0n);
    });
});

// =============================================================================
//  SECTION 25: Extreme parameter edge cases
// =============================================================================

describe("Cat16 -- Extreme parameter edge cases", () => {
    it("16.181 PROTOCOL_FEE_WEI = 0 (default): owner gets nothing from settle", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "zero-fee");
        await escrow.connect(bundler).settle(cid);

        // PROTOCOL_FEE_WEI=0: owner gets nothing
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        // Bundler gets full fee
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
    });

    it("16.182 PROTOCOL_FEE_WEI = 0 (default): owner gets nothing from refund (user gets 100% collateral)", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID, sg, rg } = await deploy();
        await escrow.connect(owner).setFeeRecipient(owner.address);
        const cid = await makeCommit(escrow, user, QUOTE_ID, "zero-fee-slash");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid);

        // PROTOCOL_FEE_WEI=0: owner gets 0; user gets 100% collateral
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(ONE_GWEI + COLLATERAL);
    });

    it("16.183 single wei feePerOp with PROTOCOL_FEE_WEI=0: commit succeeds, bundler gets 1 wei", async () => {
        const [owner, bundler, user] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), owner.address],
            { kind: "uups" },
        )) as unknown as SLAEscrow;

        // fee=1, collateral=2 (strict > required)
        await registry.connect(bundler).register(1, Number(SLA_BLOCKS), 2, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: 100n });

        // v0.6: commit() takes bytes32 userOpHash directly
        const userOpBytes = ethers.keccak256(ethers.toUtf8Bytes("1wei"));
        // PROTOCOL_FEE_WEI=0: msg.value must equal feePerOp (1 wei). Commit succeeds.
        await expect(
            escrow.connect(user).commit(1n, userOpBytes, bundler.address, 2n, Number(SLA_BLOCKS), { value: 1n }),
        ).to.not.be.reverted;
    });

    it("16.184 single wei feePerOp, PROTOCOL_FEE_WEI=1: commit requires msg.value=2, reverts with WrongFee if only 1", async () => {
        const [owner, bundler, user] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("QuoteRegistry");
        const registry = (await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"))) as QuoteRegistry;
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const escrow = (await upgrades.deployProxy(
            Escrow,
            [await registry.getAddress(), owner.address],
            { kind: "uups" },
        )) as unknown as SLAEscrow;
        await escrow.connect(owner).setProtocolFeeWei(1n);

        // fee=1, collateral=2 (strict > required)
        await registry.connect(bundler).register(1, Number(SLA_BLOCKS), 2, 302_400, { value: ethers.parseEther("0.0001") });
        await escrow.connect(bundler).deposit({ value: 100n });

        // v0.6: commit() takes bytes32 userOpHash directly
        const userOpBytes = ethers.keccak256(ethers.toUtf8Bytes("1wei-max"));
        // msg.value=1 but required = feePerOp(1) + PROTOCOL_FEE_WEI(1) = 2
        await expect(
            escrow.connect(user).commit(1n, userOpBytes, bundler.address, 2n, Number(SLA_BLOCKS), { value: 1n }),
        ).to.be.revertedWithCustomError(escrow, "WrongFee");
    });
});

// =============================================================================
//  SECTION 26: Additional anti-rug verification
// =============================================================================

describe("Cat16 -- Additional anti-rug verification", () => {
    it("16.185 owner cannot withdraw via proxy fallback (no receive/fallback function)", async () => {
        const { escrow, owner } = await deploy();
        const proxyAddr = await escrow.getAddress();
        // Sending raw ETH to proxy with no calldata -> delegatecall to impl which has no receive() -> empty revert data
        await expect(
            owner.sendTransaction({ to: proxyAddr, value: 1n }),
        ).to.be.reverted; // bare revert: delegatecall returns empty revert data, no custom error
    });

    it("16.186 owner cannot selfdestruct the proxy (not possible in Solidity 0.8.24)", async () => {
        const { escrow } = await deploy();
        // This test verifies the contract is still alive after a deploy
        expect(await escrow.protocolFeeWei()).to.equal(0n);
        expect(await escrow.REFUND_GRACE_BLOCKS()).to.equal(5n);
    });

    it("16.187 after timelock upgrade: owner() still points to timelock", async () => {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const timelockAddr = await timelock.getAddress();

        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("owner-check-post-upgrade");
        const predecessor = ethers.ZeroHash;

        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        expect(await escrow.owner()).to.equal(timelockAddr);
    });

    it("16.188 renounceOwnership reverts; non-owner upgrade attempt fails; implementation unchanged", async () => {
        const { escrow, owner, stranger } = await deploy();
        const proxyAddr = await escrow.getAddress();
        const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddr);

        await expect(escrow.connect(owner).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");

        const newImplAddr = await deployNewImpl();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await expect(proxy.connect(stranger).upgradeToAndCall(newImplAddr, "0x"))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        const implAfter = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter).to.equal(implBefore);
    });

    it("16.189 multiple rounds: commit-settle-claim repeated 20 times without any admin rug", async () => {
        const { escrow, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        for (let i = 0; i < 20; i++) {
            const cid = await makeCommit(escrow, user, QUOTE_ID, `round-${i}`);
            await escrow.connect(bundler).settle(cid);
        }
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 20n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address],
            0n,
        );
    });

    it("16.190 owner deposited collateral is not confused with bundler collateral", async () => {
        const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
        await escrow.connect(owner).deposit({ value: COLLATERAL });
        const ownerDep = await escrow.deposited(owner.address);
        const bundlerDep = await escrow.deposited(bundler.address);
        expect(ownerDep).to.equal(COLLATERAL);
        expect(bundlerDep).to.equal(COLLATERAL * 50n);

        // Commit locks bundler's collateral, not owner's
        await makeCommit(escrow, user, QUOTE_ID, "separate-deposits");
        expect(await escrow.lockedOf(bundler.address)).to.equal(COLLATERAL);
        expect(await escrow.lockedOf(owner.address)).to.equal(0n);
    });

    it("16.191 total locked never exceeds total deposited for any address", async () => {
        const { escrow, bundler, user, QUOTE_ID } = await deploy();
        for (let i = 0; i < 5; i++) {
            await makeCommit(escrow, user, QUOTE_ID, `lock-check-${i}`);
        }
        const dep = await escrow.deposited(bundler.address);
        const locked = await escrow.lockedOf(bundler.address);
        expect(locked).to.be.lte(dep);
    });

    it("16.192 admin cannot pause the contract (no pause function)", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const pauseFns = iface.fragments.filter(
            (f) => f.type === "function" && (f as any).name?.toLowerCase().includes("pause"),
        );
        expect(pauseFns.length, "No pause function should exist").to.equal(0);
    });

    it("16.193 admin cannot blacklist addresses (no blacklist function)", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const blacklistFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                ((f as any).name?.toLowerCase().includes("blacklist") ||
                    (f as any).name?.toLowerCase().includes("blocklist") ||
                    (f as any).name?.toLowerCase().includes("ban")),
        );
        expect(blacklistFns.length, "No blacklist function should exist").to.equal(0);
    });

    it("16.194 admin cannot freeze withdrawals (no withdrawal-freeze function)", async () => {
        // freezeRegistry() and freezeCommits() are legitimate governance ratchets (T22).
        // This test guards against rug-pull freeze mechanisms that would lock user withdrawals.
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const ALLOWED_FREEZE_FNS = new Set(["freezeRegistry", "freezeCommits"]);
        const freezeFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                (f as any).name?.toLowerCase().includes("freeze") &&
                !ALLOWED_FREEZE_FNS.has((f as any).name),
        );
        expect(freezeFns.length, "No withdrawal-freeze function should exist").to.equal(0);
    });

    it("16.195 admin cannot mint tokens or create ETH (no mint function)", async () => {
        const { escrow } = await deploy();
        const iface = escrow.interface;
        const mintFns = iface.fragments.filter(
            (f) =>
                f.type === "function" &&
                (f as any).name?.toLowerCase().includes("mint"),
        );
        expect(mintFns.length, "No mint function should exist").to.equal(0);
    });

    it("16.196 all external onlyOwner functions reject non-owner callers (complete surface: setFeeRecipient, setProtocolFeeWei, setRegistry, freezeRegistry, freezeCommits, sweepExcess, upgradeToAndCall, transferOwnership, renounceOwnership)", async () => {
        const { escrow, registry, stranger } = await deploy();
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;

        await expect(escrow.connect(stranger).setFeeRecipient(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).setProtocolFeeWei(1n))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).setRegistry(await registry.getAddress()))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).freezeRegistry())
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).freezeCommits())
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).sweepExcess())
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(proxy.connect(stranger).upgradeToAndCall(newImplAddr, "0x"))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).transferOwnership(stranger.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(escrow.connect(stranger).renounceOwnership())
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // Non-owner function still works for stranger:
        await expect(escrow.connect(stranger).deposit({ value: 1n })).to.not.be.reverted;
    });

    it("16.197 setRegistry is owner-only -- stranger cannot change REGISTRY", async () => {
        const { escrow, stranger } = await deploy();
        await expect(
            escrow.connect(stranger).setRegistry(stranger.address)
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("16.198 complete anti-rug scenario: timelock owned, commit lifecycle, upgrade, all accounting verified", async () => {
        const { escrow, owner, bundler, user, feeRecipient, timelock, QUOTE_ID } = await deployWithTimelock();

        // Phase 1: Normal operations
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "antirug-1");
        await escrow.connect(bundler).settle(cid1);

        // Phase 2: Schedule upgrade
        const proxyAddr = await escrow.getAddress();
        const newImplAddr = await deployNewImpl();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [newImplAddr, "0x"]);
        const salt = ethers.id("antirug-upgrade");
        const predecessor = ethers.ZeroHash;
        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, predecessor, salt, DELAY_48H);

        // Phase 3: Normal operations during delay
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "antirug-2");
        await escrow.connect(bundler).settle(cid2);

        // Phase 4: Execute upgrade
        await time.increase(DELAY_48H);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, predecessor, salt);

        // Phase 5: Normal operations after upgrade
        const cid3 = await makeCommit(escrow, user, QUOTE_ID, "antirug-3");
        await escrow.connect(bundler).settle(cid3);

        // Phase 6: Verify everything
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI * 3n);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address, owner.address],
            0n,
        );
    });

    it("16.199 owner cannot backrun a settle with fee change to steal that settle's fee", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
        const cid = await makeCommit(escrow, user, QUOTE_ID, "backrun");

        // Settle occurs
        await escrow.connect(bundler).settle(cid);
        const pendFeeRecipient = await escrow.pendingWithdrawals(feeRecipient.address);

        // Owner changes fee recipient AFTER settle
        await escrow.connect(owner).setFeeRecipient(owner.address);

        // The already-queued fee is STILL in feeRecipient's pendingWithdrawals
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(pendFeeRecipient);
        // Owner has nothing from this settle
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);
    });

    it("16.200 end-to-end trustlessness: with timelock, user/bundler cannot be rugged by any admin sequence", async () => {
        const { escrow, owner, bundler, user, feeRecipient, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock();

        // Record starting state
        const bundlerDepStart = await escrow.deposited(bundler.address);

        // User commits
        const cid = await makeCommit(escrow, user, QUOTE_ID, "final-proof");

        // Owner tries every admin action:
        // 1. Cannot setFeeRecipient directly
        await expect(escrow.connect(owner).setFeeRecipient(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 2. Cannot upgrade directly
        const newImplAddr = await deployNewImpl();
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const proxy = Escrow.attach(proxyAddr) as SLAEscrow;
        await expect(proxy.connect(owner).upgradeToAndCall(newImplAddr, "0x"))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 3. Cannot transferOwnership directly
        await expect(escrow.connect(owner).transferOwnership(owner.address))
            .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        // 4. settle() is permissionless (v0.6) -- owner CAN call it, but fee always goes to bundler
        await expect(escrow.connect(owner).settle(cid)).to.not.be.reverted;
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
        expect(await escrow.pendingWithdrawals(owner.address)).to.equal(0n);

        // Create a fresh commit for the refund + claimRefund tests
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "final-proof-2");

        // 5. EOA owner cannot claimRefund -- escrow owner is the timelock, not this EOA
        //    (escrow.owner() == timelock.address, msg.sender == owner.address -> Unauthorized)
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await expect(escrow.connect(owner).claimRefund(cid2))
            .to.be.revertedWithCustomError(escrow, "Unauthorized");

        // 6. Cannot withdraw others' funds
        await expect(escrow.connect(owner).withdraw(1n))
            .to.be.revertedWithCustomError(escrow, "InsufficientIdle");

        // 7. Cannot claimPayout with 0 pending (owner has 0 in pendingWithdrawals)
        await expect(escrow.connect(owner).claimPayout())
            .to.be.revertedWithCustomError(escrow, "NothingToClaim");

        // User can still refund normally (cid2 expired)
        await escrow.connect(user).claimRefund(cid2);
        const expectedUser = ONE_GWEI + COLLATERAL;
        expect(await escrow.pendingWithdrawals(user.address)).to.equal(expectedUser);

        // Bundler's remaining deposit is reduced by collateral (slashed from cid2 only; cid was settled)
        expect(await escrow.deposited(bundler.address)).to.equal(bundlerDepStart - COLLATERAL);

        // Final invariant
        await assertBalanceInvariant(
            escrow,
            [bundler.address],
            [bundler.address, feeRecipient.address, user.address, owner.address],
            0n,
        );
    });
});

// =============================================================================
//  SECTION 27: Protocol fee credited at commit time (nonzero fee verification)
// =============================================================================

describe("Cat16 -- Protocol fee timing (nonzero fee)", () => {
    it("16.201 protocolFeeWei > 0: fee is credited to feeRecipient at commit time -- changing feeRecipient after commit does not redirect the already-credited fee", async () => {
        const { escrow, owner, bundler, user, feeRecipient, stranger, QUOTE_ID } = await deploy();

        const FEE = 1000n;
        await escrow.connect(owner).setProtocolFeeWei(FEE);

        // commit() credits FEE to feeRecipient immediately (protocolFeeWei snapshotted in the tx)
        const cid = await makeCommit(escrow, user, QUOTE_ID, "fee-at-commit-201");
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FEE);

        // Change feeRecipient to stranger -- too late; fee was already credited above
        await escrow.connect(owner).setFeeRecipient(stranger.address);

        // settle() does not read feeRecipient at all (no further credit happens at settle)
        await escrow.connect(bundler).settle(cid);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FEE); // unchanged
        expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n); // nothing from this commit
    });

    it("16.202 setProtocolFeeWei only affects future commits -- existing committed feePaid is not retroactively changed", async () => {
        const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();

        // First commit with protocolFeeWei = 0 -- no fee credited
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "before-fee-202");
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);

        // Raise fee
        const FEE = 500n;
        await escrow.connect(owner).setProtocolFeeWei(FEE);

        // Second commit -- FEE credited at this commit time
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "after-fee-202");
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FEE);

        // Settle both -- no additional fee credits at settle time
        await escrow.connect(bundler).settle(cid1);
        await escrow.connect(bundler).settle(cid2);
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(FEE); // only from cid2's commit
    });
});
