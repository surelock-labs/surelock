export type { Offer, CommitResult } from "@surelock-labs/protocol";

/** Constraints applied before strategy scoring. */
export interface Constraints {
  /** Only consider offers whose feePerOp <= maxFee. */
  maxFee?: bigint;
  /** Only consider offers whose slaBlocks <= maxSlaBlocks. */
  maxSlaBlocks?: number;
  /** Only consider offers whose collateralWei >= minCollateral. */
  minCollateral?: bigint;
}

/**
 * Selection strategies:
 *   cheapest  -- lowest fee; tie-break by fastest SLA
 *   fastest   -- fewest inclusion blocks; tie-break by lowest fee
 *   safest    -- highest collateral; tie-break by lowest fee
 */
export type Strategy = "cheapest" | "fastest" | "safest";

export interface RouterConfig {
  /** JSON-RPC endpoint (e.g. "https://mainnet.base.org"). */
  rpcUrl: string;
  /** QuoteRegistry contract address. */
  registryAddress: string;
  /** SLAEscrow contract address (needed for commitOp). */
  escrowAddress?: string;
}
