import type { CommitInfo, PendingCommit } from "@surelock-labs/protocol";

// Mirrors of SLAEscrow constants -- must stay in sync with the contract.
export const SETTLEMENT_GRACE_BLOCKS = 10n;
export const REFUND_GRACE_BLOCKS     = 5n;
export const ACCEPT_GRACE_BLOCKS     = 12n;
/** blockhash() returns zero for blocks older than 256 blocks ago. */
export const PROOF_HORIZON_BLOCKS    = 256n;

/** Default urgency threshold for helpers that warn near expiry (~100 s on Base). */
const DEFAULT_WARN_BLOCKS = 50n;

/**
 * Blocks remaining until settle() expires.
 * settle() is valid while block.number <= deadline + SETTLEMENT_GRACE_BLOCKS.
 * Returns 0n if the window has already closed.
 */
export function blocksUntilSettlementExpiry(
  commit: Pick<CommitInfo, "deadline">,
  currentBlock: bigint,
): bigint {
  const expiry = commit.deadline + SETTLEMENT_GRACE_BLOCKS;
  return expiry >= currentBlock ? expiry - currentBlock : 0n;
}

/**
 * Blocks until claimRefund() becomes callable.
 * Opens at: deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1.
 * Returns 0n if the refund window is already open.
 */
export function blocksUntilRefundWindow(
  commit: Pick<CommitInfo, "deadline">,
  currentBlock: bigint,
): bigint {
  const opens = commit.deadline + SETTLEMENT_GRACE_BLOCKS + REFUND_GRACE_BLOCKS + 1n;
  return opens > currentBlock ? opens - currentBlock : 0n;
}

/**
 * Given that the UserOp was included at `inclusionBlock`, returns the latest block
 * at which a settle() call will succeed -- the minimum of:
 *   - deadline + SETTLEMENT_GRACE_BLOCKS  (contract settle window)
 *   - inclusionBlock + 256               (blockhash() availability horizon)
 *
 * A return value < currentBlock means the window is already closed.
 * A return value equal to currentBlock means this is the last valid block to settle.
 */
export function safeSettlementLatestBlock(
  commit: Pick<CommitInfo, "deadline">,
  inclusionBlock: bigint,
): bigint {
  const contractWindow = commit.deadline + SETTLEMENT_GRACE_BLOCKS;
  const proofHorizon   = inclusionBlock + PROOF_HORIZON_BLOCKS;
  return contractWindow < proofHorizon ? contractWindow : proofHorizon;
}

/**
 * Returns true if the settle() window is within `warnBlocks` of closing,
 * including the last valid block (where 0 remaining blocks means "settle now").
 * Default: 50 blocks (~100 s on Base).
 */
export function isSettlementUrgent(
  commit: Pick<CommitInfo, "deadline">,
  currentBlock: bigint,
  warnBlocks = DEFAULT_WARN_BLOCKS,
): boolean {
  const expiry = commit.deadline + SETTLEMENT_GRACE_BLOCKS;
  if (currentBlock > expiry) return false; // window already closed
  return expiry - currentBlock <= warnBlocks; // includes last valid block (0 remaining)
}

/**
 * Returns true if the accept window is within `warnBlocks` of closing,
 * including the last valid block (where 0 remaining means "accept now").
 * Default: 3 blocks (~6 s on Base -- roughly half of ACCEPT_GRACE_BLOCKS).
 */
export function isAcceptWindowUrgent(
  commit: Pick<CommitInfo | PendingCommit, "acceptDeadline">,
  currentBlock: bigint,
  warnBlocks = 3n,
): boolean {
  if (currentBlock > commit.acceptDeadline) return false; // window closed
  return commit.acceptDeadline - currentBlock <= warnBlocks; // includes last valid block
}
