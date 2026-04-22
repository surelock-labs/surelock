import { ethers } from "ethers";
import { REGISTRY_ABI, ESCROW_ABI, type Offer } from "@surelock-labs/protocol";
import { RegisterOfferParams, PendingCommit, CommitInfo, BundlerConfig } from "./types";
import { buildSettleProof, withRetry, SettleProof } from "./proof";

// -- offer management ----------------------------------------------------------

/**
 * Register a service offer on QuoteRegistry. Returns the full Offer so callers
 * can pass it directly to `commitOp()` without re-fetching from the registry.
 *
 * Breaking change in 0.1.4: previously returned just `bigint` (quoteId). Callers
 * who only need the id can now destructure `(await register(...)).quoteId`.
 */
export async function register(
  signer: ethers.Signer,
  registryAddress: string,
  params: RegisterOfferParams,
): Promise<Offer> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const lifetime = params.lifetime ?? 302_400; // MIN_LIFETIME default
  // Bond is always read fresh from the contract -- any stale override would
  // revert the tx. The one extra RPC call is worth the safety.
  const bond = BigInt(await registry.registrationBond());
  const tx = await registry.register(params.feePerOp, params.slaBlocks, params.collateralWei, lifetime, { value: bond });
  const receipt = await tx.wait();
  const event = receipt?.logs
    .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "OfferRegistered");
  if (!event) throw new Error("OfferRegistered event not found");
  return {
    quoteId:       BigInt(event.args.quoteId),
    bundler:       await signer.getAddress(),
    feePerOp:      params.feePerOp,
    slaBlocks:     params.slaBlocks,
    collateralWei: params.collateralWei,
    active:        true,
    lifetime,
    bond,
  };
}

/** Deactivate an offer. Only the offer owner (bundler) can call this. */
export async function deregister(
  signer: ethers.Signer,
  registryAddress: string,
  quoteId: bigint,
): Promise<ethers.ContractTransactionReceipt> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const tx = await registry.deregister(quoteId);
  return (await tx.wait())!;
}

/**
 * Permissionless cleanup of an expired offer. Anyone can call this. Bond goes
 * to the offer's bundler's pendingBonds (not the caller's).
 */
export async function deregisterExpired(
  signer: ethers.Signer,
  registryAddress: string,
  quoteId: bigint,
): Promise<ethers.ContractTransactionReceipt> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const tx = await registry.deregisterExpired(quoteId);
  return (await tx.wait())!;
}

/** Extend an offer's lifetime by resetting `registeredAt` to the current block. */
export async function renew(
  signer: ethers.Signer,
  registryAddress: string,
  quoteId: bigint,
): Promise<ethers.ContractTransactionReceipt> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const tx = await registry.renew(quoteId);
  return (await tx.wait())!;
}

/** Read the bundler's pendingBonds balance on the QuoteRegistry. */
export async function getPendingBond(
  provider: ethers.Provider,
  registryAddress: string,
  bundlerAddress: string,
): Promise<bigint> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  return BigInt(await registry.pendingBonds(bundlerAddress));
}

/**
 * Pull accumulated pendingBonds from the registry to the caller. Returns the
 * amount claimed (parsed from the BondClaimed event).
 */
export async function claimBond(
  signer: ethers.Signer,
  registryAddress: string,
): Promise<bigint> {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, signer);
  const pending = BigInt(await registry.pendingBonds(await signer.getAddress()));
  if (pending === 0n) return 0n;
  const tx = await registry.claimBond();
  const receipt = await tx.wait();
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed?.name === "BondClaimed") return BigInt(parsed.args.amount);
    } catch {}
  }
  return pending;
}

// -- collateral management -----------------------------------------------------

/** Deposit ETH as collateral into SLAEscrow. */
export async function deposit(
  signer: ethers.Signer,
  escrowAddress: string,
  amount: bigint,
): Promise<ethers.ContractTransactionReceipt> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.deposit({ value: amount });
  return (await tx.wait())!;
}

/** Withdraw idle (unlocked) collateral from SLAEscrow. */
export async function withdraw(
  signer: ethers.Signer,
  escrowAddress: string,
  amount: bigint,
): Promise<ethers.ContractTransactionReceipt> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.withdraw(amount);
  return (await tx.wait())!;
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
): Promise<ethers.ContractTransactionReceipt> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.accept(commitId);
  return (await tx.wait())!;
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
): Promise<ethers.ContractTransactionReceipt> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const tx = await escrow.settle(commitId, inclusionBlock, blockHeaderRlp, receiptProof, txIndex);
  return (await tx.wait())!;
}

/**
 * Claim all accumulated fee payouts for the caller. Returns the exact amount paid out.
 *
 * Pass `fromBlock` (e.g. the blockNumber from a recent settle/accept receipt) to pin
 * the pendingWithdrawals pre-check to a specific block. Required on load-balanced RPCs
 * where "latest" may lag behind the block that credited the payout.
 */
export async function claimPayout(
  signer: ethers.Signer,
  escrowAddress: string,
  fromBlock?: ethers.BlockTag,
): Promise<bigint> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const addr = await signer.getAddress();
  const readPending = fromBlock !== undefined
    ? () => escrow.pendingWithdrawals(addr, { blockTag: fromBlock })
    : () => escrow.pendingWithdrawals(addr);
  const pending = BigInt(await (fromBlock !== undefined ? withRetry(readPending) : readPending()));
  if (pending === 0n) return 0n;
  const tx = await escrow.claimPayout();
  const receipt = await tx.wait();
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === "PayoutClaimed") return BigInt(parsed.args.amount);
    } catch {}
  }
  return pending;
}

/**
 * Fetch the full on-chain state of a commit.
 *
 * Pass `blockTag` to pin the read to a specific block (e.g. the block number
 * returned by a recent write). This is essential on load-balanced RPCs where
 * "latest" may still be one or two blocks behind the node that accepted the
 * transaction.
 */
export async function getCommit(
  provider: ethers.Provider,
  escrowAddress: string,
  commitId: bigint,
  blockTag?: ethers.BlockTag,
): Promise<CommitInfo> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const fetch = () => blockTag !== undefined
    ? escrow.getCommit(commitId, { blockTag })
    : escrow.getCommit(commitId);
  // Pinned reads trigger load-balanced RPC lag ("header not found" / "block not found").
  // Auto-retry only when blockTag is set -- "latest" reads don't need it.
  const c = blockTag !== undefined ? await withRetry(fetch) : await fetch();
  return {
    commitId,
    user:             c.user as string,
    feePaid:          BigInt(c.feePaid),
    bundler:          c.bundler as string,
    collateralLocked: BigInt(c.collateralLocked),
    deadline:         BigInt(c.deadline),
    settled:          Boolean(c.settled),
    refunded:         Boolean(c.refunded),
    quoteId:          BigInt(c.quoteId),
    userOpHash:       c.userOpHash as string,
    inclusionBlock:   BigInt(c.inclusionBlock),
    accepted:         Boolean(c.accepted),
    cancelled:        Boolean(c.cancelled),
    acceptDeadline:   BigInt(c.acceptDeadline),
    slaBlocks:        Number(c.slaBlocks),
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
 * Scan past CommitCreated events for commits directed at this bundler.
 * Useful for one-shot discovery after a known block (e.g. right after commitOp).
 */
export async function fetchPendingCommits(
  provider: ethers.Provider,
  escrowAddress: string,
  bundlerAddress: string,
  fromBlock: number,
  toBlock: number | "latest" = "latest",
): Promise<PendingCommit[]> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const normalized = bundlerAddress.toLowerCase();
  const logs = await escrow.queryFilter(escrow.filters.CommitCreated(), fromBlock, toBlock);
  return logs
    .filter((log: any) => (log.args.bundler as string).toLowerCase() === normalized)
    .map((log: any) => ({
      commitId:      BigInt(log.args.commitId),
      quoteId:       BigInt(log.args.quoteId),
      user:          log.args.user as string,
      userOpHash:    log.args.userOpHash as string,
      acceptDeadline: BigInt(log.args.acceptDeadline),
    }));
}

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

    deregisterExpired: (signer: ethers.Signer, quoteId: bigint) =>
      deregisterExpired(signer, config.registryAddress, quoteId),

    renew: (signer: ethers.Signer, quoteId: bigint) =>
      renew(signer, config.registryAddress, quoteId),

    claimBond: (signer: ethers.Signer) =>
      claimBond(signer, config.registryAddress),

    getPendingBond: (bundlerAddress: string) =>
      getPendingBond(provider, config.registryAddress, bundlerAddress),

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

    getCommit: (commitId: bigint, blockTag?: ethers.BlockTag) =>
      getCommit(provider, config.escrowAddress, commitId, blockTag),

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
