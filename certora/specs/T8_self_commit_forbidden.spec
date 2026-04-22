// docs/DESIGN.md T8 / A3 -- Self-commit is forbidden.
//
// "SelfCommitForbidden: a CLIENT cannot name itself as the BUNDLER. This prevents
//  a single party from both committing and accepting, collapsing the two-phase
//  consent model into a single actor who could manufacture a positive-EV strategy
//  by choosing which terminal path is more profitable."
//
// commit() checks msg.sender == bundler and reverts with SelfCommitForbidden.
//
// This is a single focused rule: no matter the other parameters, if the caller
// is also the named bundler, commit() must revert.
//
// Theorem: T8 (anti-sybil guard), A3 (caller / named-bundler separation)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    // No envfree accessors needed -- the revert fires on the caller/bundler identity
    // check before any storage read. QuoteRegistry in files for full bytecode linkage.
}

rule T8_self_commit_forbidden(
    uint256 quoteId,
    bytes32 userOpHash,
    address bundler,
    uint96  collateral,
    uint32  slaBlocks
) {
    env e;
    // Caller IS the named bundler -- the forbidden case.
    require e.msg.sender == bundler;

    commit@withrevert(e, quoteId, userOpHash, bundler, collateral, slaBlocks);

    assert lastReverted,
        "T8/A3: commit() must revert with SelfCommitForbidden when msg.sender == bundler";
}
