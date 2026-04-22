export type { PendingCommit, CommitInfo } from "@surelock-labs/protocol";

export interface AcceptedCommit {
  commitId:    bigint;
  deadline:    bigint;
  blockNumber: number;
}

export interface RegisterOfferParams {
  feePerOp: bigint;
  slaBlocks: number;
  collateralWei: bigint;
  lifetime?: number;
}

export interface BundlerConfig {
  /** JSON-RPC endpoint. */
  rpcUrl: string;
  /** QuoteRegistry contract address. */
  registryAddress: string;
  /** SLAEscrow contract address. */
  escrowAddress: string;
  /**
   * Optional provider for reads and buildSettleProof.
   * Must be a JsonRpcProvider (or compatible) -- buildSettleProof calls provider.send()
   * for raw JSON-RPC access. Defaults to a new JsonRpcProvider(rpcUrl).
   */
  provider?: import("ethers").JsonRpcProvider;
}
