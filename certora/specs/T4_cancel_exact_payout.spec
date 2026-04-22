// docs/DESIGN.md T4 / T11 -- cancel() credits exactly feePaid to CLIENT; no other
// party receives anything; BUNDLER collateral is untouched (was never locked on PROPOSED).
//
// "T4: cancel() returns the full feePerOp to CLIENT. protocolFeeWei is non-refundable --
//  already credited to feeRecipient at commit time (T11). BUNDLER's deposited balance is
//  unaffected: no collateral was ever locked for a PROPOSED commit (T25)."
//
// Four rules:
//   T4_cancel_credits_exact_fee   -- pendingWithdrawals[user] increases by exactly feePaid
//   T4_cancel_bundler_unchanged   -- deposited[bundler] and lockedOf[bundler] are untouched
//   T4_cancel_feeRecipient_unchanged -- feeRecipient's pending not changed by cancel()
//   T4_cancel_only_authorized     -- non-authorized caller reverts during accept window
//
// Theorem: T4 (also T11, T25)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;
}

// Helper: common PROPOSED-commit + CLIENT-caller preconditions used in multiple rules.

// Rule: successful cancel() credits exactly feePaid to pendingWithdrawals[user].
// T4: cancel returns the full feePerOp; protocolFeeWei was already credited non-refundably.
rule T4_cancel_credits_exact_fee(uint256 commitId) {
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
    require e.msg.sender == user; // CLIENT always authorized
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    mathint pendingBefore = to_mathint(pendingWithdrawals(user));

    cancel(e, commitId);

    mathint pendingAfter = to_mathint(pendingWithdrawals(user));

    assert pendingAfter == pendingBefore + to_mathint(feePaid),
        "T4: cancel() must credit exactly feePaid to pendingWithdrawals[user]";
}

// Rule: cancel() does not change bundler's deposited or lockedOf.
// T25: no collateral was locked for a PROPOSED commit; BUNDLER loses nothing on cancel.
rule T4_cancel_bundler_unchanged(uint256 commitId) {
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
    require e.msg.sender == user;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    mathint depositedBefore = to_mathint(deposited(bundler));
    mathint lockedBefore    = to_mathint(lockedOf(bundler));

    cancel(e, commitId);

    assert to_mathint(deposited(bundler)) == depositedBefore,
        "T4/T25: cancel() must not change bundler's deposited balance";
    assert to_mathint(lockedOf(bundler))  == lockedBefore,
        "T4/T25: cancel() must not change bundler's locked balance";
}

// Rule: cancel() does not change feeRecipient's pendingWithdrawals.
// protocolFeeWei was already credited at commit time; cancel triggers no additional fee.
rule T4_cancel_feeRecipient_unchanged(uint256 commitId) {
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
    require e.msg.sender == user;
    require e.msg.value == 0;
    require to_mathint(pendingWithdrawals(user)) + to_mathint(feePaid) <= max_uint256;

    address fr = feeRecipient();
    // Distinct addresses (if user == feeRecipient, they receive feePaid as user, checked separately)
    require fr != user;
    mathint frPendingBefore = to_mathint(pendingWithdrawals(fr));

    cancel(e, commitId);

    assert to_mathint(pendingWithdrawals(fr)) == frPendingBefore,
        "T4: cancel() must not credit anything additional to feeRecipient";
}

// Rule: during the accept window, a non-user caller is rejected by cancel().
// A9: only CLIENT may cancel during the accept window; third parties must wait.
rule T4_cancel_only_user_during_window(uint256 commitId) {
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
    // Within accept window
    require to_mathint(e.block.number) <= to_mathint(acceptDeadline);
    // Not the user
    require e.msg.sender != user;
    require e.msg.value == 0;

    cancel@withrevert(e, commitId);

    assert lastReverted,
        "A9: cancel() must revert for non-user callers during the accept window";
}
