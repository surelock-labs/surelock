/**
 * Bundler reputation scoring -- derives four on-chain metrics per bundler
 * from a bounded lookback window of SLAEscrow events.
 *
 * Metrics:
 *   idleRatio       -- idleBalance / max(collateralWei across scored offers), capped at 1.0
 *   acceptRate      -- accepted / matured-created in window (0-1)
 *   settleRate      -- settled / matured-accepted in window (0-1)
 *   medianTimeToAccept -- median block-delta from CommitCreated -> CommitAccepted
 *
 * "Matured" means the resolution window has definitively closed:
 *   - created is matured when currentBlock > acceptDeadline
 *   - accepted is matured when currentBlock > deadline + SETTLEMENT_GRACE_BLOCKS
 *
 * This avoids penalising a busy honest bundler for in-flight commits that are
 * still inside their accept or settle window.
 *
 * Composite score 0-100 is used by selectReliable() to rank offers.
 */

import { ethers } from "ethers";
import { aggregate3 } from "@surelock-labs/protocol";
import { ESCROW_ABI } from "./abis";

/** Default lookback: ~2.8h on Base at ~2s/block. */
export const DEFAULT_LOOKBACK_BLOCKS = 5_000;

export interface BundlerScore {
  bundler: string;
  /** Bundler-level headroom heuristic: idleBalance / max(collateralWei across scored offers),
   *  capped at 1.0. Not an offer-level guarantee -- use idleBalance for per-offer routability. */
  idleRatio: number;
  /** Raw idle collateral in wei at score time -- use for per-offer routability checks. */
  idleBalance: bigint;
  /** Accepted / matured CommitCreated in lookback window (0-1). Excludes in-flight commits. */
  acceptRate: number;
  /** Settled / matured CommitAccepted in lookback window (0-1). Excludes in-flight commits. */
  settleRate: number;
  /** Median blocks from CommitCreated to CommitAccepted (lower is faster). */
  medianTimeToAccept: number;
  /** Composite weighted score 0-100. */
  score: number;
  /** Total CommitCreated events seen for this bundler in the window (including in-flight). */
  sampleSize: number;
}

// Weights must sum to 1.0.
const W_IDLE   = 0.15;
const W_ACCEPT = 0.40;
const W_SETTLE = 0.35;
const W_SPEED  = 0.10;

// Convert medianTimeToAccept (blocks) -> 0-1 score.
// 1 block -> 1.0 (fastest possible); ACCEPT_GRACE_BLOCKS (12) -> 0.0.
function speedScore(medianBlocks: number): number {
  if (medianBlocks <= 1) return 1;
  return Math.max(0, 1 - (medianBlocks - 1) / 11);
}

/**
 * Pure scoring computation given pre-fetched, pre-filtered event logs.
 * All event arrays must already be filtered to the target bundler.
 */
function computeBundlerScore(
  bundler: string,
  collateral: bigint,
  idle: bigint,
  created: ethers.EventLog[],   // CommitCreated events for this bundler
  accepted: ethers.EventLog[],  // CommitAccepted events for this bundler
  settledIds: Set<string>,       // all Settled commitIds in the window
  currentBlock: bigint,
  settlementGraceBlocks: bigint,
): BundlerScore {
  const idleRatio =
    collateral > 0n ? Math.min(1, Number((idle * 100n) / collateral) / 100) : 0;

  // Matured creates: accept window has definitively closed.
  const maturedCreated = created.filter(
    (e) => currentBlock > BigInt(e.args.acceptDeadline),
  );

  const acceptedCommitIds = new Set(accepted.map((e) => e.args.commitId.toString()));

  // acceptRate: of matured creates, how many were accepted?
  const acceptRate =
    maturedCreated.length > 0
      ? maturedCreated.filter((e) => acceptedCommitIds.has(e.args.commitId.toString()))
          .length / maturedCreated.length
      : 1; // no matured history -> assume perfect (don't penalise new bundlers)

  // Matured accepted: settle window has definitively closed.
  const maturedAccepted = accepted.filter(
    (e) => currentBlock > BigInt(e.args.deadline) + settlementGraceBlocks,
  );

  // settleRate: of matured accepted, how many were settled?
  const settleRate =
    maturedAccepted.length > 0
      ? maturedAccepted.filter((e) => settledIds.has(e.args.commitId.toString()))
          .length / maturedAccepted.length
      : 1; // no matured accepted -> assume perfect

  // Speed metric over all visible accepted events (each is a completed action with known timing).
  const createdBlock = new Map<string, number>();
  for (const e of created) createdBlock.set(e.args.commitId.toString(), e.blockNumber);
  const deltas: number[] = [];
  for (const e of accepted) {
    const cb = createdBlock.get(e.args.commitId.toString());
    if (cb !== undefined) deltas.push(e.blockNumber - cb);
  }
  deltas.sort((a, b) => a - b);
  const medianTimeToAccept = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 1;

  const score = Math.round(
    100 *
      (W_IDLE   * idleRatio +
       W_ACCEPT * acceptRate +
       W_SETTLE * settleRate +
       W_SPEED  * speedScore(medianTimeToAccept)),
  );

  return {
    bundler,
    idleRatio,
    idleBalance: idle,
    acceptRate,
    settleRate,
    medianTimeToAccept,
    score,
    sampleSize: created.length,
  };
}

/**
 * Score a single bundler over the last `lookbackBlocks` blocks.
 *
 * @param provider     ethers provider
 * @param escrowAddr   SLAEscrow proxy address
 * @param bundler      address to score
 * @param collateral   collateralWei used to normalise idleRatio. For scores comparable
 *                     with scoreBundlers(), pass the max collateralWei across all the
 *                     bundler's active offers; passing a single offer's collateral gives
 *                     a valid but offer-scoped idleRatio that may differ from batch scores.
 * @param lookback     how many blocks back to scan (default: DEFAULT_LOOKBACK_BLOCKS)
 */
export async function scoreBundler(
  provider: ethers.Provider,
  escrowAddr: string,
  bundler: string,
  collateral: bigint,
  lookback = DEFAULT_LOOKBACK_BLOCKS,
): Promise<BundlerScore> {
  const escrow = new ethers.Contract(escrowAddr, ESCROW_ABI, provider);
  const tip = await provider.getBlockNumber();
  const from = Math.max(0, tip - lookback);
  const currentBlock = BigInt(tip);
  const bundlerLc = bundler.toLowerCase();

  const [idle, settlementGraceBlocks, allCreated, accepted, allSettled] = await Promise.all([
    escrow.idleBalance(bundler).then(BigInt),
    escrow.SETTLEMENT_GRACE_BLOCKS().then(BigInt),
    escrow.queryFilter(escrow.filters.CommitCreated(), from, tip) as Promise<ethers.EventLog[]>,
    escrow.queryFilter(escrow.filters.CommitAccepted(null, bundler), from, tip) as Promise<ethers.EventLog[]>,
    escrow.queryFilter(escrow.filters.Settled(), from, tip) as Promise<ethers.EventLog[]>,
  ]);

  const created = allCreated.filter(
    (e) => (e.args.bundler as string).toLowerCase() === bundlerLc,
  );
  const settledIds = new Set(allSettled.map((e) => e.args.commitId.toString()));

  return computeBundlerScore(bundler, collateral, idle, created, accepted, settledIds, currentBlock, settlementGraceBlocks);
}

/**
 * Score all unique bundlers represented in `offers`.
 * Fetches CommitCreated, CommitAccepted, and Settled logs once for the full
 * window, then aggregates by bundler in memory -- avoids N redundant full
 * log scans when scoring multiple bundlers simultaneously.
 *
 * Each bundler is scored once; collateralWei is the max across all their offers.
 *
 * Returns a Map keyed by lowercased bundler address.
 */
export async function scoreBundlers(
  provider: ethers.Provider,
  escrowAddr: string,
  offers: ReadonlyArray<{ bundler: string; collateralWei: bigint }>,
  lookback = DEFAULT_LOOKBACK_BLOCKS,
  opts: { multicall?: boolean } = {},
): Promise<Map<string, BundlerScore>> {
  if (offers.length === 0) return new Map();

  const escrow = new ethers.Contract(escrowAddr, ESCROW_ABI, provider);
  const tip = await provider.getBlockNumber();
  const from = Math.max(0, tip - lookback);
  const currentBlock = BigInt(tip);

  const maxCollateral = new Map<string, bigint>();
  for (const o of offers) {
    const k = o.bundler.toLowerCase();
    const prev = maxCollateral.get(k) ?? 0n;
    if (o.collateralWei > prev) maxCollateral.set(k, o.collateralWei);
  }

  const [settlementGraceBlocks, allCreated, allAccepted, allSettled] = await Promise.all([
    escrow.SETTLEMENT_GRACE_BLOCKS().then(BigInt),
    escrow.queryFilter(escrow.filters.CommitCreated(), from, tip) as Promise<ethers.EventLog[]>,
    escrow.queryFilter(escrow.filters.CommitAccepted(), from, tip) as Promise<ethers.EventLog[]>,
    escrow.queryFilter(escrow.filters.Settled(), from, tip) as Promise<ethers.EventLog[]>,
  ]);

  const settledIds = new Set(allSettled.map((e) => e.args.commitId.toString()));
  const addrs = [...maxCollateral.keys()];

  let idles: bigint[];
  if (opts.multicall !== false) {
    try {
      const abi = ethers.AbiCoder.defaultAbiCoder();
      const returnData = await aggregate3(provider,
        addrs.map(a => ({ target: escrowAddr, callData: escrow.interface.encodeFunctionData("idleBalance", [a]) })));
      idles = returnData.map(d => BigInt(abi.decode(["uint256"], d)[0] as bigint));
    } catch (err: any) {
      console.warn(`scoreBundlers: Multicall3 unavailable (${err?.shortMessage ?? err?.message ?? err}); falling back to ${addrs.length} direct idleBalance reads. Pass { multicall: false } to silence.`);
      idles = await Promise.all(addrs.map(a => escrow.idleBalance(a).then(BigInt)));
    }
  } else {
    idles = await Promise.all(addrs.map(a => escrow.idleBalance(a).then(BigInt)));
  }

  const scores = addrs.map((addr, i) => {
    const col = maxCollateral.get(addr)!;
    const created = allCreated.filter((e) => (e.args.bundler as string).toLowerCase() === addr);
    const accepted = allAccepted.filter((e) => (e.args.bundler as string).toLowerCase() === addr);
    return computeBundlerScore(addr, col, idles[i], created, accepted, settledIds, currentBlock, settlementGraceBlocks);
  });

  const out = new Map<string, BundlerScore>();
  for (const s of scores) out.set(s.bundler.toLowerCase(), s);
  return out;
}
