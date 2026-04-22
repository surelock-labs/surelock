// Category 12: TimelockController Attack Vectors -- adversarial test suite
//
// Targets subtle exploits: predecessor chains, cancel-re-execute races,
// salt collisions, role confusion, batch operations, and interactions between
// timelock delays and escrow commit deadlines.

import { expect }                              from "chai";
import { ethers, upgrades }                    from "hardhat";
import { mine, time }                          from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow, TimelockController } from "../../typechain-types";
import {
    deployEscrow,
    deployWithTimelock as fixturesDeployWithTimelock,
    makeCommit as fixturesMakeCommit,
    COLLATERAL,
    ONE_GWEI,
} from "../helpers/fixtures";

const SLA_BLOCKS   = 2n;
const DELAY        = 3600;   // 1 hour default delay for most tests

// -- helpers ------------------------------------------------------------------

async function deployBase(slaBlocksOverride?: bigint) {
    const base = await deployEscrow({
        slaBlocks: slaBlocksOverride ?? SLA_BLOCKS,
        preDeposit: COLLATERAL * 10n,
    });
    // Read grace constants from the deployed contract (not hardcoded)
    const sg = BigInt(await base.escrow.SETTLEMENT_GRACE_BLOCKS());
    const rg = BigInt(await base.escrow.REFUND_GRACE_BLOCKS());
    // cat12 needs extra1 (signer[6]) and extra2 (signer[7])
    const signers = await ethers.getSigners();
    const extra1 = signers[6];
    const extra2 = signers[7];
    return { ...base, extra1, extra2, sg, rg };
}

async function deployWithTimelock(minDelay = DELAY, slaBlocksOverride?: bigint) {
    const base = await deployBase(slaBlocksOverride);
    const { owner } = base;

    const TimelockFactory = await ethers.getContractFactory("TimelockController");
    const timelock = (await TimelockFactory.deploy(
        minDelay,
        [owner.address],          // proposers (also get CANCELLER_ROLE by default in OZ v5)
        [ethers.ZeroAddress],     // executors: anyone can execute
        owner.address,            // admin
    )) as unknown as TimelockController;

    // Transfer escrow + registry ownership to timelock (T22: both contracts under same governance)
    await base.escrow.connect(owner).transferOwnership(await timelock.getAddress());
    await base.registry.connect(owner).transferOwnership(await timelock.getAddress());

    return { ...base, timelock };   // sg, rg propagated from deployBase
}

/** Deploy with zero delay -- simulates emergency/testing governance. */
async function deployZeroDelay() {
    return deployWithTimelock(0);
}

async function makeCommit(
    escrow: SLAEscrow,
    user: any,
    quoteId: bigint,
    tag?: string,
): Promise<bigint> {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user, quoteId, tag ?? `op-${Date.now()}-${Math.random()}`);
    return commitId;
}

/** Schedule a timelock operation and return the operationId */
async function scheduleOp(
    timelock: TimelockController,
    proposer: any,
    target: string,
    value: bigint,
    data: string,
    predecessor: string,
    salt: string,
    delay: number,
): Promise<string> {
    await timelock.connect(proposer).schedule(target, value, data, predecessor, salt, delay);
    return await timelock.hashOperation(target, value, data, predecessor, salt);
}

/** Schedule + wait + execute a timelock op */
async function scheduleAndExecute(
    timelock: TimelockController,
    proposer: any,
    executor: any,
    target: string,
    value: bigint,
    data: string,
    predecessor: string,
    salt: string,
    delay: number,
) {
    await timelock.connect(proposer).schedule(target, value, data, predecessor, salt, delay);
    if (delay > 0) await time.increase(delay);
    await timelock.connect(executor).execute(target, value, data, predecessor, salt);
}

async function safeInclBlock(escrow: any, cid: bigint): Promise<bigint> {
    const cur = BigInt(await ethers.provider.getBlockNumber());
    const deadline = (await escrow.getCommit(cid)).deadline;
    return cur < deadline ? cur : deadline - 1n;
}

// =============================================================================
//  Cat12 -- TimelockController Attack Vectors
// =============================================================================

describe("Cat12 -- Predecessor Chain Attacks", function () {

    it("12.01 execute op B (predecessor=A) before A is done reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const dataA = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const dataB = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);

        const saltA = ethers.id("pred-chain-A");
        const saltB = ethers.id("pred-chain-B");
        const predecessor = ethers.ZeroHash;

        // Schedule A
        const opIdA = await scheduleOp(timelock, owner, proxyAddr, 0n, dataA, predecessor, saltA, DELAY);

        // Schedule B with predecessor = A
        await timelock.connect(owner).schedule(proxyAddr, 0, dataB, opIdA, saltB, DELAY);

        // Advance past delay
        await time.increase(DELAY);

        // Try to execute B before A -- must revert (predecessor A not done)
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, dataB, opIdA, saltB),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexecutedPredecessor");
    });

    it("12.02 execute A then B (predecessor=A) succeeds when delay passed", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const dataA = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const dataB = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);

        const saltA = ethers.id("chain-ok-A");
        const saltB = ethers.id("chain-ok-B");

        const opIdA = await scheduleOp(timelock, owner, proxyAddr, 0n, dataA, ethers.ZeroHash, saltA, DELAY);
        await timelock.connect(owner).schedule(proxyAddr, 0, dataB, opIdA, saltB, DELAY);

        await time.increase(DELAY);

        await timelock.connect(owner).execute(proxyAddr, 0, dataA, ethers.ZeroHash, saltA);
        // Now A is done, execute B
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, dataB, opIdA, saltB),
        ).to.not.be.reverted;
    });

    it("12.03 three-deep predecessor chain: C depends on B depends on A", async function () {
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const dataA = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const dataB = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);
        const dataC = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);

        const saltA = ethers.id("deep-A");
        const saltB = ethers.id("deep-B");
        const saltC = ethers.id("deep-C");

        const opIdA = await scheduleOp(timelock, owner, proxyAddr, 0n, dataA, ethers.ZeroHash, saltA, DELAY);
        const opIdB = await scheduleOp(timelock, owner, proxyAddr, 0n, dataB, opIdA, saltB, DELAY);
        await timelock.connect(owner).schedule(proxyAddr, 0, dataC, opIdB, saltC, DELAY);

        await time.increase(DELAY);

        // Skip A, try C -- must fail (predecessor B not done)
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, dataC, opIdB, saltC),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexecutedPredecessor");

        // Execute in order
        await timelock.connect(owner).execute(proxyAddr, 0, dataA, ethers.ZeroHash, saltA);
        await timelock.connect(owner).execute(proxyAddr, 0, dataB, opIdA, saltB);
        await timelock.connect(owner).execute(proxyAddr, 0, dataC, opIdB, saltC);

        expect(await escrow.feeRecipient()).to.equal(owner.address);
    });

    it("12.04 predecessor pointing to a cancelled operation blocks execution forever", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const dataA = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const dataB = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);

        const saltA = ethers.id("cancel-pred-A");
        const saltB = ethers.id("cancel-pred-B");

        const opIdA = await scheduleOp(timelock, owner, proxyAddr, 0n, dataA, ethers.ZeroHash, saltA, DELAY);
        await timelock.connect(owner).schedule(proxyAddr, 0, dataB, opIdA, saltB, DELAY);

        // Cancel A
        await timelock.connect(owner).cancel(opIdA);

        await time.increase(DELAY);

        // B should be impossible to execute because A will never be Done
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, dataB, opIdA, saltB),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexecutedPredecessor");
    });

    it("12.05 predecessor set to non-existent (random) operation ID blocks execution", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const fakeOpId = ethers.keccak256(ethers.toUtf8Bytes("does-not-exist"));
        const salt = ethers.id("fake-pred");

        await timelock.connect(owner).schedule(proxyAddr, 0, data, fakeOpId, salt, DELAY);
        await time.increase(DELAY);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, fakeOpId, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexecutedPredecessor");
    });
});

describe("Cat12 -- Cancel + Re-schedule Races", function () {

    it("12.06 cancel then re-schedule same (target,value,data,pred,salt) and execute works", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("cancel-resched");
        const pred = ethers.ZeroHash;

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, pred, salt, DELAY);
        expect(await timelock.isOperationPending(opId)).to.be.true;

        // Cancel
        await timelock.connect(owner).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;

        // Re-schedule with exact same params
        await timelock.connect(owner).schedule(proxyAddr, 0, data, pred, salt, DELAY);
        expect(await timelock.isOperationPending(opId)).to.be.true;

        await time.increase(DELAY);
        await timelock.connect(owner).execute(proxyAddr, 0, data, pred, salt);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.07 cancel after delay elapsed, re-schedule, must wait full delay again", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("cancel-after-ready");
        const pred = ethers.ZeroHash;

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, pred, salt, DELAY);
        await time.increase(DELAY);

        // Op is ready but we cancel it
        const opId = await timelock.hashOperation(proxyAddr, 0, data, pred, salt);
        expect(await timelock.isOperationReady(opId)).to.be.true;
        await timelock.connect(owner).cancel(opId);

        // Re-schedule
        await timelock.connect(owner).schedule(proxyAddr, 0, data, pred, salt, DELAY);

        // Immediate execution should fail -- new delay hasn't elapsed
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, pred, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // Wait and execute
        await time.increase(DELAY);
        await timelock.connect(owner).execute(proxyAddr, 0, data, pred, salt);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.08 cancel an already-executed (done) operation reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("cancel-done");
        const pred = ethers.ZeroHash;

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, pred, salt, DELAY);
        await time.increase(DELAY);
        await timelock.connect(owner).execute(proxyAddr, 0, data, pred, salt);

        expect(await timelock.isOperationDone(opId)).to.be.true;

        // Can't cancel a done operation
        await expect(
            timelock.connect(owner).cancel(opId),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("12.09 execute an already-done operation reverts (no replay)", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("double-exec");
        const pred = ethers.ZeroHash;

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, pred, salt, DELAY);
        await time.increase(DELAY);
        await timelock.connect(owner).execute(proxyAddr, 0, data, pred, salt);

        // Second execute must revert
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, pred, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });
});

describe("Cat12 -- Salt Collision & Double-Schedule", function () {

    it("12.10 double-schedule exact same params reverts (already pending)", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("dup-salt");

        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, DELAY);

        await expect(
            timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, DELAY),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("12.11 same (target,data) with different salts produces different opIds -- both schedulable", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const saltA = ethers.id("salt-A");
        const saltB = ethers.id("salt-B");

        const opIdA = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, saltA, DELAY);
        const opIdB = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, saltB, DELAY);

        expect(opIdA).to.not.equal(opIdB);
        expect(await timelock.isOperationPending(opIdA)).to.be.true;
        expect(await timelock.isOperationPending(opIdB)).to.be.true;
    });

    it("12.12 different predecessors produce different opIds for same (target,data,salt)", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("same-salt-diff-pred");

        // Schedule first with no predecessor
        const opIdA = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);

        // Use opIdA as predecessor for a different "version" -- different predecessor = different opId
        // But same salt + same data + different predecessor
        const opIdB = await timelock.hashOperation(proxyAddr, 0, data, opIdA, salt);
        expect(opIdA).to.not.equal(opIdB);

        // Second schedule with predecessor = opIdA should work (different opId)
        await timelock.connect(owner).schedule(proxyAddr, 0, data, opIdA, salt, DELAY);
        expect(await timelock.isOperationPending(opIdB)).to.be.true;
    });

    it("12.13 attacker cannot front-run a legitimate schedule by using the same salt", async function () {
        // If attacker has PROPOSER_ROLE, they could schedule the same op.
        // But without PROPOSER_ROLE, they can't schedule at all.
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("frontrun-salt");

        await expect(
            timelock.connect(attacker).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, DELAY),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });
});

describe("Cat12 -- Timing: Execute Before / After Delay", function () {

    it("12.14 execute 1 second before delay elapses reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("1sec-early");

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY - 2); // 2 seconds before delay (increase is off-by-one safe)

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("12.15 execute at exactly delay boundary succeeds", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("exact-delay");

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.not.be.reverted;
    });

    it("12.16 execute long after delay still succeeds (no expiry)", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("long-after");

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY * 1000); // 1000x the delay

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.not.be.reverted;
    });

    it("12.17 zero-delay timelock: schedule and execute in consecutive txs (same block via mine)", async function () {
        const { escrow, owner, stranger, timelock } = await deployZeroDelay();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("zero-delay-instant");

        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, 0);
        // With minDelay=0, operation is immediately ready
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt);

        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.18 schedule with delay > minDelay still enforces the full custom delay", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(60); // 60s minDelay
        const proxyAddr = await escrow.getAddress();

        const customDelay = 7200; // 2 hours, well above minDelay
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("custom-long-delay");

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, customDelay);

        // Advance past minDelay but not past customDelay
        await time.increase(60);

        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // Advance the rest
        await time.increase(customDelay - 60);
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt);
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.19 schedule with delay < minDelay reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(3600);
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("too-short-delay");

        await expect(
            timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, 1800), // half of minDelay
        ).to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
    });
});

describe("Cat12 -- Role Confusion & Access Control", function () {

    it("12.20 non-proposer cannot schedule", async function () {
        const { escrow, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);

        await expect(
            timelock.connect(stranger).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("x"), DELAY),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("12.21 PROPOSER cannot cancel without CANCELLER_ROLE if roles are separated", async function () {
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const PROPOSER_ROLE  = await timelock.PROPOSER_ROLE();
        const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();

        // Grant attacker PROPOSER_ROLE only (not CANCELLER_ROLE)
        // First revoke attacker's potential CANCELLER_ROLE (they shouldn't have it anyway)
        // Grant PROPOSER to attacker
        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);

        // Attacker schedules
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);
        const salt = ethers.id("attacker-schedule");
        const opId = await scheduleOp(timelock, attacker, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);

        // Attacker tries to cancel -- in OZ v5, PROPOSER_ROLE also gets CANCELLER_ROLE by default.
        // But if admin explicitly revokes CANCELLER_ROLE from attacker:
        await timelock.connect(owner).revokeRole(CANCELLER_ROLE, attacker.address);

        await expect(
            timelock.connect(attacker).cancel(opId),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("12.22 non-admin cannot grant PROPOSER_ROLE", async function () {
        const { stranger, attacker, timelock } = await deployWithTimelock();
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();

        await expect(
            timelock.connect(stranger).grantRole(PROPOSER_ROLE, attacker.address),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("12.23 executor role = ZeroAddress means anyone can execute", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("anyone-executes");

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);

        // stranger (not a named executor) can execute because ZeroAddress is executor
        await expect(
            timelock.connect(stranger).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.not.be.reverted;
    });

    it("12.24 with specific executor, non-executor cannot execute", async function () {
        const base = await deployBase();
        const { owner, stranger, attacker } = base;

        const TimelockFactory = await ethers.getContractFactory("TimelockController");
        const timelock = (await TimelockFactory.deploy(
            DELAY,
            [owner.address],
            [owner.address],   // Only owner can execute (not ZeroAddress)
            owner.address,
        )) as unknown as TimelockController;

        await base.escrow.connect(owner).transferOwnership(await timelock.getAddress());

        const proxyAddr = await base.escrow.getAddress();
        const data = base.escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("restricted-executor");

        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);

        // attacker cannot execute
        await expect(
            timelock.connect(attacker).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");

        // owner can
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt);
    });

    it("12.25 admin renounces TIMELOCK_ADMIN_ROLE -- no more role grants", async function () {
        const { owner, attacker, timelock } = await deployWithTimelock();

        const ADMIN_ROLE    = ethers.ZeroHash;
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();

        // Renounce admin
        await timelock.connect(owner).renounceRole(ADMIN_ROLE, owner.address);

        // Now owner cannot grant roles
        await expect(
            timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });

    it("12.26 admin grants PROPOSER_ROLE to attacker -- attacker can schedule malicious upgrade", async function () {
        const { escrow, owner, attacker, timelock } = await deployWithTimelock();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);

        // Attacker deploys a new impl and schedules an upgrade
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const maliciousImpl = await Escrow.deploy();
        await maliciousImpl.waitForDeployment();

        const proxyAddr = await escrow.getAddress();
        const data = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await maliciousImpl.getAddress(),
            "0x",
        ]);
        const salt = ethers.id("malicious-upgrade");

        // Attacker can schedule
        const opId = await scheduleOp(timelock, attacker, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        expect(await timelock.isOperationPending(opId)).to.be.true;

        // This is the governance design working: the delay window gives admin time to cancel
        await timelock.connect(owner).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;
    });

    it("12.27 attacker with PROPOSER_ROLE can schedule but admin can revoke role to prevent future schedules", async function () {
        const { escrow, owner, attacker, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);

        // Attacker schedules
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);
        await scheduleOp(timelock, attacker, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("s1"), DELAY);

        // Admin revokes
        await timelock.connect(owner).revokeRole(PROPOSER_ROLE, attacker.address);

        // Attacker can no longer schedule
        await expect(
            timelock.connect(attacker).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("s2"), DELAY),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });
});

describe("Cat12 -- State Machine (Pending -> Ready -> Done)", function () {

    it("12.28 fresh operation: not pending, not ready, not done, timestamp=0", async function () {
        const { timelock } = await deployWithTimelock();
        const randomId = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));

        expect(await timelock.isOperationPending(randomId)).to.be.false;
        expect(await timelock.isOperationReady(randomId)).to.be.false;
        expect(await timelock.isOperationDone(randomId)).to.be.false;
        expect(await timelock.getTimestamp(randomId)).to.equal(0n);
    });

    it("12.29 after schedule: pending=true, ready=false, done=false, timestamp == block.timestamp + delay", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("state-pending");

        const schedTx = await timelock.connect(owner).schedule(proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        const schedRcpt = await schedTx.wait();
        const schedBlock = await ethers.provider.getBlock(schedRcpt!.blockNumber);
        const opId = await timelock.hashOperation(proxyAddr, 0n, data, ethers.ZeroHash, salt);

        expect(await timelock.isOperationPending(opId)).to.be.true;
        expect(await timelock.isOperationReady(opId)).to.be.false;
        expect(await timelock.isOperationDone(opId)).to.be.false;
        // OZ TimelockController: getTimestamp(opId) = block.timestamp_at_schedule + delay.
        expect(await timelock.getTimestamp(opId)).to.equal(BigInt(schedBlock!.timestamp) + BigInt(DELAY));
    });

    it("12.30 after delay: pending=true, ready=true, done=false", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("state-ready");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);

        expect(await timelock.isOperationPending(opId)).to.be.true;
        expect(await timelock.isOperationReady(opId)).to.be.true;
        expect(await timelock.isOperationDone(opId)).to.be.false;
    });

    it("12.31 after execute: pending=false, ready=false, done=true, timestamp=1", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("state-done");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt);

        expect(await timelock.isOperationPending(opId)).to.be.false;
        expect(await timelock.isOperationReady(opId)).to.be.false;
        expect(await timelock.isOperationDone(opId)).to.be.true;
        // OZ stores timestamp=1 for done operations
        expect(await timelock.getTimestamp(opId)).to.equal(1n);
    });

    it("12.32 after cancel: pending=false, ready=false, done=false, timestamp=0", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("state-cancelled");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await timelock.connect(owner).cancel(opId);

        expect(await timelock.isOperationPending(opId)).to.be.false;
        expect(await timelock.isOperationReady(opId)).to.be.false;
        expect(await timelock.isOperationDone(opId)).to.be.false;
        expect(await timelock.getTimestamp(opId)).to.equal(0n);
    });
});

describe("Cat12 -- Batch Operations", function () {

    it("12.33 scheduleBatch + executeBatch: all valid ops execute atomically", async function () {
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data1 = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const data2 = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);
        const salt = ethers.id("batch-ok");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr, proxyAddr],
            [0, 0],
            [data1, data2],
            ethers.ZeroHash,
            salt,
            DELAY,
        );

        await time.increase(DELAY);

        await timelock.connect(owner).executeBatch(
            [proxyAddr, proxyAddr],
            [0, 0],
            [data1, data2],
            ethers.ZeroHash,
            salt,
        );

        // Last operation wins -- feeRecipient should be attacker
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });

    it("12.34 executeBatch with one reverting op reverts the entire batch", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        // Good call
        const data1 = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        // Bad call: setFeeRecipient(0x0) -> reverts with ZeroAddress
        const data2 = escrow.interface.encodeFunctionData("setFeeRecipient", [ethers.ZeroAddress]);
        const salt = ethers.id("batch-revert");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr, proxyAddr],
            [0, 0],
            [data1, data2],
            ethers.ZeroHash,
            salt,
            DELAY,
        );

        await time.increase(DELAY);

        // The second call will revert, so entire batch fails
        await expect(
            timelock.connect(owner).executeBatch(
                [proxyAddr, proxyAddr],
                [0, 0],
                [data1, data2],
                ethers.ZeroHash,
                salt,
            ),
        ).to.be.revertedWithCustomError(escrow, "ZeroAddress"); // inner revert re-thrown directly in OZ v5
    });

    it("12.35 batch with predecessor chain: batch B depends on batch A", async function () {
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const dataA = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const dataB = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);

        const saltA = ethers.id("batch-a");
        const saltB = ethers.id("batch-b");

        // Schedule batch A
        await timelock.connect(owner).scheduleBatch(
            [proxyAddr], [0], [dataA], ethers.ZeroHash, saltA, DELAY,
        );
        const opIdA = await timelock.hashOperationBatch(
            [proxyAddr], [0], [dataA], ethers.ZeroHash, saltA,
        );

        // Schedule batch B with predecessor = A
        await timelock.connect(owner).scheduleBatch(
            [proxyAddr], [0], [dataB], opIdA, saltB, DELAY,
        );

        await time.increase(DELAY);

        // B before A fails (predecessor A not done)
        await expect(
            timelock.connect(owner).executeBatch([proxyAddr], [0], [dataB], opIdA, saltB),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexecutedPredecessor");

        // Execute A, then B
        await timelock.connect(owner).executeBatch([proxyAddr], [0], [dataA], ethers.ZeroHash, saltA);
        await timelock.connect(owner).executeBatch([proxyAddr], [0], [dataB], opIdA, saltB);
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });

    it("12.36 double-scheduleBatch with same params reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("batch-dup");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt, DELAY,
        );

        await expect(
            timelock.connect(owner).scheduleBatch(
                [proxyAddr], [0], [data], ethers.ZeroHash, salt, DELAY,
            ),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("12.37 cancel batch then re-schedule and execute", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("batch-cancel-resched");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt, DELAY,
        );

        const opId = await timelock.hashOperationBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt,
        );

        await timelock.connect(owner).cancel(opId);

        // Re-schedule
        await timelock.connect(owner).scheduleBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt, DELAY,
        );

        await time.increase(DELAY);
        await timelock.connect(owner).executeBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt,
        );

        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.38 executeBatch before delay reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("batch-too-early");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt, DELAY,
        );

        await expect(
            timelock.connect(owner).executeBatch(
                [proxyAddr], [0], [data], ethers.ZeroHash, salt,
            ),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });
});

describe("Cat12 -- Timelock <-> Escrow Commit Deadline Interactions", function () {

    it("12.39 upgrade scheduled during active commit -- commit still settles after upgrade executes", async function () {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock(10, 30n); // short delay, large SLA
        const proxyAddr = await escrow.getAddress();

        // Create a commit with SLA_BLOCKS=2
        const commitId = await makeCommit(escrow, user, QUOTE_ID, "inflight-upgrade");

        // Schedule an upgrade through timelock
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await newImpl.getAddress(), "0x",
        ]);
        const salt = ethers.id("inflight-upgrade");
        await timelock.connect(owner).schedule(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt, 10);

        // Execute upgrade (after 10s delay)
        await time.increase(10);
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt);

        // Commit is still in-flight -- bundler should be able to settle
        await expect(escrow.connect(bundler).settle(commitId)).to.not.be.reverted;
    });

    it("12.40 setFeeRecipient via timelock: new commit after the change credits fee to new feeRecipient at commit time (with PROTOCOL_FEE_WEI=0 no fee flows to either)", async function () {
        const { escrow, owner, bundler, user, stranger, feeRecipient, timelock, QUOTE_ID } = await deployWithTimelock(10, 30n);
        const proxyAddr = await escrow.getAddress();

        // Create commit 1
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "fee-change-1");

        // Schedule fee recipient change
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("fee-mid"), 10);
        await time.increase(10);

        // Settle commit 1 -- fee goes to original feeRecipient
        await escrow.connect(bundler).settle(cid1);
        const feeOld = await escrow.pendingWithdrawals(feeRecipient.address);

        // Execute fee recipient change
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("fee-mid"));

        // Create and settle commit 2 -- fee goes to new feeRecipient (stranger)
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "fee-change-2");
        await escrow.connect(bundler).settle(cid2);

        const feeNew = await escrow.pendingWithdrawals(stranger.address);
        // PROTOCOL_FEE_WEI=0: stranger (new feeRecipient) gets 0 from settle
        expect(feeNew).to.equal(0n);
        // Old recipient's pending should be unchanged from cid1 (also 0)
        expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(feeOld);
    });

    it("12.41 timelock delay longer than SLA window: commit expires while admin op is pending", async function () {
        const { escrow, owner, bundler, user, stranger, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock(86400); // 1 day
        const proxyAddr = await escrow.getAddress();

        // SLA is 2 blocks (~4s on Base), timelock delay is 1 day
        const commitId = await makeCommit(escrow, user, QUOTE_ID, "expires-during-delay");

        // Schedule a setFeeRecipient with 1-day delay
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("long-wait"), 86400);

        // Commit expires while timelock op is still pending
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));

        // User can claim refund -- escrow operations are independent of timelock
        await expect(escrow.connect(user).claimRefund(commitId)).to.not.be.reverted;
    });

    it("12.42 upgrade while bundler has locked collateral -- collateral survives upgrade", async function () {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock(10, 30n);
        const proxyAddr = await escrow.getAddress();

        // Create commit (locks collateral)
        const commitId = await makeCommit(escrow, user, QUOTE_ID, "collateral-upgrade");
        const lockedBefore = await escrow.lockedOf(bundler.address);
        expect(lockedBefore).to.be.greaterThan(0n);

        // Upgrade
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await newImpl.getAddress(), "0x",
        ]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("coll-upg"), 10);

        // Locked collateral persists
        expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);

        // Settle still works
        await escrow.connect(bundler).settle(commitId);
        expect(await escrow.lockedOf(bundler.address)).to.equal(0n);
    });

    it("12.43 batch: upgrade + setFeeRecipient in single atomic batch", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await newImpl.waitForDeployment();

        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await newImpl.getAddress(), "0x",
        ]);
        const feeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("atomic-batch");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr, proxyAddr],
            [0, 0],
            [upgradeData, feeData],
            ethers.ZeroHash,
            salt,
            DELAY,
        );

        await time.increase(DELAY);

        await timelock.connect(owner).executeBatch(
            [proxyAddr, proxyAddr],
            [0, 0],
            [upgradeData, feeData],
            ethers.ZeroHash,
            salt,
        );

        expect(await escrow.feeRecipient()).to.equal(stranger.address);
        const implAddr = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAddr).to.equal(await newImpl.getAddress());
    });
});

describe("Cat12 -- Self-Governance (updateDelay)", function () {

    it("12.44 only timelock itself can call updateDelay", async function () {
        const { owner, timelock } = await deployWithTimelock();

        // Direct call from admin reverts -- only timelock itself can call updateDelay
        await expect(
            timelock.connect(owner).updateDelay(100),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnauthorizedCaller")
          .withArgs(owner.address);
    });

    it("12.45 updateDelay via timelock schedule+execute changes minDelay", async function () {
        const { owner, timelock } = await deployWithTimelock(60);

        const timelockAddr = await timelock.getAddress();
        const newDelay = 7200;
        const data = timelock.interface.encodeFunctionData("updateDelay", [newDelay]);
        const salt = ethers.id("update-delay");

        await scheduleOp(timelock, owner, timelockAddr, 0n, data, ethers.ZeroHash, salt, 60);
        await time.increase(60);
        await timelock.connect(owner).execute(timelockAddr, 0, data, ethers.ZeroHash, salt);

        expect(await timelock.getMinDelay()).to.equal(BigInt(newDelay));
    });

    it("12.46 after updateDelay, new schedules must respect the new minDelay", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(60);
        const timelockAddr = await timelock.getAddress();
        const proxyAddr = await escrow.getAddress();

        // Increase delay to 1 hour
        const updateData = timelock.interface.encodeFunctionData("updateDelay", [3600]);
        await scheduleAndExecute(timelock, owner, owner, timelockAddr, 0n, updateData, ethers.ZeroHash, ethers.id("inc-delay"), 60);

        // Now scheduling with old delay (60s) should revert
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await expect(
            timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("old-delay"), 60),
        ).to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");

        // Scheduling with new delay (3600) should work
        await expect(
            timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("new-delay"), 3600),
        ).to.not.be.reverted;
    });

    it("12.47 reduce delay to 0 via self-governance, then schedule+execute instantly", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(60);
        const timelockAddr = await timelock.getAddress();
        const proxyAddr = await escrow.getAddress();

        // Reduce delay to 0
        const updateData = timelock.interface.encodeFunctionData("updateDelay", [0]);
        await scheduleAndExecute(timelock, owner, owner, timelockAddr, 0n, updateData, ethers.ZeroHash, ethers.id("zero-it"), 60);

        expect(await timelock.getMinDelay()).to.equal(0n);

        // Now schedule and execute instantly
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("instant"), 0);
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("instant"));
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.48 attacker with proposer role cannot call updateDelay directly (only timelock can)", async function () {
        const { owner, attacker, timelock } = await deployWithTimelock();
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);

        // Even with PROPOSER_ROLE, direct updateDelay call fails
        await expect(
            timelock.connect(attacker).updateDelay(0),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnauthorizedCaller")
          .withArgs(attacker.address);
    });
});

describe("Cat12 -- Ownership Transfer & Dual-Timelock Scenarios", function () {

    it("12.49 second timelock cannot upgrade escrow without ownership", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock();

        // Deploy a second timelock
        const TimelockFactory = await ethers.getContractFactory("TimelockController");
        const timelock2 = (await TimelockFactory.deploy(
            0, [owner.address], [ethers.ZeroAddress], owner.address,
        )) as unknown as TimelockController;

        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await newImpl.getAddress(), "0x",
        ]);

        const salt = ethers.id("second-tl-upgrade");
        await timelock2.connect(owner).schedule(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt, 0);
        // Execution should revert because timelock2 is not the owner
        await expect(
            timelock2.connect(owner).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount"); // re-thrown from escrow
    });

    it("12.50 transfer ownership from timelock1 to timelock2 via timelock1", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        // Deploy timelock2
        const TimelockFactory = await ethers.getContractFactory("TimelockController");
        const timelock2 = (await TimelockFactory.deploy(
            10, [owner.address], [ethers.ZeroAddress], owner.address,
        )) as unknown as TimelockController;

        const tl2Addr = await timelock2.getAddress();

        // Schedule transferOwnership through timelock1
        const data = escrow.interface.encodeFunctionData("transferOwnership", [tl2Addr]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("transfer-own"), 10);

        expect(await escrow.owner()).to.equal(tl2Addr);

        // Old timelock can no longer execute admin functions
        const feeData = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        await timelock.connect(owner).schedule(proxyAddr, 0, feeData, ethers.ZeroHash, ethers.id("old-tl"), 10);
        await time.increase(10);
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, feeData, ethers.ZeroHash, ethers.id("old-tl")),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount"); // re-thrown from escrow

        // New timelock can
        await scheduleAndExecute(timelock2, owner, owner, proxyAddr, 0n, feeData, ethers.ZeroHash, ethers.id("new-tl"), 10);
        expect(await escrow.feeRecipient()).to.equal(owner.address);
    });

    it("12.51 transferOwnership to EOA via timelock -- EOA gains direct upgrade power", async function () {
        const { escrow, owner, attacker, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        // Transfer to attacker EOA
        const data = escrow.interface.encodeFunctionData("transferOwnership", [attacker.address]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("eoa-own"), 10);

        expect(await escrow.owner()).to.equal(attacker.address);

        // Attacker can now directly call onlyOwner functions -- no timelock delay
        await escrow.connect(attacker).setFeeRecipient(attacker.address);
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });

    it("12.52 renounceOwnership via timelock reverts RenounceOwnershipDisabled -- owner preserved (T22)", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("renounceOwnership", []);
        // scheduleAndExecute wraps the call -- OZ v5 bubbles the inner revert data
        await expect(
            scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("renounce"), 10),
        ).to.be.revertedWithCustomError(escrow, "RenounceOwnershipDisabled");

        // Owner remains the timelock -- not zeroed
        expect(await escrow.owner()).to.equal(await timelock.getAddress());
    });
});

describe("Cat12 -- ETH Forwarding Through Timelock", function () {

    it("12.53 send ETH to timelock, then execute a tx that deposits to escrow", async function () {
        const { escrow, owner, bundler, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();
        const timelockAddr = await timelock.getAddress();

        // Send ETH to timelock
        await owner.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        const tlBal = await ethers.provider.getBalance(timelockAddr);
        expect(tlBal).to.be.greaterThanOrEqual(ethers.parseEther("1"));

        // Schedule a deposit to escrow from timelock's balance
        // The timelock itself would be the depositor
        const depositData = escrow.interface.encodeFunctionData("deposit");
        const depositValue = ethers.parseEther("0.5");
        const salt = ethers.id("eth-forward");

        await timelock.connect(owner).schedule(proxyAddr, depositValue, depositData, ethers.ZeroHash, salt, 10);
        await time.increase(10);
        await timelock.connect(owner).execute(proxyAddr, depositValue, depositData, ethers.ZeroHash, salt);

        // Timelock is now a "bundler" with deposited collateral
        expect(await escrow.deposited(timelockAddr)).to.equal(depositValue);
    });

    it("12.54 timelock execute with value but target has no payable function -> reverts", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();
        const timelockAddr = await timelock.getAddress();

        // Send ETH to timelock
        await owner.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });

        // setFeeRecipient is not payable -- sending value should revert
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [owner.address]);
        const salt = ethers.id("eth-to-nonpayable");

        await timelock.connect(owner).schedule(proxyAddr, ethers.parseEther("0.1"), data, ethers.ZeroHash, salt, 10);
        await time.increase(10);

        // non-payable function called with value -> inner call reverts with no data -> OZ Address throws FailedCall
        await expect(
            timelock.connect(owner).execute(proxyAddr, ethers.parseEther("0.1"), data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "FailedCall");
    });
});

describe("Cat12 -- Reentrancy During Timelock Execute", function () {

    it("12.55 target contract re-enters timelock.execute during execution -- no double execution", async function () {
        const { owner, timelock } = await deployWithTimelock(10);
        const timelockAddr = await timelock.getAddress();

        // Deploy the reentry attacker
        const AttackerFactory = await ethers.getContractFactory("TimelockReentryAttacker");
        const reentrant = await AttackerFactory.deploy(timelockAddr);
        await reentrant.waitForDeployment();
        const reentrantAddr = await reentrant.getAddress();

        const triggerData = reentrant.interface.encodeFunctionData("trigger");
        const salt = ethers.id("reentrant");
        const opId = await timelock.hashOperation(reentrantAddr, 0, triggerData, ethers.ZeroHash, salt);

        // Set params so trigger() re-enters timelock.execute with the same op
        await reentrant.setParams(reentrantAddr, 0, triggerData, ethers.ZeroHash, salt);

        await timelock.connect(owner).schedule(reentrantAddr, 0, triggerData, ethers.ZeroHash, salt, 10);
        await time.increase(10);

        // In OZ v5, _afterCall marks the op done AFTER the external call.
        // The re-entry finds the op still pending and succeeds, then the outer _afterCall
        // fails because the op is already done -> entire tx reverts.
        // This prevents double execution: the op remains pending for a clean retry.
        await expect(
            timelock.connect(owner).execute(reentrantAddr, 0, triggerData, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // Entire tx rolled back -- op still pending
        expect(await timelock.isOperationPending(opId)).to.be.true;

        // Disable re-entry so a clean execute can succeed
        await reentrant.setParams(ethers.ZeroAddress, 0, "0x", ethers.ZeroHash, ethers.ZeroHash);
        await timelock.connect(owner).execute(reentrantAddr, 0, triggerData, ethers.ZeroHash, salt);
        expect(await timelock.isOperationDone(opId)).to.be.true;
        // reentryCount = 1 (single clean execution, no reentry attempted)
        expect(await reentrant.reentryCount()).to.equal(1n);
    });
});

describe("Cat12 -- Upgrade Race Conditions", function () {

    it("12.56 two competing upgrade proposals with different salts -- both execute independently; second overwrites first impl", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const impl1 = await Escrow.deploy();
        const impl2 = await Escrow.deploy();

        const data1 = escrow.interface.encodeFunctionData("upgradeToAndCall", [await impl1.getAddress(), "0x"]);
        const data2 = escrow.interface.encodeFunctionData("upgradeToAndCall", [await impl2.getAddress(), "0x"]);

        await scheduleOp(timelock, owner, proxyAddr, 0n, data1, ethers.ZeroHash, ethers.id("upg1"), DELAY);
        await scheduleOp(timelock, owner, proxyAddr, 0n, data2, ethers.ZeroHash, ethers.id("upg2"), DELAY);

        await time.increase(DELAY);

        // Execute first -- both have different salts so different opIds
        await timelock.connect(owner).execute(proxyAddr, 0, data1, ethers.ZeroHash, ethers.id("upg1"));
        const implAfter1 = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter1).to.equal(await impl1.getAddress());

        // Second is still valid -- timelock doesn't know about contract state
        // This will succeed because it's a different operation and the proxy accepts it
        await timelock.connect(owner).execute(proxyAddr, 0, data2, ethers.ZeroHash, ethers.id("upg2"));
        const implAfter2 = await upgrades.erc1967.getImplementationAddress(proxyAddr);
        expect(implAfter2).to.equal(await impl2.getAddress());
    });

    it("12.57 upgrade + immediate commit before new implementation's init -- commit uses old state", async function () {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        // Upgrade to same implementation (just testing state continuity)
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await newImpl.getAddress(), "0x",
        ]);

        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("upg-state"), 10);

        // Immediately create a commit -- should use preserved state
        const commitId = await makeCommit(escrow, user, QUOTE_ID, "post-upgrade-commit");
        await escrow.connect(bundler).settle(commitId);

        const pending = await escrow.pendingWithdrawals(bundler.address);
        // PROTOCOL_FEE_WEI=0 -> bundler receives exactly feePerOp (ONE_GWEI).
        expect(pending).to.equal(ONE_GWEI);
    });
});

describe("Cat12 -- Edge Cases & Misc Attacks", function () {

    it("12.58 schedule to address(0) target -- may not revert at schedule time but fails at execute", async function () {
        const { owner, timelock } = await deployWithTimelock();
        const salt = ethers.id("zero-target");

        // schedule to address(0) with some data
        await timelock.connect(owner).schedule(ethers.ZeroAddress, 0, "0x", ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);

        // execute -- calling address(0) with no code
        // This may succeed (empty call to EOA succeeds) or revert depending on data
        // With empty data, calling address(0) is just a transfer of 0 ETH -- it succeeds
        await expect(
            timelock.connect(owner).execute(ethers.ZeroAddress, 0, "0x", ethers.ZeroHash, salt),
        ).to.not.be.reverted;
    });

    it("12.59 schedule with max uint256 delay -- getTimestamp must not overflow", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(0);
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("max-delay");
        const maxDelay = 2n ** 255n; // Very large but not max uint256 to avoid revert on arithmetic

        // This should either succeed with a very distant timestamp or revert on overflow
        // OZ uses block.timestamp + delay which could overflow
        try {
            const schedTx = await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, maxDelay);
            const schedRcpt = await schedTx.wait();
            const schedBlock = await ethers.provider.getBlock(schedRcpt!.blockNumber);
            // If it doesn't revert, check the timestamp equals block.timestamp + maxDelay exactly
            const opId = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, salt);
            const ts = await timelock.getTimestamp(opId);
            expect(ts).to.equal(BigInt(schedBlock!.timestamp) + maxDelay);
        } catch (e: any) {
            // Overflow is acceptable behavior -- the point is it shouldn't silently produce a past timestamp
            expect(e.message).to.match(/overflow|revert/i);
        }
    });

    it("12.60 empty batch (no operations) -- scheduleBatch with empty arrays", async function () {
        const { owner, timelock } = await deployWithTimelock();
        const salt = ethers.id("empty-batch");

        // Empty batch should still produce an opId and be schedulable
        await timelock.connect(owner).scheduleBatch([], [], [], ethers.ZeroHash, salt, DELAY);

        const opId = await timelock.hashOperationBatch([], [], [], ethers.ZeroHash, salt);
        expect(await timelock.isOperationPending(opId)).to.be.true;

        await time.increase(DELAY);
        await timelock.connect(owner).executeBatch([], [], [], ethers.ZeroHash, salt);
        expect(await timelock.isOperationDone(opId)).to.be.true;
    });

    it("12.61 cancel a pending operation and verify it can never be executed", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("cancel-forever");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await timelock.connect(owner).cancel(opId);

        await time.increase(DELAY * 10);

        // Even after long delay, cannot execute a cancelled op
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    });

    it("12.62 schedule targeting timelock itself (grant role) -- self-referential operation", async function () {
        const { owner, attacker, timelock } = await deployWithTimelock(10);
        const timelockAddr = await timelock.getAddress();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        const data = timelock.interface.encodeFunctionData("grantRole", [PROPOSER_ROLE, attacker.address]);
        const salt = ethers.id("self-grant");

        await scheduleAndExecute(timelock, owner, owner, timelockAddr, 0n, data, ethers.ZeroHash, salt, 10);

        expect(await timelock.hasRole(PROPOSER_ROLE, attacker.address)).to.be.true;
    });

    it("12.63 schedule revokeRole via timelock -- proposer can revoke their own role via self-governance", async function () {
        const { owner, timelock } = await deployWithTimelock(10);
        const timelockAddr = await timelock.getAddress();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        const data = timelock.interface.encodeFunctionData("revokeRole", [PROPOSER_ROLE, owner.address]);
        const salt = ethers.id("self-revoke");

        await scheduleAndExecute(timelock, owner, owner, timelockAddr, 0n, data, ethers.ZeroHash, salt, 10);

        expect(await timelock.hasRole(PROPOSER_ROLE, owner.address)).to.be.false;

        // Owner can no longer schedule
        await expect(
            timelock.connect(owner).schedule(timelockAddr, 0, "0x", ethers.ZeroHash, ethers.id("nope"), 10),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });
});

describe("Cat12 -- Complex Multi-Step Attack Scenarios", function () {

    it("12.64 malicious proposer schedules drain: transferOwnership + upgrade in batch -- admin catches and cancels", async function () {
        const { escrow, owner, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);

        // Attacker schedules batch: transferOwnership to attacker
        const transferData = escrow.interface.encodeFunctionData("transferOwnership", [attacker.address]);
        const salt = ethers.id("drain-batch");

        await timelock.connect(attacker).scheduleBatch(
            [proxyAddr],
            [0],
            [transferData],
            ethers.ZeroHash,
            salt,
            DELAY,
        );

        const opId = await timelock.hashOperationBatch([proxyAddr], [0], [transferData], ethers.ZeroHash, salt);

        // Admin detects within delay window and cancels
        await timelock.connect(owner).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;

        // Revoke attacker's role
        await timelock.connect(owner).revokeRole(PROPOSER_ROLE, attacker.address);
    });

    it("12.65 proposer floods with many operations to hide malicious one -- all must wait full delay", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        // Schedule 20 benign operations and 1 malicious one
        for (let i = 0; i < 20; i++) {
            const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
            await timelock.connect(owner).schedule(
                proxyAddr, 0, data, ethers.ZeroHash, ethers.id(`flood-${i}`), DELAY,
            );
        }

        // The "malicious" one: transferOwnership
        const maliciousData = escrow.interface.encodeFunctionData("transferOwnership", [stranger.address]);
        await timelock.connect(owner).schedule(
            proxyAddr, 0, maliciousData, ethers.ZeroHash, ethers.id("hidden-malicious"), DELAY,
        );

        // All 21 operations must wait the full delay -- none can skip
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, maliciousData, ethers.ZeroHash, ethers.id("hidden-malicious")),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        // Cancel the malicious one
        const maliciousOpId = await timelock.hashOperation(proxyAddr, 0, maliciousData, ethers.ZeroHash, ethers.id("hidden-malicious"));
        await timelock.connect(owner).cancel(maliciousOpId);
    });

    it("12.66 schedule upgrade, then schedule setFeeRecipient dependent on upgrade -- chained governance", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [
            await newImpl.getAddress(), "0x",
        ]);
        const feeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);

        const upgradeOpId = await scheduleOp(
            timelock, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("chained-upg"), DELAY,
        );

        // Fee change depends on upgrade completing first
        await timelock.connect(owner).schedule(
            proxyAddr, 0, feeData, upgradeOpId, ethers.id("chained-fee"), DELAY,
        );

        await time.increase(DELAY);

        // Must execute in order
        await timelock.connect(owner).execute(proxyAddr, 0, upgradeData, ethers.ZeroHash, ethers.id("chained-upg"));
        await timelock.connect(owner).execute(proxyAddr, 0, feeData, upgradeOpId, ethers.id("chained-fee"));

        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.67 schedule transferOwnership -> cancel -> re-schedule with longer delay -- governance correction", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(60);
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("transferOwnership", [stranger.address]);
        const salt = ethers.id("correct-delay");

        // Schedule with min delay
        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, 60);

        // Community feedback: delay too short! Cancel and re-schedule with longer delay
        await timelock.connect(owner).cancel(opId);

        // Same salt is fine after cancel (op is Unset state)
        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, 86400); // 1 day

        // Old delay doesn't apply -- must wait full new delay
        await time.increase(60);
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        await time.increase(86400 - 60);
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt);
        expect(await escrow.owner()).to.equal(stranger.address);
    });
});

describe("Cat12 -- Escrow Functional Integrity Through Timelock Operations", function () {

    it("12.68 multiple commits survive multiple upgrades", async function () {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock(10, 50n);
        const proxyAddr = await escrow.getAddress();
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");

        // Create 3 commits
        const cids: bigint[] = [];
        for (let i = 0; i < 3; i++) {
            cids.push(await makeCommit(escrow, user, QUOTE_ID, `multi-upg-${i}`));
        }

        // Upgrade
        const impl1 = await Escrow.deploy();
        const upg1 = escrow.interface.encodeFunctionData("upgradeToAndCall", [await impl1.getAddress(), "0x"]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upg1, ethers.ZeroHash, ethers.id("mupg1"), 10);

        // Settle 2
        await escrow.connect(bundler).settle(cids[0]);
        await escrow.connect(bundler).settle(cids[1]);

        // Upgrade again
        const impl2 = await Escrow.deploy();
        const upg2 = escrow.interface.encodeFunctionData("upgradeToAndCall", [await impl2.getAddress(), "0x"]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upg2, ethers.ZeroHash, ethers.id("mupg2"), 10);

        // Settle the third
        await escrow.connect(bundler).settle(cids[2]);

        // All three settled
        for (const cid of cids) {
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.true;
        }
    });

    it("12.69 claimRefund works after upgrade (slash accounting persists)", async function () {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        const commitId = await makeCommit(escrow, user, QUOTE_ID, "refund-post-upg");
        const depositedBefore = await escrow.deposited(bundler.address);

        // Let SLA expire
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));

        // Upgrade
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [await newImpl.getAddress(), "0x"]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("refund-upg"), 10);

        // Claim refund
        await escrow.connect(user).claimRefund(commitId);
        const c = await escrow.getCommit(commitId);
        expect(c.refunded).to.be.true;

        // Collateral was slashed
        expect(await escrow.deposited(bundler.address)).to.be.lessThan(depositedBefore);
    });

    it("12.70 claimPayout works after upgrade", async function () {
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        const commitId = await makeCommit(escrow, user, QUOTE_ID, "payout-post-upg");
        await escrow.connect(bundler).settle(commitId);

        // Upgrade
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [await newImpl.getAddress(), "0x"]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("payout-upg"), 10);

        const pending = await escrow.pendingWithdrawals(bundler.address);
        // PROTOCOL_FEE_WEI=0 -> bundler receives exactly feePerOp (ONE_GWEI).
        expect(pending).to.equal(ONE_GWEI);

        await escrow.connect(bundler).claimPayout();
        expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
    });

    it("12.71 deposit() and withdraw() work after upgrade", async function () {
        const { escrow, owner, bundler, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [await newImpl.getAddress(), "0x"]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("dep-upg"), 10);

        const before = await escrow.deposited(bundler.address);
        await escrow.connect(bundler).deposit({ value: ethers.parseEther("1") });
        expect(await escrow.deposited(bundler.address)).to.equal(before + ethers.parseEther("1"));

        await escrow.connect(bundler).withdraw(ethers.parseEther("0.5"));
        expect(await escrow.deposited(bundler.address)).to.equal(before + ethers.parseEther("0.5"));
    });

    it("12.72 ETH balance invariant holds after timelock-mediated operations", async function () {
        const { escrow, owner, bundler, user, feeRecipient, stranger, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        // Create and settle a commit
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "invariant-1");
        await escrow.connect(bundler).settle(cid1);

        // Create a commit that will be refunded
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "invariant-2");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid2);

        // Upgrade
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        const upgradeData = escrow.interface.encodeFunctionData("upgradeToAndCall", [await newImpl.getAddress(), "0x"]);
        await scheduleAndExecute(timelock, owner, owner, proxyAddr, 0n, upgradeData, ethers.ZeroHash, ethers.id("inv-upg"), 10);

        // Check invariant: balance == deposited + pendingWithdrawals
        const contractBal = await ethers.provider.getBalance(proxyAddr);
        const dep = await escrow.deposited(bundler.address);
        const pendBundler = await escrow.pendingWithdrawals(bundler.address);
        const pendUser = await escrow.pendingWithdrawals(user.address);
        const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);

        expect(contractBal).to.equal(dep + pendBundler + pendUser + pendFee);
    });
});

describe("Cat12 -- getTimestamp & Long Delay Verification", function () {

    it("12.73 getTimestamp returns block.timestamp + delay for pending operation", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("check-ts");

        const tx = await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, DELAY);
        const block = await tx.wait().then(r => ethers.provider.getBlock(r!.blockNumber));

        const opId = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, salt);
        const storedTs = await timelock.getTimestamp(opId);

        // Should be block.timestamp + delay
        expect(storedTs).to.equal(BigInt(block!.timestamp) + BigInt(DELAY));
    });

    it("12.74 very long delay (1 year): operation stays pending and not ready", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(0);
        const proxyAddr = await escrow.getAddress();

        const oneYear = 365 * 24 * 3600;
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("1year");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, oneYear);

        expect(await timelock.isOperationPending(opId)).to.be.true;
        expect(await timelock.isOperationReady(opId)).to.be.false;

        // Advance 364 days -- still not ready
        await time.increase(oneYear - 86400);
        expect(await timelock.isOperationReady(opId)).to.be.false;

        // Advance the last day
        await time.increase(86400);
        expect(await timelock.isOperationReady(opId)).to.be.true;
    });
});

describe("Cat12 -- hashOperation Consistency", function () {

    it("12.75 hashOperation is deterministic: same inputs always produce same hash", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("determ");

        const hash1 = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, salt);
        const hash2 = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, salt);
        expect(hash1).to.equal(hash2);
    });

    it("12.76 hashOperation differs when any single parameter changes", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("differ");

        const baseHash = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, salt);

        // Different target
        const h1 = await timelock.hashOperation(owner.address, 0, data, ethers.ZeroHash, salt);
        expect(h1).to.not.equal(baseHash);

        // Different value
        const h2 = await timelock.hashOperation(proxyAddr, 1, data, ethers.ZeroHash, salt);
        expect(h2).to.not.equal(baseHash);

        // Different data
        const h3 = await timelock.hashOperation(proxyAddr, 0, "0x01", ethers.ZeroHash, salt);
        expect(h3).to.not.equal(baseHash);

        // Different predecessor
        const h4 = await timelock.hashOperation(proxyAddr, 0, data, ethers.id("x"), salt);
        expect(h4).to.not.equal(baseHash);

        // Different salt
        const h5 = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("y"));
        expect(h5).to.not.equal(baseHash);
    });

    it("12.77 hashOperationBatch is consistent with single-element batch", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("batch-vs-single");

        const batchHash = await timelock.hashOperationBatch(
            [proxyAddr], [0], [data], ethers.ZeroHash, salt,
        );
        const singleHash = await timelock.hashOperation(proxyAddr, 0, data, ethers.ZeroHash, salt);

        // These should NOT be equal -- batch encoding differs from single
        // (batch uses abi.encode of arrays vs abi.encode of values)
        expect(batchHash).to.not.equal(singleHash);
    });
});

describe("Cat12 -- Canceller Role Separation", function () {

    it("12.78 CANCELLER with no PROPOSER can cancel but not schedule", async function () {
        const { escrow, owner, attacker, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
        const PROPOSER_ROLE  = await timelock.PROPOSER_ROLE();

        // Grant only CANCELLER to attacker
        await timelock.connect(owner).grantRole(CANCELLER_ROLE, attacker.address);

        // Attacker cannot schedule
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await expect(
            timelock.connect(attacker).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("x"), DELAY),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");

        // Owner schedules, attacker cancels
        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("y"), DELAY);
        await timelock.connect(attacker).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;
    });

    it("12.79 cancel a ready (delay passed) operation", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("cancel-ready");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);
        expect(await timelock.isOperationReady(opId)).to.be.true;

        // Cancel it even though it's ready
        await timelock.connect(owner).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;
        expect(await timelock.isOperationReady(opId)).to.be.false;
    });

    it("12.80 stranger without CANCELLER_ROLE cannot cancel", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("stranger-cancel");

        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);

        await expect(
            timelock.connect(stranger).cancel(opId),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
    });
});

describe("Cat12 -- Timelock as Escrow Owner: onlyOwner Function Coverage", function () {

    it("12.81 setFeeRecipient(address(0)) via timelock reverts in escrow (ZeroAddress)", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [ethers.ZeroAddress]);
        const salt = ethers.id("zero-fee");

        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, 10);
        await time.increase(10);

        // The inner call reverts with ZeroAddress, re-thrown directly in OZ v5
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("12.82 upgradeToAndCall with invalid implementation via timelock reverts", async function () {
        const { escrow, owner, timelock } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        // Try to upgrade to an EOA (not a contract) -- should revert
        const data = escrow.interface.encodeFunctionData("upgradeToAndCall", [owner.address, "0x"]);
        const salt = ethers.id("bad-impl");

        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, salt, 10);
        await time.increase(10);

        // EOA upgrade: ABI-decode of empty return fails with no data -> timelock wraps as FailedCall
        await expect(
            timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "FailedCall");
    });

    it("12.83 direct owner call on escrow reverts when timelock is owner", async function () {
        const { escrow, owner, stranger } = await deployWithTimelock();

        await expect(
            escrow.connect(owner).setFeeRecipient(stranger.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

        await expect(
            escrow.connect(stranger).setFeeRecipient(stranger.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });
});

describe("Cat12 -- Multiple Proposers", function () {

    it("12.84 two proposers can both schedule operations", async function () {
        const { escrow, owner, attacker, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);

        const data1 = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const data2 = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);

        await scheduleOp(timelock, owner, proxyAddr, 0n, data1, ethers.ZeroHash, ethers.id("p1"), DELAY);
        await scheduleOp(timelock, attacker, proxyAddr, 0n, data2, ethers.ZeroHash, ethers.id("p2"), DELAY);

        await time.increase(DELAY);

        // Both execute
        await timelock.connect(owner).execute(proxyAddr, 0, data1, ethers.ZeroHash, ethers.id("p1"));
        await timelock.connect(owner).execute(proxyAddr, 0, data2, ethers.ZeroHash, ethers.id("p2"));
    });

    it("12.85 proposer A schedules, proposer B cancels (if B has CANCELLER_ROLE)", async function () {
        const { escrow, owner, attacker, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const PROPOSER_ROLE  = await timelock.PROPOSER_ROLE();
        const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();

        await timelock.connect(owner).grantRole(PROPOSER_ROLE, attacker.address);
        // In OZ v5, granting PROPOSER_ROLE also grants CANCELLER_ROLE. But let's be explicit:
        await timelock.connect(owner).grantRole(CANCELLER_ROLE, attacker.address);

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const salt = ethers.id("cross-cancel");

        // Owner schedules
        const opId = await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, salt, DELAY);

        // Attacker (with CANCELLER_ROLE) cancels owner's operation!
        await timelock.connect(attacker).cancel(opId);
        expect(await timelock.isOperationPending(opId)).to.be.false;
    });

    it("12.86 one proposer schedules conflicting operations -- last executed wins", async function () {
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data1 = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const data2 = escrow.interface.encodeFunctionData("setFeeRecipient", [attacker.address]);

        await scheduleOp(timelock, owner, proxyAddr, 0n, data1, ethers.ZeroHash, ethers.id("c1"), DELAY);
        await scheduleOp(timelock, owner, proxyAddr, 0n, data2, ethers.ZeroHash, ethers.id("c2"), DELAY);

        await time.increase(DELAY);

        await timelock.connect(owner).execute(proxyAddr, 0, data1, ethers.ZeroHash, ethers.id("c1"));
        expect(await escrow.feeRecipient()).to.equal(stranger.address);

        await timelock.connect(owner).execute(proxyAddr, 0, data2, ethers.ZeroHash, ethers.id("c2"));
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });
});

describe("Cat12 -- Batch Edge Cases", function () {

    it("12.87 batch with mismatched array lengths reverts at schedule time", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);

        // 2 targets but only 1 payload
        await expect(
            timelock.connect(owner).scheduleBatch(
                [proxyAddr, proxyAddr], [0, 0], [data], ethers.ZeroHash, ethers.id("mismatch"), DELAY,
            ),
        ).to.be.revertedWithCustomError(timelock, "TimelockInvalidOperationLength");
    });

    it("12.88 batch with mismatched values array length reverts", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);

        await expect(
            timelock.connect(owner).scheduleBatch(
                [proxyAddr], [0, 0], [data], ethers.ZeroHash, ethers.id("mismatch2"), DELAY,
            ),
        ).to.be.revertedWithCustomError(timelock, "TimelockInvalidOperationLength");
    });

    it("12.89 large batch (50 ops) all targeting setFeeRecipient", async function () {
        const { escrow, owner, stranger, attacker, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        const targets: string[] = [];
        const values: number[] = [];
        const payloads: string[] = [];

        for (let i = 0; i < 50; i++) {
            targets.push(proxyAddr);
            values.push(0);
            payloads.push(
                escrow.interface.encodeFunctionData("setFeeRecipient", [
                    i % 2 === 0 ? stranger.address : attacker.address,
                ]),
            );
        }

        const salt = ethers.id("big-batch");

        await timelock.connect(owner).scheduleBatch(targets, values, payloads, ethers.ZeroHash, salt, DELAY);
        await time.increase(DELAY);
        await timelock.connect(owner).executeBatch(targets, values, payloads, ethers.ZeroHash, salt);

        // Last call wins -- index 49 is odd so attacker
        expect(await escrow.feeRecipient()).to.equal(attacker.address);
    });

    it("12.90 batch mixing escrow and timelock self-ops", async function () {
        const { escrow, owner, stranger, timelock } = await deployWithTimelock(60);
        const proxyAddr = await escrow.getAddress();
        const timelockAddr = await timelock.getAddress();

        const feeData = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        const delayData = timelock.interface.encodeFunctionData("updateDelay", [120]);
        const salt = ethers.id("mixed-batch");

        await timelock.connect(owner).scheduleBatch(
            [proxyAddr, timelockAddr],
            [0, 0],
            [feeData, delayData],
            ethers.ZeroHash,
            salt,
            60,
        );

        await time.increase(60);

        await timelock.connect(owner).executeBatch(
            [proxyAddr, timelockAddr],
            [0, 0],
            [feeData, delayData],
            ethers.ZeroHash,
            salt,
        );

        expect(await escrow.feeRecipient()).to.equal(stranger.address);
        expect(await timelock.getMinDelay()).to.equal(120n);
    });
});

describe("Cat12 -- Timelock Receives ETH", function () {

    it("12.91 timelock can receive ETH directly", async function () {
        const { owner, timelock } = await deployWithTimelock();
        const timelockAddr = await timelock.getAddress();

        await owner.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        const bal = await ethers.provider.getBalance(timelockAddr);
        expect(bal).to.be.greaterThanOrEqual(ethers.parseEther("1"));
    });

    it("12.92 timelock forwards ETH via execute with value", async function () {
        const { owner, stranger, timelock } = await deployWithTimelock(10);
        const timelockAddr = await timelock.getAddress();

        await owner.sendTransaction({ to: timelockAddr, value: ethers.parseEther("2") });

        const balBefore = await ethers.provider.getBalance(stranger.address);
        const salt = ethers.id("forward-eth");

        // Send 1 ETH to stranger via timelock
        await timelock.connect(owner).schedule(stranger.address, ethers.parseEther("1"), "0x", ethers.ZeroHash, salt, 10);
        await time.increase(10);
        await timelock.connect(owner).execute(stranger.address, ethers.parseEther("1"), "0x", ethers.ZeroHash, salt);

        const balAfter = await ethers.provider.getBalance(stranger.address);
        expect(balAfter - balBefore).to.equal(ethers.parseEther("1"));
    });

    it("12.93 execute with value but timelock has insufficient balance reverts", async function () {
        const { owner, stranger, timelock } = await deployWithTimelock(10);

        const salt = ethers.id("no-funds");
        await timelock.connect(owner).schedule(stranger.address, ethers.parseEther("100"), "0x", ethers.ZeroHash, salt, 10);
        await time.increase(10);

        // Timelock has 0 ETH; EVM CALL with insufficient value fails -> FailedCall (no return data)
        await expect(
            timelock.connect(owner).execute(stranger.address, ethers.parseEther("100"), "0x", ethers.ZeroHash, salt),
        ).to.be.revertedWithCustomError(timelock, "FailedCall");
    });
});

describe("Cat12 -- TIMELOCK_ADMIN_ROLE Management", function () {

    it("12.94 timelock itself has TIMELOCK_ADMIN_ROLE by default", async function () {
        const { timelock } = await deployWithTimelock();
        const timelockAddr = await timelock.getAddress();
        const ADMIN_ROLE = ethers.ZeroHash;

        expect(await timelock.hasRole(ADMIN_ROLE, timelockAddr)).to.be.true;
    });

    it("12.95 admin can transfer admin role to new admin and then lose it", async function () {
        const { owner, attacker, timelock } = await deployWithTimelock();

        const ADMIN_ROLE    = ethers.ZeroHash;
        const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();

        // Grant admin to attacker
        await timelock.connect(owner).grantRole(ADMIN_ROLE, attacker.address);
        expect(await timelock.hasRole(ADMIN_ROLE, attacker.address)).to.be.true;

        // Renounce own admin
        await timelock.connect(owner).renounceRole(ADMIN_ROLE, owner.address);

        // Owner can no longer grant roles
        await expect(
            timelock.connect(owner).grantRole(PROPOSER_ROLE, owner.address),
        ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");

        // Attacker now controls all role assignments
        await timelock.connect(attacker).grantRole(PROPOSER_ROLE, attacker.address);
        expect(await timelock.hasRole(PROPOSER_ROLE, attacker.address)).to.be.true;
    });

    it("12.96 remove admin from timelock itself via timelock self-governance", async function () {
        const { owner, timelock } = await deployWithTimelock(10);
        const timelockAddr = await timelock.getAddress();
        const ADMIN_ROLE = ethers.ZeroHash;

        // Schedule revokeRole(ADMIN, timelock) via timelock
        const data = timelock.interface.encodeFunctionData("revokeRole", [ADMIN_ROLE, timelockAddr]);
        await scheduleAndExecute(timelock, owner, owner, timelockAddr, 0n, data, ethers.ZeroHash, ethers.id("revoke-self-admin"), 10);

        expect(await timelock.hasRole(ADMIN_ROLE, timelockAddr)).to.be.false;

        // Owner still has ADMIN_ROLE and can manage roles
        expect(await timelock.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });
});

describe("Cat12 -- Interleaved Commit/Settle with Timelock Operations", function () {

    it("12.97 commit during timelock delay, settle after timelock executes -- no interference", async function () {
        const { escrow, owner, bundler, user, stranger, timelock, QUOTE_ID } = await deployWithTimelock(100, 30n);
        const proxyAddr = await escrow.getAddress();

        // Schedule fee recipient change
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await timelock.connect(owner).schedule(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("interleave"), 100);

        // Commit during delay
        const commitId = await makeCommit(escrow, user, QUOTE_ID, "during-delay");

        // Wait and execute timelock op
        await time.increase(100);
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("interleave"));

        // Settle -- PROTOCOL_FEE_WEI=0, no fee to feeRecipient; bundler gets full fee
        await escrow.connect(bundler).settle(commitId);
        const pendingStranger = await escrow.pendingWithdrawals(stranger.address);
        expect(pendingStranger).to.equal(0n);
    });

    it("12.98 many commits + refunds + settles interleaved with upgrades -- stress test", async function () {
        const slaBlocks = 50n;
        const { escrow, owner, bundler, user, timelock, QUOTE_ID } = await deployWithTimelock(5, slaBlocks);
        const proxyAddr = await escrow.getAddress();
        const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
        const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");

        const commitIds: bigint[] = [];

        // Create 5 commits
        for (let i = 0; i < 5; i++) {
            commitIds.push(await makeCommit(escrow, user, QUOTE_ID, `stress-${i}`));
        }

        // Settle first 2
        await escrow.connect(bundler).settle(commitIds[0]);
        await escrow.connect(bundler).settle(commitIds[1]);

        // Upgrade
        const impl1 = await Escrow.deploy();
        await scheduleAndExecute(
            timelock, owner, owner, proxyAddr, 0n,
            escrow.interface.encodeFunctionData("upgradeToAndCall", [await impl1.getAddress(), "0x"]),
            ethers.ZeroHash, ethers.id("stress-upg1"), 5,
        );

        // Settle 3rd
        await escrow.connect(bundler).settle(commitIds[2]);

        // Let 4th and 5th expire (sla + SETTLEMENT_GRACE + REFUND_GRACE + 2 safety)
        await mine(Number(slaBlocks + sg + rg + 2n));
        await escrow.connect(user).claimRefund(commitIds[3]);
        await escrow.connect(user).claimRefund(commitIds[4]);

        // Upgrade again
        const impl2 = await Escrow.deploy();
        await scheduleAndExecute(
            timelock, owner, owner, proxyAddr, 0n,
            escrow.interface.encodeFunctionData("upgradeToAndCall", [await impl2.getAddress(), "0x"]),
            ethers.ZeroHash, ethers.id("stress-upg2"), 5,
        );

        // All finalized
        for (let i = 0; i < 3; i++) {
            expect((await escrow.getCommit(commitIds[i])).settled).to.be.true;
        }
        for (let i = 3; i < 5; i++) {
            expect((await escrow.getCommit(commitIds[i])).refunded).to.be.true;
        }
    });

    it("12.99 bundler withdraws idle collateral during pending timelock operation -- no conflict", async function () {
        const { escrow, owner, bundler, stranger, timelock } = await deployWithTimelock();
        const proxyAddr = await escrow.getAddress();

        // Bundler has idle collateral
        const idle = await escrow.idleBalance(bundler.address);
        expect(idle).to.be.greaterThan(0n);

        // Schedule an admin op
        const data = escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]);
        await scheduleOp(timelock, owner, proxyAddr, 0n, data, ethers.ZeroHash, ethers.id("during-withdraw"), DELAY);

        // Bundler withdraws during delay -- should work fine
        await escrow.connect(bundler).withdraw(idle);
        expect(await escrow.idleBalance(bundler.address)).to.equal(0n);

        // Timelock op still executes
        await time.increase(DELAY);
        await timelock.connect(owner).execute(proxyAddr, 0, data, ethers.ZeroHash, ethers.id("during-withdraw"));
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
    });

    it("12.100 full lifecycle: deploy -> timelock ownership -> commit -> settle -> upgrade -> commit -> refund -> payout", async function () {
        const { escrow, owner, bundler, user, feeRecipient, stranger, timelock, QUOTE_ID, sg, rg } = await deployWithTimelock(10);
        const proxyAddr = await escrow.getAddress();

        // 1. Commit and settle
        const cid1 = await makeCommit(escrow, user, QUOTE_ID, "lifecycle-1");
        await escrow.connect(bundler).settle(cid1);

        // 2. Upgrade via timelock
        const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
        const newImpl = await Escrow.deploy();
        await scheduleAndExecute(
            timelock, owner, owner, proxyAddr, 0n,
            escrow.interface.encodeFunctionData("upgradeToAndCall", [await newImpl.getAddress(), "0x"]),
            ethers.ZeroHash, ethers.id("lifecycle-upg"), 10,
        );

        // 3. Change fee recipient via timelock
        await scheduleAndExecute(
            timelock, owner, owner, proxyAddr, 0n,
            escrow.interface.encodeFunctionData("setFeeRecipient", [stranger.address]),
            ethers.ZeroHash, ethers.id("lifecycle-fee"), 10,
        );

        // 4. New commit, let it expire -> refund
        const cid2 = await makeCommit(escrow, user, QUOTE_ID, "lifecycle-2");
        await mine(Number(SLA_BLOCKS + sg + rg + 1n));
        await escrow.connect(user).claimRefund(cid2);

        // 5. Everyone claims payouts
        if ((await escrow.pendingWithdrawals(bundler.address)) > 0n) {
            await escrow.connect(bundler).claimPayout();
        }
        if ((await escrow.pendingWithdrawals(user.address)) > 0n) {
            await escrow.connect(user).claimPayout();
        }
        if ((await escrow.pendingWithdrawals(feeRecipient.address)) > 0n) {
            await escrow.connect(feeRecipient).claimPayout();
        }
        if ((await escrow.pendingWithdrawals(stranger.address)) > 0n) {
            await escrow.connect(stranger).claimPayout();
        }

        // 6. Verify final state
        expect(await escrow.owner()).to.equal(await timelock.getAddress());
        expect(await escrow.feeRecipient()).to.equal(stranger.address);
        expect((await escrow.getCommit(cid1)).settled).to.be.true;
        expect((await escrow.getCommit(cid2)).refunded).to.be.true;

        // ETH invariant
        const contractBal = await ethers.provider.getBalance(proxyAddr);
        const dep = await escrow.deposited(bundler.address);
        const pendAll =
            (await escrow.pendingWithdrawals(bundler.address)) +
            (await escrow.pendingWithdrawals(user.address)) +
            (await escrow.pendingWithdrawals(feeRecipient.address)) +
            (await escrow.pendingWithdrawals(stranger.address));
        expect(contractBal).to.equal(dep + pendAll);
    });
});

// =============================================================================
//  SECTION: T22 full governance posture verification
// =============================================================================

describe("Cat12 -- T22 governance posture: both contracts timelock-owned", function () {
    it("12.101 deployWithTimelock transfers both escrow and registry ownership to the timelock (full T22 posture)", async function () {
        const { escrow, registry, timelock } = await deployWithTimelock();
        const timelockAddr = await timelock.getAddress();
        expect(await escrow.owner()).to.equal(timelockAddr);
        expect(await registry.owner()).to.equal(timelockAddr);
    });

    it("12.102 old owner cannot call onlyOwner functions on either contract after handover", async function () {
        const { escrow, registry, owner, stranger } = await deployWithTimelock();
        await expect(
            escrow.connect(owner).setFeeRecipient(stranger.address),
        ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        await expect(
            registry.connect(owner).setBond(1n),
        ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
});
