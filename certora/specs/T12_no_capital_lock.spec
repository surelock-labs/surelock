// docs/DESIGN.md T12 + A9 -- No capital lock; bounded resolution.
//
// "Before expiry, only CLIENT can trigger a refund. After expiry, CLIENT,
//  BUNDLER, or feeRecipient (PROTOCOL) can trigger resolution."
//
// This spec verifies:
// 1. After the full grace window (deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1),
//    the commit's bundler can call claimRefund and it succeeds (does not revert).
// 2. After the full grace window, an unrelated caller is rejected.
//
// Note: we use @withrevert + assert !lastReverted for rule 1 because that is
// exactly what T12 claims -- resolution is POSSIBLE, not that a specific amount
// flows. Balance preconditions below reflect contract invariants that the prover
// cannot derive automatically.
//
// Theorem: T12, A9
// Contract: SLAEscrow
// Status: READY

using SLAEscrow as escrow;

methods {
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function reservedBalance() external returns (uint256) envfree;
    function nextCommitId() external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function REFUND_GRACE_BLOCKS() external returns (uint64) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;

}

// Rule: BUNDLER can trigger claimRefund after the full grace window.
// This ensures BUNDLER's collateral is not locked forever if CLIENT disappears.
rule T12_bundler_can_resolve_after_expiry(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    // Preconditions: valid open commit
    require !settled && !refunded && !cancelled;
    require accepted; // claimRefund requires ACTIVE commit (accepted=true)
    require user != 0;
    require bundler != 0;

    // Caller is the bundler
    require e.msg.sender == bundler;
    require e.msg.value == 0; // claimRefund is non-payable; msg.value > 0 causes implicit revert

    // Block number is past the full grace window.
    // Bound block.number to uint64 range: the contract casts block.number to uint64,
    // so values > max_uint64 would truncate and re-trigger NotExpired revert.
    // Also bound deadline so the uint64 unlocksAt computation doesn't overflow.
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    uint64 refundGrace = REFUND_GRACE_BLOCKS();
    mathint unlocksAt = to_mathint(deadline) + to_mathint(settlementGrace)
                      + to_mathint(refundGrace) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;

    // Contract invariants: deposited tracks locked collateral correctly.
    // These hold in any reachable state but the prover needs them explicitly.
    require to_mathint(lockedOf(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(lockedOf(bundler));

    // v0.6: claimRefund sends 100% (feePaid + collateralLocked) to CLIENT only.
    // feeRecipient is not touched on the refund path; no aliasing concern.

    // Overflow guard: pendingWithdrawals[user] += feePaid + collateralLocked must not overflow.
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) + to_mathint(collateralLocked) <= max_uint256;

    // Execute -- must NOT revert (T12 core claim: resolution is always possible)
    claimRefund@withrevert(e, commitId);

    assert !lastReverted,
        "T12: bundler must be able to trigger claimRefund after expiry";
}

// Rule: an unrelated third party (not CLIENT, BUNDLER, or feeRecipient) must be
// rejected even after the full grace window.
rule T12_third_party_rejected_after_expiry(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require !settled && !refunded && !cancelled;
    require accepted;
    require user != 0;
    require bundler != 0;

    // Caller is NOT user, NOT bundler, NOT feeRecipient (T12: those three are authorized)
    require e.msg.sender != user;
    require e.msg.sender != bundler;
    require e.msg.sender != feeRecipient();

    // Past grace window
    uint64 settlementGrace = SETTLEMENT_GRACE_BLOCKS();
    uint64 refundGrace = REFUND_GRACE_BLOCKS();
    mathint unlocksAt = to_mathint(deadline) + to_mathint(settlementGrace)
                      + to_mathint(refundGrace) + 1;
    require to_mathint(e.block.number) >= unlocksAt;

    // Execute -- should revert with Unauthorized
    claimRefund@withrevert(e, commitId);

    assert lastReverted,
        "T12: third-party caller must be rejected after expiry";
}
