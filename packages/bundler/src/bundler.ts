import { ethers } from "ethers";
import { REGISTRY_ABI, ESCROW_ABI } from "@surelock-labs/protocol";
import { RegisterOfferParams, PendingCommit, CommitInfo, BundlerConfig } from "./types";
import { buildSettleProof, SettleProof } from "./proof";

// -- offer management ----------------------------------------------------------

/** Register a service offer on QuoteRegistry. Returns the assigned quoteId. */
export async function register(
  signer: ethers.Signer,
  registryAddress: string,
  params: RegisterOfferParams,
): Promise<bigint> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const lifetime = params.lifetime ?? 302_400; // MIN_LIFETIME default
  const bond = params.bond ?? BigInt(await registry.registrationBond());
  const tx = await registry.register(params.feePerOp, params.slaBlocks, params.collateralWei, lifetime, { value: bond });
  const receipt = await tx.wait();
  const event = receipt?.logs
    .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "OfferRegistered");
  if (!event) throw new Error("OfferRegistered event not found");
  return BigInt(event.args.quoteId);
}

/** Deactivate an offer. Only the offer owner (bundler) can call this. */
export async function deregister(
  signer: ethers.Signer,
  registryAddress: string,
  quoteId: bigint,
): Promise<void> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const tx = await registry.deregister(quoteId);
  await tx.wait();
}

// -- collateral management -----------------------------------------------------

/** Deposit ETH as collateral into SLAEscrow. */
export async function deposit(
  signer: ethers.Signer,
  escrowAddress: string,
  amount: bigint,
): Promise<void> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.deposit({ value: amount });
  await tx.wait();
}

/** Withdraw idle (unlocked) collateral from SLAEscrow. */
export async function withdraw(
  signer: ethers.Signer,
  escrowAddress: string,
  amount: bigint,
): Promise<void> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.withdraw(amount);
  await tx.wait();
}

/** Return the bundler's idle (unlocked) balance in SLAEscrow. */
export async function getIdleBalance(
  provider: ethers.Provider,
  escrowAddress: string,
  bundlerAddress: string,
): Promise<bigint> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  return BigInt(await escrow.idleBalance(bundlerAddress));
}

/** Return the bundler's total deposited balance (idle + locked) in SLAEscrow. */
export async function getDeposited(
  provider: ethers.Provider,
  escrowAddress: string,
  bundlerAddress: string,
): Promise<bigint> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  return BigInt(await escrow.deposited(bundlerAddress));
}

// -- commit lifecycle ----------------------------------------------------------

/**
 * Accept a PROPOSED commit -- locks collateral and starts the SLA clock (T25/A9).
 * Must be called by the named bundler within ACCEPT_GRACE_BLOCKS of the commit.
 * After accept, the commit is ACTIVE and the bundler has `slaBlocks` to settle.
 */
export async function accept(
  signer: ethers.Signer,
  escrowAddress: string,
  commitId: bigint,
): Promise<void> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.accept(commitId);
  await tx.wait();
}

/**
 * Settle a commit with an MPT receipt proof (A10).
 *
 * The bundler provides the RLP-encoded block header and a Merkle Patricia Trie proof
 * that the EntryPoint emitted `UserOperationEvent(userOpHash, ...)` in the named block.
 *
 * @param inclusionBlock  Block number where inclusion occurred (must be <= commit deadline
 *                        and within the last 256 blocks from the current block).
 * @param blockHeaderRlp  RLP-encoded block header for `inclusionBlock`.
 * @param receiptProof    Ordered MPT proof nodes (root -> leaf) for the receipt trie.
 * @param txIndex         Transaction index of the EntryPoint bundle within the block.
 */
export async function settle(
  signer: ethers.Signer,
  escrowAddress: string,
  commitId: bigint,
  inclusionBlock: bigint,
  blockHeaderRlp: string,
  receiptProof: string[],
  txIndex: number,
): Promise<void> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.settle(commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);
  await tx.wait();
}

/** Claim all accumulated fee payouts for the caller. Returns the exact amount paid out. */
export async function claimPayout(
  signer: ethers.Signer,
  escrowAddress: string,
): Promise<bigint> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const pending = BigInt(await escrow.pendingWithdrawals(await signer.getAddress()));
  if (pending === 0n) return 0n;
  const tx = await escrow.claimPayout();
  const receipt = await tx.wait();
  // Parse amount from the PayoutClaimed event -- exact, even if additional
  // payouts accrued between the pre-tx snapshot and execution.
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "PayoutClaimed") return BigInt(parsed.args.amount);
    } catch {}
  }
  return pending; // fallback: return pre-tx snapshot if event not found
}

/** Fetch the full on-chain state of a commit. */
export async function getCommit(
  provider: ethers.Provider,
  escrowAddress: string,
  commitId: bigint,
): Promise<CommitInfo> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const [core, state] = await Promise.all([
    escrow.getCommitCore(commitId),
    escrow.getCommitState(commitId),
  ]);
  return {
    commitId,
    user: core.user as string,
    feePaid: BigInt(core.feePaid),
    bundler: core.bundler as string,
    collateralLocked: BigInt(core.collateralLocked),
    deadline: BigInt(core.deadline),
    settled: Boolean(core.settled),
    refunded: Boolean(core.refunded),
    quoteId: BigInt(state.quoteId),
    userOpHash: state.userOpHash as string,
    inclusionBlock: BigInt(state.inclusionBlock),
    accepted: Boolean(state.accepted),
    cancelled: Boolean(state.cancelled),
    acceptDeadline: BigInt(state.acceptDeadline),
    slaBlocks: Number(state.slaBlocks),
  };
}

// -- accept policy ------------------------------------------------------------

/** Per-check results from validateBeforeAccept. */
export interface AcceptChecks {
  /** Commit exists and is PROPOSED (not accepted/settled/refunded/cancelled). */
  notFinalized: boolean;
  /** Current block is within the accept window (<= acceptDeadline). */
  windowOpen: boolean;
  /** Bundler's idle balance >= commit.collateralLocked. */
  sufficientIdle: boolean;
}

/**
 * Result of validateBeforeAccept.
 * Note: UserOp simulation, nonce validity, and fee profitability are off-chain
 * concerns that callers must validate separately using the UserOp payload.
 */
export interface AcceptValidation {
  /** True only if all on-chain checks pass. */
  canAccept: boolean;
  checks: AcceptChecks;
  /** Human-readable reason for the first failing check, or undefined if all pass. */
  reason?: string;
}

/**
 * Pre-flight check before calling accept() -- validates on-chain conditions.
 * Does not send any transaction.
 *
 * @param provider        Ethers provider for read calls.
 * @param escrowAddress   SLAEscrow contract address.
 * @param commitId        Commitment to validate.
 * @param bundlerAddress  Bundler whose idle balance is checked.
 */
export async function validateBeforeAccept(
  provider: ethers.Provider,
  escrowAddress: string,
  commitId: bigint,
  bundlerAddress: string,
): Promise<AcceptValidation> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);

  const [c, currentBlock] = await Promise.all([
    escrow.getCommit(commitId),
    provider.getBlockNumber(),
  ]);

  const correctBundler =
    typeof c.bundler === "string" &&
    c.bundler.toLowerCase() === bundlerAddress.toLowerCase();

  const idle = correctBundler ? BigInt(await escrow.idleBalance(c.bundler)) : 0n;

  const notFinalized  = c.user !== ethers.ZeroAddress &&
                        !c.accepted && !c.cancelled && !c.settled && !c.refunded;
  const windowOpen    = BigInt(currentBlock) <= BigInt(c.acceptDeadline);
  const sufficientIdle = idle >= BigInt(c.collateralLocked);

  const canAccept = notFinalized && correctBundler && windowOpen && sufficientIdle;

  let reason: string | undefined;
  if (!notFinalized)      reason = "commit is already finalized or does not exist";
  else if (!correctBundler) reason = `commit belongs to ${c.bundler}, not ${bundlerAddress}`;
  else if (!windowOpen)   reason = `accept window closed at block ${c.acceptDeadline} (current: ${currentBlock})`;
  else if (!sufficientIdle) reason = `insufficient idle: need ${c.collateralLocked} wei, have ${idle} wei`;

  return { canAccept, checks: { notFinalized, windowOpen, sufficientIdle }, reason };
}

// -- event watching ------------------------------------------------------------

/**
 * Subscribe to CommitCreated events directed at this bundler.
 * The callback receives a PendingCommit for each new commit.
 * Returns an unsubscribe function.
 */
export function watchCommits(
  provider: ethers.Provider,
  escrowAddress: string,
  bundlerAddress: string,
  callback: (commit: PendingCommit) => Promise<void> | void,
): () => void {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const normalized = bundlerAddress.toLowerCase();

  const handler = (
    commitId: bigint,
    quoteId: bigint,
    user: string,
    bundler: string,
    userOpHash: string,
    acceptDeadline: bigint,
  ) => {
    if (bundler.toLowerCase() !== normalized) return;
    Promise.resolve(callback({ commitId, quoteId, user, userOpHash, acceptDeadline })).catch(
      (err) => console.error(`[watchCommits] unhandled error for commit ${commitId}:`, err),
    );
  };

  escrow.on("CommitCreated", handler);
  return () => { escrow.off("CommitCreated", handler); };
}

// -- batch ordering ------------------------------------------------------------

/**
 * Place SureLock UserOps first among the ops in a bundle whenever possible.
 *
 * SLAEscrow.settle() scans receipt logs sequentially to find the UserOperationEvent
 * matching `c.userOpHash`. Placing SureLock UserOps early in the receipt reduces that
 * scan cost; the exact log index depends on
 * how many SureLock ops are batched together and what other logs the EntryPoint emits
 * before them, so "early" is the correct characterisation, not a fixed index.
 *
 * Preserves relative order within each group (stable partition).
 *
 * After deploying, collect a logIndex histogram via `buildSettleProof({ userOpHash })`
 * to measure actual scan depth and decide whether Option B (logIndex hint param) is
 * worth the protocol change.
 *
 * @param ops           UserOp array to be passed to EntryPoint.handleOps().
 * @param isSureLockOp  Returns true for any op that has an active SureLock commit.
 *                      Typically: `(op) => activeHashes.has(computeUserOpHash(op))`.
 *
 * @example
 * const ordered = prioritizeSureLockOps(mempool, (op) => myCommitHashes.has(op.hash));
 * await entryPoint.handleOps(ordered.map(o => o.userOp), bundlerAddress);
 */
export function prioritizeSureLockOps<T>(
  ops: T[],
  isSureLockOp: (op: T) => boolean,
): T[] {
  const sureLock: T[] = [];
  const rest: T[] = [];
  for (const op of ops) {
    (isSureLockOp(op) ? sureLock : rest).push(op);
  }
  return [...sureLock, ...rest];
}

// -- factory -------------------------------------------------------------------

/** Create a bundler client bound to specific contract addresses. */
export function createBundlerClient(config: BundlerConfig) {
  const provider = config.provider ?? new ethers.JsonRpcProvider(config.rpcUrl);

  return {
    register: (signer: ethers.Signer, params: RegisterOfferParams) =>
      register(signer, config.registryAddress, params),

    deregister: (signer: ethers.Signer, quoteId: bigint) =>
      deregister(signer, config.registryAddress, quoteId),

    deposit: (signer: ethers.Signer, amount: bigint) =>
      deposit(signer, config.escrowAddress, amount),

    withdraw: (signer: ethers.Signer, amount: bigint) =>
      withdraw(signer, config.escrowAddress, amount),

    accept: (signer: ethers.Signer, commitId: bigint) =>
      accept(signer, config.escrowAddress, commitId),

    settle: (
      signer: ethers.Signer,
      commitId: bigint,
      inclusionBlock: bigint,
      blockHeaderRlp: string,
      receiptProof: string[],
      txIndex: number,
    ) => settle(signer, config.escrowAddress, commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex),

    claimPayout: (signer: ethers.Signer) =>
      claimPayout(signer, config.escrowAddress),

    getCommit: (commitId: bigint) =>
      getCommit(provider, config.escrowAddress, commitId),

    getIdleBalance: (bundlerAddress: string) =>
      getIdleBalance(provider, config.escrowAddress, bundlerAddress),

    getDeposited: (bundlerAddress: string) =>
      getDeposited(provider, config.escrowAddress, bundlerAddress),

    watchCommits: (bundlerAddress: string, callback: (commit: PendingCommit) => Promise<void> | void) =>
      watchCommits(provider, config.escrowAddress, bundlerAddress, callback),

    validateBeforeAccept: (commitId: bigint, bundlerAddress: string) =>
      validateBeforeAccept(provider, config.escrowAddress, commitId, bundlerAddress),

    /**
     * Build the complete MPT proof bundle for SLAEscrow.settle().
     * Returns blockHeaderRlp, hex-encoded receiptProof[], txIndex, and inclusionBlock.
     * Pass the result directly to `client.settle()`.
     *
     * Pass `userOpHash` to also get `logIndex` and `logCount` for the settle-gas
     * histogram -- useful for deciding whether a logIndex hint is worth adding.
     */
    buildSettleProof: (inclusionBlock: number, txHash: string, userOpHash?: string): Promise<SettleProof> => {
      // JsonRpcProvider.send() is needed for raw RPC access. The factory always
      // constructs a JsonRpcProvider when config.provider is not supplied; when
      // the caller provides their own, it must also be a JsonRpcProvider.
      const rpc = { send: (m: string, p: unknown[]) => (provider as any).send(m, p) };
      return buildSettleProof(rpc, inclusionBlock, txHash, userOpHash);
    },
  };
}
