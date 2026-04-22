// docs/DESIGN.md T8 -- Deliberate SLA miss is net-negative.
//
// "Provided the protocol enforces collateral > netHonorFee at registration, a BUNDLER
//  who misses the SLA forfeits more than they would have earned on honor."
//
// The registry enforces the stronger bound: collateral > feePerOp (which is >= netHonorFee
// since the owner cut is non-negative). This rule checks that invariant holds for every
// registered offer.
//
// Theorem: T8
// Contract: QuoteRegistry
// Status: PASS

using QuoteRegistry as registry;

methods {
    function nextQuoteId() external returns (uint256) envfree;
    function getOffer(uint256) external returns (QuoteRegistry.Offer) envfree;
}

// For every registered offer (quoteId in [1, nextQuoteId)),
// collateralWei must be strictly greater than feePerOp.
//
// quoteId 0 is excluded: the constructor sets nextQuoteId = 1 to reserve 0 as
// the "no offer" sentinel. _offers[0] is never written and has collateralWei ==
// feePerOp == 0 by default, which would violate the invariant if included.
// Valid offers live in [1, nextQuoteId).
//
// register() enforces strict > at registration time (QuoteRegistry.sol:182).
invariant collateralStrictlyGtFee(uint256 quoteId)
    (quoteId >= 1 && quoteId < nextQuoteId()) =>
        getOffer(quoteId).collateralWei > getOffer(quoteId).feePerOp;
