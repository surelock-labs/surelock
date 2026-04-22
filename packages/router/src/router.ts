import { ethers } from "ethers";
import { REGISTRY_ABI, ESCROW_ABI } from "./abis";
import { selectBest } from "./strategies";
import { scoreBundlers, BundlerScore, DEFAULT_LOOKBACK_BLOCKS } from "./scoring";
import { Offer, Constraints, Strategy, RouterConfig, CommitResult } from "./types";

export { selectBest };
export { scoreBundlers, BundlerScore, DEFAULT_LOOKBACK_BLOCKS } from "./scoring";

/**
 * Fetch all active offers from a QuoteRegistry contract.
 *
 * Calls `QuoteRegistry.list()`, which scans all registered quotes in one RPC
 * call -- O(n) in the total number of registered quotes. For registries with
 * large offer counts, prefer `listActivePage()` to paginate and avoid hitting
 * provider response-size limits.
 */
export async function fetchQuotes(
  provider: ethers.Provider,
  registryAddress: string,
): Promise<Offer[]> {
  const contract = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  const raw: any[] = await contract.list();
  return raw.map((o) => ({
    quoteId: BigInt(o.quoteId),
    bundler: o.bundler as string,
    feePerOp: BigInt(o.feePerOp),
    slaBlocks: Number(o.slaBlocks),
    collateralWei: BigInt(o.collateralWei),
    active: true, // list() only returns active offers
    lifetime: Number(o.lifetime),
    registeredAt: BigInt(o.registeredAt),
    bond: BigInt(o.bond),
  }));
}

/**
 * Submit a UserOp commitment to the SLAEscrow for the chosen quote.
 * `userOpHash` is the canonical ERC-4337 userOpHash, computed off-chain as:
 *   keccak256(abi.encode(keccak256(abi.encode(allUserOpFields)), entryPoint, chainId))
 * This is the exact hash the EntryPoint will emit as topic[1] of UserOperationEvent,
 * enabling direct on-chain settlement proof verification.
 * msg.value must equal `feePerOp + protocolFeeWei()`.
 * Returns the commitId emitted by CommitCreated. The commit starts in PROPOSED
 * state and must be accepted by the bundler within ACCEPT_GRACE_BLOCKS (12).
 */
export async function commitOp(
  signer: ethers.Signer,
  escrowAddress: string,
  offer: Offer,
  userOpHash: string,
): Promise<CommitResult> {
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, signer);
  const protocolFee: bigint = await escrow.protocolFeeWei();
  const tx = await escrow.commit(
    offer.quoteId, userOpHash,
    offer.bundler, offer.collateralWei, offer.slaBlocks,
    { value: offer.feePerOp + protocolFee },
  );
  const receipt = await tx.wait();
  const event = receipt?.logs
    .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "CommitCreated");
  if (!event) throw new Error("CommitCreated event not found in receipt");
  return { commitId: BigInt(event.args.commitId), blockNumber: receipt!.blockNumber };
}

/**
 * Fetch active offers and score each bundler's on-chain track record.
 * Returns offers paired with their scores, sorted best-to-worst by composite score.
 *
 * Requires `escrowAddress` in the provider call arguments.
 */
export async function fetchAndScoreQuotes(
  provider: ethers.Provider,
  registryAddress: string,
  escrowAddress: string,
  lookback = DEFAULT_LOOKBACK_BLOCKS,
): Promise<Array<{ offer: Offer; score: BundlerScore }>> {
  const offers = await fetchQuotes(provider, registryAddress);
  if (offers.length === 0) return [];

  const scores = await scoreBundlers(provider, escrowAddress, offers, lookback);

  return offers
    .map((offer) => ({
      offer,
      score: scores.get(offer.bundler.toLowerCase())!,
    }))
    .sort((a, b) => {
      if (b.score.score !== a.score.score) return b.score.score - a.score.score;
      // Same bundler score: prefer lower fee then shorter SLA so candidates[0]
      // is the best offer from the best bundler, not an arbitrary one.
      if (a.offer.feePerOp !== b.offer.feePerOp) {
        return a.offer.feePerOp < b.offer.feePerOp ? -1 : 1;
      }
      return a.offer.slaBlocks - b.offer.slaBlocks;
    });
}

/** Factory that bundles provider + addresses into a single object. */
export function createRouter(config: RouterConfig) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);

  return {
    async fetchQuotes(): Promise<Offer[]> {
      return fetchQuotes(provider, config.registryAddress);
    },

    selectBest(
      offers: Offer[],
      strategy: Strategy = "cheapest",
      constraints: Constraints = {},
    ): Offer | null {
      return selectBest(offers, strategy, constraints);
    },

    /**
     * Fetch offers and rank by bundler reliability score.
     * Returns null if no offers are available.
     * Requires `escrowAddress` in RouterConfig.
     */
    async selectReliable(
      constraints: Constraints = {},
      lookback = DEFAULT_LOOKBACK_BLOCKS,
    ): Promise<Offer | null> {
      if (!config.escrowAddress) throw new Error("escrowAddress not set in RouterConfig");
      const scored = await fetchAndScoreQuotes(
        provider,
        config.registryAddress,
        config.escrowAddress,
        lookback,
      );
      const candidates = scored.filter(({ offer, score }) => {
        if (!offer.active || offer.collateralWei <= offer.feePerOp) return false;
        // Hard routability check: bundler must have enough idle collateral to
        // accept this specific offer right now. idleRatio is bundler-level
        // (scored against max collateral); only idleBalance is per-offer accurate.
        if (score.idleBalance < offer.collateralWei) return false;
        if (constraints.maxFee !== undefined && offer.feePerOp > constraints.maxFee) return false;
        if (constraints.maxSlaBlocks !== undefined && offer.slaBlocks > constraints.maxSlaBlocks) return false;
        if (constraints.minCollateral !== undefined && offer.collateralWei < constraints.minCollateral) return false;
        return true;
      });
      return candidates[0]?.offer ?? null;
    },

    async commitOp(
      signer: ethers.Signer,
      offer: Offer,
      userOpHash: string,
    ): Promise<CommitResult> {
      if (!config.escrowAddress) throw new Error("escrowAddress not set in RouterConfig");
      return commitOp(signer, config.escrowAddress, offer, userOpHash);
    },
  };
}
