import { ethers } from "ethers";
import { ESCROW_ABI } from "@surelock-labs/protocol";
import type { CommitInfo } from "@surelock-labs/protocol";
import {
  blocksUntilSettlementExpiry,
  blocksUntilRefundWindow,
  safeSettlementLatestBlock,
  isSettlementUrgent,
  isAcceptWindowUrgent,
} from "./deadline";

export type MonitorAlertType =
  | "ACCEPT_WINDOW_EXPIRING"  // PROPOSED commit -- accept window closing soon
  | "DEADLINE_APPROACHING"    // ACTIVE commit -- settle() window closing soon
  | "PROOF_HORIZON_WARNING"   // inclusion known, but blockhash() expiring soon
  | "REFUND_WINDOW_OPEN"      // ACTIVE commit -- claimRefund() is now callable
  | "LOW_IDLE_COLLATERAL";    // bundler idle balance below threshold

export interface MonitorAlert {
  type: MonitorAlertType;
  commitId?: bigint;
  blocksRemaining?: bigint;
  message: string;
}

/**
 * Check a commit for monitoring alerts at the current block.
 * Pure -- no async calls. Run on each new block for real-time alerting.
 *
 * @param commit         Full CommitInfo for the commitment.
 * @param currentBlock   Current chain block number (as bigint).
 * @param warnBlocks     Urgency threshold (default 50 blocks ~= 100 s on Base).
 * @param inclusionBlock If the bundler has observed on-chain inclusion, pass the
 *                       block number here to enable proof-horizon warnings.
 */
export function checkActiveCommit(
  commit: CommitInfo,
  currentBlock: bigint,
  warnBlocks = 50n,
  inclusionBlock?: bigint,
): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];

  if (commit.accepted && !commit.settled && !commit.refunded && !commit.cancelled) {
    // Approaching settle() expiry
    const settleRemaining = blocksUntilSettlementExpiry(commit, currentBlock);
    if (isSettlementUrgent(commit, currentBlock, warnBlocks)) {
      alerts.push({
        type: "DEADLINE_APPROACHING",
        commitId: commit.commitId,
        blocksRemaining: settleRemaining,
        message: `commit ${commit.commitId}: settle() expires in ${settleRemaining} block(s)`,
      });
    }

    // Refund window open -- BUNDLER can call claimRefund() to release locked collateral
    if (blocksUntilRefundWindow(commit, currentBlock) === 0n) {
      alerts.push({
        type: "REFUND_WINDOW_OPEN",
        commitId: commit.commitId,
        blocksRemaining: 0n,
        message: `commit ${commit.commitId}: refund window open -- call claimRefund() to release collateral`,
      });
    }

    // Proof horizon warning (only when caller has observed on-chain inclusion)
    if (inclusionBlock !== undefined) {
      const latestSafe = safeSettlementLatestBlock(commit, inclusionBlock);
      if (currentBlock > latestSafe) {
        // Window is actually closed (currentBlock past the last valid block).
        alerts.push({
          type: "PROOF_HORIZON_WARNING",
          commitId: commit.commitId,
          blocksRemaining: 0n,
          message: `commit ${commit.commitId}: settle() window closed (included at block ${inclusionBlock})`,
        });
      } else {
        // latestSafe - currentBlock = 0 means "this is the last valid block -- settle now"
        const proofRemaining = latestSafe - currentBlock;
        if (proofRemaining <= warnBlocks) {
          alerts.push({
            type: "PROOF_HORIZON_WARNING",
            commitId: commit.commitId,
            blocksRemaining: proofRemaining,
            message: `commit ${commit.commitId}: settle() proof window expires in ${proofRemaining} block(s)`,
          });
        }
      }
    }
  }

  // PROPOSED commit -- accept window expiring
  if (!commit.accepted && !commit.cancelled && !commit.settled && !commit.refunded) {
    const acceptRemaining = commit.acceptDeadline >= currentBlock
      ? commit.acceptDeadline - currentBlock
      : 0n;
    if (isAcceptWindowUrgent(commit, currentBlock, 3n)) {
      alerts.push({
        type: "ACCEPT_WINDOW_EXPIRING",
        commitId: commit.commitId,
        blocksRemaining: acceptRemaining,
        message: `commit ${commit.commitId}: accept window expires in ${acceptRemaining} block(s)`,
      });
    }
  }

  return alerts;
}

/**
 * Check idle collateral against a minimum threshold.
 * Returns an alert if idleBalance < minIdle, null otherwise.
 */
export function checkIdleCollateral(
  idleBalance: bigint,
  minIdle: bigint,
): MonitorAlert | null {
  if (idleBalance < minIdle) {
    return {
      type: "LOW_IDLE_COLLATERAL",
      message: `idle collateral ${idleBalance} wei is below minimum threshold ${minIdle} wei`,
    };
  }
  return null;
}

/**
 * Subscribe to CommitAccepted events for a specific bundler.
 * Returns an unsubscribe function.
 */
export function watchAccepted(
  provider: ethers.Provider,
  escrowAddress: string,
  bundlerAddress: string,
  callback: (commitId: bigint, deadline: bigint) => Promise<void> | void,
): () => void {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const normalized = bundlerAddress.toLowerCase();

  const handler = (commitId: bigint, bundler: string, deadline: bigint) => {
    if (bundler.toLowerCase() !== normalized) return;
    Promise.resolve(callback(commitId, deadline)).catch(
      (err) => console.error(`[watchAccepted] unhandled error for commit ${commitId}:`, err),
    );
  };

  escrow.on("CommitAccepted", handler);
  return () => { escrow.off("CommitAccepted", handler); };
}

/**
 * Subscribe to Settled events.
 * The Settled event does not include the bundler address; callers should
 * filter by their own commit IDs. Returns an unsubscribe function.
 */
export function watchSettled(
  provider: ethers.Provider,
  escrowAddress: string,
  callback: (commitId: bigint, bundlerNet: bigint) => Promise<void> | void,
): () => void {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const handler = (commitId: bigint, bundlerNet: bigint) => {
    Promise.resolve(callback(commitId, bundlerNet)).catch(
      (err) => console.error(`[watchSettled] unhandled error for commit ${commitId}:`, err),
    );
  };
  escrow.on("Settled", handler);
  return () => { escrow.off("Settled", handler); };
}

/**
 * Subscribe to Refunded events (SLA slash alerts).
 * A Refunded event means a bundler missed the SLA and was slashed.
 * Returns an unsubscribe function.
 */
export function watchRefunded(
  provider: ethers.Provider,
  escrowAddress: string,
  callback: (commitId: bigint, userAmount: bigint) => Promise<void> | void,
): () => void {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const handler = (commitId: bigint, userAmount: bigint) => {
    Promise.resolve(callback(commitId, userAmount)).catch(
      (err) => console.error(`[watchRefunded] unhandled error for commit ${commitId}:`, err),
    );
  };
  escrow.on("Refunded", handler);
  return () => { escrow.off("Refunded", handler); };
}
