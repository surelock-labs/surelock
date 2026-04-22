// Integration tests for @surelock-labs/bundler against a live in-process Hardhat chain.
// Deploys real QuoteRegistry + SLAEscrow and exercises the full SureLock bundler lifecycle.

import { expect }   from "chai";
import { ethers }   from "hardhat";
import { mine, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { PendingCommit } from "@surelock-labs/bundler";
import { commitOp as routerCommitOp, cancel as sdkCancel, claimRefund as sdkClaimRefund } from "@surelock-labs/router";

import {
  register,
  deregister,
  deregisterExpired,
  renew,
  claimBond,
  getPendingBond,
  deposit,
  withdraw,
  claimPayout,
  getCommit,
  getIdleBalance,
  getDeposited,
  getPendingPayout,
  fetchAcceptedCommits,
  watchCommits,
  accept,
  settle as sdkSettle,
  computeUserOpHash,
  type UserOperation,
} from "@surelock-labs/bundler";

import { buildBlockHeaderRlp, buildReceiptProof } from "./helpers/buildSettleProof";

import {
  ONE_GWEI,
  COLLATERAL,
  MIN_BOND,
  deployEscrow,
  deployRealEscrow,
  mineToRefundable,
} from "./helpers/fixtures";
import type { QuoteRegistry, SLAEscrow } from "../typechain-types";

/** Test helper: settle via the 1-arg SLAEscrowTestable overload (no proof required). */
async function settle(signer: any, escrowAddress: string, commitId: bigint): Promise<void> {
  const esc = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
  const tx = await esc.connect(signer)["settle(uint256)"](commitId);
  await tx.wait();
}

// -- fixture ------------------------------------------------------------------
// Uses shared deployEscrow() with skipRegister:true -- these tests exercise the
// register() SDK function itself and expect the first registration to return quoteId=1.

async function deploy() {
  const base = await deployEscrow({ skipRegister: true });
  return {
    registry:        base.registry,
    escrow:          base.escrow,
    registryAddress: base.registryAddress,
    escrowAddress:   base.escrowAddress,
    owner:           base.owner,
    bundler:         base.bundler,
    user:            base.user,
    feeRecipient:    base.feeRecipient,
    bundler2:        base.bundler2,
  };
}

// -- register / deregister -----------------------------------------------------

describe("register", () => {
  it("registers an offer and returns the quoteId", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    const offer = await register(bundler, registryAddress, {
      feePerOp: ONE_GWEI,
      slaBlocks: 5,
      collateralWei: COLLATERAL,
    });
    expect(offer.quoteId).to.equal(1n);
    expect(offer.feePerOp).to.equal(ONE_GWEI);
    expect(offer.slaBlocks).to.equal(5);
    expect(offer.collateralWei).to.equal(COLLATERAL);
    expect(offer.bundler.toLowerCase()).to.equal(bundler.address.toLowerCase());
  });

  it("each registration increments the quoteId", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    const { quoteId: id0 } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    const { quoteId: id1 } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI * 2n, slaBlocks: 3, collateralWei: COLLATERAL });
    expect(id0).to.equal(1n);
    expect(id1).to.equal(2n);
  });

  it("reverts when collateralWei < feePerOp", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    await expect(
      register(bundler, registryAddress, { feePerOp: ONE_GWEI * 2n, slaBlocks: 5, collateralWei: ONE_GWEI }),
    ).to.be.rejectedWith(/collateralWei must be > feePerOp|couldn't infer/);
  });

  it("reverts on zero slaBlocks", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    await expect(
      register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 0, collateralWei: COLLATERAL }),
    ).to.be.rejectedWith(/slaBlocks must be > 0|couldn't infer/);
  });
});

describe("deregister", () => {
  it("deactivates the offer on-chain", async () => {
    const { registry, registryAddress, bundler } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deregister(bundler, registryAddress, quoteId);
    const offer = await registry.getOffer(quoteId);
    expect(offer.bond).to.equal(0n); // deregistered
  });

  it("deregistered offer no longer appears in list()", async () => {
    const { registry, registryAddress, bundler } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deregister(bundler, registryAddress, quoteId);
    const offers = await registry.list();
    expect(offers.length).to.equal(0);
  });

  it("reverts when caller is not the offer owner", async () => {
    const { registry, registryAddress, bundler, user } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await expect(deregister(user, registryAddress, quoteId))
      .to.be.rejectedWith("NotOfferOwner");
  });
});

// -- collateral management -----------------------------------------------------

describe("deposit / getIdleBalance / getDeposited", () => {
  it("increases idle and deposited balances after deposit", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    await deposit(bundler, escrowAddress, COLLATERAL);
    const idle = await getIdleBalance(ethers.provider, escrowAddress, bundler.address);
    const total = await getDeposited(ethers.provider, escrowAddress, bundler.address);
    expect(idle).to.equal(COLLATERAL);
    expect(total).to.equal(COLLATERAL);
  });

  it("multiple deposits accumulate correctly", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    await deposit(bundler, escrowAddress, COLLATERAL);
    await deposit(bundler, escrowAddress, COLLATERAL * 2n);
    const idle = await getIdleBalance(ethers.provider, escrowAddress, bundler.address);
    expect(idle).to.equal(COLLATERAL * 3n);
  });

  it("reverts on zero deposit", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    await expect(deposit(bundler, escrowAddress, 0n)).to.be.rejectedWith("ZeroDeposit");
  });
});

describe("getPendingPayout", () => {
  it("returns 0 when nothing is pending", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    expect(await getPendingPayout(ethers.provider, escrowAddress, bundler.address)).to.equal(0n);
  });

  it("reflects the fee credited by settle()", async () => {
    const fix = await loadFixture(deploy);
    const { registryAddress, escrowAddress, bundler, user } = fix;
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundler, escrowAddress, COLLATERAL);

    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const protocolFee = BigInt(await escrow.protocolFeeWei());
    const userOp = ethers.keccak256(ethers.toUtf8Bytes("getPendingPayout-test"));
    const tx = await escrow.connect(user).commit(quoteId, userOp, bundler.address, COLLATERAL, 10, { value: ONE_GWEI + protocolFee });
    const receipt = await tx.wait();
    const log = receipt!.logs.map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);
    const esc = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
    await esc.connect(bundler).accept(commitId);
    await esc.connect(bundler)["settle(uint256)"](commitId);

    expect(await getPendingPayout(ethers.provider, escrowAddress, bundler.address)).to.equal(ONE_GWEI);
    await claimPayout(bundler, escrowAddress);
    expect(await getPendingPayout(ethers.provider, escrowAddress, bundler.address)).to.equal(0n);
  });
});

describe("computeUserOpHash", () => {
  const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
  const userOp: UserOperation = {
    sender:               "0x1234567890123456789012345678901234567890",
    nonce:                0n,
    initCode:             "0x",
    callData:             "0xdeadbeef",
    callGasLimit:         50_000n,
    verificationGasLimit: 80_000n,
    preVerificationGas:   21_000n,
    maxFeePerGas:         ethers.parseUnits("2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    paymasterAndData:     "0x",
  };

  it("matches a fresh inline reference implementation", async () => {
    const chainId = 84532n;
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const inner = ethers.keccak256(coder.encode(
      ["address","uint256","bytes32","bytes32","uint256","uint256","uint256","uint256","uint256","bytes32"],
      [userOp.sender, userOp.nonce,
       ethers.keccak256(userOp.initCode),
       ethers.keccak256(userOp.callData),
       userOp.callGasLimit, userOp.verificationGasLimit, userOp.preVerificationGas,
       userOp.maxFeePerGas, userOp.maxPriorityFeePerGas,
       ethers.keccak256(userOp.paymasterAndData)],
    ));
    const expected = ethers.keccak256(coder.encode(["bytes32","address","uint256"], [inner, entryPoint, chainId]));
    expect(computeUserOpHash(userOp, entryPoint, chainId)).to.equal(expected);
  });

  it("changes when any input changes", async () => {
    const base = computeUserOpHash(userOp, entryPoint, 84532n);
    expect(computeUserOpHash({ ...userOp, nonce: 1n }, entryPoint, 84532n)).to.not.equal(base);
    expect(computeUserOpHash(userOp, "0x0000000000000000000000000000000000000001", 84532n)).to.not.equal(base);
    expect(computeUserOpHash(userOp, entryPoint, 8453n)).to.not.equal(base);
  });

  it("accepts number and bigint for nonce and chainId", async () => {
    const h1 = computeUserOpHash(userOp, entryPoint, 84532);
    const h2 = computeUserOpHash(userOp, entryPoint, 84532n);
    expect(h1).to.equal(h2);
  });
});

describe("withdraw", () => {
  it("reduces idle balance after withdrawal", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    await deposit(bundler, escrowAddress, COLLATERAL);
    await withdraw(bundler, escrowAddress, COLLATERAL / 2n);
    const idle = await getIdleBalance(ethers.provider, escrowAddress, bundler.address);
    expect(idle).to.equal(COLLATERAL / 2n);
  });

  it("can withdraw the entire idle balance", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    await deposit(bundler, escrowAddress, COLLATERAL);
    await withdraw(bundler, escrowAddress, COLLATERAL);
    expect(await getIdleBalance(ethers.provider, escrowAddress, bundler.address)).to.equal(0n);
  });

  it("reverts when withdrawing more than idle", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    await deposit(bundler, escrowAddress, COLLATERAL);
    await expect(withdraw(bundler, escrowAddress, COLLATERAL * 2n)).to.be.rejectedWith("InsufficientIdle");
  });
});

// -- settle + claimPayout ------------------------------------------------------

describe("settle + claimPayout", () => {
  async function setupCommit() {
    const fix = await loadFixture(deploy);
    const { registryAddress, escrowAddress, bundler, user } = fix;

    const { quoteId } = await register(bundler, registryAddress, {
      feePerOp: ONE_GWEI,
      slaBlocks: 10,
      collateralWei: COLLATERAL,
    });
    await deposit(bundler, escrowAddress, COLLATERAL);

    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const registry = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await registry.getOffer(quoteId);
    const userOp = ethers.keccak256(ethers.toUtf8Bytes("test-userop"));
    const tx = await escrow.connect(user).commit(quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    const escrowFull = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
    await escrowFull.connect(bundler).accept(commitId);

    return { ...fix, commitId, quoteId };
  }

  it("settle marks the commit as settled", async () => {
    const { escrowAddress, bundler, commitId } = await setupCommit();
    await settle(bundler, escrowAddress, commitId);
    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(info.settled).to.be.true;
    expect(info.refunded).to.be.false;
  });

  it("settle queues the full fee for bundler payout (PROTOCOL_FEE_WEI=0)", async () => {
    const { escrow, escrowAddress, bundler, commitId } = await setupCommit();
    await settle(bundler, escrowAddress, commitId);
    const pending = BigInt(await escrow.pendingWithdrawals(bundler.address));
    expect(pending).to.equal(ONE_GWEI);
  });

  it("claimPayout transfers the pending amount to the bundler", async () => {
    const { escrow, escrowAddress, bundler, commitId } = await setupCommit();
    await settle(bundler, escrowAddress, commitId);

    const claimed = await claimPayout(bundler, escrowAddress);
    expect(claimed).to.equal(ONE_GWEI);

    // pendingWithdrawals cleared
    const pending = BigInt(await escrow.pendingWithdrawals(bundler.address));
    expect(pending).to.equal(0n);
  });

  it("claimPayout returns 0 when there is nothing pending", async () => {
    const { escrowAddress, bundler } = await loadFixture(deploy);
    const claimed = await claimPayout(bundler, escrowAddress);
    expect(claimed).to.equal(0n);
  });

  it("reverts settling after deadline", async () => {
    const { escrow, escrowAddress, bundler, commitId } = await setupCommit();
    // Mine past deadline + settlement grace + refund grace so settle() reverts.
    await mineToRefundable(escrow, commitId);
    await expect(settle(bundler, escrowAddress, commitId))
      .to.be.rejectedWith("DeadlinePassed");
  });

  it("a non-bundler can settle (permissionless); fee routes to bundler", async () => {
    const { escrowAddress, user, bundler, commitId } = await setupCommit();
    const pendingBefore = await (await ethers.getContractAt("SLAEscrow", escrowAddress)).pendingWithdrawals(bundler.address);
    await settle(user, escrowAddress, commitId);
    const pendingAfter = await (await ethers.getContractAt("SLAEscrow", escrowAddress)).pendingWithdrawals(bundler.address);
    // PROTOCOL_FEE_WEI=0 -> bundler gets full feePerOp credited on settle().
    expect(pendingAfter).to.equal(pendingBefore + ONE_GWEI);
  });
});

// -- getCommit -----------------------------------------------------------------

describe("getCommit", () => {
  it("returns correct commit fields", async () => {
    const { registryAddress, escrowAddress, bundler, user } = await loadFixture(deploy);
    const slaBlocks = 5;
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks, collateralWei: COLLATERAL });
    await deposit(bundler, escrowAddress, COLLATERAL);

    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const registry = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await registry.getOffer(quoteId);
    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("get-commit-test"));
    const tx = await escrow.connect(user).commit(quoteId, userOpHash, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    // Two-phase commit: accept() sets the deadline (PROPOSED -> ACTIVE)
    const escrowTestable = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
    const acceptTx = await escrowTestable.connect(bundler).accept(commitId);
    const acceptRcpt = await acceptTx.wait();
    const acceptBlock = BigInt(acceptRcpt!.blockNumber);

    const info = await getCommit(ethers.provider, escrowAddress, commitId);

    expect(info.commitId).to.equal(commitId);
    expect(info.user.toLowerCase()).to.equal(user.address.toLowerCase());
    expect(info.bundler.toLowerCase()).to.equal(bundler.address.toLowerCase());
    expect(info.feePaid).to.equal(ONE_GWEI);
    expect(info.collateralLocked).to.equal(COLLATERAL);
    expect(info.quoteId).to.equal(quoteId);
    expect(info.userOpHash).to.equal(userOpHash);
    expect(info.settled).to.be.false;
    expect(info.refunded).to.be.false;
    // deadline set exactly at accept() block + slaBlocks (T9).
    expect(info.deadline).to.equal(acceptBlock + BigInt(slaBlocks));
  });
});

// -- watchCommits --------------------------------------------------------------

describe("fetchAcceptedCommits", () => {
  async function acceptOne(fix: Awaited<ReturnType<typeof deploy>>, tag: string) {
    const { registryAddress, escrowAddress, bundler, user } = fix;
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL });
    await deposit(bundler, escrowAddress, COLLATERAL);
    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const protocolFee = BigInt(await escrow.protocolFeeWei());
    const tx = await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes(tag)), bundler.address, COLLATERAL, 10, { value: ONE_GWEI + protocolFee });
    const receipt = await tx.wait();
    const log = receipt!.logs.map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);
    const esc = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
    const acceptTx = await esc.connect(bundler).accept(commitId);
    const acceptRcpt = await acceptTx.wait();
    return { commitId, acceptBlock: acceptRcpt!.blockNumber };
  }

  it("returns accepted events for this bundler", async () => {
    const fix = await loadFixture(deploy);
    const fromBlock = await ethers.provider.getBlockNumber();
    const { commitId, acceptBlock } = await acceptOne(fix, "fac-1");

    const accepted = await fetchAcceptedCommits(ethers.provider, fix.escrowAddress, fix.bundler.address, fromBlock);
    expect(accepted).to.have.length(1);
    expect(accepted[0].commitId).to.equal(commitId);
    expect(accepted[0].blockNumber).to.equal(acceptBlock);
    expect(accepted[0].deadline).to.be.greaterThan(0n);
  });

  it("excludes events for other bundlers via indexed filter", async () => {
    const fix = await loadFixture(deploy);
    const fromBlock = await ethers.provider.getBlockNumber();
    await acceptOne(fix, "fac-2");

    const other = await fetchAcceptedCommits(ethers.provider, fix.escrowAddress, fix.bundler2.address, fromBlock);
    expect(other).to.have.length(0);
  });

  it("returns historical records -- does not filter commits that have since settled", async () => {
    const fix = await loadFixture(deploy);
    const fromBlock = await ethers.provider.getBlockNumber();
    const { commitId } = await acceptOne(fix, "fac-3");

    const esc = await ethers.getContractAt("SLAEscrowTestable", fix.escrowAddress);
    await esc.connect(fix.bundler)["settle(uint256)"](commitId);

    const accepted = await fetchAcceptedCommits(ethers.provider, fix.escrowAddress, fix.bundler.address, fromBlock);
    expect(accepted).to.have.length(1);
    expect(accepted[0].commitId).to.equal(commitId);
  });
});

describe("watchCommits", () => {
  it("fires the callback when a commit is directed at the bundler", async () => {
    const { escrow: escrowContract, registryAddress, escrowAddress, bundler, user } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundler, escrowAddress, COLLATERAL);

    const userOp = ethers.keccak256(ethers.toUtf8Bytes("watch-test"));

    // Set up a promise that resolves when the callback fires; also capture the
    // commit block so we can assert acceptDeadline exactly.
    let commitBlock: bigint = 0n;
    const received = await new Promise<PendingCommit>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("watchCommits timeout")), 10_000);
      const unwatch = watchCommits(ethers.provider, escrowAddress, bundler.address, (c) => {
        clearTimeout(timer);
        unwatch();
        resolve(c);
      });

      const escrow = ethers.getContractAt("SLAEscrow", escrowAddress).then(async (e) => {
        const reg = await ethers.getContractAt("QuoteRegistry", registryAddress);
        const offer = await reg.getOffer(quoteId);
        return e.connect(user).commit(quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
      }).then(async (tx) => {
        const rcpt = await tx.wait();
        commitBlock = BigInt(rcpt!.blockNumber);
      }).catch(reject);
    });

    const accGrace = BigInt(await escrowContract.ACCEPT_GRACE_BLOCKS());
    expect(received.userOpHash).to.equal(userOp);
    expect(received.quoteId).to.equal(quoteId);
    // acceptDeadline set at commit() to commitBlock + ACCEPT_GRACE_BLOCKS (exact).
    expect(received.acceptDeadline).to.equal(commitBlock + accGrace);
  });

  it("does NOT fire for commits directed at a different bundler", async () => {
    const { registryAddress, escrowAddress, bundler, user, bundler2 } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundler, escrowAddress, COLLATERAL);

    const received: PendingCommit[] = [];
    // Watch for bundler2, but commits go to bundler
    const unwatch = watchCommits(ethers.provider, escrowAddress, bundler2.address, (c) => {
      received.push(c);
    });

    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const registry = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await registry.getOffer(quoteId);
    await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("not-for-you")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
    await new Promise((r) => setTimeout(r, 50));

    unwatch();
    expect(received).to.have.length(0);
  });

  it("stops firing after unwatch() is called", async () => {
    const { registryAddress, escrowAddress, bundler, user } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deposit(bundler, escrowAddress, COLLATERAL * 2n);

    const received: PendingCommit[] = [];
    const unwatch = watchCommits(ethers.provider, escrowAddress, bundler.address, (c) => {
      received.push(c);
    });

    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const registry = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await registry.getOffer(quoteId);
    await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("before")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
    await new Promise((r) => setTimeout(r, 50));

    unwatch();

    await escrow.connect(user).commit(quoteId, ethers.keccak256(ethers.toUtf8Bytes("after")), offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).to.have.length(1); // only the first commit
  });
});

// -- full happy-path flow ------------------------------------------------------

describe("full happy-path (register -> deposit -> commit -> settle -> claim)", () => {
  it("bundler earns the net fee end-to-end", async () => {
    const { registryAddress, escrowAddress, bundler, user, feeRecipient } = await loadFixture(deploy);

    // 1. Register and deposit
    const { quoteId } = await register(bundler, registryAddress, {
      feePerOp: ONE_GWEI,
      slaBlocks: 10,
      collateralWei: COLLATERAL,
    });
    await deposit(bundler, escrowAddress, COLLATERAL);

    // 2. User commits (router side)
    const escrow = await ethers.getContractAt("SLAEscrow", escrowAddress);
    const registry = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const offer = await registry.getOffer(quoteId);
    const userOp = ethers.keccak256(ethers.toUtf8Bytes("e2e-happy"));
    const commitTx = await escrow.connect(user).commit(quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
    const commitReceipt = await commitTx.wait();
    const log = commitReceipt!.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    // Two-phase commit: bundler must accept() to transition PROPOSED -> ACTIVE
    const escrowTestable = await ethers.getContractAt("SLAEscrowTestable", escrowAddress);
    await escrowTestable.connect(bundler).accept(commitId);

    // 3. Collateral is locked during the commitment
    const idleDuring = await getIdleBalance(ethers.provider, escrowAddress, bundler.address);
    expect(idleDuring).to.equal(0n); // all COLLATERAL locked

    // 4. Bundler settles
    await settle(bundler, escrowAddress, commitId);

    // 5. Collateral unlocked, fee queued
    const idleAfter = await getIdleBalance(ethers.provider, escrowAddress, bundler.address);
    expect(idleAfter).to.equal(COLLATERAL);



    // 6. Claim payouts
    const escrowInst = await ethers.getContractAt("SLAEscrow", escrowAddress);
    await claimPayout(bundler, escrowAddress);
    expect(BigInt(await escrowInst.pendingWithdrawals(bundler.address))).to.equal(0n);

    // 7. Contract should hold only the deposited collateral now
    const contractBal = await ethers.provider.getBalance(escrowAddress);
    expect(contractBal).to.equal(COLLATERAL);
  });
});

// -- settle (real A10 proof via SDK + real SLAEscrow) --------------------------

describe("settle (real A10 proof via SDK + real SLAEscrow)", () => {
  it("SDK settle() calls the real 5-arg proof path and settles the commit (A10)", async () => {
    const { registry, escrow, escrowAddress, bundler, user, mockEP } = await deployRealEscrow();

    await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND });
    await escrow.connect(bundler).deposit({ value: COLLATERAL });

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("sdk-a10-settle"));
    const commitTx = await escrow.connect(user).commit(
      1n, userOpHash, bundler.address, COLLATERAL, 10, { value: ONE_GWEI },
    );
    await commitTx.wait();
    const commitId = 0n;
    await accept(bundler, escrowAddress, commitId);

    const inclusionTx = await mockEP.connect(bundler).handleOp(userOpHash);
    const inclusionReceipt = await inclusionTx.wait();

    const rpc = { send: (m: string, p: unknown[]) => ethers.provider.send(m, p) };
    const blockHeaderRlp = await buildBlockHeaderRlp(rpc, inclusionReceipt.blockNumber);
    const { proofNodes, txIndex } = await buildReceiptProof(rpc, inclusionReceipt.blockNumber, inclusionReceipt.hash);

    await sdkSettle(
      bundler, escrowAddress, commitId,
      BigInt(inclusionReceipt.blockNumber), blockHeaderRlp, proofNodes, txIndex,
    );

    const info = await getCommit(ethers.provider, escrowAddress, commitId);
    expect(info.settled).to.be.true;
    expect(await escrow.pendingWithdrawals(bundler.address)).to.equal(ONE_GWEI);
  });

  it("SDK settle() propagates InvalidInclusionProof when UserOp success=false (A1)", async () => {
    const { registry, escrow, escrowAddress, bundler, user, mockEP } = await deployRealEscrow();

    await registry.connect(bundler).register(ONE_GWEI, 10, COLLATERAL, 302_400, { value: MIN_BOND });
    await escrow.connect(bundler).deposit({ value: COLLATERAL });

    const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("sdk-failed-a1"));
    await escrow.connect(user).commit(1n, userOpHash, bundler.address, COLLATERAL, 10, { value: ONE_GWEI });
    await accept(bundler, escrowAddress, 0n);

    const tx = await mockEP.connect(bundler).handleFailedOp(userOpHash);
    const receipt = await tx.wait();

    const rpc = { send: (m: string, p: unknown[]) => ethers.provider.send(m, p) };
    const blockHeaderRlp = await buildBlockHeaderRlp(rpc, receipt.blockNumber);
    const { proofNodes, txIndex } = await buildReceiptProof(rpc, receipt.blockNumber, receipt.hash);

    await expect(
      sdkSettle(bundler, escrowAddress, 0n, BigInt(receipt.blockNumber), blockHeaderRlp, proofNodes, txIndex),
    ).to.be.rejectedWith("InvalidInclusionProof");
  });
});

// -- PROTOCOL_FEE_WEI > 0 economics -------------------------------------------

const FLAT_FEE = 5_000n;

async function deployWithFee() {
  const base = await deployEscrow({ skipRegister: true, protocolFeeWei: FLAT_FEE });
  return { ...base, FLAT_FEE };
}

describe("PROTOCOL_FEE_WEI > 0 economics", () => {
  async function registerAndDeposit(fix: Awaited<ReturnType<typeof deployWithFee>>) {
    const { quoteId } = await register(fix.bundler, fix.registryAddress, {
      feePerOp: ONE_GWEI, slaBlocks: 10, collateralWei: COLLATERAL,
    });
    await deposit(fix.bundler, fix.escrowAddress, COLLATERAL);
    const registry = await ethers.getContractAt("QuoteRegistry", fix.registryAddress);
    const offer    = await registry.getOffer(quoteId);
    return { quoteId, offer };
  }

  it("commit requires feePerOp + protocolFeeWei; sending only feePerOp reverts WrongFee", async () => {
    const fix = await deployWithFee();
    const { quoteId, offer } = await registerAndDeposit(fix);
    const userOp = ethers.keccak256(ethers.toUtf8Bytes("wrong-fee-test"));

    await expect(
      fix.escrow.connect(fix.user).commit(
        quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks,
        { value: ONE_GWEI },
      ),
    ).to.be.revertedWithCustomError(fix.escrow, "WrongFee");

    await fix.escrow.connect(fix.user).commit(
      quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: ONE_GWEI + FLAT_FEE },
    );
  });

  it("protocolFeeWei credited to feeRecipient at commit, before settle", async () => {
    const fix = await deployWithFee();
    const { quoteId, offer } = await registerAndDeposit(fix);

    const pendingBefore = BigInt(await fix.escrow.pendingWithdrawals(fix.feeRecipient.address));
    await fix.escrow.connect(fix.user).commit(
      quoteId, ethers.keccak256(ethers.toUtf8Bytes("fee-credit")),
      offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: ONE_GWEI + FLAT_FEE },
    );
    expect(await fix.escrow.pendingWithdrawals(fix.feeRecipient.address)).to.equal(pendingBefore + FLAT_FEE);
  });

  it("cancel returns feePerOp to user; protocolFee stays with feeRecipient (T4)", async () => {
    const fix = await deployWithFee();
    const { quoteId, offer } = await registerAndDeposit(fix);

    const commitTx = await fix.escrow.connect(fix.user).commit(
      quoteId, ethers.keccak256(ethers.toUtf8Bytes("cancel-fee")),
      offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: ONE_GWEI + FLAT_FEE },
    );
    const rcpt = await commitTx.wait();
    const log  = rcpt!.logs
      .map((l: any) => { try { return fix.escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    await sdkCancel(fix.user, fix.escrowAddress, commitId);

    expect(await fix.escrow.pendingWithdrawals(fix.user.address)).to.equal(ONE_GWEI);
    expect(await fix.escrow.pendingWithdrawals(fix.feeRecipient.address)).to.equal(FLAT_FEE);
  });

  it("claimRefund returns feePerOp + collateral to user; protocolFee stays (T11)", async () => {
    const fix = await deployWithFee();
    const { quoteId, offer } = await registerAndDeposit(fix);

    const commitTx = await fix.escrow.connect(fix.user).commit(
      quoteId, ethers.keccak256(ethers.toUtf8Bytes("refund-fee")),
      offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: ONE_GWEI + FLAT_FEE },
    );
    const rcpt = await commitTx.wait();
    const log  = rcpt!.logs
      .map((l: any) => { try { return fix.escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    const escrowTestable = await ethers.getContractAt("SLAEscrowTestable", fix.escrowAddress);
    await escrowTestable.connect(fix.bundler).accept(commitId);
    await mineToRefundable(fix.escrow, commitId);
    await sdkClaimRefund(fix.user, fix.escrowAddress, commitId);

    expect(await fix.escrow.pendingWithdrawals(fix.user.address)).to.equal(ONE_GWEI + COLLATERAL);
    expect(await fix.escrow.pendingWithdrawals(fix.feeRecipient.address)).to.equal(FLAT_FEE);
    expect(await getIdleBalance(ethers.provider, fix.escrowAddress, fix.bundler.address)).to.equal(0n);
  });

  it("settle credits feePerOp to bundler; feeRecipient retains protocolFee from commit", async () => {
    const fix = await deployWithFee();
    const { quoteId, offer } = await registerAndDeposit(fix);

    const commitTx = await fix.escrow.connect(fix.user).commit(
      quoteId, ethers.keccak256(ethers.toUtf8Bytes("settle-fee")),
      offer.bundler, offer.collateralWei, offer.slaBlocks,
      { value: ONE_GWEI + FLAT_FEE },
    );
    const rcpt = await commitTx.wait();
    const log  = rcpt!.logs
      .map((l: any) => { try { return fix.escrow.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommitCreated");
    const commitId = BigInt(log!.args.commitId);

    const escrowTestable = await ethers.getContractAt("SLAEscrowTestable", fix.escrowAddress);
    await escrowTestable.connect(fix.bundler).accept(commitId);
    await settle(fix.bundler, fix.escrowAddress, commitId);

    expect(await fix.escrow.pendingWithdrawals(fix.bundler.address)).to.equal(ONE_GWEI);
    expect(await fix.escrow.pendingWithdrawals(fix.feeRecipient.address)).to.equal(FLAT_FEE);
  });
});

// -- cancel / claimRefund cleanup flows ----------------------------------------

describe("cancel / claimRefund cleanup flows", () => {
  async function setupOffer() {
    const fix = await loadFixture(deploy);
    const { quoteId } = await register(fix.bundler, fix.registryAddress, {
      feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL,
    });
    await deposit(fix.bundler, fix.escrowAddress, COLLATERAL);
    return { ...fix, quoteId };
  }

  async function commitOp(fix: Awaited<ReturnType<typeof setupOffer>>, tag: string) {
    const registry = await ethers.getContractAt("QuoteRegistry", fix.registryAddress);
    const offer    = await registry.getOffer(fix.quoteId);
    const userOp   = ethers.keccak256(ethers.toUtf8Bytes(tag));
    const res = await routerCommitOp(fix.user, fix.escrowAddress, {
      quoteId:       fix.quoteId,
      bundler:       offer.bundler as string,
      feePerOp:      BigInt(offer.feePerOp),
      slaBlocks:     Number(offer.slaBlocks),
      collateralWei: BigInt(offer.collateralWei),
      active:        true,
    }, userOp);
    return res.commitId;
  }

  it("client can cancel a PROPOSED commit during the accept window", async () => {
    const fix = await setupOffer();
    const commitId = await commitOp(fix, "cancel-proposed");
    const escrow = await ethers.getContractAt("SLAEscrow", fix.escrowAddress);

    await sdkCancel(fix.user, fix.escrowAddress, commitId);

    const info = await getCommit(ethers.provider, fix.escrowAddress, commitId);
    expect(info.cancelled).to.be.true;
    expect(info.settled).to.be.false;
    // feePerOp queued to user; collateral never locked (commit was PROPOSED)
    expect(await escrow.pendingWithdrawals(fix.user.address)).to.equal(ONE_GWEI);
    expect(await getIdleBalance(ethers.provider, fix.escrowAddress, fix.bundler.address)).to.equal(COLLATERAL);
  });

  it("bundler can cancel a PROPOSED commit after the accept window expires", async () => {
    const fix = await setupOffer();
    const commitId = await commitOp(fix, "cancel-expired");
    const escrow = await ethers.getContractAt("SLAEscrow", fix.escrowAddress);

    await mine(Number(await escrow.ACCEPT_GRACE_BLOCKS()) + 1);
    await sdkCancel(fix.bundler, fix.escrowAddress, commitId);

    const info = await getCommit(ethers.provider, fix.escrowAddress, commitId);
    expect(info.cancelled).to.be.true;
    expect(await escrow.pendingWithdrawals(fix.user.address)).to.equal(ONE_GWEI);
  });

  it("user can claimRefund after the SLA deadline + grace periods expire (T11)", async () => {
    const fix = await setupOffer();
    const commitId = await commitOp(fix, "refund-claim");
    const escrow = await ethers.getContractAt("SLAEscrow", fix.escrowAddress);
    const escrowTestable = await ethers.getContractAt("SLAEscrowTestable", fix.escrowAddress);

    await escrowTestable.connect(fix.bundler).accept(commitId);
    await mineToRefundable(fix.escrow, commitId);
    await sdkClaimRefund(fix.user, fix.escrowAddress, commitId);

    expect(await escrow.pendingWithdrawals(fix.user.address)).to.equal(ONE_GWEI + COLLATERAL);
    expect(await getIdleBalance(ethers.provider, fix.escrowAddress, fix.bundler.address)).to.equal(0n);
  });
});

// -- watchCommits data usability -----------------------------------------------

describe("watchCommits data usability", () => {
  it("callback commitId is sufficient to call SDK accept() immediately", async () => {
    const { escrow: escrowContract, registryAddress, escrowAddress, bundler, user } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, {
      feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL,
    });
    await deposit(bundler, escrowAddress, COLLATERAL);

    const userOp = ethers.keccak256(ethers.toUtf8Bytes("watch-usability"));
    const received = await new Promise<import("@surelock-labs/bundler").PendingCommit>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("watchCommits timeout")), 10_000);
      const unwatch = watchCommits(ethers.provider, escrowAddress, bundler.address, (c) => {
        clearTimeout(timer);
        unwatch();
        resolve(c);
      });

      ethers.getContractAt("SLAEscrow", escrowAddress).then(async (e) => {
        const reg   = await ethers.getContractAt("QuoteRegistry", registryAddress);
        const offer = await reg.getOffer(quoteId);
        return e.connect(user).commit(quoteId, userOp, offer.bundler, offer.collateralWei, offer.slaBlocks, { value: offer.feePerOp });
      }).then((tx) => tx.wait()).catch(reject);
    });

    await accept(bundler, escrowAddress, received.commitId);

    const info = await getCommit(ethers.provider, escrowAddress, received.commitId);
    expect(info.accepted).to.be.true;
    expect(info.deadline).to.be.greaterThan(0n);
  });
});

// -- renew / claimBond / getPendingBond / deregisterExpired --------------------

describe("renew", () => {
  it("resets the offer's registered-at block (extending lifetime)", async () => {
    const { registry, registryAddress, bundler } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    const beforeRenew = await registry.getOffer(quoteId);
    await mine(5);
    await renew(bundler, registryAddress, quoteId);
    const afterRenew = await registry.getOffer(quoteId);
    expect(BigInt(afterRenew.registeredAt)).to.be.greaterThan(BigInt(beforeRenew.registeredAt));
  });
});

describe("claimBond / getPendingBond", () => {
  it("getPendingBond returns 0 before any deregistration", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    const pending = await getPendingBond(ethers.provider, registryAddress, bundler.address);
    expect(pending).to.equal(0n);
  });

  it("deregister moves bond to pendingBonds; claimBond pulls it out", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    await deregister(bundler, registryAddress, quoteId);

    const pending = await getPendingBond(ethers.provider, registryAddress, bundler.address);
    expect(pending).to.equal(MIN_BOND);

    const claimed = await claimBond(bundler, registryAddress);
    expect(claimed).to.equal(MIN_BOND);
    expect(await getPendingBond(ethers.provider, registryAddress, bundler.address)).to.equal(0n);
  });

  it("claimBond returns 0 when nothing is pending", async () => {
    const { registryAddress, bundler } = await loadFixture(deploy);
    const claimed = await claimBond(bundler, registryAddress);
    expect(claimed).to.equal(0n);
  });
});

describe("deregisterExpired", () => {
  it("anyone can deregister an expired offer; bond goes to pendingBonds", async () => {
    const { registryAddress, bundler, user } = await loadFixture(deploy);
    const { quoteId } = await register(bundler, registryAddress, { feePerOp: ONE_GWEI, slaBlocks: 5, collateralWei: COLLATERAL });
    const registry = await ethers.getContractAt("QuoteRegistry", registryAddress);
    const lifetime = BigInt(await registry.MIN_LIFETIME());
    await mine(Number(lifetime) + 1);

    await deregisterExpired(user, registryAddress, quoteId);
    const pending = await getPendingBond(ethers.provider, registryAddress, bundler.address);
    expect(pending).to.equal(MIN_BOND);
  });
});
