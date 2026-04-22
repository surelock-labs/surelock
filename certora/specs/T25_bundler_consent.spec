// docs/DESIGN.md T25 -- Two-phase bundler consent: collateral cannot be locked without
// explicit BUNDLER acceptance.
//
// "BUNDLER consent is required before any collateral is locked. commit() creates
//  a PROPOSED state with no collateral locked. Only the named BUNDLER can call
//  accept(), which locks collateral and starts the SLA clock."
//
// This spec verifies:
// 1. T25_only_bundler_can_accept            -- non-bundler callers get NotBundler.
// 2. T25_accept_locks_exactly_collateral    -- successful accept() increases lockedOf[c.bundler]
//                                             by exactly c.collateralLocked.
// 3. T25_accept_after_window_reverts        -- accept() past acceptDeadline reverts.
// 4. T25_accept_sets_active_state           -- accepted=true, deadline=block.number+slaBlocks.
// 5. T25_accept_preserves_immutable_fields  -- feePaid, bundler, collateral, quoteId, userOpHash,
//                                             acceptDeadline, slaBlocks all unchanged.
// 6. T25_accept_non_proposed_reverts        -- reverts on accepted/cancelled/settled/refunded.
// 7. T25_accept_insufficient_collateral_reverts -- reverts when idle < collateralLocked.
//
// The complementary property "commit() does not lock collateral" is proved in
// A4_commit_accounting.spec (A4_commit_does_not_modify_lockedOf).
//
// Theorem: T25 (also touches A9)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;
}

// Rule: accept() reverts for any caller who is not the commit's bundler.
// T25: the named BUNDLER's explicit consent is required; no third party can lock
// someone else's collateral on their behalf.
rule T25_only_bundler_can_accept(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0; // commit exists
    require !accepted && !cancelled && !settled && !refunded; // PROPOSED state
    require e.msg.sender != bundler; // non-bundler caller
    require e.msg.value == 0;

    accept@withrevert(e, commitId);

    assert lastReverted,
        "T25: accept() must revert for any caller who is not the commit's bundler";
}

// Rule: successful accept() increases lockedOf[c.bundler] by exactly c.collateralLocked.
// T25: accept() is the single point where BUNDLER's collateral moves from idle to locked.
rule T25_accept_locks_exactly_collateral(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    // PROPOSED commit
    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    // Named bundler calling
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    // Within accept window
    require to_mathint(acceptDeadline) <= max_uint64;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    // Sufficient idle balance
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));
    require to_mathint(deposited(bundler)) - to_mathint(lockedOf(bundler))
          >= to_mathint(collateralLocked);
    // Overflow guard
    require to_mathint(lockedOf(bundler)) + to_mathint(collateralLocked) <= max_uint256;

    mathint lockedBefore = to_mathint(lockedOf(bundler));

    accept(e, commitId);

    mathint lockedAfter = to_mathint(lockedOf(bundler));

    assert lockedAfter == lockedBefore + to_mathint(collateralLocked),
        "T25: successful accept() must increase lockedOf[bundler] by exactly collateralLocked";
}

// Rule: accept() reverts after the accept window (block.number > acceptDeadline).
// A9: the accept window is bounded; expired PROPOSED commits can only be cancelled.
rule T25_accept_after_window_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    // Past the accept window
    require to_mathint(acceptDeadline) <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) > to_mathint(acceptDeadline);

    accept@withrevert(e, commitId);

    assert lastReverted,
        "T25: accept() must revert after the accept window has expired";
}

// Rule: successful accept() sets accepted=true and deadline=block.number+slaBlocks.
// These are the two PROPOSED→ACTIVE state transition writes; all other fields stay frozen.
rule T25_accept_sets_active_state(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));
    require to_mathint(deposited(bundler)) - to_mathint(lockedOf(bundler))
          >= to_mathint(collateralLocked);
    require to_mathint(lockedOf(bundler)) + to_mathint(collateralLocked) <= max_uint256;

    mathint expectedDeadline = to_mathint(e.block.number) + to_mathint(slaBlocks);
    require expectedDeadline <= max_uint64;

    accept(e, commitId);

    address rUser; uint96 rFeePaid; address rBundler; uint96 rColl;
    uint64 rDeadline; bool rSettled; bool rRefunded;
    uint256 rQuoteId; bytes32 rUserOpHash; uint64 rInclusionBlock;
    bool rAccepted; bool rCancelled; uint64 rAcceptDeadline; uint32 rSlaBlocks;

    rUser, rFeePaid, rBundler, rColl, rDeadline, rSettled, rRefunded
        = getCommitCore(commitId);
    rQuoteId, rUserOpHash, rInclusionBlock,
        rAccepted, rCancelled, rAcceptDeadline, rSlaBlocks = getCommitState(commitId);

    assert rAccepted == true,
        "T25: successful accept() must set accepted = true";
    assert to_mathint(rDeadline) == expectedDeadline,
        "T25: successful accept() must set deadline = block.number + slaBlocks";
}

// Rule: accept() does not modify feePaid, bundler, collateralLocked, quoteId, userOpHash,
// acceptDeadline, slaBlocks, user, inclusionBlock, settled, refunded, or cancelled.
// Only accepted and deadline change; everything else is frozen at commit time.
rule T25_accept_preserves_immutable_fields(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));
    require to_mathint(deposited(bundler)) - to_mathint(lockedOf(bundler))
          >= to_mathint(collateralLocked);
    require to_mathint(lockedOf(bundler)) + to_mathint(collateralLocked) <= max_uint256;

    accept(e, commitId);

    address rUser; uint96 rFeePaid; address rBundler; uint96 rColl;
    uint64 rDeadline; bool rSettled; bool rRefunded;
    uint256 rQuoteId; bytes32 rUserOpHash; uint64 rInclusionBlock;
    bool rAccepted; bool rCancelled; uint64 rAcceptDeadline; uint32 rSlaBlocks;

    rUser, rFeePaid, rBundler, rColl, rDeadline, rSettled, rRefunded
        = getCommitCore(commitId);
    rQuoteId, rUserOpHash, rInclusionBlock,
        rAccepted, rCancelled, rAcceptDeadline, rSlaBlocks = getCommitState(commitId);

    assert rUser             == user,             "T25: accept() must not modify user";
    assert rFeePaid          == feePaid,           "T25: accept() must not modify feePaid";
    assert rBundler          == bundler,           "T25: accept() must not modify bundler";
    assert rColl             == collateralLocked,  "T25: accept() must not modify collateralLocked";
    assert !rSettled && !rRefunded && !rCancelled, "T25: accept() must not set settled/refunded/cancelled";
    assert rQuoteId          == quoteId,           "T25: accept() must not modify quoteId";
    assert rUserOpHash       == userOpHash,        "T25: accept() must not modify userOpHash";
    assert rInclusionBlock   == inclusionBlock,    "T25: accept() must not modify inclusionBlock";
    assert rAcceptDeadline   == acceptDeadline,    "T25: accept() must not modify acceptDeadline";
    assert rSlaBlocks        == slaBlocks,         "T25: accept() must not modify slaBlocks";
}

// Rule: accept() on already-accepted / cancelled / settled / refunded commit reverts.
// These are the CommitNotProposed guard cases (all non-PROPOSED states).
rule T25_accept_non_proposed_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require accepted || cancelled || settled || refunded; // any non-PROPOSED state
    require e.msg.value == 0;

    accept@withrevert(e, commitId);

    assert lastReverted,
        "T25: accept() must revert on any commit that is not in PROPOSED state";
}

// Rule: accept() reverts when bundler's idle collateral is insufficient.
// T8: QuoteRegistry enforces collateral > feePerOp, so this is the economic safety check.
rule T25_accept_insufficient_collateral_reverts(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0;
    require !accepted && !cancelled && !settled && !refunded;
    require e.msg.sender == bundler;
    require e.msg.value == 0;
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    // No deposited underflow, but idle < required collateral
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));
    require to_mathint(deposited(bundler)) - to_mathint(lockedOf(bundler))
          < to_mathint(collateralLocked);

    accept@withrevert(e, commitId);

    assert lastReverted,
        "T25: accept() must revert when bundler has insufficient idle collateral";
}
