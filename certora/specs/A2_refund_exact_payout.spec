// docs/DESIGN.md A2 / T8 -- claimRefund() credits exactly feePaid + collateralLocked
// to CLIENT; BUNDLER receives nothing; BUNDLER's deposited decreases by collateralLocked.
//
// "A2: on SLA miss CLIENT receives feePerOp + full collateral. The slash is 100% --
//  deliberate miss is always strictly net-negative for BUNDLER (T8: collateral > feePerOp).
//  BUNDLER's deposited balance is reduced (the bond is burned to CLIENT), and their
//  locked balance is freed."
//
// Four rules:
//   A2_refund_credits_full_payout   -- pendingWithdrawals[user] += feePaid + collateralLocked
//   A2_refund_slashes_deposited     -- deposited[bundler] -= collateralLocked
//   A2_refund_frees_locked          -- lockedOf[bundler]  -= collateralLocked
//   A2_refund_bundler_gets_nothing  -- pendingWithdrawals[bundler] unchanged
//
// Theorem: A2 (also T8 slash, T12/A9)
// Contract: SLAEscrow
// Status: READY (pending run)

using SLAEscrow as escrow;

methods {
    function pendingWithdrawals(address) external returns (uint256) envfree;
    function deposited(address) external returns (uint256) envfree;
    function lockedOf(address) external returns (uint256) envfree;
    function feeRecipient() external returns (address) envfree;
    function SETTLEMENT_GRACE_BLOCKS() external returns (uint64) envfree;
    function REFUND_GRACE_BLOCKS() external returns (uint64) envfree;
    function getCommitCore(uint256) external returns (address, uint96, address, uint96, uint64, bool, bool) envfree;
    function getCommitState(uint256) external returns (uint256, bytes32, uint64, bool, bool, uint64, uint32) envfree;
}

// Shared precondition helper (comments only -- CVL does not support rule helpers).
// Preconditions for all rules:
//   ACTIVE commit (!settled !refunded !cancelled, accepted=true)
//   block.number >= deadline + SETTLEMENT_GRACE + REFUND_GRACE + 1
//   lockedOf[bundler] >= collateralLocked
//   deposited[bundler] >= collateralLocked
//   overflow guard on pendingWithdrawals[user]

// Rule: successful claimRefund() credits exactly feePaid + collateralLocked to CLIENT.
// A2: 100% slash -- feePerOp refunded (performance guarantee failed) plus full collateral.
rule A2_refund_credits_full_payout(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender == user;
    require e.msg.value == 0;

    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;
    require to_mathint(lockedOf(bundler))   >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler))  >= to_mathint(collateralLocked);

    mathint userTotal = to_mathint(feePaid) + to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(user)) + userTotal <= max_uint256;

    mathint pendingBefore = to_mathint(pendingWithdrawals(user));

    claimRefund(e, commitId);

    assert to_mathint(pendingWithdrawals(user)) == pendingBefore + userTotal,
        "A2: claimRefund() must credit exactly feePaid + collateralLocked to CLIENT";
}

// Rule: successful claimRefund() reduces deposited[bundler] by exactly collateralLocked.
// T8: slash is permanent -- the bond is transferred to CLIENT, not held in escrow.
rule A2_refund_slashes_deposited(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender == user;
    require e.msg.value == 0;

    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;
    require to_mathint(lockedOf(bundler))  >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(user))
          + to_mathint(feePaid) + to_mathint(collateralLocked) <= max_uint256;

    mathint depositedBefore = to_mathint(deposited(bundler));

    claimRefund(e, commitId);

    assert to_mathint(deposited(bundler)) == depositedBefore - to_mathint(collateralLocked),
        "A2/T8: claimRefund() must reduce deposited[bundler] by exactly collateralLocked";
}

// Rule: successful claimRefund() frees lockedOf[bundler] by collateralLocked.
// The slot was locked at accept(); refund releases it (and also slashes deposited).
rule A2_refund_frees_locked(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender == user;
    require e.msg.value == 0;

    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;
    require to_mathint(lockedOf(bundler))  >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(user))
          + to_mathint(feePaid) + to_mathint(collateralLocked) <= max_uint256;

    mathint lockedBefore = to_mathint(lockedOf(bundler));

    claimRefund(e, commitId);

    assert to_mathint(lockedOf(bundler)) == lockedBefore - to_mathint(collateralLocked),
        "A2: claimRefund() must decrease lockedOf[bundler] by exactly collateralLocked";
}

// Rule: successful claimRefund() does NOT increase bundler's pendingWithdrawals.
// BUNDLER receives no compensation on SLA miss -- slash is 100% to CLIENT (A2/T8).
rule A2_refund_bundler_gets_nothing(uint256 commitId) {
    env e;

    address user; uint96 feePaid; address bundler; uint96 collateralLocked;
    uint64 deadline; bool settled; bool refunded;
    uint256 quoteId; bytes32 userOpHash; uint64 inclusionBlock;
    bool accepted; bool cancelled; uint64 acceptDeadline; uint32 slaBlocks;

    user, feePaid, bundler, collateralLocked, deadline, settled, refunded
        = getCommitCore(commitId);
    quoteId, userOpHash, inclusionBlock,
        accepted, cancelled, acceptDeadline, slaBlocks = getCommitState(commitId);

    require user != 0 && bundler != 0;
    require accepted && !settled && !refunded && !cancelled;
    require e.msg.sender == user;
    require e.msg.value == 0;
    // Distinct: bundler != user (otherwise their pending as user increases -- correct behaviour)
    require bundler != user;

    mathint unlocksAt = to_mathint(deadline) + to_mathint(SETTLEMENT_GRACE_BLOCKS())
                      + to_mathint(REFUND_GRACE_BLOCKS()) + 1;
    require unlocksAt <= max_uint64;
    require to_mathint(e.block.number) >= unlocksAt;
    require to_mathint(lockedOf(bundler))  >= to_mathint(collateralLocked);
    require to_mathint(deposited(bundler)) >= to_mathint(collateralLocked);
    require to_mathint(pendingWithdrawals(user))
          + to_mathint(feePaid) + to_mathint(collateralLocked) <= max_uint256;

    mathint bundlerPendingBefore = to_mathint(pendingWithdrawals(bundler));

    claimRefund(e, commitId);

    assert to_mathint(pendingWithdrawals(bundler)) == bundlerPendingBefore,
        "A2/T8: claimRefund() must not credit anything to bundler's pendingWithdrawals";
}
