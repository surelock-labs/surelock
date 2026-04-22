/** On-chain offer as returned by QuoteRegistry. */
export interface Offer {
  quoteId: bigint;
  bundler: string;
  feePerOp: bigint;
  slaBlocks: number;
  collateralWei: bigint;
  active: boolean;
  lifetime?: number;
  registeredAt?: bigint;
  bond?: bigint;
}

/** Full on-chain state of a commitment (read via escrow.getCommit()). */
export interface CommitInfo {
  commitId: bigint;
  user: string;
  feePaid: bigint;
  bundler: string;
  collateralLocked: bigint;
  /** SLA deadline block; valid only when `accepted` is true (zero before). */
  deadline: bigint;
  settled: boolean;
  refunded: boolean;
  quoteId: bigint;
  userOpHash: string;
  /** Block number where the UserOp was included on-chain. Zero if not yet settled. */
  inclusionBlock: bigint;
  /** Bundler has accepted and locked collateral (PROPOSED -> ACTIVE). */
  accepted: boolean;
  /** Commit was cancelled (CLIENT only during accept window; CLIENT, BUNDLER, or feeRecipient after acceptDeadline). */
  cancelled: boolean;
  /** Deadline block for bundler accept (commitBlock + ACCEPT_GRACE_BLOCKS). */
  acceptDeadline: bigint;
  /** SLA window in blocks, copied from the offer at commit time. */
  slaBlocks: number;
}

/** Lightweight representation of a CommitCreated event. */
export interface PendingCommit {
  commitId: bigint;
  quoteId: bigint;
  user: string;
  userOpHash: string;
  /** Bundler must call accept() before this block or the commit becomes cancellable. */
  acceptDeadline: bigint;
}

/** Returned by commitOp -- block number lets callers pin reads on load-balanced RPCs. */
export interface CommitResult {
  commitId: bigint;
  blockNumber: number;
}
