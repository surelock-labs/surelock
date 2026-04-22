/**
 * Shared test fixture API for the SureLock test suite.
 *
 * THREE THINGS THIS FILE OWNS -- update only here when protocol changes:
 *   1. deployEscrow()    -- initialize() arg order + protocolFeeWei setup
 *   2. makeCommit()      -- msg.value formula (feePerOp + PROTOCOL_FEE_WEI)
 *   3. assertSettled() / assertRefunded() -- event field names & order
 *
 * Edge-case tests that intentionally send wrong values or trigger reverts
 * should call escrow.connect(user).commit(...) directly -- the wrappers are
 * only for the happy path.
 */

import { ethers, upgrades }  from "hardhat";
import { mine as _mine }     from "@nomicfoundation/hardhat-network-helpers";
import type { ContractTransactionResponse } from "ethers";
import type {
  SLAEscrow,
  QuoteRegistry,
  TimelockController,
} from "../../typechain-types";

// -- re-exports ----------------------------------------------------------------

export { mine } from "@nomicfoundation/hardhat-network-helpers";

// -- standard constants --------------------------------------------------------

export const ONE_GWEI     = ethers.parseUnits("1", "gwei");
export const COLLATERAL   = ethers.parseEther("0.01");
export const SLA_BLOCKS   = 20n;
export const MIN_BOND     = ethers.parseEther("0.0001");
export const MIN_LIFETIME = 302_400n;

// -- deploy --------------------------------------------------------------------

export interface DeployResult {
  escrow:          SLAEscrow;
  registry:        QuoteRegistry;
  escrowAddress:   string;
  registryAddress: string;
  owner:           Awaited<ReturnType<typeof ethers.getSigner>>;
  bundler:         Awaited<ReturnType<typeof ethers.getSigner>>;
  user:            Awaited<ReturnType<typeof ethers.getSigner>>;
  feeRecipient:    Awaited<ReturnType<typeof ethers.getSigner>>;
  stranger:        Awaited<ReturnType<typeof ethers.getSigner>>;
  attacker:        Awaited<ReturnType<typeof ethers.getSigner>>;
  bundler2:        Awaited<ReturnType<typeof ethers.getSigner>>;
  user2:           Awaited<ReturnType<typeof ethers.getSigner>>;
  QUOTE_ID:        bigint;
}

export interface DeployOpts {
  /** SLA window for the default offer. Default: SLA_BLOCKS (20). */
  slaBlocks?:      bigint;
  /** PROTOCOL_FEE_WEI to set after deploy. Default: 0n (fee-inactive). */
  protocolFeeWei?: bigint;
  /** Collateral for the default offer. Default: COLLATERAL (0.01 ETH). */
  collateral?:     bigint;
  /**
   * How much to pre-deposit for the default bundler.
   * Default: 3 x collateral.  Pass `false` to skip the deposit entirely
   * (useful for tests that manage collateral themselves).
   */
  preDeposit?:     bigint | false;
  /**
   * Skip register() + deposit entirely (tests manage their own offers).
   * QUOTE_ID is still 1n (what the first registration would have received).
   */
  skipRegister?:   boolean;
  /** NOT needed -- bundler2 is returned by default. */
  bundler2?:       never;
}

/**
 * Deploy QuoteRegistry + SLAEscrow proxy with one registered bundler offer.
 *
 * This is the ONLY place that calls upgrades.deployProxy() and knows the
 * initialize() argument order.  Change it once here when the constructor
 * signature changes -- nowhere else.
 */
export async function deployEscrow(opts?: DeployOpts): Promise<DeployResult> {
  const slaBlocks      = opts?.slaBlocks      ?? SLA_BLOCKS;
  const protocolFeeWei = opts?.protocolFeeWei ?? 0n;
  const collateral     = opts?.collateral     ?? COLLATERAL;

  const [owner, bundler, user, feeRecipient, stranger, attacker, bundler2, user2] =
    await ethers.getSigners();

  const Registry = await ethers.getContractFactory("QuoteRegistry");
  const registry = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;

  // -- THE initialize() arg list lives here and nowhere else ------------------
  const Escrow = await ethers.getContractFactory("SLAEscrowTestable");
  const escrow = (await upgrades.deployProxy(
    Escrow,
    [await registry.getAddress(), feeRecipient.address],
    { kind: "uups" },
  )) as unknown as SLAEscrow;

  if (protocolFeeWei > 0n) {
    await escrow.connect(owner).setProtocolFeeWei(protocolFeeWei);
  }

  const QUOTE_ID = 1n;

  if (!opts?.skipRegister) {
    await registry
      .connect(bundler)
      .register(ONE_GWEI, Number(slaBlocks), collateral, Number(MIN_LIFETIME), { value: MIN_BOND });

    const deposit =
      opts?.preDeposit === false ? 0n :
      opts?.preDeposit !== undefined ? opts.preDeposit :
      collateral * 3n;

    if (deposit > 0n) {
      await escrow.connect(bundler).deposit({ value: deposit });
    }
  }

  return {
    escrow,
    registry,
    escrowAddress:   await escrow.getAddress(),
    registryAddress: await registry.getAddress(),
    owner,
    bundler,
    user,
    feeRecipient,
    stranger,
    attacker,
    bundler2,
    user2,
    QUOTE_ID,
  };
}

/**
 * Deploy real SLAEscrow (not SLAEscrowTestable) with a MockEntryPoint.
 * Use this for A10 inclusion-proof tests that need the full MPT proof path.
 * The 1-arg testable settle(uint256) is NOT available; use the SDK settle().
 */
export async function deployRealEscrow() {
  const [owner, bundler, user, feeRecipient] = await ethers.getSigners();

  const EPFactory = await ethers.getContractFactory("MockEntryPoint");
  const mockEP    = await EPFactory.deploy();

  const Registry  = await ethers.getContractFactory("QuoteRegistry");
  const registry  = (await Registry.deploy(owner.address, MIN_BOND)) as QuoteRegistry;
  const registryAddress = await registry.getAddress();

  const EscrowFactory = await ethers.getContractFactory("SLAEscrow");
  const escrow = await upgrades.deployProxy(
    EscrowFactory,
    [registryAddress, feeRecipient.address],
    { kind: "uups", constructorArgs: [await mockEP.getAddress()] },
  ) as any;
  const escrowAddress = await escrow.getAddress();

  return { registry, escrow, mockEP, registryAddress, escrowAddress, owner, bundler, user, feeRecipient };
}

/**
 * Deploy with a TimelockController owning the escrow.
 * The deployer is proposer; ZeroAddress is executor (anyone can execute).
 */
export async function deployWithTimelock(
  delay = 3600,
  opts?: DeployOpts,
): Promise<DeployResult & { timelock: TimelockController }> {
  const base = await deployEscrow(opts);
  const { owner } = base;

  const TL = await ethers.getContractFactory("TimelockController");
  const timelock = (await TL.deploy(
    delay,
    [owner.address],
    [ethers.ZeroAddress],
    owner.address,
  )) as unknown as TimelockController;

  // transfer ownership to timelock
  await base.escrow.connect(owner).transferOwnership(await timelock.getAddress());

  return { ...base, timelock };
}

// -- offer registration --------------------------------------------------------

export interface OfferOpts {
  /** Fee per UserOp. Default: ONE_GWEI. */
  feePerOp?:   bigint;
  /** SLA window. Default: SLA_BLOCKS (20). */
  slaBlocks?:  bigint;
  /** Collateral per commit. Default: COLLATERAL (0.01 ETH). */
  collateral?: bigint;
  /** Offer active-until lifetime (blocks). Default: MIN_LIFETIME. */
  lifetime?:   bigint;
  /**
   * How much the bundler deposits after registering.
   * Default: same as collateral.  Pass `false` to skip.
   */
  deposit?:    bigint | false;
}

/**
 * Register a new offer for `bundler` and optionally deposit collateral.
 * Useful when a test needs multiple offers with different parameters.
 * Returns the quoteId of the new offer.
 */
export async function registerOffer(
  registry: QuoteRegistry,
  escrow:   SLAEscrow,
  bundler:  Awaited<ReturnType<typeof ethers.getSigner>>,
  opts?:    OfferOpts,
): Promise<bigint> {
  const feePerOp   = opts?.feePerOp   ?? ONE_GWEI;
  const slaBlocks  = opts?.slaBlocks  ?? SLA_BLOCKS;
  const collateral = opts?.collateral ?? COLLATERAL;
  const lifetime   = opts?.lifetime   ?? MIN_LIFETIME;

  const tx      = await registry.connect(bundler).register(
    feePerOp, Number(slaBlocks), collateral, Number(lifetime), { value: MIN_BOND },
  );
  const receipt = await tx.wait();

  let quoteId: bigint | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed?.name === "OfferRegistered") { quoteId = BigInt(parsed.args.quoteId); break; }
    } catch {}
  }
  if (quoteId === undefined) throw new Error("registerOffer: OfferRegistered event not found");

  const depositAmount =
    opts?.deposit === false ? 0n :
    opts?.deposit !== undefined ? opts.deposit :
    collateral;

  if (depositAmount > 0n) {
    await escrow.connect(bundler).deposit({ value: depositAmount });
  }

  return quoteId;
}

// -- commit --------------------------------------------------------------------

export interface CommitResult {
  commitId:    bigint;
  commitBlock: number;
}

/**
 * Commits without accepting -- leaves the commit in PROPOSED state (no collateral locked).
 * The bundler still has ACCEPT_GRACE_BLOCKS to call accept() before it can be cancelled.
 */
export async function makeProposedCommit(
  escrow:      SLAEscrow,
  registry:    QuoteRegistry,
  user:        Awaited<ReturnType<typeof ethers.getSigner>>,
  quoteId:     bigint,
  tag?:        string,
  userOpHash?: string,
): Promise<CommitResult> {
  const hash        = userOpHash ?? ethers.keccak256(ethers.toUtf8Bytes(tag ?? "default-op"));
  const offer       = await registry.getOffer(quoteId);
  const protocolFee = await escrow.protocolFeeWei();

  const tx      = await escrow.connect(user).commit(
    quoteId, hash, offer.bundler, offer.collateralWei, offer.slaBlocks,
    { value: offer.feePerOp + protocolFee },
  );
  const receipt = await tx.wait();

  let commitId: bigint | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "CommitCreated") {
        commitId = BigInt(parsed.args.commitId);
        break;
      }
    } catch {}
  }
  if (commitId === undefined) throw new Error("makeProposedCommit: CommitCreated event not found");
  return { commitId, commitBlock: receipt!.blockNumber };
}

/**
 * THE ONLY PLACE that knows msg.value = feePerOp + PROTOCOL_FEE_WEI.
 *
 * Two-phase happy path: commit() then accept() in two separate transactions.
 *
 * Creates a PROPOSED commit on behalf of `user`, then immediately has the
 * bundler accept() it (ACTIVE).  Uses `tag` to generate unique deterministic
 * userOpHash values so every commit in a test suite has a distinct hash.
 * Pass explicit `userOpHash` (bytes32 hex) to override (e.g. for collision tests).
 */
export async function makeCommit(
  escrow:      SLAEscrow,
  registry:    QuoteRegistry,
  user:        Awaited<ReturnType<typeof ethers.getSigner>>,
  quoteId:     bigint,
  tag?:        string,
  userOpHash?: string,
): Promise<CommitResult> {
  const hash        = userOpHash ?? ethers.keccak256(ethers.toUtf8Bytes(tag ?? "default-op"));
  const offer       = await registry.getOffer(quoteId);
  const protocolFee = await escrow.protocolFeeWei();

  const tx      = await escrow.connect(user).commit(
    quoteId, hash, offer.bundler, offer.collateralWei, offer.slaBlocks,
    { value: offer.feePerOp + protocolFee },
  );
  const receipt = await tx.wait();

  let commitId: bigint | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "CommitCreated") {
        commitId = BigInt(parsed.args.commitId);
        break;
      }
    } catch {}
  }
  if (commitId === undefined) throw new Error("makeCommit: CommitCreated event not found");

  // Two-phase: BUNDLER must accept() to transition PROPOSED -> ACTIVE.
  const bundlerSigner = await ethers.getSigner(offer.bundler);
  await (escrow as any).connect(bundlerSigner).accept(commitId);

  return { commitId, commitBlock: receipt!.blockNumber };
}

/**
 * Extract commitId from any transaction that emits CommitCreated.
 * Useful when a test calls escrow.commit() directly (e.g. for revert tests
 * where the raw callsite is unavoidable) but still needs the id.
 */
export async function getCommitId(
  tx:     ContractTransactionResponse,
  escrow: SLAEscrow,
): Promise<bigint> {
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "CommitCreated") return BigInt(parsed.args.commitId);
    } catch {}
  }
  throw new Error("getCommitId: CommitCreated event not found");
}

// -- settle --------------------------------------------------------------------

/**
 * Settle via SLAEscrowTestable's 1-arg settle(commitId) -- no MPT proof needed
 * in unit/adversarial tests.  Returns the tx for event assertions.
 *
 * settle() is permissionless; the caller signer is arbitrary but callers
 * conventionally pass the bundler for readability.
 */
export async function makeSettle(
  escrow:   SLAEscrow,
  bundler:  Awaited<ReturnType<typeof ethers.getSigner>>,
  commitId: bigint,
): Promise<ContractTransactionResponse> {
  // SLAEscrowTestable exposes settle(uint256 commitId) that calls _settle() directly.
  // The cast is safe -- all test deployments use SLAEscrowTestable.
  return (escrow as any).connect(bundler)["settle(uint256)"](commitId);
}

// -- event assertions ----------------------------------------------------------
//
// These are THE ONLY PLACES that name Settled / Refunded event fields.
// When an event signature changes, update only here.

/**
 * Assert the tx emitted Settled(commitId, bundlerNet).
 * `expectedBundlerNet` = feePerOp when PROTOCOL_FEE_WEI=0 (default).
 */
export async function assertSettled(
  tx:                  ContractTransactionResponse,
  escrow:              SLAEscrow,
  commitId:            bigint,
  expectedBundlerNet:  bigint,
): Promise<void> {
  const { expect } = await import("chai");
  await expect(tx)
    .to.emit(escrow, "Settled")
    .withArgs(commitId, expectedBundlerNet);
}

/**
 * Assert the tx emitted Refunded(commitId, userAmount).
 * `expectedUserAmount` = feePaid + collateralLocked (client gets 100%).
 */
export async function assertRefunded(
  tx:                  ContractTransactionResponse,
  escrow:              SLAEscrow,
  commitId:            bigint,
  expectedUserAmount:  bigint,
): Promise<void> {
  const { expect } = await import("chai");
  await expect(tx)
    .to.emit(escrow, "Refunded")
    .withArgs(commitId, expectedUserAmount);
}

// -- amount helpers ------------------------------------------------------------
//
// Encapsulate current fee / slash math.  If the split changes (e.g. protocol
// takes a cut), update only here -- not in every test file.

/**
 * Amount the bundler receives when a commit is settled.
 * Currently: full feePerOp (PROTOCOL_FEE_WEI credited at commit time, not here).
 */
export function bundlerNet(feePerOp: bigint): bigint {
  return feePerOp;
}

/**
 * Amount the user receives when they claim a refund (SLA miss).
 * Currently: feePaid + collateralLocked in full (100% slash to client).
 */
export function userRefundAmount(feePaid: bigint, collateral: bigint): bigint {
  return feePaid + collateral;
}

// -- commit accessor -----------------------------------------------------------

/**
 * Fetch all fields of a commit. Uses getCommit() on-chain (returns Commit memory --
 * no stack overflow) so all 14 fields come back in one call.
 */
export async function getCommit(escrow: SLAEscrow, commitId: bigint | number) {
  return escrow.getCommit(BigInt(commitId));
}

// -- timing helpers ------------------------------------------------------------

/**
 * Mine blocks so that the NEXT tx lands at block `target`
 * (no-op if already at or past `target`).  This matches the semantic
 * used across the cat14/cat18/cat19 lifecycle tests: after calling
 * `mineTo(X)`, the subsequent `await tx.wait()` resolves with `blockNumber == X`.
 */
export async function mineTo(target: bigint): Promise<void> {
  const current = BigInt(await ethers.provider.getBlockNumber());
  const diff    = target - current - 1n; // the next tx itself adds one block
  if (diff > 0n) await _mine(Number(diff));
}

/**
 * Mine to exactly the commit's deadline block (settle window closes after this).
 */
export async function mineToDeadline(escrow: SLAEscrow, commitId: bigint): Promise<void> {
  const c       = await getCommit(escrow, commitId);
  const current = BigInt(await ethers.provider.getBlockNumber());
  if (BigInt(c.deadline) > current) await _mine(Number(BigInt(c.deadline) - current));
}

/**
 * Mine past deadline + SETTLEMENT_GRACE + REFUND_GRACE so claimRefund() is callable.
 */
export async function mineToRefundable(escrow: SLAEscrow, commitId: bigint): Promise<void> {
  const c       = await getCommit(escrow, commitId);
  const settle  = await escrow.SETTLEMENT_GRACE_BLOCKS();
  const grace   = await escrow.REFUND_GRACE_BLOCKS();
  const current = BigInt(await ethers.provider.getBlockNumber());
  const target  = BigInt(c.deadline) + BigInt(settle) + BigInt(grace) + 2n;
  if (target > current) await _mine(Number(target - current));
}

/** Alias kept for backwards-compat. Prefer mineToRefundable(). */
export const expireCommit = mineToRefundable;

/**
 * Returns an inclusion block number safely before the commit deadline.
 * Used in tests to settle without triggering InclusionAfterDeadline.
 */
export async function safeInclBlock(
  escrow: SLAEscrow,
  commitId: bigint,
): Promise<bigint> {
  const c = await getCommit(escrow, commitId);
  return c.deadline - 1n;
}

// -- invariant helpers ---------------------------------------------------------

/**
 * Assert the decomposed ETH accounting invariant:
 *   address(escrow).balance == sum(deposited[b]) + sum(pendingWithdrawals[p]) + pendingFees
 *
 * Useful when you need to verify the breakdown of funds rather than just
 * the single-line reservedBalance check.  Prefer assertReservedInvariant for
 * lifecycle tests; use this for targeted accounting assertions.
 */
export async function assertBalanceInvariant(
  escrow:      SLAEscrow,
  bundlers:    string[],
  parties:     string[],
  pendingFees: bigint = 0n,
  label = "",
): Promise<void> {
  const { expect } = await import("chai");
  let sumDeposited = 0n;
  for (const b of bundlers) sumDeposited += await escrow.deposited(b);
  let sumPending = 0n;
  for (const a of parties) sumPending += await escrow.pendingWithdrawals(a);
  const bal = await ethers.provider.getBalance(await escrow.getAddress());
  expect(bal, `balance invariant broken${label ? " @ " + label : ""}`).to.equal(
    sumDeposited + sumPending + pendingFees,
  );
}

/**
 * Assert the ETH accounting invariant:
 *   address(escrow).balance == reservedBalance
 */
export async function assertReservedInvariant(
  escrow:   SLAEscrow,
  provider: typeof ethers.provider,
): Promise<void> {
  const { expect } = await import("chai");
  const bal      = await provider.getBalance(await escrow.getAddress());
  const reserved = await escrow.reservedBalance();
  expect(bal).to.equal(reserved, "balance != reservedBalance: ETH accounting broken");
}

/**
 * Assert lockedOf[bundler] == sum of collateralLocked across all open commits
 * in `commitIds`.  "Open" = not settled and not refunded.
 */
export async function assertLockedOfInvariant(
  escrow:    SLAEscrow,
  bundler:   string,
  commitIds: bigint[],
): Promise<void> {
  const { expect } = await import("chai");
  let expected = 0n;
  for (const id of commitIds) {
    const c = await getCommit(escrow, id);
    if (c.bundler.toLowerCase() === bundler.toLowerCase() && !c.settled && !c.refunded) {
      expected += BigInt(c.collateralLocked);
    }
  }
  const actual = await escrow.lockedOf(bundler);
  expect(actual).to.equal(expected,
    `lockedOf[${bundler.slice(0, 8)}] mismatch: expected ${expected}, got ${actual}`);
}

/**
 * Assert the QuoteRegistry ETH accounting invariant:
 *   address(registry).balance >= totalTracked
 */
export async function assertRegistryInvariant(
  registry: QuoteRegistry,
  provider: typeof ethers.provider,
): Promise<void> {
  const { expect } = await import("chai");
  const bal     = await provider.getBalance(await registry.getAddress());
  const tracked = await registry.totalTracked();
  expect(bal).to.be.gte(tracked, "registry balance < totalTracked: ETH accounting broken");
}

/** Backwards-compat alias. */
export const registryTotalTrackedInvariant = assertRegistryInvariant;
