/**
 * Helpers for constructing the on-chain proof required by SLAEscrow.settle().
 *
 * SLAEscrow._verifyReceiptProof() requires:
 *   1. blockHeaderRlp  -- RLP of the full block header; keccak256 must equal blockhash(block)
 *   2. receiptProof    -- ordered MPT proof nodes (root -> leaf) for the receipt trie
 *   3. txIndex         -- position of the target tx in the block
 *
 * All of this can be built from Hardhat JSON-RPC data with no external API calls.
 * Supports Ethereum mainnet and OP Stack chains (Base, Optimism).
 */

import { encodeRlp, getBytes, keccak256, hexlify } from "ethers";
import { Trie } from "@ethereumjs/trie";
import { RLP } from "@ethereumjs/rlp";

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
 */
export async function buildBlockHeaderRlp(
    provider: { send(method: string, params: unknown[]): Promise<any> },
    blockNumber: number,
): Promise<string> {
    const tag = "0x" + blockNumber.toString(16);
    const b = await provider.send("eth_getBlockByNumber", [tag, false]);
    if (!b) throw new Error(`header not found for block ${blockNumber}`);

    const fields: string[] = [
        b.parentHash,
        b.sha3Uncles,
        b.miner,
        b.stateRoot,
        b.transactionsRoot,
        b.receiptsRoot,              // <- field [5] verified by SLAEscrow
        b.logsBloom,
        toRlpUint(b.difficulty),
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
    if (b.withdrawalsRoot       !== undefined) fields.push(b.withdrawalsRoot);
    // Cancun+ (EIP-4844 / EIP-4788)
    if (b.blobGasUsed           !== undefined) fields.push(toRlpUint(b.blobGasUsed));
    if (b.excessBlobGas         !== undefined) fields.push(toRlpUint(b.excessBlobGas));
    if (b.parentBeaconBlockRoot !== undefined) fields.push(b.parentBeaconBlockRoot);
    // Prague+ (EIP-7685)
    if (b.requestsHash          !== undefined) fields.push(b.requestsHash);

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
 * Handles OP Stack deposit receipts (type 0x7e) including optional tail fields:
 *   depositNonce           -- Regolith hardfork+
 *   depositReceiptVersion  -- Canyon hardfork+
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
 * Verifies the trie root matches block.receiptsRoot before returning.
 */
export async function buildReceiptProof(
    provider: { send(method: string, params: unknown[]): Promise<any> },
    blockNumber: number,
    txHash: string,
): Promise<ReceiptProof> {
    const tag = "0x" + blockNumber.toString(16);
    const block = await provider.send("eth_getBlockByNumber", [tag, true]);
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
