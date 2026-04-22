import { Offer, Constraints, Strategy } from "./types";

/** Filter offers by constraints, then pick the best one by strategy. Returns null if none qualify. */
export function selectBest(
  offers: Offer[],
  strategy: Strategy = "cheapest",
  constraints: Constraints = {},
): Offer | null {
  // T8: collateral must strictly exceed fee, or deliberate miss is net-neutral not negative.
  let candidates = offers.filter((o) => o.active && o.collateralWei > o.feePerOp);

  if (constraints.maxFee !== undefined) {
    candidates = candidates.filter((o) => o.feePerOp <= constraints.maxFee!);
  }
  if (constraints.maxSlaBlocks !== undefined) {
    candidates = candidates.filter((o) => o.slaBlocks <= constraints.maxSlaBlocks!);
  }
  if (constraints.minCollateral !== undefined) {
    candidates = candidates.filter((o) => o.collateralWei >= constraints.minCollateral!);
  }

  if (candidates.length === 0) return null;

  return candidates.sort(comparatorFor(strategy))[0];
}

function comparatorFor(strategy: Strategy): (a: Offer, b: Offer) => number {
  switch (strategy) {
    case "cheapest":
      return (a, b) => {
        if (a.feePerOp !== b.feePerOp) return a.feePerOp < b.feePerOp ? -1 : 1;
        return a.slaBlocks - b.slaBlocks; // tie-break: faster SLA
      };
    case "fastest":
      return (a, b) => {
        if (a.slaBlocks !== b.slaBlocks) return a.slaBlocks - b.slaBlocks;
        return a.feePerOp < b.feePerOp ? -1 : a.feePerOp > b.feePerOp ? 1 : 0; // tie-break: lower fee
      };
    case "safest":
      return (a, b) => {
        if (a.collateralWei !== b.collateralWei) return a.collateralWei > b.collateralWei ? -1 : 1;
        return a.feePerOp < b.feePerOp ? -1 : a.feePerOp > b.feePerOp ? 1 : 0; // tie-break: lower fee
      };
  }
}
