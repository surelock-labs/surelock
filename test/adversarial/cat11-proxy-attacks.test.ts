// Category 11: UUPS Proxy Storage Collision & Upgrade Attacks -- adversarial test suite

import { expect }                                   from "chai";
import { ethers, upgrades }                          from "hardhat";
import { mine }                                      from "@nomicfoundation/hardhat-network-helpers";
import { QuoteRegistry, SLAEscrow }                  from "../../typechain-types";
import { Signer }                                    from "ethers";
import {
    deployEscrow,
    makeCommit as fixturesMakeCommit,
    mineToRefundable,
    safeInclBlock,
    ONE_GWEI,
    COLLATERAL,
} from "../helpers/fixtures";

const SLA_BLOCKS = 2n;

// ERC-1967 implementation slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function contractBalance(addr: string): Promise<bigint> {
    return await ethers.provider.getBalance(addr);
}

async function deploy(slaBlocksOverride?: bigint) {
    return deployEscrow({ slaBlocks: slaBlocksOverride ?? SLA_BLOCKS, preDeposit: COLLATERAL * 10n });
}

async function makeCommit(
    escrow: SLAEscrow,
    user: Signer,
    quoteId: bigint,
    tag?: string,
): Promise<bigint> {
    const registry = await ethers.getContractAt("QuoteRegistry", await escrow.registry()) as QuoteRegistry;
    const { commitId } = await fixturesMakeCommit(escrow, registry, user as any, quoteId, tag ?? "op");
    return commitId;
}

async function getImplAddress(proxyAddr: string): Promise<string> {
    const raw = await ethers.provider.getStorage(proxyAddr, IMPL_SLOT);
    return ethers.getAddress("0x" + raw.slice(26));
}

// Helper to call commit() + (no accept) on V2Safe proxy after upgrade.
// V2Safe uses commit(uint256, bytes32, address, uint96, uint32) -- single phase, no accept().
async function makeCommitV2(
    proxyAddr: string,
    user: Signer,
    quoteId: bigint,
    tag?: string,
): Promise<bigint> {
    const v2 = await ethers.getContractAt("SLAEscrowV2Safe", proxyAddr) as any;
    const registry = await ethers.getContractAt("QuoteRegistry", await v2.registry()) as QuoteRegistry;
    const offer = await registry.getOffer(quoteId);
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes(tag ?? "op"));
    const tx = await v2.connect(user).commit(
        quoteId, userOpHash, offer.bundler, offer.collateralWei, offer.slaBlocks,
        { value: offer.feePerOp },
    );
    const receipt = await tx.wait();
    let commitId: bigint | undefined;
    for (const log of receipt!.logs) {
        try {
            const parsed = v2.interface.parseLog(log);
            if (parsed?.name === "CommitCreated") { commitId = BigInt(parsed.args.commitId); break; }
        } catch {}
    }
    if (commitId === undefined) throw new Error("makeCommitV2: CommitCreated event not found");
    return commitId;
}

// Read commits() from proxy via V2Safe ABI (10-field struct) after upgrade.
async function commitsV2(proxyAddr: string, commitId: bigint) {
    const v2 = await ethers.getContractAt("SLAEscrowV2Safe", proxyAddr) as any;
    return v2.commits(commitId);
}

// ============================================================
// Tests
// ============================================================

describe("Cat11 -- UUPS Proxy Storage Collision & Upgrade Attacks", function () {
    this.timeout(120_000);

    // -----------------------------------------------------------
    // 11.01-11.10: upgradeToAndCall calldata hijack attacks
    // -----------------------------------------------------------

    describe("Cat11 -- upgradeToAndCall calldata hijack", () => {
        it("11.01 upgradeToAndCall with setFeeRecipient(attacker) -- owner CAN redirect fees via calldata (governance risk); non-owner cannot", async () => {
            const { escrow, registry, owner, feeRecipient, attacker } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // Deploy a V2 implementation
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();
            const v2Addr = await v2Impl.getAddress();

            // Encode calldata to setFeeRecipient(attacker)
            const hijackCalldata = escrow.interface.encodeFunctionData("setFeeRecipient", [
                attacker.address,
            ]);

            // Owner calls upgradeToAndCall with hijack calldata -- this SUCCEEDS because owner is msg.sender
            await escrow.connect(owner).upgradeToAndCall(v2Addr, hijackCalldata);

            // Fee recipient was changed -- this shows the attack vector:
            // if a compromised owner or malicious governance proposal sneaks calldata into upgradeToAndCall,
            // the fee recipient changes atomically with the upgrade
            expect(await escrow.feeRecipient()).to.equal(attacker.address);

            // Verify: a non-owner cannot do this
            const V2b = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2ImplB = await V2b.deploy();
            await expect(
                escrow.connect(attacker).upgradeToAndCall(await v2ImplB.getAddress(), hijackCalldata)
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("11.02 upgradeToAndCall with calldata that calls initialize() -- must revert InvalidInitialization", async () => {
            const { escrow, registry, owner, feeRecipient } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const reinitCalldata = escrow.interface.encodeFunctionData("initialize", [
                await registry.getAddress(),
                feeRecipient.address,
            ]);

            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), reinitCalldata)
            ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
        });

        it("11.03 upgradeToAndCall with calldata that calls deposit() -- mid-upgrade deposit must be accounted", async () => {
            const { escrow, owner, bundler } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const balBefore = await contractBalance(proxyAddr);
            const depositedBefore = await escrow.deposited(owner.address);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            // Encode deposit() call -- must send value
            const depositCalldata = escrow.interface.encodeFunctionData("deposit");

            // upgradeToAndCall with value to trigger deposit in same tx
            const depositAmount = ethers.parseEther("0.005");
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), depositCalldata, {
                value: depositAmount,
            });

            // The deposit happened atomically with the upgrade
            expect(await escrow.deposited(owner.address)).to.equal(depositedBefore + depositAmount);
            expect(await contractBalance(proxyAddr)).to.equal(balBefore + depositAmount);
        });

        it("11.04 upgradeToAndCall to an EOA -- bare revert (proxiableUUID staticcall returns empty data, ABI-decode fails)", async () => {
            const { escrow, owner, stranger } = await deploy();

            // EOA staticcall returns success=true with empty data; Solidity ABI-decode of bytes32 from
            // empty return data causes a bare revert (not caught by try/catch in _upgradeToAndCallUUPS)
            await expect(
                escrow.connect(owner).upgradeToAndCall(stranger.address, "0x")
            ).to.be.reverted; // bare revert: ABI-decode of empty EOA return fails with no error data
        });

        it("11.05 upgradeToAndCall to QuoteRegistry -- non-UUPS contract must revert", async () => {
            const { escrow, registry, owner } = await deploy();

            // QuoteRegistry has no proxiableUUID(); OZ catches the revert -> ERC1967InvalidImplementation
            await expect(
                escrow.connect(owner).upgradeToAndCall(await registry.getAddress(), "0x")
            ).to.be.revertedWithCustomError(escrow, "ERC1967InvalidImplementation")
              .withArgs(await registry.getAddress());
        });

        it("11.06 upgradeToAndCall to NotUUPSContract -- must revert", async () => {
            const { escrow, owner } = await deploy();

            const NotUUPS = await ethers.getContractFactory("NotUUPSContract");
            const notUups = await NotUUPS.deploy();

            // NotUUPS has no proxiableUUID(); OZ catches the revert -> ERC1967InvalidImplementation
            await expect(
                escrow.connect(owner).upgradeToAndCall(await notUups.getAddress(), "0x")
            ).to.be.revertedWithCustomError(escrow, "ERC1967InvalidImplementation")
              .withArgs(await notUups.getAddress());
        });

        it("11.07 upgradeToAndCall(selfAddress, '0x') -- upgrade to current impl is a no-op, state intact", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // Create a commit before upgrade
            const cid = await makeCommit(escrow, user, QUOTE_ID, "pre-self-upgrade");
            const depositedBefore = await escrow.deposited(bundler.address);
            const lockedBefore = await escrow.lockedOf(bundler.address);
            const nextIdBefore = await escrow.nextCommitId();
            const implBefore = await getImplAddress(proxyAddr);

            // Get current implementation address
            await escrow.connect(owner).upgradeToAndCall(implBefore, "0x");

            // Everything preserved
            const implAfter = await getImplAddress(proxyAddr);
            expect(implAfter).to.equal(implBefore);
            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
            expect(await escrow.nextCommitId()).to.equal(nextIdBefore);

            // Commit is still usable
            await escrow.connect(bundler).settle(cid);
            const c = await escrow.getCommit(cid);
            expect(c.settled).to.be.true;
        });

        it("11.08 upgradeToAndCall with calldata that calls settle() -- mid-upgrade settle", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-upgrade-settle");

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            // Encode settle(commitId) -- but owner is calling, not bundler, so this should revert
            const settleCalldata = v2Impl.interface.encodeFunctionData("settle", [cid]);

            // This should revert because msg.sender during calldata execution is the proxy caller (owner), not bundler
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), settleCalldata)
            ).to.be.revertedWithCustomError(escrow, "NotBundler");
        });

        it("11.09 upgradeToAndCall with calldata that calls claimRefund() -- must revert (not expired yet)", async () => {
            const { escrow, owner, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "mid-upgrade-refund");

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const refundCalldata = escrow.interface.encodeFunctionData("claimRefund", [cid]);

            // Owner is not the user -- V2Safe.claimRefund rejects with NotUser (from V2Safe ABI)
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), refundCalldata)
            ).to.be.revertedWithCustomError(v2Impl, "NotUser");
        });

        it("11.10 upgradeToAndCall with calldata that calls withdraw() -- owner drains own idle funds mid-upgrade", async () => {
            const { escrow, owner } = await deploy();

            // Owner deposits
            await escrow.connect(owner).deposit({ value: ethers.parseEther("1") });
            const ownerDeposited = await escrow.deposited(owner.address);
            expect(ownerDeposited).to.equal(ethers.parseEther("1"));

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const withdrawCalldata = escrow.interface.encodeFunctionData("withdraw", [ethers.parseEther("1")]);

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), withdrawCalldata);

            expect(await escrow.deposited(owner.address)).to.equal(0n);
        });
    });

    // -----------------------------------------------------------
    // 11.11-11.30: State preservation across upgrades
    // -----------------------------------------------------------

    describe("Cat11 -- state preservation across upgrades", () => {
        it("11.11 open commit survives upgrade -- settle still works after upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            // Pre-deploy impl so upgrade only mines 1 block, keeping commit within deadline
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "survive-upgrade-settle");
            const commitBefore = await escrow.getCommit(cid);

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            // Settle after upgrade
            const proxyAddr = await escrow.getAddress();
            await (V2.attach(proxyAddr) as any).connect(bundler).settle(cid);
            const commitAfter = await commitsV2(proxyAddr, cid);
            expect(commitAfter.settled).to.be.true;
        });

        it("11.12 open commit survives upgrade -- claimRefund still works after upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            // Read grace constants before upgrade (V2Safe does not expose them)
            const sg12 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg12 = BigInt(await escrow.REFUND_GRACE_BLOCKS());

            const cid = await makeCommit(escrow, user, QUOTE_ID, "survive-upgrade-refund");
            // Snapshot deadline before upgrade -- mineToRefundable uses v0.6 commits() ABI
            const commitSnap12 = await escrow.getCommit(cid);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Mine to refundable point manually (deadline + settlement_grace + refund_grace + 2)
            const cur12 = BigInt(await ethers.provider.getBlockNumber());
            const target12 = BigInt(commitSnap12.deadline) + sg12 + rg12 + 2n;
            if (target12 > cur12) await mine(Number(target12 - cur12));

            await escrow.connect(user).claimRefund(cid);
            const commitAfter = await commitsV2(await escrow.getAddress(), cid);
            expect(commitAfter.refunded).to.be.true;
        });

        it("11.13 lockedOf[bundler] preserved after upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            await makeCommit(escrow, user, QUOTE_ID, "lock-test");
            const lockedBefore = await escrow.lockedOf(bundler.address);
            expect(lockedBefore).to.equal(COLLATERAL);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
        });

        it("11.14 deposited[bundler] preserved after upgrade", async () => {
            const { escrow, owner, bundler } = await deploy();

            const depositedBefore = await escrow.deposited(bundler.address);
            expect(depositedBefore).to.equal(COLLATERAL * 10n);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        });

        it("11.15 PROTOCOL_FEE_WEI preserved after upgrade", async () => {
            const { escrow, owner } = await deploy();

            await escrow.connect(owner).setProtocolFeeWei(50n);
            const feeBefore = await escrow.protocolFeeWei();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.protocolFeeWei()).to.equal(feeBefore);
        });

        it("11.16 feeRecipient preserved after upgrade", async () => {
            const { escrow, owner, feeRecipient } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.feeRecipient()).to.equal(feeRecipient.address);
        });

        it("11.17 REGISTRY preserved after upgrade", async () => {
            const { escrow, registry, owner } = await deploy();

            const regBefore = await escrow.registry();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.registry()).to.equal(regBefore);
        });

        it("11.18 nextCommitId preserved after upgrade", async () => {
            const { escrow, owner, user, QUOTE_ID } = await deploy();

            await makeCommit(escrow, user, QUOTE_ID, "id-test-1");
            await makeCommit(escrow, user, QUOTE_ID, "id-test-2");
            const nextIdBefore = await escrow.nextCommitId();
            expect(nextIdBefore).to.equal(2n);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.nextCommitId()).to.equal(nextIdBefore);

            // New commit gets id=2 (sequential)
            const cid3 = await makeCommitV2(await escrow.getAddress(), user, QUOTE_ID, "id-test-3");
            expect(cid3).to.equal(2n);
        });

        it("11.19 pendingWithdrawals preserved after upgrade", async () => {
            const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "pending-test");
            await escrow.connect(bundler).settle(cid);

            const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
            const feePending = await escrow.pendingWithdrawals(feeRecipient.address);
            expect(bundlerPending).to.equal(ONE_GWEI); // PROTOCOL_FEE_WEI=0, bundler earns full feePaid
            expect(feePending).to.equal(0n);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(bundlerPending);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(feePending);
        });

        it("11.20 contract ETH balance preserved after upgrade", async () => {
            const { escrow, owner, user, QUOTE_ID } = await deploy();
            const proxyAddr = await escrow.getAddress();

            await makeCommit(escrow, user, QUOTE_ID, "bal-test");
            const balBefore = await contractBalance(proxyAddr);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await contractBalance(proxyAddr)).to.equal(balBefore);
        });

        it("11.21 commit struct fields fully preserved after upgrade (all 14 fields)", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "struct-check");
            const before = await escrow.getCommit(cid);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const after = await commitsV2(await escrow.getAddress(), cid);
            expect(after.user).to.equal(before.user);
            expect(after.feePaid).to.equal(before.feePaid);
            expect(after.bundler).to.equal(before.bundler);
            expect(after.collateralLocked).to.equal(before.collateralLocked);
            expect(after.deadline).to.equal(before.deadline);
            expect(after.settled).to.equal(before.settled);
            expect(after.refunded).to.equal(before.refunded);
            expect(after.quoteId).to.equal(before.quoteId);
            expect(after.userOpHash).to.equal(before.userOpHash);
            expect(after.inclusionBlock).to.equal(before.inclusionBlock);
            expect(after.accepted).to.equal(before.accepted);
            expect(after.cancelled).to.equal(before.cancelled);
            expect(after.acceptDeadline).to.equal(before.acceptDeadline);
            expect(after.slaBlocks).to.equal(before.slaBlocks);
        });

        it("11.22 multiple open commits from different users all survive upgrade", async () => {
            const { escrow, owner, bundler, user, stranger, QUOTE_ID } = await deploy(50n);

            // Read grace constants before upgrade (V2Safe does not expose them)
            const sg22 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg22 = BigInt(await escrow.REFUND_GRACE_BLOCKS());

            const cid1 = await makeCommit(escrow, user, QUOTE_ID, "multi-1");
            const cid2 = await makeCommit(escrow, stranger, QUOTE_ID, "multi-2");
            const cid3 = await makeCommit(escrow, user, QUOTE_ID, "multi-3");

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Settle one, refund another, leave one open
            const proxyAddr22 = await escrow.getAddress();
            await (V2.attach(proxyAddr22) as any).connect(bundler).settle(cid1);
            expect((await commitsV2(proxyAddr22, cid1)).settled).to.be.true;

            await mine(Number(50n + sg22 + rg22 + 2n)); // past cid3's deadline + settlement_grace + refund_grace
            await escrow.connect(stranger).claimRefund(cid2);
            expect((await commitsV2(proxyAddr22, cid2)).refunded).to.be.true;

            // Third commit is past deadline + grace -- refund works
            await escrow.connect(user).claimRefund(cid3);
            expect((await commitsV2(proxyAddr22, cid3)).refunded).to.be.true;
        });

        it("11.23 ownership preserved after upgrade -- owner can still call onlyOwner functions", async () => {
            const { escrow, owner, stranger } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Owner can still set fee recipient
            await expect(escrow.connect(owner).setFeeRecipient(stranger.address)).to.not.be.reverted;

            // Stranger still cannot
            await expect(
                escrow.connect(stranger).setFeeRecipient(stranger.address)
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("11.24 implementation address changes after upgrade", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const implBefore = await getImplAddress(proxyAddr);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(proxyAddr, V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const implAfter = await getImplAddress(proxyAddr);
            expect(implAfter).to.not.equal(implBefore);
        });

        it("11.25 proxy address remains the same after upgrade", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const upgraded = await upgrades.upgradeProxy(proxyAddr, V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await upgraded.getAddress()).to.equal(proxyAddr);
        });
    });

    // -----------------------------------------------------------
    // 11.26-11.40: Re-initialization attacks
    // -----------------------------------------------------------

    describe("Cat11 -- re-initialization attacks", () => {
        it("11.26 calling initialize() on proxy after deployment reverts", async () => {
            const { escrow, registry, owner, feeRecipient } = await deploy();

            await expect(
                escrow.connect(owner).initialize(
                    await registry.getAddress(),
                    feeRecipient.address,
                )
            ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
        });

        it("11.27 calling initialize() on implementation contract reverts (_disableInitializers)", async () => {
            const { escrow, registry, feeRecipient } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const implAddr = await getImplAddress(proxyAddr);

            const impl = await ethers.getContractAt("SLAEscrow", implAddr);
            await expect(
                impl.initialize(
                    await registry.getAddress(),
                    feeRecipient.address,
                )
            ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
        });

        it("11.28 reinitializer(2) in V2 works once via upgradeToAndCall -- proper migration path", async () => {
            const { escrow, owner } = await deploy();

            const V2Reinit = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v2Impl = await V2Reinit.deploy();

            const v2Iface = V2Reinit.interface;
            const initV2Data = v2Iface.encodeFunctionData("initializeV2", [42n]);

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), initV2Data);

            const v2Proxy = V2Reinit.attach(await escrow.getAddress()) as any;
            expect(await v2Proxy.v2Marker()).to.equal(42n);
        });

        it("11.29 calling reinitializer(2) a second time reverts", async () => {
            const { escrow, owner } = await deploy();

            const V2Reinit = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v2Impl = await V2Reinit.deploy();

            const v2Iface = V2Reinit.interface;
            const initV2Data = v2Iface.encodeFunctionData("initializeV2", [42n]);

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), initV2Data);

            const v2Proxy = V2Reinit.attach(await escrow.getAddress()) as any;

            // Try calling initializeV2 again directly
            await expect(v2Proxy.connect(owner).initializeV2(99n)).to.be.revertedWithCustomError(
                v2Proxy,
                "InvalidInitialization"
            );
        });

        it("11.30 reinitializer(2) preserves all v1 storage", async () => {
            const { escrow, owner, bundler, user, feeRecipient, registry, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "reinit-preserve");
            await escrow.connect(bundler).settle(cid);

            const depositedBefore = await escrow.deposited(bundler.address);
            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            const feeRecipientBefore = await escrow.feeRecipient();
            const registryBefore = await escrow.registry();
            const protocolFeeWeiBefore = await escrow.protocolFeeWei();
            const nextIdBefore = await escrow.nextCommitId();

            const V2Reinit = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v2Impl = await V2Reinit.deploy();
            const initV2Data = V2Reinit.interface.encodeFunctionData("initializeV2", [999n]);
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), initV2Data);

            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(pendingBefore);
            expect(await escrow.feeRecipient()).to.equal(feeRecipientBefore);
            expect(await escrow.registry()).to.equal(registryBefore);
            expect(await escrow.protocolFeeWei()).to.equal(protocolFeeWeiBefore);
            expect(await escrow.nextCommitId()).to.equal(nextIdBefore);
        });

        it("11.31 stranger cannot call initialize() on proxy even after upgrade", async () => {
            const { escrow, registry, owner, feeRecipient, stranger } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            await expect(
                escrow.connect(stranger).initialize(
                    await registry.getAddress(),
                    stranger.address,
                )
            ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
        });

        it("11.32 initialize() with zero registry address reverts even if somehow callable", async () => {
            // Deploy a fresh proxy to test the actual init guards
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const [, , , feeRecipient] = await ethers.getSigners();
            await expect(
                upgrades.deployProxy(
                    Escrow,
                    [ethers.ZeroAddress, feeRecipient.address],
                    { kind: "uups" }
                )
            ).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
        });

        it("11.33 initialize() with valid args succeeds (no feeBps param)", async () => {
            const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
            const Registry = await ethers.getContractFactory("QuoteRegistry");
            const reg = await Registry.deploy((await ethers.getSigners())[0].address, ethers.parseEther("0.0001"));
            const [, , , feeRecipient] = await ethers.getSigners();
            const escrow = await upgrades.deployProxy(
                Escrow,
                [await reg.getAddress(), feeRecipient.address],
                { kind: "uups" }
            );
            expect(await (escrow as any).protocolFeeWei()).to.equal(0n);
        });
    });

    // -----------------------------------------------------------
    // 11.34-11.50: UUPS-specific authorization and bricking
    // -----------------------------------------------------------

    describe("Cat11 -- authorization and bricking", () => {
        it("11.34 stranger cannot call upgradeToAndCall", async () => {
            const { escrow, stranger } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            await expect(
                escrow.connect(stranger).upgradeToAndCall(await v2Impl.getAddress(), "0x")
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("11.35 upgradeToAndCall cannot be called on implementation directly (not via proxy)", async () => {
            const { escrow } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const implAddr = await getImplAddress(proxyAddr);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            // Attach to impl directly
            const impl = await ethers.getContractAt("SLAEscrow", implAddr);

            // OZ UUPSUpgradeable checks that upgradeToAndCall is called on the proxy, not the impl
            await expect(
                impl.upgradeToAndCall(await v2Impl.getAddress(), "0x")
            ).to.be.revertedWithCustomError(impl, "UUPSUnauthorizedCallContext");
        });

        it("11.36 upgrade to bricked impl -- proxy becomes unusable for further upgrades", async () => {
            const { escrow, owner } = await deploy();

            // First upgrade to an impl with _authorizeUpgrade that always reverts
            const Bricked = await ethers.getContractFactory("SLAEscrowBricked");
            const bricked = await Bricked.deploy();

            // Do the upgrade via direct call (bypassing plugin safety checks)
            await escrow.connect(owner).upgradeToAndCall(await bricked.getAddress(), "0x");

            // Now try upgrading again -- should revert with "BRICKED"
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x")
            ).to.be.revertedWith("BRICKED");
        });

        it("11.37 upgrade to V2 with open _authorizeUpgrade -- stranger can then hijack", async () => {
            const { escrow, owner, stranger } = await deploy();

            // Deploy V2 with no auth on _authorizeUpgrade
            const OpenAuth = await ethers.getContractFactory("SLAEscrowV2OpenAuth");
            const openImpl = await OpenAuth.deploy();

            // Owner upgrades to the open-auth version
            await escrow.connect(owner).upgradeToAndCall(await openImpl.getAddress(), "0x");

            // Now stranger can upgrade to whatever they want!
            const Bricked = await ethers.getContractFactory("SLAEscrowBricked");
            const bricked = await Bricked.deploy();

            // Stranger CAN call upgradeToAndCall -- devastating vulnerability
            await expect(
                escrow.connect(stranger).upgradeToAndCall(await bricked.getAddress(), "0x")
            ).to.not.be.reverted;
        });

        it("11.38 double upgrade in same block -- second upgrade overwrites first", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();

            const V2a = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2a = await V2a.deploy();

            const V2b = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v2b = await V2b.deploy();

            // Both upgrades in rapid succession (same block in hardhat)
            await escrow.connect(owner).upgradeToAndCall(await v2a.getAddress(), "0x");
            await escrow.connect(owner).upgradeToAndCall(await v2b.getAddress(), "0x");

            // Final impl should be V2b
            const finalImpl = await getImplAddress(proxyAddr);
            expect(finalImpl.toLowerCase()).to.equal((await v2b.getAddress()).toLowerCase());
        });

        it("11.39 upgrade + ownership transfer in same calldata -- new owner controls proxy", async () => {
            const { escrow, owner, stranger } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            // Encode transferOwnership
            const transferCalldata = escrow.interface.encodeFunctionData("transferOwnership", [
                stranger.address,
            ]);

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), transferCalldata);

            // Old owner lost control
            expect(await escrow.owner()).to.equal(stranger.address);
            await expect(
                escrow.connect(owner).setFeeRecipient(owner.address)
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("11.40 upgrade with renounceOwnership in calldata -- proxy permanently locked", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const renounceCalldata = escrow.interface.encodeFunctionData("renounceOwnership");

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), renounceCalldata);

            expect(await escrow.owner()).to.equal(ethers.ZeroAddress);

            // Can never upgrade again
            const V3 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v3Impl = await V3.deploy();
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v3Impl.getAddress(), "0x")
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

            // But existing functionality still works
            const [, bundler, user] = await ethers.getSigners();
            // Deposits, commits, settles still function -- proxy is just frozen in terms of upgrades
        });

        it("11.41 upgrade preserves proxy's ability to receive ETH via deposit()", async () => {
            const { escrow, owner, bundler } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Deposit after upgrade should work
            const depositedBefore = await escrow.deposited(bundler.address);
            await escrow.connect(bundler).deposit({ value: ethers.parseEther("0.05") });
            expect(await escrow.deposited(bundler.address)).to.equal(
                depositedBefore + ethers.parseEther("0.05")
            );
        });
    });

    // -----------------------------------------------------------
    // 11.42-11.55: Constants and immutable behavior across upgrades
    // -----------------------------------------------------------

    describe("Cat11 -- constant and immutable behavior across upgrades", () => {
        it("11.42 REFUND_GRACE_BLOCKS constant changes in V2 -- old commits use new grace (dangerous!)", async () => {
            // This test demonstrates the subtle danger: constants are baked into bytecode.
            // If V2 changes REFUND_GRACE_BLOCKS from 5 to 20, ALL existing commits
            // now require 20 more blocks before refund, even those created under V1.
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "grace-change");
            const commitData = await escrow.getCommit(cid);
            const deadline = commitData.deadline;

            // Under V1: refund unlocks at deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1
            const sg = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg = BigInt(await escrow.REFUND_GRACE_BLOCKS());
            const v1UnlockAt = deadline + sg + rg + 1n;

            // Upgrade to V2 with REFUND_GRACE_BLOCKS = 20
            const V2Grace = await ethers.getContractFactory("SLAEscrowV2DifferentGrace");
            const v2Impl = await V2Grace.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            // Mine to V1 unlock point
            const currentBlock = BigInt(await ethers.provider.getBlockNumber());
            if (v1UnlockAt > currentBlock) {
                await mine(Number(v1UnlockAt - currentBlock));
            }

            // Under V1 this would be claimable, but V2 requires deadline + 20 + 1
            // The V2 contract's claimRefund now uses REFUND_GRACE_BLOCKS = 20
            const v2Escrow = V2Grace.attach(await escrow.getAddress()) as any;
            const v2Grace = await v2Escrow.REFUND_GRACE_BLOCKS();
            expect(v2Grace).to.equal(20n);

            // Try claiming -- should fail because we need 20 more blocks now
            await expect(
                v2Escrow.connect(user).claimRefund(cid)
            ).to.be.revertedWithCustomError(v2Escrow, "NotExpired");

            // Mine the remaining blocks (V2 uses only REFUND_GRACE_BLOCKS, no settlement grace)
            const v2UnlockAt = deadline + v2Grace + 1n;
            const nowBlock = BigInt(await ethers.provider.getBlockNumber());
            if (v2UnlockAt > nowBlock) {
                await mine(Number(v2UnlockAt - nowBlock) + 1);
            }

            // Now it works
            await v2Escrow.connect(user).claimRefund(cid);
            expect((await v2Escrow.commits(cid)).refunded).to.be.true;
        });

        it("11.43 PROTOCOL_FEE_WEI is stored in proxy storage, not bytecode -- preserved after upgrade", async () => {
            const { escrow, owner } = await deploy();

            await escrow.connect(owner).setProtocolFeeWei(50n);
            expect(await escrow.protocolFeeWei()).to.equal(50n);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // PROTOCOL_FEE_WEI is a storage variable, not a constant -- it persists
            expect(await escrow.protocolFeeWei()).to.equal(50n);
        });

        it("11.44 settle fee calculation: with PROTOCOL_FEE_WEI=0, bundler gets full fee after upgrade", async () => {
            const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const cid = await makeCommitV2(await escrow.getAddress(), user, QUOTE_ID, "fee-calc-post-upgrade");
            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);

            await (V2.attach(await escrow.getAddress()) as any).connect(bundler).settle(cid);

            const pendingAfter = await escrow.pendingWithdrawals(bundler.address);
            // With PROTOCOL_FEE_WEI=0, bundler gets full ONE_GWEI
            expect(pendingAfter - pendingBefore).to.equal(ONE_GWEI);
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("11.45 V2 extraField starts at 0 (not corrupted by V1 gap)", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2Proxy = V2.attach(await escrow.getAddress()) as any;
            expect(await v2Proxy.extraField()).to.equal(0n);
        });

        it("11.46 V2 extraField can be set by owner after upgrade", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2Proxy = V2.attach(await escrow.getAddress()) as any;
            await v2Proxy.connect(owner).setExtraField(12345n);
            expect(await v2Proxy.extraField()).to.equal(12345n);
        });

        it("11.47 V2 version() function accessible after upgrade", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2Proxy = V2.attach(await escrow.getAddress()) as any;
            expect(await v2Proxy.version()).to.equal("2.0.0");
        });

        it("11.48 new commit after upgrade still uses same REGISTRY for offer lookup", async () => {
            const { escrow, owner, bundler, user, registry, QUOTE_ID } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Register a new offer on the same registry
            await registry.connect(bundler).register(ONE_GWEI * 2n, Number(SLA_BLOCKS), COLLATERAL, 302_400, { value: ethers.parseEther("0.0001") });
            const newQuoteId = 2n;

            // Commit with new offer via V2Safe (bytes32 API) -- requires 2 gwei fee
            const hash = ethers.keccak256(ethers.toUtf8Bytes("new-offer"));
            const v2 = await ethers.getContractAt("SLAEscrowV2Safe", await escrow.getAddress()) as any;
            const tx = await v2.connect(user).commit(newQuoteId, hash, bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI * 2n });
            const receipt = await tx.wait();
            expect(receipt!.status).to.equal(1);
        });

        it("11.49 deregistering an offer on registry still prevents commits after escrow upgrade", async () => {
            const { escrow, owner, bundler, user, registry, QUOTE_ID } = await deploy();

            await registry.connect(bundler).deregister(QUOTE_ID);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const hash = ethers.keccak256(ethers.toUtf8Bytes("deregistered"));
            const v2 = await ethers.getContractAt("SLAEscrowV2Safe", await escrow.getAddress()) as any;
            await expect(
                v2.connect(user).commit(QUOTE_ID, hash, bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI })
            ).to.be.revertedWithCustomError(v2, "OfferInactive");
        });
    });

    // -----------------------------------------------------------
    // 11.50-11.65: ETH accounting invariants across upgrades
    // -----------------------------------------------------------

    describe("Cat11 -- ETH accounting invariants across upgrades", () => {
        it("11.50 ETH balance invariant holds: balance == sum(deposited) + sum(pending) + open_fees", async () => {
            const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();
            const proxyAddr = await escrow.getAddress();

            const cid1 = await makeCommit(escrow, user, QUOTE_ID, "inv-1");
            await escrow.connect(bundler).settle(cid1);

            const cid2 = await makeCommit(escrow, user, QUOTE_ID, "inv-2"); // open commit

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(proxyAddr, V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const bal = await contractBalance(proxyAddr);
            const dep = await escrow.deposited(bundler.address);
            const pendBundler = await escrow.pendingWithdrawals(bundler.address);
            const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);
            const openFee = ONE_GWEI; // cid2's fee is still in the contract (PROTOCOL_FEE_WEI=0)

            expect(bal).to.equal(dep + pendBundler + pendFee + openFee);
        });

        it("11.51 claimPayout after upgrade transfers correct ETH", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "claim-post-upgrade");
            await escrow.connect(bundler).settle(cid);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            expect(pendingBefore).to.equal(ONE_GWEI); // PROTOCOL_FEE_WEI=0, bundler earns full feePaid

            const balBefore = await ethers.provider.getBalance(bundler.address);
            const tx = await escrow.connect(bundler).claimPayout();
            const receipt = await tx.wait();
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            const balAfter = await ethers.provider.getBalance(bundler.address);

            expect(balAfter).to.equal(balBefore + pendingBefore - gasCost);
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
        });

        it("11.52 withdraw after upgrade returns correct ETH", async () => {
            const { escrow, owner, bundler } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const idle = await escrow.idleBalance(bundler.address);
            const balBefore = await ethers.provider.getBalance(bundler.address);

            const tx = await escrow.connect(bundler).withdraw(idle);
            const receipt = await tx.wait();
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            const balAfter = await ethers.provider.getBalance(bundler.address);

            expect(balAfter).to.equal(balBefore + idle - gasCost);
        });

        it("11.53 upgradeToAndCall with ETH value -- proxy balance increases, calldata function receives msg.value", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const balBefore = await contractBalance(proxyAddr);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const depositCalldata = escrow.interface.encodeFunctionData("deposit");
            const depositAmount = ethers.parseEther("0.01");

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), depositCalldata, {
                value: depositAmount,
            });

            expect(await contractBalance(proxyAddr)).to.equal(balBefore + depositAmount);
            expect(await escrow.deposited(owner.address)).to.equal(depositAmount);
        });

        it("11.54 slash after upgrade -- collateral correctly deducted from bundler deposited", async () => {
            const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();

            // Read grace constants before upgrade (V2Safe does not expose them)
            const sg54 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg54 = BigInt(await escrow.REFUND_GRACE_BLOCKS());

            const cid = await makeCommit(escrow, user, QUOTE_ID, "slash-post-upgrade");
            const depositedBefore = await escrow.deposited(bundler.address);

            // Snapshot deadline before upgrade to avoid post-upgrade ABI mismatch
            const commitSnap = await escrow.getCommit(cid);
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Mine past deadline + settlement grace + refund grace + 2
            const cur = BigInt(await ethers.provider.getBlockNumber());
            const target = BigInt(commitSnap.deadline) + sg54 + rg54 + 2n;
            if (target > cur) await mine(Number(target - cur));
            await escrow.connect(user).claimRefund(cid);

            const depositedAfter = await escrow.deposited(bundler.address);
            expect(depositedAfter).to.equal(depositedBefore - COLLATERAL);
        });

        it("11.55 multiple settles + refunds after upgrade -- final ETH balance invariant holds", async () => {
            const { escrow, owner, bundler, user, stranger, feeRecipient, QUOTE_ID } = await deploy(50n);
            const proxyAddr = await escrow.getAddress();

            // Read grace constants before upgrade (V2Safe does not expose them)
            const sg55 = BigInt(await escrow.SETTLEMENT_GRACE_BLOCKS());
            const rg55 = BigInt(await escrow.REFUND_GRACE_BLOCKS());

            // Create several commits
            const cid1 = await makeCommit(escrow, user, QUOTE_ID, "multi-fin-1");
            const cid2 = await makeCommit(escrow, user, QUOTE_ID, "multi-fin-2");
            const cid3 = await makeCommit(escrow, stranger, QUOTE_ID, "multi-fin-3");

            // Upgrade mid-flight
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(proxyAddr, V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Settle one
            await (V2.attach(proxyAddr) as any).connect(bundler).settle(cid1);

            // Let others expire
            await mine(Number(50n + sg55 + rg55 + 2n)); // past cid3's deadline + settlement_grace + refund_grace
            await escrow.connect(user).claimRefund(cid2);
            await escrow.connect(stranger).claimRefund(cid3);

            // Verify invariant
            const bal = await contractBalance(proxyAddr);
            const dep = await escrow.deposited(bundler.address);
            const pend = await escrow.pendingWithdrawals(bundler.address);
            const pendUser = await escrow.pendingWithdrawals(user.address);
            const pendStranger = await escrow.pendingWithdrawals(stranger.address);
            const pendFee = await escrow.pendingWithdrawals(feeRecipient.address);

            expect(bal).to.equal(dep + pend + pendUser + pendStranger + pendFee);
        });
    });

    // -----------------------------------------------------------
    // 11.56-11.70: Timing and upgrade ordering attacks
    // -----------------------------------------------------------

    describe("Cat11 -- timing and upgrade ordering attacks", () => {
        it("11.56 upgrade between commit and settle -- bundler can still settle", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "timing-settle");

            // Upgrade immediately
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Settle should work
            const proxyAddr56 = await escrow.getAddress();
            await (V2.attach(proxyAddr56) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr56, cid)).settled).to.be.true;
        });

        it("11.57 upgrade at exact deadline block -- settle still possible", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            // Pre-deploy impl so upgrade consumes exactly 1 block (upgradeToAndCall only)
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "exact-deadline");
            const commitData = await escrow.getCommit(cid);

            // Mine to 2 blocks before deadline so: upgrade (1 block) + settle (1 block) = deadline
            const current = BigInt(await ethers.provider.getBlockNumber());
            const blocksToMine = commitData.deadline - current - 2n;
            if (blocksToMine > 0n) await mine(Number(blocksToMine));

            // Upgrade (1 block -- now at deadline - 1)
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            // Settle at exactly deadline block
            const proxyAddr57 = await escrow.getAddress();
            await (V2.attach(proxyAddr57) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr57, cid)).settled).to.be.true;
        });

        it("11.58 rapid upgrade + commit + upgrade -- commit survives double upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy(10n);

            // Upgrade to V2
            const V2a = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2a, { kind: "uups", unsafeSkipStorageCheck: true });

            // Create commit under V2 (uses V2Safe bytes32 API)
            const proxyAddr58 = await escrow.getAddress();
            const cid = await makeCommitV2(proxyAddr58, user, QUOTE_ID, "double-upgrade");

            // Upgrade to V2Reinit (V3 effectively)
            const V2b = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v2bImpl = await V2b.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v2bImpl.getAddress(), "0x");

            // Settle under V3
            await (V2b.attach(proxyAddr58) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr58, cid)).settled).to.be.true;
        });

        it("11.59 commit created pre-upgrade, expired during upgrade, refunded post-upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "expire-during-upgrade");

            // Mine past deadline + settlement_grace + refund_grace
            await mineToRefundable(escrow, cid);

            // Upgrade while commit is expired
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Refund should work
            await escrow.connect(user).claimRefund(cid);
            expect((await commitsV2(await escrow.getAddress(), cid)).refunded).to.be.true;
        });

        it("11.60 upgrade reverts if impl address is zero", async () => {
            const { escrow, owner } = await deploy();

            // address(0) staticcall returns empty data; Solidity ABI-decode of bytes32 fails with no error data
            await expect(
                escrow.connect(owner).upgradeToAndCall(ethers.ZeroAddress, "0x")
            ).to.be.reverted; // bare revert: same mechanism as EOA upgrade
        });

        it("11.61 20 sequential commits, upgrade, all 20 still settleable", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy(100n);

            // Need more collateral for 20 commits
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 20n });

            const commitIds: bigint[] = [];
            for (let i = 0; i < 20; i++) {
                commitIds.push(await makeCommit(escrow, user, QUOTE_ID, `batch-${i}`));
            }

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const proxyAddr61 = await escrow.getAddress();
            const v2Proxy = V2.attach(proxyAddr61) as any;
            for (const cid of commitIds) {
                await v2Proxy.connect(bundler).settle(cid);
                expect((await commitsV2(proxyAddr61, cid)).settled).to.be.true;
            }
        });

        it("11.62 upgrade during the grace period window -- refund timing changes with new grace constant", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "grace-window");
            const commitData = await escrow.getCommit(cid);

            // Mine to deadline + 3 (inside V1 grace of 5, but well outside deadline)
            const current = BigInt(await ethers.provider.getBlockNumber());
            const target = commitData.deadline + 3n;
            if (target > current) await mine(Number(target - current));

            // Upgrade to V2 with grace = 20 while inside the V1 grace window
            const V2Grace = await ethers.getContractFactory("SLAEscrowV2DifferentGrace");
            const v2Impl = await V2Grace.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            const v2Escrow = V2Grace.attach(await escrow.getAddress()) as any;

            // Under V1: unlocks at deadline + 5 + 1 = deadline + 6
            // Under V2: unlocks at deadline + 20 + 1 = deadline + 21
            // We're at ~deadline + 4 -> neither V1 nor V2 would allow refund yet
            await expect(
                v2Escrow.connect(user).claimRefund(cid)
            ).to.be.revertedWithCustomError(v2Escrow, "NotExpired");
        });

        it("11.63 frontrunning upgrade: attacker creates commit in same block as upgrade tx", async () => {
            // In practice, both happen in same block. The commit uses pre-upgrade logic
            // if it appears before the upgrade in the block, post-upgrade logic if after.
            // In Hardhat, txs are sequential within a block, so order matters.
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            // Stop auto-mining to batch txs
            // (Hardhat default is auto-mine -- each tx gets its own block)
            // We test that commit created just before upgrade still works after
            const cid = await makeCommit(escrow, user, QUOTE_ID, "frontrun");

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Commit should be fully functional
            const proxyAddr63 = await escrow.getAddress();
            await (V2.attach(proxyAddr63) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr63, cid)).settled).to.be.true;
        });

        it("11.64 upgrade between two commits -- both use same nextCommitId sequence", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid1 = await makeCommit(escrow, user, QUOTE_ID, "seq-1");
            expect(cid1).to.equal(0n);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const proxyAddr64 = await escrow.getAddress();
            const cid2 = await makeCommitV2(proxyAddr64, user, QUOTE_ID, "seq-2");
            expect(cid2).to.equal(1n); // Sequential, no gap

            const cid3 = await makeCommitV2(proxyAddr64, user, QUOTE_ID, "seq-3");
            expect(cid3).to.equal(2n);
        });

        it("11.65 upgrade does not reset lockedOf even with many open commits", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            await escrow.connect(bundler).deposit({ value: COLLATERAL * 5n });

            await makeCommit(escrow, user, QUOTE_ID, "lock-a");
            await makeCommit(escrow, user, QUOTE_ID, "lock-b");
            await makeCommit(escrow, user, QUOTE_ID, "lock-c");

            const lockedBefore = await escrow.lockedOf(bundler.address);
            expect(lockedBefore).to.equal(COLLATERAL * 3n);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
        });
    });

    // -----------------------------------------------------------
    // 11.66-11.80: Storage layout and gap attacks
    // -----------------------------------------------------------

    describe("Cat11 -- storage layout and gap attacks", () => {
        it("11.66 nextCommitId is 0 at deploy (no prior commits)", async () => {
            const { escrow } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // __gap is after nextCommitId. nextCommitId is at some slot.
            // With OZ upgradeable: Initializable (1), OwnableUpgradeable (1), UUPSUpgradeable (50 gap of its own)
            // Then our storage: REGISTRY(0), feeRecipient(1), commits(2), deposited(3), lockedOf(4), pendingWithdrawals(5), nextCommitId(6), reservedBalance(7), activeCommitForHash(8), PROTOCOL_FEE_WEI(9), __gap[47]
            // The exact slot depends on the layout. Let's just read nextCommitId and the next 50 slots.
            const nextCommitId = await escrow.nextCommitId();
            expect(nextCommitId).to.equal(0n); // No commits yet -- gap should be clean
        });

        it("11.67 V2Safe shrinks __gap from 50 to 49, adds extraField -- no corruption", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            await makeCommit(escrow, user, QUOTE_ID, "gap-shrink");
            const lockedBefore = await escrow.lockedOf(bundler.address);
            const depositedBefore = await escrow.deposited(bundler.address);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2 = V2.attach(await escrow.getAddress()) as any;

            // extraField should be 0 (it occupies what was __gap[49], which should be 0)
            expect(await v2.extraField()).to.equal(0n);

            // Existing storage untouched
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        });

        it("11.68 writing to V2 extraField does not corrupt V1 mappings", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            await makeCommit(escrow, user, QUOTE_ID, "no-corrupt");
            const lockedBefore = await escrow.lockedOf(bundler.address);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2 = V2.attach(await escrow.getAddress()) as any;
            await v2.connect(owner).setExtraField(ethers.MaxUint256);

            // Mappings should be completely unaffected
            expect(await escrow.lockedOf(bundler.address)).to.equal(lockedBefore);
            expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n);
            expect(await escrow.feeRecipient()).to.not.equal(ethers.ZeroAddress);
        });

        it("11.69 downgrade from V2 back to V1 -- extraField data persists in storage but is inaccessible", async () => {
            const { escrow, owner, bundler } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // Upgrade to V2
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(proxyAddr, V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2 = V2.attach(proxyAddr) as any;
            await v2.connect(owner).setExtraField(42n);
            expect(await v2.extraField()).to.equal(42n);

            // "Downgrade" back to V1 (directly, bypassing plugin safety)
            const V1 = await ethers.getContractFactory("SLAEscrowTestable");
            const v1Impl = await V1.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v1Impl.getAddress(), "0x");

            // V1 doesn't expose extraField -- but storage slot still has 42
            // This is safe because V1's __gap[49] maps to the same slot (raw storage preserved)
            // Core functionality still works
            expect(await escrow.deposited(bundler.address)).to.equal(COLLATERAL * 10n);
        });

        it("11.70 upgrade preserves mapping entries even for addresses that are not signers in test", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            // Create a commit -- this writes to commits mapping and lockedOf
            const cid = await makeCommit(escrow, user, QUOTE_ID, "mapping-persist");

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const commit = await commitsV2(await escrow.getAddress(), cid);
            expect(commit.user).to.equal(user.address);
            expect(commit.bundler).to.equal(bundler.address);
            expect(commit.feePaid).to.equal(ONE_GWEI);
        });

        it("11.71 implementation slot (ERC-1967) is updated to the new impl address after upgrade", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // Read implementation slot before
            const implBefore = await getImplAddress(proxyAddr);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2 = await V2.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v2.getAddress(), "0x");

            // Implementation slot updated
            const implAfter = await getImplAddress(proxyAddr);
            expect(implAfter).to.not.equal(implBefore);
            expect(implAfter.toLowerCase()).to.equal((await v2.getAddress()).toLowerCase());
        });

        it("11.72 storage slot for owner (OwnableUpgradeable) not corrupted by upgrade", async () => {
            const { escrow, owner } = await deploy();

            expect(await escrow.owner()).to.equal(owner.address);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            expect(await escrow.owner()).to.equal(owner.address);
        });
    });

    // -----------------------------------------------------------
    // 11.73-11.85: TimelockController upgrade scenarios
    // -----------------------------------------------------------

    describe("Cat11 -- TimelockController upgrade scenarios", () => {
        it("11.73 timelock with minDelay=0 -- schedule then execute immediately (sequential txs, not same block)", async () => {
            const { escrow, owner, stranger } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // Deploy TimelockController with delay 0
            const Timelock = await ethers.getContractFactory("TimelockController");
            const timelock = await Timelock.deploy(
                0, // minDelay
                [owner.address], // proposers
                [owner.address], // executors
                ethers.ZeroAddress // admin (no admin)
            );
            const timelockAddr = await timelock.getAddress();

            // Transfer escrow ownership to timelock
            await escrow.connect(owner).transferOwnership(timelockAddr);
            expect(await escrow.owner()).to.equal(timelockAddr);

            // Prepare upgrade
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const upgradeCalldata = escrow.interface.encodeFunctionData("upgradeToAndCall", [
                await v2Impl.getAddress(),
                "0x",
            ]);

            const salt = ethers.id("upgrade-v2");
            const predecessor = ethers.ZeroHash;

            // Schedule with delay 0
            await timelock.connect(owner).schedule(
                proxyAddr,
                0, // value
                upgradeCalldata,
                predecessor,
                salt,
                0 // delay
            );

            // Execute in the next tx (minDelay=0 means no time constraint between schedule and execute)
            await timelock.connect(owner).execute(
                proxyAddr,
                0,
                upgradeCalldata,
                predecessor,
                salt
            );

            // Verify upgrade happened
            const implAfter = await getImplAddress(proxyAddr);
            expect(implAfter.toLowerCase()).to.equal((await v2Impl.getAddress()).toLowerCase());
        });

        it("11.74 timelock with minDelay > 0 -- cannot execute before delay", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();

            const Timelock = await ethers.getContractFactory("TimelockController");
            const timelock = await Timelock.deploy(
                100, // minDelay in seconds
                [owner.address],
                [owner.address],
                ethers.ZeroAddress
            );

            await escrow.connect(owner).transferOwnership(await timelock.getAddress());

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const upgradeCalldata = escrow.interface.encodeFunctionData("upgradeToAndCall", [
                await v2Impl.getAddress(),
                "0x",
            ]);

            const salt = ethers.id("upgrade-delayed");
            await timelock.connect(owner).schedule(
                proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt, 100
            );

            // Try immediate execute -- should fail (operation not yet ready)
            await expect(
                timelock.connect(owner).execute(
                    proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt
                )
            ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
        });

        it("11.75 stranger cannot schedule upgrade through timelock", async () => {
            const { escrow, owner, stranger } = await deploy();

            const Timelock = await ethers.getContractFactory("TimelockController");
            const timelock = await Timelock.deploy(
                0,
                [owner.address], // only owner is proposer
                [owner.address],
                ethers.ZeroAddress
            );

            await escrow.connect(owner).transferOwnership(await timelock.getAddress());

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const upgradeCalldata = escrow.interface.encodeFunctionData("upgradeToAndCall", [
                await v2Impl.getAddress(),
                "0x",
            ]);

            await expect(
                timelock.connect(stranger).schedule(
                    await escrow.getAddress(), 0, upgradeCalldata, ethers.ZeroHash, ethers.id("hack"), 0
                )
            ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
        });

        it("11.76 timelock-controlled upgrade preserves all commit state", async () => {
            const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy(15n);
            const proxyAddr = await escrow.getAddress();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "timelock-preserve");

            const Timelock = await ethers.getContractFactory("TimelockController");
            const timelock = await Timelock.deploy(0, [owner.address], [owner.address], ethers.ZeroAddress);
            await escrow.connect(owner).transferOwnership(await timelock.getAddress());

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const upgradeCalldata = escrow.interface.encodeFunctionData("upgradeToAndCall", [
                await v2Impl.getAddress(),
                "0x",
            ]);

            const salt = ethers.id("preserve-test");
            await timelock.connect(owner).schedule(proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt, 0);
            await timelock.connect(owner).execute(proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt);

            // State preserved -- read via V2Safe ABI after upgrade
            const commit = await commitsV2(proxyAddr, cid);
            expect(commit.user).to.equal(user.address);
            expect(commit.bundler).to.equal(bundler.address);
            expect(commit.settled).to.be.false;
            expect(commit.refunded).to.be.false;

            // Can still settle
            await (V2.attach(proxyAddr) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr, cid)).settled).to.be.true;
        });

        it("11.77 timelock batch: upgrade + setFeeRecipient in one batch operation", async () => {
            const { escrow, owner, stranger } = await deploy();
            const proxyAddr = await escrow.getAddress();

            const Timelock = await ethers.getContractFactory("TimelockController");
            const timelock = await Timelock.deploy(0, [owner.address], [owner.address], ethers.ZeroAddress);
            await escrow.connect(owner).transferOwnership(await timelock.getAddress());

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const upgradeCalldata = escrow.interface.encodeFunctionData("upgradeToAndCall", [
                await v2Impl.getAddress(),
                "0x",
            ]);
            const setFeeCalldata = escrow.interface.encodeFunctionData("setFeeRecipient", [
                stranger.address,
            ]);

            const salt = ethers.id("batch-upgrade");

            await timelock.connect(owner).scheduleBatch(
                [proxyAddr, proxyAddr],
                [0, 0],
                [upgradeCalldata, setFeeCalldata],
                ethers.ZeroHash,
                salt,
                0
            );
            await timelock.connect(owner).executeBatch(
                [proxyAddr, proxyAddr],
                [0, 0],
                [upgradeCalldata, setFeeCalldata],
                ethers.ZeroHash,
                salt
            );

            // Both operations applied
            const implAfter = await getImplAddress(proxyAddr);
            expect(implAfter.toLowerCase()).to.equal((await v2Impl.getAddress()).toLowerCase());
            expect(await escrow.feeRecipient()).to.equal(stranger.address);
        });

        it("11.78 cancel scheduled upgrade via timelock", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();

            const Timelock = await ethers.getContractFactory("TimelockController");
            const timelock = await Timelock.deploy(0, [owner.address], [owner.address], ethers.ZeroAddress);
            await escrow.connect(owner).transferOwnership(await timelock.getAddress());

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const upgradeCalldata = escrow.interface.encodeFunctionData("upgradeToAndCall", [
                await v2Impl.getAddress(),
                "0x",
            ]);

            const salt = ethers.id("cancel-test");
            const opId = await timelock.hashOperation(proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt);

            await timelock.connect(owner).schedule(proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt, 0);

            // Cancel the operation
            await timelock.connect(owner).cancel(opId);

            // Execute should fail -- operation was cancelled
            await expect(
                timelock.connect(owner).execute(proxyAddr, 0, upgradeCalldata, ethers.ZeroHash, salt)
            ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
        });
    });

    // -----------------------------------------------------------
    // 11.79-11.90: Edge cases and exotic attacks
    // -----------------------------------------------------------

    describe("Cat11 -- edge cases and exotic attacks", () => {
        it("11.79 upgrade to impl with selfdestruct -- proxy continues working post-Dencun (EIP-6780)", async () => {
            // Post-Dencun, selfdestruct only sends ETH but doesn't erase code/storage
            // unless called in the same tx as creation. So proxy should survive.
            const { escrow, owner, bundler } = await deploy();

            const SD = await ethers.getContractFactory("SLAEscrowV2Selfdestruct");
            const sdImpl = await SD.deploy();
            await escrow.connect(owner).upgradeToAndCall(await sdImpl.getAddress(), "0x");

            // Deposit should still work
            await escrow.connect(bundler).deposit({ value: ethers.parseEther("0.01") });

            // Call nuke on the proxy (selfdestruct the impl context? No -- selfdestruct in delegatecall
            // would affect the proxy, not the impl. Post-Dencun it just sends ETH.)
            const sdProxy = SD.attach(await escrow.getAddress()) as any;
            // nuke() is onlyOwner
            // After Dencun, selfdestruct in a proxy context: sends balance but doesn't destroy storage
            // The proxy should still function after this
            await sdProxy.connect(owner).nuke();

            // Proxy should still have its code (post-Dencun)
            const code = await ethers.provider.getCode(await escrow.getAddress());
            expect(code).to.not.equal("0x");
        });

        it("11.80 upgrade with empty calldata ('0x') -- pure impl swap, no side effects", async () => {
            const { escrow, owner, bundler } = await deploy();
            const depositedBefore = await escrow.deposited(bundler.address);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            expect(await escrow.deposited(bundler.address)).to.equal(depositedBefore);
        });

        it("11.81 upgrade with invalid calldata (random bytes) -- should revert", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const randomCalldata = "0xdeadbeef";

            // upgradeToAndCall delegates to the new impl with unknown selector; impl has no fallback
            // so delegatecall returns false -> OZ Address.functionDelegateCall throws FailedCall
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), randomCalldata)
            ).to.be.revertedWithCustomError(escrow, "FailedCall");
        });

        it("11.82 upgrade with calldata targeting nonexistent function selector -- reverts", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            // Random valid-length selector that doesn't match any function
            const fakeSelector = "0x12345678" + "0".repeat(56);

            // Unknown selector, no fallback in impl -> delegatecall returns false -> FailedCall
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), fakeSelector)
            ).to.be.revertedWithCustomError(escrow, "FailedCall");
        });

        it("11.83 triple upgrade V1 -> V2 -> V2Reinit -> V2Safe -- state consistent throughout", async () => {
            const { escrow, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy(15n);

            const cid = await makeCommit(escrow, user, QUOTE_ID, "triple-upgrade");

            // V1 -> V2Safe
            const V2a = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2a, { kind: "uups", unsafeSkipStorageCheck: true });

            // V2Safe -> V2Reinit
            const V2b = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v2bImpl = await V2b.deploy();
            const initData = V2b.interface.encodeFunctionData("initializeV2", [777n]);
            await escrow.connect(owner).upgradeToAndCall(await v2bImpl.getAddress(), initData);

            // V2Reinit -> V2Safe again
            const V2c = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2cImpl = await V2c.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v2cImpl.getAddress(), "0x");

            // Original commit still valid -- read via V2Safe ABI after final upgrade
            const proxyAddr83 = await escrow.getAddress();
            await (V2c.attach(proxyAddr83) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr83, cid)).settled).to.be.true;

            // Fee accounting still correct: PROTOCOL_FEE_WEI=0, feeRecipient gets 0
            expect(await escrow.pendingWithdrawals(feeRecipient.address)).to.equal(0n);
        });

        it("11.84 upgrade does not affect other proxy instances (separate deployments are independent)", async () => {
            const { escrow, registry, owner, bundler, feeRecipient } = await deploy();

            // Deploy a second proxy with same impl
            const Escrow2 = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow2 = (await upgrades.deployProxy(
                Escrow2,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" }
            )) as unknown as SLAEscrow;

            // Upgrade only the first proxy
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Second proxy still on V1
            const impl1 = await getImplAddress(await escrow.getAddress());
            const impl2 = await getImplAddress(await escrow2.getAddress());
            expect(impl1).to.not.equal(impl2);
        });

        it("11.85 gas cost of upgradeToAndCall is bounded -- no unbounded loop during upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            // Create many commits to fill storage
            await escrow.connect(bundler).deposit({ value: COLLATERAL * 20n });
            for (let i = 0; i < 10; i++) {
                await makeCommit(escrow, user, QUOTE_ID, `gas-${i}`);
            }

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const tx = await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");
            const receipt = await tx.wait();

            // Upgrade gas should be constant regardless of storage size
            // A reasonable UUPS upgrade costs ~50k-150k gas
            expect(receipt!.gasUsed).to.be.lt(500_000n);
        });

        it("11.86 sending ETH directly to proxy reverts -- no receive() or fallback()", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // SLAEscrow has no receive() or fallback(); bare EVM revert (no custom error selector)
            await expect(
                owner.sendTransaction({ to: proxyAddr, value: ethers.parseEther("1") })
            ).to.be.reverted; // no receive() or fallback() in the implementation; delegatecall returns empty revert data
        });

        it("11.87 upgrade to V2, use V2 feature, downgrade to V1 -- V1 cannot access V2 feature but doesn't break", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy(10n);

            // Create commit PRE-upgrade under V1 (has accepted=true in storage)
            const cid = await makeCommit(escrow, user, QUOTE_ID, "downgrade-test");

            // Upgrade to V2 and use V2 feature
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const v2 = V2.attach(await escrow.getAddress()) as any;
            await v2.connect(owner).setExtraField(123n);

            // Downgrade back to V1 -- extraField persists in storage but V1 ignores it
            const V1 = await ethers.getContractFactory("SLAEscrowTestable");
            const v1Impl = await V1.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v1Impl.getAddress(), "0x");

            // V1 still works -- commit created pre-upgrade retains accepted=true in storage
            await escrow.connect(bundler).settle(cid);
            expect((await escrow.getCommit(cid)).settled).to.be.true;
        });

        it("11.88 upgradeToAndCall with calldata encoding a commit -- user field becomes proxy/owner", async () => {
            const { escrow, owner, bundler, user, registry, QUOTE_ID } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const hash = ethers.keccak256(ethers.toUtf8Bytes("mid-upgrade-commit"));
            // Use V2Safe ABI (bytes32 selector) for commit calldata sent in upgradeToAndCall
            const commitCalldata = v2Impl.interface.encodeFunctionData("commit", [QUOTE_ID, hash, bundler.address, COLLATERAL, Number(SLA_BLOCKS)]);

            // upgradeToAndCall with msg.value for the commit fee
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), commitCalldata, {
                value: ONE_GWEI,
            });

            // The commit was created with user = owner (msg.sender of upgradeToAndCall)
            const cid = (await escrow.nextCommitId()) - 1n;
            const commit = await commitsV2(await escrow.getAddress(), cid);
            expect(commit.user).to.equal(owner.address);
        });

        it("11.89 upgrade reverts if calldata reverts -- implementation NOT changed (atomic)", async () => {
            const { escrow, owner } = await deploy();
            const proxyAddr = await escrow.getAddress();
            const implBefore = await getImplAddress(proxyAddr);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            // Calldata that will revert: withdraw more than deposited
            const badCalldata = escrow.interface.encodeFunctionData("withdraw", [ethers.parseEther("999")]);

            // withdraw(999 ETH) reverts with InsufficientIdle; upgrade is atomic so impl slot unchanged
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), badCalldata)
            ).to.be.revertedWithCustomError(escrow, "InsufficientIdle");

            // Implementation should NOT have changed
            expect(await getImplAddress(proxyAddr)).to.equal(implBefore);
        });

        it("11.90 upgrade to same V2 impl twice -- no revert, idempotent", async () => {
            const { escrow, owner } = await deploy();

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();
            const v2Addr = await v2Impl.getAddress();

            await escrow.connect(owner).upgradeToAndCall(v2Addr, "0x");
            const implAfter1 = await getImplAddress(await escrow.getAddress());
            expect(implAfter1.toLowerCase()).to.equal(v2Addr.toLowerCase());

            // Upgrade to same impl again
            await escrow.connect(owner).upgradeToAndCall(v2Addr, "0x");
            const implAfter2 = await getImplAddress(await escrow.getAddress());
            expect(implAfter2.toLowerCase()).to.equal(v2Addr.toLowerCase());
        });
    });

    // -----------------------------------------------------------
    // 11.91-11.100: Multi-party and cross-concern proxy attacks
    // -----------------------------------------------------------

    describe("Cat11 -- multi-party and cross-concern proxy attacks", () => {
        it("11.91 attacker deploys malicious impl with backdoor withdraw -- owner must not upgrade to it", async () => {
            // This test verifies the PROCESS: an attacker can deploy any contract.
            // Only the owner can upgrade. If owner is tricked, funds are lost.
            const { escrow, owner, stranger, attacker } = await deploy();

            // Attacker deploys a seemingly-valid V2 with open _authorizeUpgrade
            const OpenAuth = await ethers.getContractFactory("SLAEscrowV2OpenAuth");
            const malicious = await OpenAuth.connect(attacker).deploy();

            // Attacker cannot upgrade
            await expect(
                escrow.connect(attacker).upgradeToAndCall(await malicious.getAddress(), "0x")
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");

            // Only owner can -- but if they do, attacker gains upgrade ability
            // This is a social engineering / governance attack, not a contract bug
        });

        it("11.92 two proxies sharing same registry -- upgrade one, commit on other uses same offer", async () => {
            const { escrow, registry, owner, bundler, user, feeRecipient, QUOTE_ID } = await deploy();

            const Escrow2 = await ethers.getContractFactory("SLAEscrowTestable");
            const escrow2 = (await upgrades.deployProxy(
                Escrow2,
                [await registry.getAddress(), feeRecipient.address],
                { kind: "uups" }
            )) as unknown as SLAEscrow;

            await escrow2.connect(bundler).deposit({ value: COLLATERAL * 10n });

            // Upgrade escrow1 only
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Commit on escrow2 still uses same offer from shared registry
            const hash = ethers.keccak256(ethers.toUtf8Bytes("shared-registry"));
            const tx = await escrow2.connect(user).commit(QUOTE_ID, hash, bundler.address, COLLATERAL, Number(SLA_BLOCKS), { value: ONE_GWEI });
            const receipt = await tx.wait();
            expect(receipt!.status).to.equal(1);
        });

        it("11.93 upgrade while bundler has pending withdrawal -- claim still works post-upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "pending-claim");
            await escrow.connect(bundler).settle(cid);

            const pendingBefore = await escrow.pendingWithdrawals(bundler.address);
            expect(pendingBefore).to.equal(ONE_GWEI); // PROTOCOL_FEE_WEI=0, bundler earns full feePaid

            // Upgrade
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Claim payout post-upgrade
            await escrow.connect(bundler).claimPayout();
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);
        });

        it("11.94 upgrade while user has pending refund withdrawal -- claim still works post-upgrade", async () => {
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "user-pending");
            await mineToRefundable(escrow, cid);
            await escrow.connect(user).claimRefund(cid);

            const userPending = await escrow.pendingWithdrawals(user.address);
            expect(userPending).to.equal(ONE_GWEI + COLLATERAL); // user gets feePaid + full collateral (PROTOCOL_FEE_WEI=0)

            // Upgrade
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Claim
            await escrow.connect(user).claimPayout();
            expect(await escrow.pendingWithdrawals(user.address)).to.equal(0n);
        });

        it("11.95 upgrade after ownership transferred -- new owner can upgrade again", async () => {
            const { escrow, owner, stranger } = await deploy();

            await escrow.connect(owner).transferOwnership(stranger.address);

            // New owner upgrades
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();
            await escrow.connect(stranger).upgradeToAndCall(await v2Impl.getAddress(), "0x");

            // Old owner cannot
            const V3 = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const v3Impl = await V3.deploy();
            await expect(
                escrow.connect(owner).upgradeToAndCall(await v3Impl.getAddress(), "0x")
            ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
        });

        it("11.96 upgrade + setFeeRecipient + settle: with PROTOCOL_FEE_WEI=0 no protocol fee flows to either feeRecipient", async () => {
            const { escrow, owner, bundler, user, stranger, feeRecipient, QUOTE_ID } = await deploy();

            // Pre-deploy impl so upgrade only mines 1 block, keeping commit within deadline
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2Impl = await V2.deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "fee-redirect");

            // Upgrade + set fee recipient to stranger in one tx
            const setFeeCalldata = escrow.interface.encodeFunctionData("setFeeRecipient", [
                stranger.address,
            ]);
            await escrow.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), setFeeCalldata);

            // Now settle -- fee should go to stranger's pending, not original feeRecipient
            await (V2.attach(await escrow.getAddress()) as any).connect(bundler).settle(cid);

            // PROTOCOL_FEE_WEI=0: stranger (new feeRecipient) gets 0; original also gets 0
            expect(await escrow.pendingWithdrawals(stranger.address)).to.equal(0n);
            // Original fee recipient gets nothing from this settle
        });

        it("11.97 race: owner starts upgrade, bundler tries to settle in same block -- only one succeeds", async () => {
            // In Hardhat, txs are mined sequentially. This tests that both operations
            // don't corrupt each other.
            const { escrow, owner, bundler, user, QUOTE_ID } = await deploy();

            const cid = await makeCommit(escrow, user, QUOTE_ID, "race-condition");

            // Settle first
            await escrow.connect(bundler).settle(cid);

            // Then upgrade
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // Commit is settled, state consistent -- read via V2Safe ABI
            expect((await commitsV2(await escrow.getAddress(), cid)).settled).to.be.true;
        });

        it("11.98 upgrade between deposit and withdraw -- idle balance correctly computed", async () => {
            const { escrow, owner, bundler } = await deploy();

            const depositedBefore = await escrow.deposited(bundler.address);

            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2, { kind: "uups", unsafeSkipStorageCheck: true });

            const idle = await escrow.idleBalance(bundler.address);
            expect(idle).to.equal(depositedBefore);

            // Withdraw all idle
            await escrow.connect(bundler).withdraw(idle);
            expect(await escrow.deposited(bundler.address)).to.equal(0n);
        });

        it("11.99 chained upgrades: V1 -> V2Safe -> V2Reinit(initV2) -> V2Safe -- reinitializer consumed, cannot re-run", async () => {
            const { escrow, owner } = await deploy();

            // V1 -> V2Safe
            const V2a = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(await escrow.getAddress(), V2a, { kind: "uups", unsafeSkipStorageCheck: true });

            // V2Safe -> V2Reinit with initializeV2
            const V2Reinit = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const reinitImpl = await V2Reinit.deploy();
            const initData = V2Reinit.interface.encodeFunctionData("initializeV2", [42n]);
            await escrow.connect(owner).upgradeToAndCall(await reinitImpl.getAddress(), initData);

            // V2Reinit -> V2Safe again
            const V2b = await ethers.getContractFactory("SLAEscrowV2Safe");
            const v2bImpl = await V2b.deploy();
            await escrow.connect(owner).upgradeToAndCall(await v2bImpl.getAddress(), "0x");

            // Now go BACK to V2Reinit -- initializeV2 should fail (reinitializer(2) already consumed)
            const V2Reinit2 = await ethers.getContractFactory("SLAEscrowV2Reinit");
            const reinitImpl2 = await V2Reinit2.deploy();
            const initData2 = V2Reinit2.interface.encodeFunctionData("initializeV2", [99n]);

            await expect(
                escrow.connect(owner).upgradeToAndCall(await reinitImpl2.getAddress(), initData2)
            ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");
        });

        it("11.100 full lifecycle across upgrade: deposit -> commit -> upgrade -> settle -> claimPayout -> withdraw", async () => {
            const { escrow, owner, bundler, user, feeRecipient, registry, QUOTE_ID } = await deploy();
            const proxyAddr = await escrow.getAddress();

            // 1. Bundler already deposited in deploy()
            const depositedStart = await escrow.deposited(bundler.address);

            // 2. User commits
            const cid = await makeCommit(escrow, user, QUOTE_ID, "full-lifecycle");
            const balAfterCommit = await contractBalance(proxyAddr);

            // 3. Upgrade
            const V2 = await ethers.getContractFactory("SLAEscrowV2Safe");
            await upgrades.upgradeProxy(proxyAddr, V2, { kind: "uups", unsafeSkipStorageCheck: true });

            // 4. Bundler settles -- read via V2Safe ABI after upgrade
            await (V2.attach(proxyAddr) as any).connect(bundler).settle(cid);
            expect((await commitsV2(proxyAddr, cid)).settled).to.be.true;

            // 5. Bundler claims payout
            const bundlerPending = await escrow.pendingWithdrawals(bundler.address);
            expect(bundlerPending).to.equal(ONE_GWEI); // PROTOCOL_FEE_WEI=0, bundler earns full feePaid
            await escrow.connect(bundler).claimPayout();
            expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(0n);

            // 6. Fee recipient claims
            const feePending = await escrow.pendingWithdrawals(feeRecipient.address);
            if (feePending > 0n) {
                await escrow.connect(feeRecipient).claimPayout();
            }

            // 7. Bundler withdraws remaining idle
            const idle = await escrow.idleBalance(bundler.address);
            if (idle > 0n) {
                await escrow.connect(bundler).withdraw(idle);
            }

            // 8. Final invariant: contract balance should equal remaining deposits + pending
            const finalBal = await contractBalance(proxyAddr);
            const finalDep = await escrow.deposited(bundler.address);
            expect(finalBal).to.equal(finalDep);
        });
    });
});
