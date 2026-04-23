/**
 * On-chain MPT receipt proof construction for SLAEscrow.settle().
 *
 * SLAEscrow._verifyReceiptProof() requires:
 *   1. blockHeaderRlp  -- RLP of the full block header; keccak256 must equal blockhash(block)
 *   2. receiptProof    -- ordered MPT proof nodes (root -> leaf) for the receipt trie
 *   3. txIndex         -- position of the target tx in the block
 *
 * All of this can be built from JSON-RPC data. Supports Ethereum mainnet and OP Stack
 * chains (Base, Optimism) including deposit receipts (EIP-2718 type 0x7e).
 */

import { encodeRlp, getBytes, keccak256, hexlify, id as keccak256str } from "ethers";
import { Trie } from "@ethereumjs/trie";
import { RLP } from "@ethereumjs/rlp";

// -- Type alias for a minimal JSON-RPC provider ---------------------------------

export type RpcProvider = { send(method: string, params: unknown[]): Promise<any> };

// -- UserOperationEvent log scanner ---------------------------------------------

// keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
const USEROP_EVENT_TOPIC0 = keccak256str(
  "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
);

/**
 * Return the index of the UserOperationEvent log for `userOpHash` within a
 * JSON-RPC receipt's `logs` array, or `null` if not found.
 *
 * Useful for building a post-launch histogram of log depths to decide whether
 * a logIndex hint parameter (Option B) is worth adding to settle().
 */
export function findUserOpLogIndex(
  logs: Array<{ topics?: string[] }>,
  userOpHash: string,
): number | null {
  const target = userOpHash.toLowerCase();
  for (let i = 0; i < logs.length; i++) {
    const { topics } = logs[i];
    if (
      topics &&
      topics.length >= 2 &&
      topics[0].toLowerCase() === USEROP_EVENT_TOPIC0.toLowerCase() &&
      topics[1].toLowerCase() === target
    ) {
      return i;
    }
  }
  return null;
}

// -- RLP helpers ----------------------------------------------------------------

/**
 * Convert a JSON-RPC hex integer string to its minimal big-endian byte
 * representation for RLP uint encoding.
 *   0   -> "0x"     (empty bytes = RLP integer 0)
 *   1   -> "0x01"
 *   256 -> "0x0100"
 */
function toRlpUint(hex: string | null | undefined): string {
  if (!hex || hex === "0x" || hex === "0x0") return "0x";
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.length % 2 === 0 ? clean : "0" + clean;
  const stripped = padded.replace(/^(00)+/, "");
  return stripped ? "0x" + stripped : "0x";
}

// -- Block header RLP -----------------------------------------------------------

/**
 * Build the RLP-encoded block header for `blockNumber`.
 * keccak256 of the result equals blockhash(blockNumber) inside the EVM.
 *
 * Supports post-merge headers (London / Shanghai / Cancun / Prague) and OP Stack.
 * Throws `"header not found for block N"` when the block is not yet available --
 * use `withRetry()` to handle load-balanced RPC nodes that lag behind.
 */
export async function buildBlockHeaderRlp(
  provider: RpcProvider,
  blockNumber: number,
): Promise<string> {
  const tag = "0x" + blockNumber.toString(16);
  const b = await provider.send("eth_getBlockByNumber", [tag, false]);
  if (!b) throw new Error(`header not found for block ${blockNumber}`);

  // Fields present in all post-merge headers (London+)
  const fields: string[] = [
    b.parentHash,
    b.sha3Uncles,
    b.miner,
    b.stateRoot,
    b.transactionsRoot,
    b.receiptsRoot,              // <- field [5] verified by SLAEscrow
    b.logsBloom,
    toRlpUint(b.difficulty),     // always 0x post-merge
    toRlpUint(b.number),
    toRlpUint(b.gasLimit),
    toRlpUint(b.gasUsed),
    toRlpUint(b.timestamp),
    b.extraData,
    b.mixHash,
    b.nonce,
    toRlpUint(b.baseFeePerGas),  // EIP-1559 / London+
  ];

  // Shanghai+ (EIP-4895)
  if (b.withdrawalsRoot !== undefined) fields.push(b.withdrawalsRoot);
  // Cancun+ (EIP-4844 / EIP-4788)
  if (b.blobGasUsed          !== undefined) fields.push(toRlpUint(b.blobGasUsed));
  if (b.excessBlobGas        !== undefined) fields.push(toRlpUint(b.excessBlobGas));
  if (b.parentBeaconBlockRoot !== undefined) fields.push(b.parentBeaconBlockRoot);
  // Prague+ (EIP-7685)
  if (b.requestsHash !== undefined) fields.push(b.requestsHash);

  const encoded = encodeRlp(fields);
  const got = keccak256(encoded);
  if (got.toLowerCase() !== b.hash.toLowerCase()) {
    throw new Error(
      `buildBlockHeaderRlp: hash mismatch for block ${blockNumber}\n` +
      `  computed: ${got}\n  expected: ${b.hash}\n` +
      `  Check that all hardfork fields are included.`,
    );
  }
  return encoded;
}

// -- Receipt encoding -----------------------------------------------------------

/**
 * RLP-encode an EIP-2718 receipt as raw bytes (the leaf value in the receipt MPT).
 *
 * Format:
 *   type 0 (legacy):      RLP([status, cumGas, logsBloom, logs])
 *   type 1/2 (typed):     <type> || RLP([status, cumGas, logsBloom, logs])
 *   type 0x7e (OP Stack): 0x7e  || RLP([status, cumGas, logsBloom, logs,
 *                                        depositNonce?, depositReceiptVersion?])
 *
 * OP Stack deposit receipts (type 0x7e) carry optional tail fields introduced
 * by the Regolith (depositNonce) and Canyon (depositReceiptVersion) hardforks.
 * Without them the trie root does not match block.receiptsRoot on OP chains.
 */
function encodeReceipt(receipt: any): Uint8Array {
  const status        = receipt.status === "0x1" || receipt.status === 1 ? "0x01" : "0x";
  const cumulativeGas = toRlpUint(receipt.cumulativeGasUsed);
  const logsBloom     = receipt.logsBloom;
  const logs = (receipt.logs as any[]).map((log) => [
    log.address.toLowerCase(),
    log.topics as string[],
    log.data === "0x" ? "0x" : log.data,
  ]);

  const txType = parseInt(receipt.type ?? "0x0", 16);

  if (txType === 0x7e) {
    const fields: any[] = [status, cumulativeGas, logsBloom, logs];
    if (receipt.depositNonce          != null) fields.push(toRlpUint(receipt.depositNonce));
    if (receipt.depositReceiptVersion != null) fields.push(toRlpUint(receipt.depositReceiptVersion));
    const body = getBytes(encodeRlp(fields));
    return new Uint8Array([0x7e, ...body]);
  }

  const body = getBytes(encodeRlp([status, cumulativeGas, logsBloom, logs]));
  if (txType === 0) return body;
  return new Uint8Array([txType, ...body]);
}

// -- Receipt MPT proof ----------------------------------------------------------

export interface ReceiptProof {
  /** EIP-2718 encoded receipt bytes (the leaf value). */
  receiptEncoded: Uint8Array;
  /** Ordered MPT proof nodes, root -> leaf (each node is RLP-encoded). */
  proofNodes: Uint8Array[];
  /** Transaction index within the block. */
  txIndex: number;
}

/**
 * Build a Merkle Patricia Trie receipt proof for `txHash` within `blockNumber`.
 *
 * Steps:
 *   1. Fetch all receipts in the block.
 *   2. Build the receipt MPT: key = RLP(txIndex), value = encoded receipt.
 *   3. Assert trie root == block.receiptsRoot.
 *   4. Return a proof for the target tx.
 *
 * Throws `"receiptsRoot mismatch"` if receipt encoding is wrong for any tx in the
 * block (typically indicates a missing hardfork or OP Stack extension field).
 */
export async function buildReceiptProof(
  provider: RpcProvider,
  blockNumber: number,
  txHash: string,
): Promise<ReceiptProof> {
  const tag = "0x" + blockNumber.toString(16);
  const block = await provider.send("eth_getBlockByNumber", [tag, true]);
  if (!block) throw new Error(`header not found: block ${blockNumber} not yet available`);
  const txs: any[] = block.transactions;

  if (txs.length === 0) throw new Error(`block ${blockNumber} has no transactions`);

  const txIndex = txs.findIndex(
    (tx: any) => (tx.hash ?? tx).toLowerCase() === txHash.toLowerCase(),
  );
  if (txIndex === -1) throw new Error(`tx ${txHash} not found in block ${blockNumber}`);

  const receipts: any[] = await Promise.all(
    txs.map((tx: any) => provider.send("eth_getTransactionReceipt", [tx.hash ?? tx])),
  );

  const trie = new Trie();
  for (let i = 0; i < receipts.length; i++) {
    const key   = RLP.encode(i === 0 ? new Uint8Array(0) : BigInt(i));
    const value = encodeReceipt(receipts[i]);
    await trie.put(key, value);
  }

  const trieRoot = hexlify(trie.root());
  const expected = block.receiptsRoot.toLowerCase();
  if (trieRoot.toLowerCase() !== expected) {
    throw new Error(
      `buildReceiptProof: receiptsRoot mismatch for block ${blockNumber}\n` +
      `  trie root: ${trieRoot}\n  expected:  ${expected}\n` +
      `  Receipt encoding is wrong for one of the ${receipts.length} receipts.`,
    );
  }

  const proofKey   = RLP.encode(txIndex === 0 ? new Uint8Array(0) : BigInt(txIndex));
  const proofNodes = await trie.createProof(proofKey);

  return { receiptEncoded: encodeReceipt(receipts[txIndex]), proofNodes, txIndex };
}

// -- Convenience wrapper --------------------------------------------------------

export interface SettleProof {
  /** RLP-encoded block header; keccak256 must equal blockhash(inclusionBlock). */
  blockHeaderRlp: string;
  /** Hex-encoded ordered MPT proof nodes (root -> leaf), ready for settle(). */
  receiptProof: string[];
  /** Transaction index of the bundle within the block. */
  txIndex: number;
  /** Block number where inclusion occurred. */
  inclusionBlock: number;
  /**
   * Index of the matching UserOperationEvent within the receipt's log array.
   * Only populated when `userOpHash` is passed to `buildSettleProof`.
   * Use for the settle-gas histogram: (logIndex, logCount, gasUsed) -> decide
   * whether Option B (logIndex hint parameter) is worth the protocol change.
   */
  logIndex?: number;
  /**
   * Total number of logs in the receipt (~= batch size + 1 for BeforeExecution).
   * Only populated when `userOpHash` is passed to `buildSettleProof`.
   */
  logCount?: number;
}

/**
 * Build the complete proof bundle required by SLAEscrow.settle().
 * Combines `buildBlockHeaderRlp` + `buildReceiptProof` in parallel.
 *
 * The returned `receiptProof` is already hex-encoded -- pass it directly to
 * the `settle()` function or the bundler client's `settle()` method.
 *
 * Pass `userOpHash` to also compute `logIndex` and `logCount` for the
 * settle-gas histogram (see SettleProof for details).
 *
 * On load-balanced RPC nodes wrap this call with `withRetry()`:
 *   const proof = await withRetry(() => buildSettleProof(provider, block, txHash));
 */
export async function buildSettleProof(
  provider: RpcProvider,
  inclusionBlock: number,
  txHash: string,
  userOpHash?: string,
): Promise<SettleProof> {
  const [blockHeaderRlp, proof, receipt] = await Promise.all([
    buildBlockHeaderRlp(provider, inclusionBlock),
    buildReceiptProof(provider, inclusionBlock, txHash),
    userOpHash ? provider.send("eth_getTransactionReceipt", [txHash]) : Promise.resolve(null),
  ]);

  const result: SettleProof = {
    blockHeaderRlp,
    receiptProof: proof.proofNodes.map((n) => hexlify(n)),
    txIndex:      proof.txIndex,
    inclusionBlock,
  };

  if (userOpHash && receipt?.logs) {
    const idx = findUserOpLogIndex(receipt.logs, userOpHash);
    if (idx !== null) result.logIndex = idx;
    result.logCount = (receipt.logs as unknown[]).length;
  }

  return result;
}

// -- Retry helper ---------------------------------------------------------------

/**
 * Retry an async function when the RPC node reports the block is not yet
 * visible -- either "header not found" or "block not found".
 *
 * Load-balanced RPC endpoints (e.g. Base Sepolia, public Base mainnet) may
 * serve a request from a node that hasn't yet synced the most recently mined
 * block. Different providers phrase the error differently and bury it at
 * different nesting depths; this helper matches both phrases at any depth
 * ethers-v6 surfaces them.
 *
 * @param fn       Async function to retry.
 * @param retries  Maximum number of retry attempts (default 5).
 * @param delayMs  Delay between attempts in milliseconds (default 1500).
 */
export { withRetry } from "@surelock-labs/protocol";
